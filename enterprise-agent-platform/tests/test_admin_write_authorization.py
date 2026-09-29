from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.service import EnterpriseService, ServiceError
from test_platform import RecordingAgent, make_config


class AdminWriteAuthorizationTests(unittest.TestCase):
    def test_revoked_or_demoted_admin_cannot_mutate_other_admin_surfaces(self):
        for invalidation in ("demote", "revoke"):
            for surface in ("security", "telegram", "runtime", "branding", "impersonate"):
                with self.subTest(invalidation=invalidation, surface=surface):
                    with tempfile.TemporaryDirectory() as directory:
                        service = EnterpriseService(make_config(Path(directory)), agent_client=RecordingAgent())
                        try:
                            _, actor = service.authenticate("admin", "admin")
                            other = service.create_user(
                                username="other-admin", password="other-admin-password",
                                permission_group="admin", actor=actor,
                            )
                            target = service.create_user(
                                username="member", password="member-password", actor=actor,
                            )
                            stale = actor.copy()
                            if invalidation == "demote":
                                service.update_user(other, actor["id"], {"permission_group": "member"})
                            else:
                                service.revoke_user_sessions(actor["id"])
                            before = service.db.query("SELECT * FROM settings ORDER BY key")
                            target_before = service.db.query_one("SELECT * FROM users WHERE id = ?", (target["id"],))
                            actions = {
                                "security": lambda: service.update_platform_security_config(
                                    stale, {"session_secret": "replacement-session-secret-" * 3},
                                ),
                                "telegram": lambda: service.update_telegram_admin_config(
                                    stale, {"bot_username": "changed_bot", "enabled": False},
                                ),
                                "runtime": lambda: service.update_agent_runtime_config(
                                    stale, {"max_concurrency": 3},
                                ),
                                "branding": lambda: service.update_branding_config(stale, {
                                    "expected_revision": service.branding_public_config()["revision"],
                                    "product_name": "Unauthorized Product", "agent_name": "Unauthorized Agent",
                                    "primary_color": "#123456",
                                }),
                                "impersonate": lambda: service.impersonate_user(stale, target["id"]),
                            }
                            result = None
                            error = None
                            try:
                                result = actions[surface]()
                            except ServiceError as exc:
                                error = exc
                            with self.subTest(contract="no persistent mutation"):
                                self.assertEqual(service.db.query("SELECT * FROM settings ORDER BY key"), before)
                                self.assertEqual(service.db.query_one("SELECT * FROM users WHERE id = ?", (target["id"],)), target_before)
                            with self.subTest(contract="no impersonation capability"):
                                if surface == "impersonate" and result is not None:
                                    self.assertIsNone(service.user_from_token(result[0]))
                            with self.subTest(contract="stale admin rejected"):
                                self.assertIsNotNone(error)
                                if error is not None:
                                    self.assertIn(error.status, (401, 403))
                        finally:
                            service.close()

    def test_revoked_session_cannot_access_private_mail_accounts(self):
        with tempfile.TemporaryDirectory() as directory:
            service = EnterpriseService(make_config(Path(directory)), agent_client=RecordingAgent())
            try:
                _, actor = service.authenticate("admin", "admin")
                service.revoke_user_sessions(actor["id"])
                actions = {
                    "list": lambda: service.list_private_mail_accounts(actor),
                    "get": lambda: service.get_private_mail_account(actor, 1),
                    "create": lambda: service.create_private_mail_account(actor, {}),
                    "update": lambda: service.update_private_mail_account(actor, 1, {}),
                    "delete": lambda: service.delete_private_mail_account(actor, 1),
                    "test": lambda: service.test_private_mail_account(actor, 1),
                    "check": lambda: service.check_private_mail_account(actor, 1),
                }
                for name, action in actions.items():
                    with self.subTest(operation=name):
                        with self.assertRaises(ServiceError) as rejected:
                            action()
                        self.assertEqual(rejected.exception.status, 401)
            finally:
                service.close()
