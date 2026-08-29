from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import db as db_module
from enterprise_agent_platform.db import Database, migrate_database
from enterprise_agent_platform.skills import (
    SkillStore,
    _default_usage_record,
    _render_skill_document,
    _render_sidecar,
    _render_usage_state,
    _validated_document,
)
from enterprise_agent_platform.workspace_mount_compat import (
    normalize_legacy_workspace_mounts,
)


SOURCE_SCHEMA_VERSION = 2026080801
TARGET_SCHEMA_VERSION = 2026082901
SCOPE_KEY = "private:7"
WORKSPACE_PATH = "user-7"
SKILL_ID = "portable-workflow"

RETIRED_SCHEMA = """
CREATE TABLE knowledge_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_knowledge_documents_content_hash
    ON knowledge_documents(content_hash) WHERE content_hash != '';
CREATE TABLE knowledge_index_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_hash TEXT NOT NULL,
    embedding_base_url TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    embedding_dimensions INTEGER
        CHECK(embedding_dimensions IS NULL OR embedding_dimensions BETWEEN 1 AND 65536),
    chunker_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'building'
        CHECK(status IN ('building', 'active', 'failed', 'superseded')),
    document_count INTEGER NOT NULL DEFAULT 0 CHECK(document_count >= 0),
    ready_document_count INTEGER NOT NULL DEFAULT 0
        CHECK(ready_document_count >= 0 AND ready_document_count <= document_count),
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    activated_at INTEGER
);
CREATE INDEX idx_knowledge_index_generations_status
    ON knowledge_index_generations(status, id DESC);
CREATE UNIQUE INDEX uq_knowledge_index_generations_active
    ON knowledge_index_generations(status) WHERE status = 'active';
CREATE TABLE knowledge_document_index (
    generation_id INTEGER NOT NULL
        REFERENCES knowledge_index_generations(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL
        REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    expected_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'ready', 'failed')),
    chunk_count INTEGER NOT NULL DEFAULT 0 CHECK(chunk_count >= 0),
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(generation_id, document_id)
);
CREATE INDEX idx_knowledge_document_index_status
    ON knowledge_document_index(generation_id, status, document_id);
CREATE TABLE knowledge_chunks (
    generation_id INTEGER NOT NULL
        REFERENCES knowledge_index_generations(id) ON DELETE CASCADE,
    chunk_id TEXT NOT NULL,
    document_id INTEGER NOT NULL
        REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
    title_path TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    char_start INTEGER NOT NULL CHECK(char_start >= 0),
    char_end INTEGER NOT NULL CHECK(char_end > char_start),
    chunk_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(generation_id, chunk_id),
    UNIQUE(generation_id, document_id, chunk_index)
);
CREATE INDEX idx_knowledge_chunks_document
    ON knowledge_chunks(generation_id, document_id, chunk_index);
CREATE TABLE knowledge_chunk_embeddings (
    generation_id INTEGER NOT NULL,
    chunk_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 65536),
    vector BLOB NOT NULL,
    norm REAL NOT NULL CHECK(norm > 0),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(generation_id, chunk_id),
    FOREIGN KEY(generation_id, chunk_id)
        REFERENCES knowledge_chunks(generation_id, chunk_id) ON DELETE CASCADE
);
CREATE TABLE knowledge_document_files (
    document_id INTEGER PRIMARY KEY
        REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 255),
    media_type TEXT NOT NULL CHECK(length(media_type) BETWEEN 1 AND 255),
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 52428800),
    sha256 TEXT NOT NULL
        CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    content BLOB NOT NULL CHECK(length(content) = size_bytes),
    created_at INTEGER NOT NULL
);
CREATE TABLE sylver_platform_connections (
    owner_user_id INTEGER PRIMARY KEY
        REFERENCES users(id) ON DELETE CASCADE,
    base_url TEXT NOT NULL CHECK(length(base_url) > 0),
    remote_user_id INTEGER NOT NULL CHECK(remote_user_id > 0),
    username TEXT NOT NULL CHECK(length(username) > 0),
    full_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    verified_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(base_url, remote_user_id)
);
CREATE TABLE sylver_platform_credentials (
    owner_user_id INTEGER PRIMARY KEY
        REFERENCES sylver_platform_connections(owner_user_id) ON DELETE CASCADE,
    token TEXT NOT NULL CHECK(length(token) > 0),
    updated_at INTEGER NOT NULL
);
"""


