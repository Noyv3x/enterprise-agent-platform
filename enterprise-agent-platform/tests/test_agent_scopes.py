from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.db import Database

from test_platform import make_config


class AgentScopeSessionTests(unittest.TestCase):
    def test_session_updates_are_scoped_and_recorded_for_current_lifecycle(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                db.execute(
                    """
                    INSERT INTO users(
                        id, username, display_name, password_hash, role,
                        permission_group, created_at
                    ) VALUES (1, 'one', 'One', 'hash', 'member', 'member', 1)
                    """
                )
                manager = AgentScopeManager(config, db)
                private = manager.ensure_private_scope(1)
                channel = manager.ensure_channel_scope("7")

                self.assertEqual(private.session_id, "ubitech-private-u1")
                self.assertEqual(channel.session_id, "ubitech-channel-7-main-agent")

                manager.update_session_id(private.scope_key, "private-compacted")
                manager.update_session_id(channel.scope_key, "channel-compacted")

                updated_private = manager.get_scope(private.scope_key)
                updated_channel = manager.get_scope(channel.scope_key)
                self.assertEqual(updated_private.session_id, "private-compacted")
                self.assertEqual(updated_channel.session_id, "channel-compacted")
                self.assertTrue(
                    manager.session_belongs_to_current_lifecycle(
                        private.scope_key,
                        "private-compacted",
                    )
                )
                self.assertTrue(
                    manager.session_belongs_to_current_lifecycle(
                        channel.scope_key,
                        "channel-compacted",
                    )
                )
                self.assertFalse(
                    manager.session_belongs_to_current_lifecycle(
                        private.scope_key,
                        "channel-compacted",
                    )
                )
            finally:
                db.close()

    def test_runtime_session_migration_and_rotation_preserve_legacy_rollback_state(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            db = Database(config.db_path)
            try:
                db.execute(
                    """
                    INSERT INTO users(
                        id, username, display_name, password_hash, role,
                        permission_group, created_at
                    ) VALUES (1, 'legacy', 'Legacy User', 'hash', 'member', 'member', 1)
                    """
                )
                db.execute(
                    """
                    INSERT INTO private_agents(
                        user_id, session_id, workspace_path, created_at, updated_at
                    ) VALUES (1, 'legacy-private-session', ?, 1, 2)
                    """,
                    (str(config.workspace_dir / "user-1"),),
                )
                db.execute(
                    """
                    INSERT INTO agent_scopes(
                        scope_key, scope_type, scope_id, session_id, lifecycle_id,
                        workspace_path, execution_backend, created_at, updated_at
                    ) VALUES (
                        'private:1', 'private', '1', 'legacy-scope-session',
                        'legacy-lifecycle', ?, 'host', 1, 2
                    )
                    """,
                    (str(config.workspace_dir / "user-1"),),
                )
                db.execute(
                    """
                    INSERT INTO agent_scope_sessions(
                        scope_key, lifecycle_id, session_id, created_at
                    ) VALUES ('private:1', 'legacy-lifecycle', 'legacy-history-session', 1)
                    """
                )
                legacy_scope = db.query_one(
                    "SELECT session_id, lifecycle_id FROM agent_scopes WHERE scope_key = 'private:1'"
                )
                legacy_history = db.query(
                    """
                    SELECT lifecycle_id, session_id, created_at
                    FROM agent_scope_sessions WHERE scope_key = 'private:1'
                    ORDER BY created_at, session_id
                    """
                )
                legacy_private = db.query_one(
                    "SELECT session_id FROM private_agents WHERE user_id = 1"
                )
            finally:
                db.close()

            migrated = Database(config.db_path)
            try:
                self.assertEqual(
                    migrated.query_one(
                        "SELECT session_id, lifecycle_id FROM agent_scopes WHERE scope_key = 'private:1'"
                    ),
                    legacy_scope,
                )
                self.assertEqual(
                    migrated.query(
                        """
                        SELECT lifecycle_id, session_id, created_at
                        FROM agent_scope_sessions WHERE scope_key = 'private:1'
                        ORDER BY created_at, session_id
                        """
                    ),
                    legacy_history,
                )
                self.assertEqual(
                    migrated.query_one("SELECT session_id FROM private_agents WHERE user_id = 1"),
                    legacy_private,
                )

                manager = AgentScopeManager(config, migrated)
                initial = manager.ensure_private_scope(1)
                self.assertNotEqual(initial.session_id, legacy_scope["session_id"])
                self.assertNotEqual(initial.lifecycle_id, legacy_scope["lifecycle_id"])
                self.assertEqual(
                    migrated.query_one(
                        "SELECT session_id, lifecycle_id FROM agent_runtime_scopes WHERE scope_key = 'private:1'"
                    ),
                    {"session_id": initial.session_id, "lifecycle_id": initial.lifecycle_id},
                )

                manager.update_session_id("private:1", "runtime-compacted-session")
                compacted = manager.get_scope("private:1")
                self.assertEqual(compacted.session_id, "runtime-compacted-session")
                self.assertEqual(compacted.lifecycle_id, initial.lifecycle_id)

                rotated = manager.rotate_session("private:1")
                self.assertNotEqual(rotated.session_id, compacted.session_id)
                self.assertNotEqual(rotated.lifecycle_id, compacted.lifecycle_id)
                self.assertEqual(
                    migrated.query(
                        """
                        SELECT lifecycle_id, session_id
                        FROM agent_runtime_scope_sessions WHERE scope_key = 'private:1'
                        """
                    ),
                    [{"lifecycle_id": rotated.lifecycle_id, "session_id": rotated.session_id}],
                )

                self.assertEqual(
                    migrated.query_one(
                        "SELECT session_id, lifecycle_id FROM agent_scopes WHERE scope_key = 'private:1'"
                    ),
                    legacy_scope,
                )
                self.assertEqual(
                    migrated.query(
                        """
                        SELECT lifecycle_id, session_id, created_at
                        FROM agent_scope_sessions WHERE scope_key = 'private:1'
                        ORDER BY created_at, session_id
                        """
                    ),
                    legacy_history,
                )
                self.assertEqual(
                    migrated.query_one("SELECT session_id FROM private_agents WHERE user_id = 1"),
                    legacy_private,
                )
            finally:
                migrated.close()


if __name__ == "__main__":
    unittest.main()
