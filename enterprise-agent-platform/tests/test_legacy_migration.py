from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.db import Database, now_ts
from enterprise_agent_platform.legacy_migration import (
    LEGACY_HERMES_MIGRATION_KEY,
    LegacyMigrationError,
    LegacySessionImportResult,
    finalize_legacy_hermes_migration,
    migrate_legacy_hermes_data,
)


class LegacyMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_dir = Path(self.temporary.name) / "data"
        self.hermes_home = self.data_dir / "runtimes" / "hermes"
        self.hermes_home.mkdir(parents=True)
        self.db = Database(self.data_dir / "platform.db")
        self.addCleanup(self.db.close)

    def _add_user(self, user_id: int = 1) -> None:
        self.db.execute(
            """
            INSERT INTO users(
                id, username, display_name, password_hash, role, created_at
            ) VALUES (?, ?, ?, 'hash', 'member', ?)
            """,
            (user_id, f"user{user_id}", f"User {user_id}", now_ts()),
        )

    def _add_scope(
        self,
        scope_type: str = "private",
        scope_id: str = "1",
        *,
        workspace: Path | None = None,
    ) -> tuple[str, Path]:
        if scope_type == "private":
            scope_key = f"private:{scope_id}"
            default_workspace = self.data_dir / "workspaces" / f"user-{scope_id}"
        else:
            scope_key = f"channel:{scope_id}:main-agent"
            default_workspace = self.data_dir / "workspaces" / "channels" / f"channel-{scope_id}"
        workspace = workspace or default_workspace
        workspace.mkdir(parents=True, exist_ok=True)
        timestamp = now_ts()
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO agent_scopes(
                    scope_key, scope_type, scope_id, session_id, lifecycle_id,
                    workspace_path, execution_backend, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'host', ?, ?)
                """,
                (
                    scope_key,
                    scope_type,
                    scope_id,
                    f"legacy-session-{scope_id}",
                    f"legacy-lifecycle-{scope_id}",
                    str(workspace),
                    timestamp,
                    timestamp,
                ),
            )
            conn.execute(
                """
                INSERT INTO agent_runtime_scopes(
                    scope_key, session_id, lifecycle_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    scope_key,
                    f"pi-session-{scope_id}",
                    f"pi-lifecycle-{scope_id}",
                    timestamp,
                    timestamp,
                ),
            )
        return scope_key, workspace

    def _add_message(
        self,
        scope_type: str,
        scope_id: str,
        author_type: str,
        content: str,
        *,
        user_id: int | None = None,
    ) -> int:
        return self.db.insert(
            """
            INSERT INTO messages(
                scope_type, scope_id, author_type, user_id, username,
                content, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, '', ?, '{}', ?)
            """,
            (scope_type, scope_id, author_type, user_id, content, now_ts()),
        )

    def _memory_dir(self, scope_key: str) -> Path:
        digest = hashlib.sha256(scope_key.encode("utf-8")).hexdigest()[:12]
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", scope_key).strip(".-") or "agent"
        safe = safe[:80].rstrip(".-") or "agent"
        path = self.hermes_home / "memories" / "agents" / f"{safe}-{digest}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _set_setting(self, key: str, value: str, *, secret: bool = True) -> None:
        self.db.execute(
            """
            INSERT INTO settings(key, value, secret, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value, secret = excluded.secret,
              updated_at = excluded.updated_at
            """,
            (key, value, 1 if secret else 0, now_ts()),
        )

    def _write_auth(self, providers: dict[str, object]) -> None:
        (self.hermes_home / "auth.json").write_text(
            json.dumps({"version": 2, "providers": providers}),
            encoding="utf-8",
        )

    def _state(self) -> dict[str, object] | None:
        row = self.db.query_one(
            "SELECT value, secret FROM settings WHERE key = ?",
            (LEGACY_HERMES_MIGRATION_KEY,),
        )
        if row is None:
            return None
        self.assertEqual(row["secret"], 0)
        return json.loads(str(row["value"]))

    def test_full_migration_is_bounded_content_free_and_idempotent(self) -> None:
        self._add_user(1)
        scope_key, workspace = self._add_scope()
        marker = workspace / "keep.txt"
        marker.write_text("workspace-is-preserved", encoding="utf-8")
        message_ids = []
        for index in range(35):
            message_ids.append(
                self._add_message(
                    "private",
                    "1",
                    "user" if index % 2 == 0 else "agent",
                    f"visible-history-{index}",
                    user_id=1 if index % 2 == 0 else None,
                )
            )
        memory_dir = self._memory_dir(scope_key)
        (memory_dir / "MEMORY.md").write_text(
            "remember-alpha\n§\nremember-beta\n", encoding="utf-8"
        )
        (memory_dir / "USER.md").write_text("private-user-profile", encoding="utf-8")

        attachment_relative = f"private/1/{message_ids[-1]}-keep.txt"
        attachment = self.data_dir / "attachments" / attachment_relative
        attachment.parent.mkdir(parents=True)
        attachment.write_bytes(b"attachment-is-preserved")
        self.db.execute(
            """
            INSERT INTO attachments(
                message_id, scope_type, scope_id, uploader_user_id, source,
                filename, storage_path, mime_type, size_bytes, sha256, created_at
            ) VALUES (?, 'private', '1', 1, 'upload', 'keep.txt', ?,
                      'text/plain', ?, 'digest', ?)
            """,
            (message_ids[-1], attachment_relative, attachment.stat().st_size, now_ts()),
        )

        self._set_setting("CODEX_OAUTH_ACCESS_TOKEN", "db-old-access")
        self._set_setting("CODEX_OAUTH_REFRESH_TOKEN", "db-old-refresh")
        self._set_setting("CODEX_OAUTH_EXPIRES_AT", "9999999999", secret=False)
        self._write_auth(
            {
                "openai-codex": {
                    "tokens": {
                        "access_token": "rotated-access-secret",
                        "refresh_token": "rotated-refresh-secret",
                    },
                    "platform_synced_refresh_token": "db-old-refresh",
                }
            }
        )

        batches = []

        def importer(manifests):
            batches.append(manifests)
            return None

        result = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=importer,
        )

        self.assertEqual(result.phase, "prepared")
        self.assertEqual((result.imported, result.skipped), (1, 0))
        self.assertEqual(result.session_messages, 30)
        self.assertEqual(result.memories_imported, 3)
        self.assertEqual(result.oauth_imported, 1)
        self.assertEqual((result.attachments_verified, result.attachments_skipped), (1, 0))
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 1)
        manifest = batches[0][0]
        self.assertEqual(manifest.scope_key, scope_key)
        self.assertEqual(manifest.session_id, "pi-session-1")
        self.assertEqual(manifest.lifecycle_id, "pi-lifecycle-1")
        self.assertEqual(len(manifest.item_hash), 64)
        self.assertEqual(len(manifest.messages), 30)
        self.assertEqual(manifest.messages[0].source_message_id, message_ids[5])
        self.assertEqual(manifest.messages[-1].content, "visible-history-34")
        self.assertTrue(all(len(message.item_hash) == 64 for message in manifest.messages))

        memories = self.db.query(
            """
            SELECT target, owner_user_id, content FROM agent_memories
            WHERE scope_key = ? ORDER BY id
            """,
            (scope_key,),
        )
        self.assertEqual(
            memories,
            [
                {"target": "memory", "owner_user_id": None, "content": "remember-alpha"},
                {"target": "memory", "owner_user_id": None, "content": "remember-beta"},
                {"target": "user", "owner_user_id": 1, "content": "private-user-profile"},
            ],
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_ACCESS_TOKEN'"),
            "rotated-access-secret",
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_REFRESH_TOKEN'"),
            "rotated-refresh-secret",
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_EXPIRES_AT'"),
            "0",
        )
        state_text = json.dumps(self._state(), sort_keys=True)
        self.assertEqual(self._state()["phase"], "prepared")
        for sensitive in (
            "visible-history",
            "remember-alpha",
            "private-user-profile",
            "rotated-access-secret",
            "rotated-refresh-secret",
            str(workspace),
            manifest.item_hash,
        ):
            self.assertNotIn(sensitive, state_text)
        self.assertEqual(marker.read_text(encoding="utf-8"), "workspace-is-preserved")
        self.assertEqual(attachment.read_bytes(), b"attachment-is-preserved")

        completed = finalize_legacy_hermes_migration(self.db, result)
        self.assertEqual(completed.phase, "complete")
        second_callback_calls = []
        second = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=lambda manifests: second_callback_calls.append(manifests),
        )
        self.assertTrue(second.already_complete)
        self.assertEqual(second_callback_calls, [])
        self.assertEqual(self.db.scalar("SELECT count(*) FROM agent_memories"), 3)

        # Even if the content-free marker is administratively lost, item-level
        # memory hashes and the external importer contract prevent duplication.
        self.db.execute(
            "DELETE FROM settings WHERE key = ?", (LEGACY_HERMES_MIGRATION_KEY,)
        )
        retry_hashes = []

        def deduplicating_importer(manifests):
            retry_hashes.extend(manifest.item_hash for manifest in manifests)
            return LegacySessionImportResult(imported=0, skipped=len(manifests))

        repeated = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=deduplicating_importer,
        )
        self.assertEqual((repeated.memories_imported, repeated.memories_skipped), (0, 3))
        self.assertEqual((repeated.imported, repeated.skipped), (0, 1))
        self.assertEqual(retry_hashes, [manifest.item_hash])
        self.assertEqual(self.db.scalar("SELECT count(*) FROM agent_memories"), 3)

    def test_channel_user_memory_and_oauth_precedence(self) -> None:
        self._add_user(1)
        scope_key, _ = self._add_scope("channel", "7")
        (self._memory_dir(scope_key) / "USER.md").write_text(
            "shared-channel-profile", encoding="utf-8"
        )
        self._set_setting("CODEX_OAUTH_ACCESS_TOKEN", "fresh-db-access")
        self._set_setting("CODEX_OAUTH_REFRESH_TOKEN", "fresh-db-refresh")
        self._write_auth(
            {
                "openai-codex": {
                    "tokens": {
                        "access_token": "stale-auth-access",
                        "refresh_token": "auth-rotated-from-old-login",
                    },
                    "platform_synced_refresh_token": "old-db-refresh",
                },
                "xai-oauth": {
                    "tokens": {
                        "access_token": "xai-auth-access",
                        "refresh_token": "xai-auth-refresh",
                        "id_token": "xai-auth-id",
                    }
                },
            }
        )

        result = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=lambda manifests: LegacySessionImportResult(
                imported=0, skipped=len(manifests)
            ),
        )

        memory = self.db.query_one(
            "SELECT target, owner_user_id, content FROM agent_memories WHERE scope_key = ?",
            (scope_key,),
        )
        self.assertEqual(
            memory,
            {
                "target": "memory",
                "owner_user_id": None,
                "content": "shared-channel-profile",
            },
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_ACCESS_TOKEN'"),
            "fresh-db-access",
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_REFRESH_TOKEN'"),
            "fresh-db-refresh",
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'GROK_OAUTH_ACCESS_TOKEN'"),
            "xai-auth-access",
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'GROK_OAUTH_REFRESH_TOKEN'"),
            "xai-auth-refresh",
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'GROK_OAUTH_ID_TOKEN'"),
            "xai-auth-id",
        )
        self.assertEqual((result.oauth_imported, result.oauth_skipped), (1, 1))
        self.assertEqual((result.imported, result.skipped), (0, 0))

    def test_global_legacy_memory_is_assigned_to_the_single_private_owner(self) -> None:
        self._add_user(1)
        scope_key, _ = self._add_scope()
        memories = self.hermes_home / "memories"
        memories.mkdir(parents=True)
        (memories / "MEMORY.md").write_text("global-fact", encoding="utf-8")
        (memories / "USER.md").write_text("global-profile", encoding="utf-8")

        result = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=lambda manifests: None,
        )

        self.assertEqual(result.memories_imported, 2)
        rows = self.db.query(
            "SELECT scope_key, target, owner_user_id, content FROM agent_memories ORDER BY id"
        )
        self.assertEqual(
            rows,
            [
                {
                    "scope_key": scope_key,
                    "target": "memory",
                    "owner_user_id": None,
                    "content": "global-fact",
                },
                {
                    "scope_key": scope_key,
                    "target": "user",
                    "owner_user_id": 1,
                    "content": "global-profile",
                },
            ],
        )

    def test_global_memory_prefers_the_earliest_admin_without_broad_copying(self) -> None:
        self._add_user(1)
        self._add_user(2)
        first_scope, _ = self._add_scope(scope_id="1")
        self._add_scope(scope_id="2")
        self.db.execute("UPDATE users SET role = 'admin' WHERE id IN (1, 2)")
        memories = self.hermes_home / "memories"
        memories.mkdir(parents=True)
        (memories / "USER.md").write_text("owner-is-unknown", encoding="utf-8")

        result = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=lambda manifests: None,
        )

        self.assertEqual(result.memories_imported, 1)
        row = self.db.query_one(
            "SELECT scope_key, target, owner_user_id, content FROM agent_memories"
        )
        self.assertEqual(
            row,
            {
                "scope_key": first_scope,
                "target": "user",
                "owner_user_id": 1,
                "content": "owner-is-unknown",
            },
        )

    def test_missing_channel_scope_is_materialized_without_changing_legacy_session(self) -> None:
        self._add_user(1)
        self.db.execute(
            "INSERT INTO channels(id, name, created_by, created_at) VALUES (7, 'legacy', 1, ?)",
            (now_ts(),),
        )
        self._add_message("channel", "7", "user", "quiet-channel-history", user_id=1)
        self._set_setting(
            "hermes_session:channel:7:main-agent",
            "hermes-channel-session-7",
            secret=False,
        )
        batches = []

        result = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=lambda manifests: batches.append(manifests),
        )

        self.assertEqual(result.session_manifests, 1)
        legacy = self.db.query_one(
            "SELECT session_id FROM agent_scopes WHERE scope_key = 'channel:7:main-agent'"
        )
        runtime = self.db.query_one(
            "SELECT session_id FROM agent_runtime_scopes WHERE scope_key = 'channel:7:main-agent'"
        )
        self.assertEqual(legacy["session_id"], "hermes-channel-session-7")
        self.assertEqual(runtime["session_id"], "ubitech-channel-7-main-agent")
        channel_manifest = next(
            manifest for manifest in batches[0] if manifest.scope_key == "channel:7:main-agent"
        )
        self.assertEqual(channel_manifest.messages[-1].content, "quiet-channel-history")

    def test_terminal_relogin_clears_only_matching_stale_db_credentials(self) -> None:
        self._set_setting("CODEX_OAUTH_ACCESS_TOKEN", "terminal-access")
        self._set_setting("CODEX_OAUTH_REFRESH_TOKEN", "terminal-refresh")
        self._set_setting("CODEX_OAUTH_EXPIRES_AT", "42", secret=False)
        self._set_setting("GROK_OAUTH_ACCESS_TOKEN", "fresh-grok-access")
        self._set_setting("GROK_OAUTH_REFRESH_TOKEN", "fresh-grok-refresh")
        self._write_auth(
            {
                "openai-codex": {
                    "tokens": {
                        "access_token": "unusable-access",
                        "refresh_token": "unusable-refresh",
                    },
                    "platform_synced_refresh_token": "terminal-refresh",
                    "last_auth_error": {"relogin_required": True},
                },
                "xai-oauth": {
                    "tokens": {
                        "access_token": "older-grok-access",
                        "refresh_token": "older-grok-refresh",
                    },
                    "platform_synced_refresh_token": "old-grok-refresh",
                    "last_auth_error": {"relogin_required": True},
                },
            }
        )

        result = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=lambda manifests: None,
        )

        codex_rows = self.db.scalar(
            """
            SELECT count(*) FROM settings
            WHERE key IN (
                'CODEX_OAUTH_ACCESS_TOKEN', 'CODEX_OAUTH_REFRESH_TOKEN',
                'CODEX_OAUTH_EXPIRES_AT'
            )
            """
        )
        self.assertEqual(codex_rows, 0)
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'GROK_OAUTH_ACCESS_TOKEN'"),
            "fresh-grok-access",
        )
        self.assertEqual(result.oauth_cleared, 1)
        self.assertEqual(result.oauth_skipped, 1)

    def test_prepared_retry_rereads_hermes_and_preserves_a_newer_db_login(self) -> None:
        self._add_user(1)
        scope_key, _ = self._add_scope()
        self._add_message("private", "1", "user", "retry-visible", user_id=1)
        (self._memory_dir(scope_key) / "MEMORY.md").write_text(
            "retry-memory", encoding="utf-8"
        )
        self._set_setting("CODEX_OAUTH_ACCESS_TOKEN", "before-access")
        self._set_setting("CODEX_OAUTH_REFRESH_TOKEN", "before-refresh")
        self._write_auth(
            {
                "openai-codex": {
                    "tokens": {
                        "access_token": "prepared-access",
                        "refresh_token": "prepared-refresh",
                    },
                    "platform_synced_refresh_token": "before-refresh",
                }
            }
        )
        first_hashes = []

        def failing_importer(manifests):
            first_hashes.extend(manifest.item_hash for manifest in manifests)
            raise RuntimeError("do not leak retry-visible or prepared-refresh")

        with self.assertRaises(LegacyMigrationError) as raised:
            migrate_legacy_hermes_data(
                self.db,
                self.data_dir,
                session_importer=failing_importer,
            )
        self.assertEqual(str(raised.exception), "legacy session import failed")
        self.assertEqual(self._state()["phase"], "prepared")
        self.assertEqual(self.db.scalar("SELECT count(*) FROM agent_memories"), 1)
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_REFRESH_TOKEN'"),
            "prepared-refresh",
        )

        # A later login is authoritative even though prepared-state retry
        # re-reads the valid stopped Hermes store for new rotations/memories.
        self._set_setting("CODEX_OAUTH_ACCESS_TOKEN", "new-login-access")
        self._set_setting("CODEX_OAUTH_REFRESH_TOKEN", "new-login-refresh")
        (self._memory_dir(scope_key) / "MEMORY.md").write_text(
            "retry-memory\n§\npost-failure-memory", encoding="utf-8"
        )
        self._add_message("private", "1", "agent", "post-failure-visible")
        second_hashes = []

        def successful_importer(manifests):
            second_hashes.extend(manifest.item_hash for manifest in manifests)
            return LegacySessionImportResult(imported=1, skipped=0)

        result = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=successful_importer,
        )
        self.assertEqual(result.phase, "prepared")
        self.assertNotEqual(first_hashes, second_hashes)
        self.assertEqual(self.db.scalar("SELECT count(*) FROM agent_memories"), 2)
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_REFRESH_TOKEN'"),
            "new-login-refresh",
        )

    def test_prepared_retry_imports_a_later_hermes_oauth_rotation(self) -> None:
        self._add_user(1)
        self._add_scope()
        self._set_setting("CODEX_OAUTH_ACCESS_TOKEN", "db-access")
        self._set_setting("CODEX_OAUTH_REFRESH_TOKEN", "db-refresh")
        self._write_auth(
            {
                "openai-codex": {
                    "tokens": {
                        "access_token": "first-access",
                        "refresh_token": "first-refresh",
                    },
                    "platform_synced_refresh_token": "db-refresh",
                }
            }
        )

        with self.assertRaises(LegacyMigrationError):
            migrate_legacy_hermes_data(
                self.db,
                self.data_dir,
                session_importer=lambda manifests: (_ for _ in ()).throw(RuntimeError("fail")),
            )

        auth = json.loads((self.hermes_home / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(
            auth["providers"]["openai-codex"]["platform_synced_refresh_token"],
            "first-refresh",
        )
        self._write_auth(
            {
                "openai-codex": {
                    "tokens": {
                        "access_token": "second-access",
                        "refresh_token": "second-refresh",
                    },
                    "platform_synced_refresh_token": "first-refresh",
                }
            }
        )

        result = migrate_legacy_hermes_data(
            self.db,
            self.data_dir,
            session_importer=lambda manifests: None,
        )

        self.assertEqual(result.phase, "prepared")
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_ACCESS_TOKEN'"),
            "second-access",
        )
        self.assertEqual(
            self.db.scalar("SELECT value FROM settings WHERE key = 'CODEX_OAUTH_REFRESH_TOKEN'"),
            "second-refresh",
        )
        updated_auth = json.loads(
            (self.hermes_home / "auth.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            updated_auth["providers"]["openai-codex"]["platform_synced_refresh_token"],
            "second-refresh",
        )

    def test_global_memory_limits_fail_before_any_database_write(self) -> None:
        self._add_user(1)
        scope_key, _ = self._add_scope()
        memory_path = self._memory_dir(scope_key) / "MEMORY.md"
        importer_calls = []

        memory_path.write_text("first\n§\nsecond", encoding="utf-8")
        with mock.patch(
            "enterprise_agent_platform.legacy_migration._MAX_TOTAL_MEMORY_ENTRIES",
            1,
        ):
            with self.assertRaisesRegex(LegacyMigrationError, "memory total limit"):
                migrate_legacy_hermes_data(
                    self.db,
                    self.data_dir,
                    session_importer=lambda manifests: importer_calls.append(manifests),
                )

        self.assertEqual(self.db.scalar("SELECT count(*) FROM agent_memories"), 0)
        self.assertIsNone(self._state())
        self.assertEqual(importer_calls, [])

        memory_path.write_text("four", encoding="utf-8")
        with mock.patch(
            "enterprise_agent_platform.legacy_migration._MAX_TOTAL_MEMORY_BYTES",
            3,
        ):
            with self.assertRaisesRegex(LegacyMigrationError, "memory total limit"):
                migrate_legacy_hermes_data(
                    self.db,
                    self.data_dir,
                    session_importer=lambda manifests: importer_calls.append(manifests),
                )

        self.assertEqual(self.db.scalar("SELECT count(*) FROM agent_memories"), 0)
        self.assertIsNone(self._state())
        self.assertEqual(importer_calls, [])

    def test_auth_lineage_atomic_write_ignores_a_stale_pid_timestamp_temp(self) -> None:
        fixed_pid = 4242
        fixed_timestamp = 1_700_000_000
        stale = self.hermes_home / f".auth.json.{fixed_pid}.{fixed_timestamp}.tmp"
        stale.write_text("stale migration artifact", encoding="utf-8")
        self._set_setting("CODEX_OAUTH_ACCESS_TOKEN", "db-access")
        self._set_setting("CODEX_OAUTH_REFRESH_TOKEN", "db-refresh")
        self._write_auth(
            {
                "openai-codex": {
                    "tokens": {
                        "access_token": "rotated-access",
                        "refresh_token": "rotated-refresh",
                    },
                    "platform_synced_refresh_token": "db-refresh",
                }
            }
        )

        with mock.patch(
            "enterprise_agent_platform.legacy_migration.os.getpid",
            return_value=fixed_pid,
        ), mock.patch(
            "enterprise_agent_platform.legacy_migration.now_ts",
            return_value=fixed_timestamp,
        ):
            result = migrate_legacy_hermes_data(
                self.db,
                self.data_dir,
                session_importer=lambda manifests: None,
            )

        self.assertEqual(result.phase, "prepared")
        auth = json.loads((self.hermes_home / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(
            auth["providers"]["openai-codex"]["platform_synced_refresh_token"],
            "rotated-refresh",
        )
        self.assertEqual(stale.read_text(encoding="utf-8"), "stale migration artifact")
        self.assertEqual(
            [path for path in self.hermes_home.glob(".auth.json.*.tmp") if path != stale],
            [],
        )

    def test_malformed_auth_rolls_back_without_calling_importer(self) -> None:
        self._add_user(1)
        scope_key, _ = self._add_scope()
        (self._memory_dir(scope_key) / "MEMORY.md").write_text(
            "must-not-partially-import", encoding="utf-8"
        )
        (self.hermes_home / "auth.json").write_text("{broken", encoding="utf-8")
        calls = []

        with self.assertRaises(LegacyMigrationError):
            migrate_legacy_hermes_data(
                self.db,
                self.data_dir,
                session_importer=lambda manifests: calls.append(manifests),
            )

        self.assertEqual(calls, [])
        self.assertEqual(self.db.scalar("SELECT count(*) FROM agent_memories"), 0)
        self.assertIsNone(self._state())

    def test_malformed_memory_and_unsafe_workspace_fail_before_writes(self) -> None:
        self._add_user(1)
        scope_key, _ = self._add_scope()
        (self._memory_dir(scope_key) / "MEMORY.md").write_bytes(b"\xff\xfe")
        with self.assertRaises(LegacyMigrationError):
            migrate_legacy_hermes_data(
                self.db,
                self.data_dir,
                session_importer=lambda manifests: None,
            )
        self.assertEqual(self.db.scalar("SELECT count(*) FROM agent_memories"), 0)
        self.assertIsNone(self._state())

        # Rebuild a clean database because the existing scope key is unique.
        self.db.close()
        unsafe_data = Path(self.temporary.name) / "unsafe-data"
        self.data_dir = unsafe_data
        self.hermes_home = unsafe_data / "runtimes" / "hermes"
        self.hermes_home.mkdir(parents=True)
        self.db = Database(unsafe_data / "platform.db")
        self.addCleanup(self.db.close)
        self._add_user(1)
        outside = Path(self.temporary.name) / "outside-workspace"
        self._add_scope(workspace=outside)
        with self.assertRaises(LegacyMigrationError):
            migrate_legacy_hermes_data(
                self.db,
                self.data_dir,
                session_importer=lambda manifests: None,
            )
        self.assertIsNone(self._state())

    def test_importer_must_account_for_every_manifest(self) -> None:
        self._add_user(1)
        self._add_scope()
        self._add_message("private", "1", "user", "history", user_id=1)

        with self.assertRaises(LegacyMigrationError):
            migrate_legacy_hermes_data(
                self.db,
                self.data_dir,
                session_importer=lambda manifests: LegacySessionImportResult(
                    imported=0, skipped=0
                ),
            )

        state = self._state()
        self.assertIsNotNone(state)
        self.assertEqual(state["phase"], "prepared")


if __name__ == "__main__":
    unittest.main()