def write_private(path: Path, content: bytes) -> None:
    path.write_bytes(content)
    path.chmod(0o600)


def create_source_database(
    data_dir: Path,
    *,
    with_legacy_skill: bool = True,
) -> tuple[Path, Path, Path]:
    database_path = data_dir / "platform.db"
    workspace = data_dir / "workspaces" / WORKSPACE_PATH
    workspace.mkdir(mode=0o700, parents=True)
    (data_dir / "workspaces").chmod(0o700)
    database = Database(database_path)
    try:
        with database.transaction(immediate=True) as connection:
            connection.execute(
                "INSERT INTO agent_scopes(scope_key, scope_type, scope_id, session_id, "
                "lifecycle_id, workspace_path, sandbox_id, created_at, updated_at) "
                "VALUES (?, 'private', '7', 'session-7', '', ?, 'sandbox-7', 1, 1)",
                (SCOPE_KEY, WORKSPACE_PATH),
            )
    finally:
        database.close()

    digest = hashlib.sha256(SCOPE_KEY.encode("utf-8")).hexdigest()
    legacy_scope = data_dir / "agent-skills" / digest
    legacy_scope.mkdir(mode=0o700, parents=True)
    (data_dir / "agent-skills").chmod(0o700)
    write_private(legacy_scope / ".lock", b"")
    if with_legacy_skill:
        package = legacy_scope / SKILL_ID
        references = package / "references"
        references.mkdir(mode=0o700, parents=True)
        package.chmod(0o700)
        document = _validated_document(
            name="Portable Workflow",
            description="A migrated workflow.",
            instructions="Use the migrated workflow.",
            version="1.0.0",
            category="general",
            tags=["migration"],
        )
        write_private(
            package / "SKILL.md",
            _render_skill_document(document).encode("utf-8"),
        )
        write_private(references / "guide.txt", b"portable support\n")
        write_private(
            package / ".skill.json",
            _render_sidecar(
                {
                    "schema_version": 1,
                    "id": SKILL_ID,
                    "enabled": True,
                    "created_at": "2026-08-01T00:00:00+00:00",
                    "updated_at": "2026-08-02T00:00:00+00:00",
                }
            ),
        )
        usage = {
            "schema_version": 1,
            "skills": {SKILL_ID: _default_usage_record(created_by="agent")},
        }
        usage["skills"][SKILL_ID]["use_count"] = 3
        write_private(legacy_scope / ".skill-usage.json", _render_usage_state(usage))

    with sqlite3.connect(database_path) as connection:
        connection.executescript(RETIRED_SCHEMA)
        connection.execute(
            "INSERT INTO settings(key, value, secret, updated_at) "
            "VALUES ('knowledge_embedding_model', 'retired-model', 0, 1)"
        )
        connection.execute(
            "INSERT INTO durable_jobs(kind, scope_type, scope_id, dedupe_key, "
            "created_at, updated_at) VALUES "
            "('knowledge_index', 'knowledge', '1', 'knowledge:1', 1, 1)"
        )
        connection.execute(
            "UPDATE schema_migrations SET version = ?",
            (SOURCE_SCHEMA_VERSION,),
        )
    return database_path, workspace, legacy_scope


def marker(database_path: Path) -> int:
    with sqlite3.connect(database_path) as connection:
        return int(connection.execute("SELECT version FROM schema_migrations").fetchone()[0])


