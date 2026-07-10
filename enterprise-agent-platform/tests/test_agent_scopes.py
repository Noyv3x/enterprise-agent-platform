from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.db import Database

from test_platform import make_config


class AgentScopeCompatibilityTests(unittest.TestCase):
    def test_session_updates_dual_write_legacy_rollback_state(self):
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
                manager.update_session_id(private.scope_key, "private-compressed")
                private_legacy = db.query_one("SELECT session_id FROM private_agents WHERE user_id = 1")
                self.assertEqual(private_legacy["session_id"], "private-compressed")

                channel = manager.ensure_channel_scope("7")
                manager.update_session_id(channel.scope_key, "channel-compressed")
                setting = db.query_one(
                    "SELECT value FROM settings WHERE key = 'hermes_session:channel:7:main-agent'"
                )
                self.assertEqual(setting["value"], "channel-compressed")
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