class DatabaseMigrationTests(unittest.TestCase):
    def test_legacy_mount_compatibility_prepares_skill_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, workspace, _legacy = create_source_database(data_dir)
            internal = workspace / ".agent-platform"
            attachments = internal / "attachments"
            attachments.mkdir(mode=0o755, parents=True)
            internal.chmod(0o755)
            with mock.patch(
                "enterprise_agent_platform.workspace_mount_compat.os.geteuid",
                return_value=0,
            ):
                normalize_legacy_workspace_mounts(
                    data_dir,
                    target_uid=os.getuid(),
                    target_gid=os.getgid(),
                )

            self.assertEqual(
                migrate_database(database_path, data_dir=data_dir),
                TARGET_SCHEMA_VERSION,
            )
            self.assertEqual(internal.stat().st_mode & 0o777, 0o700)
            self.assertTrue((internal / "skills" / SKILL_ID / "SKILL.md").is_file())

    def test_copies_legacy_skill_to_portable_and_protected_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, workspace, legacy = create_source_database(data_dir)
            legacy_before = db_module._read_migration_tree(legacy)
            old_snapshot = data_dir / "old-platform.db"
            with (
                sqlite3.connect(database_path) as source,
                sqlite3.connect(old_snapshot) as destination,
            ):
                source.backup(destination)

            self.assertEqual(
                migrate_database(database_path, data_dir=data_dir),
                TARGET_SCHEMA_VERSION,
            )

            destination = workspace / ".agent-platform" / "skills"
            package = destination / SKILL_ID
            state_scope = (
                data_dir
                / "agent-skill-state"
                / hashlib.sha256(SCOPE_KEY.encode("utf-8")).hexdigest()
            )
            self.assertEqual(db_module._read_migration_tree(legacy), legacy_before)
            self.assertFalse((destination / ".lock").exists())
            self.assertFalse((state_scope / ".lock").exists())
            self.assertEqual(
                (package / "references" / "guide.txt").read_bytes(),
                b"portable support\n",
            )
            self.assertFalse((package / ".skill.json").exists())
            self.assertFalse((destination / ".skill-usage.json").exists())
            package_info = package.stat()
            sidecar = json.loads(
                (state_scope / SKILL_ID / ".skill.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                (
                    sidecar["package_dev"],
                    sidecar["package_ino"],
                    sidecar["package_ctime_ns"],
                ),
                (
                    package_info.st_dev,
                    package_info.st_ino,
                    package_info.st_ctime_ns,
                ),
            )
            usage = json.loads(
                (state_scope / ".skill-usage.json").read_text(encoding="utf-8")
            )
            self.assertEqual(usage["skills"][SKILL_ID]["created_by"], "agent")
            store = SkillStore(
                data_dir / "workspaces",
                lambda scope_key: workspace,
                state_root=data_dir / "agent-skill-state",
                bundled_skills_dir=None,
            )
            self.assertEqual(store.list(SCOPE_KEY)[0]["id"], SKILL_ID)
            self.assertEqual(marker(old_snapshot), SOURCE_SCHEMA_VERSION)
            self.assertEqual(db_module._read_migration_tree(legacy), legacy_before)
            with sqlite3.connect(database_path) as connection:
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                self.assertFalse(
                    {name for name in tables if name.startswith(("knowledge_", "sylver_"))}
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT count(*) FROM settings WHERE key LIKE 'knowledge_%'"
                    ).fetchone()[0],
                    0,
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT count(*) FROM durable_jobs WHERE kind = 'knowledge_index'"
                    ).fetchone()[0],
                    0,
                )

    def test_conflicting_destination_has_no_database_or_copy_side_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, workspace, legacy = create_source_database(data_dir)
            destination = workspace / ".agent-platform" / "skills"
            destination.mkdir(mode=0o700, parents=True)
            destination.parent.chmod(0o700)
            write_private(destination / "extra.txt", b"conflict\n")
            legacy_before = db_module._read_migration_tree(legacy)

            with self.assertRaisesRegex(sqlite3.DatabaseError, "differs"):
                migrate_database(database_path, data_dir=data_dir)

            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
            self.assertEqual(db_module._read_migration_tree(legacy), legacy_before)
            self.assertEqual((destination / "extra.txt").read_bytes(), b"conflict\n")
            self.assertFalse((data_dir / "agent-skill-state").exists())

    def test_schema_failure_keeps_durable_copy_for_exact_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, workspace, legacy = create_source_database(data_dir)
            original = db_module._execute_transactional_schema

            def fail_after_schema(connection, schema):
                original(connection, schema)
                raise RuntimeError("simulated migration interruption")

            with mock.patch.object(
                db_module,
                "_execute_transactional_schema",
                side_effect=fail_after_schema,
            ):
                with self.assertRaisesRegex(RuntimeError, "simulated"):
                    migrate_database(database_path, data_dir=data_dir)

            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
            self.assertTrue(legacy.exists())
            destination = workspace / ".agent-platform" / "skills"
            self.assertTrue(destination.exists())
            package_inode = (destination / SKILL_ID).stat().st_ino
            with sqlite3.connect(database_path) as connection:
                self.assertIsNotNone(
                    connection.execute(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'knowledge_documents'"
                    ).fetchone()
                )
            self.assertEqual(
                migrate_database(database_path, data_dir=data_dir),
                TARGET_SCHEMA_VERSION,
            )
            self.assertEqual((destination / SKILL_ID).stat().st_ino, package_inode)

    def test_unknown_legacy_scope_is_preserved_and_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, _workspace, legacy = create_source_database(data_dir)
            unknown = data_dir / "agent-skills" / ("f" * 64)
            unknown.mkdir(mode=0o700)

            with self.assertRaisesRegex(sqlite3.DatabaseError, "unknown scope"):
                migrate_database(database_path, data_dir=data_dir)

            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
            self.assertTrue(legacy.exists())
            self.assertTrue(unknown.exists())

    def test_unsafe_or_oversized_source_tree_fails_before_copy(self):
        for case in ("hardlink", "unknown", "directory-limit", "nonempty-lock"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                data_dir = Path(directory) / "data"
                database_path, _workspace, legacy = create_source_database(data_dir)
                package = legacy / SKILL_ID
                if case == "hardlink":
                    (package / "references" / "linked.txt").hardlink_to(
                        package / "references" / "guide.txt"
                    )
                else:
                    if case == "unknown":
                        write_private(package / "unexpected.txt", b"unknown\n")
                    elif case == "directory-limit":
                        for index in range(64):
                            (package / "references" / f"empty-{index}").mkdir(
                                mode=0o700
                            )
                    else:
                        write_private(legacy / ".lock", b"unexpected\n")

                with self.assertRaises(sqlite3.DatabaseError):
                    migrate_database(database_path, data_dir=data_dir)

                self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
                self.assertFalse((data_dir / "agent-skill-state").exists())

    def test_source_tree_entry_budget_fails_before_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, _workspace, legacy = create_source_database(data_dir)
            legacy_before = db_module._read_migration_tree(legacy)

            with mock.patch.object(
                db_module,
                "_MAX_SKILL_MIGRATION_ENTRIES",
                2,
            ):
                with self.assertRaisesRegex(sqlite3.DatabaseError, "entry limits"):
                    migrate_database(database_path, data_dir=data_dir)

            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
            self.assertEqual(db_module._read_migration_tree(legacy), legacy_before)
            self.assertFalse((data_dir / "agent-skill-state").exists())

    def test_existing_protected_state_must_match_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, _workspace, _legacy = create_source_database(data_dir)
            with mock.patch.object(
                db_module,
                "_execute_transactional_schema",
                side_effect=RuntimeError("stop after copies"),
            ):
                with self.assertRaisesRegex(RuntimeError, "stop after copies"):
                    migrate_database(database_path, data_dir=data_dir)
            state_scope = (
                data_dir
                / "agent-skill-state"
                / hashlib.sha256(SCOPE_KEY.encode("utf-8")).hexdigest()
            )
            write_private(state_scope / "extra.json", b"{}\n")

            with self.assertRaisesRegex(sqlite3.DatabaseError, "differs"):
                migrate_database(database_path, data_dir=data_dir)

            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)

    def test_rejects_noncanonical_duplicate_and_symlink_workspaces(self):
        cases = ("noncanonical", "duplicate", "symlink")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                data_dir = Path(directory) / "data"
                database_path, workspace, legacy = create_source_database(data_dir)
                with sqlite3.connect(database_path) as connection:
                    if case == "noncanonical":
                        connection.execute(
                            "UPDATE agent_scopes SET workspace_path = 'private-7' "
                            "WHERE scope_key = ?",
                            (SCOPE_KEY,),
                        )
                    elif case == "duplicate":
                        duplicate_workspace = data_dir / "workspaces" / "channels" / "channel-a-b"
                        duplicate_workspace.mkdir(mode=0o700, parents=True)
                        (data_dir / "workspaces" / "channels").chmod(0o700)
                        connection.executemany(
                            "INSERT INTO agent_scopes(scope_key, scope_type, scope_id, "
                            "session_id, lifecycle_id, workspace_path, sandbox_id, "
                            "created_at, updated_at) VALUES (?, 'channel', ?, ?, '', ?, ?, 1, 1)",
                            (
                                ("channel:a/b:main-agent", "a/b", "s-a", "channels/channel-a-b", "b-a"),
                                ("channel:a-b:main-agent", "a-b", "s-b", "channels/channel-a-b", "b-b"),
                            ),
                        )
                if case == "symlink":
                    moved = workspace.with_name("user-7-real")
                    workspace.rename(moved)
                    workspace.symlink_to(moved, target_is_directory=True)

                with self.assertRaises(sqlite3.DatabaseError):
                    migrate_database(database_path, data_dir=data_dir)

                self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
                self.assertTrue(legacy.exists())
                self.assertFalse((data_dir / "agent-skill-state").exists())

    def test_scope_without_legacy_source_preserves_existing_canonical_skills(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, workspace, legacy = create_source_database(
                data_dir, with_legacy_skill=False
            )
            (legacy / ".lock").unlink()
            legacy.rmdir()
            destination = workspace / ".agent-platform" / "skills"
            destination.mkdir(mode=0o700, parents=True)
            destination.parent.chmod(0o700)
            write_private(destination / "user-file.txt", b"leave me alone\n")

            self.assertEqual(
                migrate_database(database_path, data_dir=data_dir),
                TARGET_SCHEMA_VERSION,
            )
            self.assertEqual(
                (destination / "user-file.txt").read_bytes(), b"leave me alone\n"
            )

    def test_apply_rejects_agent_platform_replacement_without_writing_victim(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, workspace, legacy = create_source_database(data_dir)
            legacy_before = db_module._read_migration_tree(legacy)
            victim = data_dir / "victim"
            victim.mkdir(mode=0o700)
            write_private(victim / "keep.txt", b"keep\n")
            original = Database._publish_legacy_skill_copies

            def replace_after_preflight(database, copies):
                (workspace / ".agent-platform").symlink_to(
                    victim, target_is_directory=True
                )
                return original(database, copies)

            with mock.patch.object(
                Database,
                "_publish_legacy_skill_copies",
                autospec=True,
                side_effect=replace_after_preflight,
            ):
                with self.assertRaises((RuntimeError, sqlite3.DatabaseError)):
                    migrate_database(database_path, data_dir=data_dir)

            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
            self.assertEqual((victim / "keep.txt").read_bytes(), b"keep\n")
            self.assertEqual(set(victim.iterdir()), {victim / "keep.txt"})
            self.assertEqual(db_module._read_migration_tree(legacy), legacy_before)

    def test_staging_replacement_is_not_followed_or_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, workspace, legacy = create_source_database(data_dir)
            legacy_before = db_module._read_migration_tree(legacy)
            victim = data_dir / "victim"
            victim.mkdir(mode=0o700)
            write_private(victim / "keep.txt", b"keep\n")
            replaced = False

            def replace_staging(_descriptor, _content):
                nonlocal replaced
                self.assertFalse(replaced)
                replaced = True
                parent = workspace / ".agent-platform"
                staging = next(parent.glob(".skills.migration-*"))
                staging.rename(parent / "detached-staging")
                staging.symlink_to(victim, target_is_directory=True)
                raise OSError("simulated staging race")

            with mock.patch.object(
                db_module.os,
                "write",
                side_effect=replace_staging,
            ):
                with self.assertRaises((RuntimeError, sqlite3.DatabaseError)):
                    migrate_database(database_path, data_dir=data_dir)

            self.assertTrue(replaced)
            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
            self.assertEqual((victim / "keep.txt").read_bytes(), b"keep\n")
            self.assertEqual(set(victim.iterdir()), {victim / "keep.txt"})
            self.assertEqual(db_module._read_migration_tree(legacy), legacy_before)

    def test_plan_keeps_only_compact_scope_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, _workspace, _legacy = create_source_database(data_dir)

            def inspect_plan(_database, copies):
                self.assertEqual(len(copies), 1)
                self.assertEqual(
                    set(copies[0]),
                    {"digest", "source", "source_fingerprint", "workspace_parts"},
                )
                self.assertFalse(
                    any(isinstance(value, bytes) for value in copies[0].values())
                )
                raise RuntimeError("plan inspected")

            with mock.patch.object(
                Database,
                "_publish_legacy_skill_copies",
                autospec=True,
                side_effect=inspect_plan,
            ):
                with self.assertRaisesRegex(RuntimeError, "plan inspected"):
                    migrate_database(database_path, data_dir=data_dir)

            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)

    def test_final_verification_rejects_portable_or_state_leaf_drift(self):
        for case in ("portable", "state"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                data_dir = Path(directory) / "data"
                database_path, workspace, legacy = create_source_database(data_dir)
                legacy_before = db_module._read_migration_tree(legacy)
                digest = hashlib.sha256(SCOPE_KEY.encode("utf-8")).hexdigest()
                original_fsync = db_module._fsync_migration_tree_fd
                changed = False

                def mutate_after_final_fsync(directory_fd):
                    nonlocal changed
                    original_fsync(directory_fd)
                    names = set(db_module.os.listdir(directory_fd))
                    if changed:
                        return
                    if case == "portable" and SKILL_ID in names:
                        write_private(
                            workspace
                            / ".agent-platform"
                            / "skills"
                            / SKILL_ID
                            / "SKILL.md",
                            b"changed after publication\n",
                        )
                        changed = True
                    elif case == "state" and ".skill-usage.json" in names:
                        write_private(
                            data_dir
                            / "agent-skill-state"
                            / digest
                            / ".skill-usage.json",
                            b'{"changed":true}\n',
                        )
                        changed = True

                with mock.patch.object(
                    db_module,
                    "_fsync_migration_tree_fd",
                    side_effect=mutate_after_final_fsync,
                ):
                    with self.assertRaisesRegex(sqlite3.DatabaseError, "differs"):
                        migrate_database(database_path, data_dir=data_dir)

                self.assertTrue(changed)
                self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
                self.assertEqual(db_module._read_migration_tree(legacy), legacy_before)

    def test_later_scope_preflight_conflict_creates_no_earlier_target(self):
        with tempfile.TemporaryDirectory() as directory:
            data_dir = Path(directory) / "data"
            database_path, workspace, legacy = create_source_database(data_dir)
            second_workspace = data_dir / "workspaces" / "user-8"
            second_workspace.mkdir(mode=0o700)
            with sqlite3.connect(database_path) as connection:
                connection.execute(
                    "INSERT INTO agent_scopes(scope_key, scope_type, scope_id, "
                    "session_id, lifecycle_id, workspace_path, sandbox_id, "
                    "created_at, updated_at) VALUES "
                    "('private:8', 'private', '8', 'session-8', '', "
                    "'user-8', 'sandbox-8', 1, 1)"
                )
            second_digest = hashlib.sha256(b"private:8").hexdigest()
            shutil.copytree(
                legacy,
                data_dir / "agent-skills" / second_digest,
            )
            conflict = second_workspace / ".agent-platform" / "skills"
            conflict.mkdir(mode=0o700, parents=True)
            conflict.parent.chmod(0o700)
            write_private(conflict / "extra.txt", b"conflict\n")

            with self.assertRaisesRegex(sqlite3.DatabaseError, "differs"):
                migrate_database(database_path, data_dir=data_dir)

            self.assertEqual(marker(database_path), SOURCE_SCHEMA_VERSION)
            self.assertFalse((workspace / ".agent-platform").exists())


if __name__ == "__main__":
    unittest.main()
