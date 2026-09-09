from __future__ import annotations

import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from enterprise_agent_platform import service as service_module
from enterprise_agent_platform.model_catalog import CODEX_MODELS_URL
from enterprise_agent_platform.oauth_flows import (
    CODEX_DEVICE_TOKEN_URL,
    CODEX_DEVICE_USER_CODE_URL,
    CODEX_TOKEN_URL,
    OAuthHTTPResponse,
)
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError
from test_oauth_more import _ScriptedOAuthHTTPClient
from test_platform import RecordingAgent, make_config


class AccountCredentialBoundaryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.client = _ScriptedOAuthHTTPClient({
            CODEX_MODELS_URL: OAuthHTTPResponse(
                200, {"models": [{"slug": "gpt-5.6-sol", "priority": 0}]}
            ),
            CODEX_TOKEN_URL: OAuthHTTPResponse(
                200, {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600}
            ),
            CODEX_DEVICE_USER_CODE_URL: OAuthHTTPResponse(
                200, {"user_code": "SYNTHETIC", "device_auth_id": "synthetic-device", "interval": 1, "expires_in": 900}
            ),
            CODEX_DEVICE_TOKEN_URL: OAuthHTTPResponse(
                200, {"authorization_code": "synthetic-code", "code_verifier": "synthetic-verifier"}
            ),
        })
        self.config = make_config(Path(directory.name))
        self.service = EnterpriseService(
            self.config, agent_client=RecordingAgent(), oauth_http_client=self.client
        )
        self.addCleanup(self.service.close)
        _, self.admin = self.service.authenticate("admin", "admin")

    def _member(self, username="credential-member", password="old-member-password"):
        return self.service.create_user(
            username=username, password=password, actor=self.admin, permission_group="member"
        )

    def test_client_supplied_token_version_does_not_authenticate_an_actor(self):
        forged = dict(self.admin)
        current = self.service.db.query_one(
            "SELECT token_version FROM users WHERE id = ?", (self.admin["id"],)
        )
        forged["token_version"] = current["token_version"]
        target = self._member("forged-actor-target")
        with self.assertRaises(ServiceError) as denied_create:
            self.service.create_user(
                username="forged-admin", password="forged-admin-password",
                actor=forged, permission_group="admin",
            )
        self.assertIn(denied_create.exception.status, (401, 403))
        self.assertIsNone(self.service.db.query_one(
            "SELECT id FROM users WHERE username = ?", ("forged-admin",)
        ))
        with self.assertRaises(ServiceError) as denied_update:
            self.service.update_user(forged, target["id"], {"permission_group": "admin"})
        self.assertIn(denied_update.exception.status, (401, 403))
        self.assertEqual(self.service.get_user(target["id"])["role"], "member")

    def test_demoted_admin_snapshot_cannot_create_admin(self):
        stale = self.admin.copy()
        other = self.service.create_user(
            username="other-admin", password="other-admin-password", actor=self.admin,
            permission_group="admin",
        )
        self.service.update_user(other, stale["id"], {"permission_group": "member"})
        allowed = self.service.create_user(
            username="authorized-admin", password="authorized-password", actor=other,
            permission_group="admin",
        )
        self.assertEqual(allowed["role"], "admin")
        with self.assertRaises(ServiceError) as denied:
            self.service.create_user(
                username="unauthorized-admin", password="unauthorized-password", actor=stale,
                permission_group="admin",
            )
        self.assertIn(denied.exception.status, (401, 403))
        self.assertIsNone(self.service.db.query_one(
            "SELECT id FROM users WHERE username = ?", ("unauthorized-admin",)
        ))

    def test_demoted_admin_snapshot_cannot_restore_own_role(self):
        stale = self.admin.copy()
        other = self.service.create_user(
            username="other-admin", password="other-admin-password", actor=self.admin,
            permission_group="admin",
        )
        self.service.update_user(other, stale["id"], {"permission_group": "member"})
        updated = self.service.update_user(other, stale["id"], {"display_name": "Authorized edit"})
        self.assertEqual(updated["display_name"], "Authorized edit")
        with self.assertRaises(ServiceError) as denied:
            self.service.update_user(stale, stale["id"], {"permission_group": "admin"})
        self.assertIn(denied.exception.status, (401, 403))
        self.assertEqual(self.service.get_user(stale["id"])["role"], "member")

    def test_revoked_admin_session_cannot_commit_after_model_validation(self):
        for operation in ("create", "update"):
            with self.subTest(operation=operation):
                actor = self.service.create_user(
                    username="racing-admin-" + operation, password="racing-admin-password",
                    actor=self.admin, permission_group="admin",
                )
                target = self._member("race-target-" + operation)
                entered, resume = threading.Event(), threading.Event()
                results, errors = [], []
                original = self.service._validate_account_model_name

                def validate(model):
                    result = original(model)
                    if threading.current_thread() is worker:
                        entered.set()
                        if not resume.wait(10):
                            raise AssertionError("model-validation barrier timed out")
                    return result

                def mutate():
                    try:
                        if operation == "create":
                            results.append(self.service.create_user(
                                username="raced-new-admin", password="new-admin-password",
                                actor=actor, permission_group="admin", model_name="",
                            ))
                        else:
                            results.append(self.service.update_user(actor, target["id"], {
                                "model_name": "", "permission_group": "admin",
                                "display_name": "Unauthorized edit",
                            }))
                    except BaseException as exc:
                        errors.append(exc)

                worker = threading.Thread(target=mutate, daemon=True)
                with patch.object(self.service, "_validate_account_model_name", side_effect=validate):
                    worker.start()
                    try:
                        self.assertTrue(entered.wait(5), "mutation did not reach validation boundary")
                        # Reset by another administrator revokes the session without changing
                        # its role, so checking only the latest admin role is insufficient.
                        self.service.update_user(self.admin, actor["id"], {
                            "password": "replacement-admin-password",
                        })
                    finally:
                        resume.set()
                        worker.join(10)
                self.assertFalse(worker.is_alive(), "account mutation worker did not stop")
                self.assertEqual(results, [])
                self.assertEqual(len(errors), 1)
                self.assertIsInstance(errors[0], ServiceError)
                self.assertIn(errors[0].status, (401, 403))
                if operation == "create":
                    self.assertIsNone(self.service.db.query_one(
                        "SELECT id FROM users WHERE username = ?", ("raced-new-admin",)
                    ))
                else:
                    unchanged = self.service.get_user(target["id"])
                    self.assertEqual(unchanged["role"], "member")
                    self.assertEqual(unchanged["display_name"], target["display_name"])

    def test_admin_reset_wins_over_already_verified_self_password_change(self):
        member = self._member()
        _, actor = self.service.authenticate("credential-member", "old-member-password")
        verified = threading.Event()
        resume = threading.Event()
        results, errors = [], []
        original = service_module.verify_password

        def verify(password, encoded):
            valid = original(password, encoded)
            if threading.current_thread() is worker and valid:
                verified.set()
                if not resume.wait(10):
                    raise AssertionError("password-change barrier timed out")
            return valid

        def change():
            try:
                results.append(self.service.change_current_user_password(actor, {
                    "current_password": "old-member-password", "new_password": "stale-self-password"
                }))
            except BaseException as exc:
                errors.append(exc)

        worker = threading.Thread(target=change, daemon=True)
        with patch.object(service_module, "verify_password", side_effect=verify):
            worker.start()
            try:
                self.assertTrue(verified.wait(5), "old password was not verified")
                self.service.update_user(self.admin, member["id"], {"password": "admin-reset-password"})
                reset_token, _ = self.service.authenticate("credential-member", "admin-reset-password")
            finally:
                resume.set()
                worker.join(10)
        self.assertFalse(worker.is_alive(), "password worker did not stop")
        with self.subTest(contract="reset password remains usable"):
            self.assertEqual(self.service.authenticate("credential-member", "admin-reset-password")[1]["id"], member["id"])
        with self.subTest(contract="reset session remains usable"):
            self.assertIsNotNone(self.service.user_from_token(reset_token))
        with self.subTest(contract="stale request cannot issue a usable session"):
            for token, _ in results:
                self.assertIsNone(self.service.user_from_token(token))
        with self.subTest(contract="stale request is rejected"):
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], ServiceError)
            self.assertIn(errors[0].status, (400, 401, 403, 409))

    def test_password_write_boundaries_match_authentication(self):
        for entry in ("create", "reset", "self"):
            with self.subTest(entry=entry):
                member = self._member(username="boundary-" + entry)
                old_token, _ = self.service.authenticate(member["username"], "old-member-password")
                if entry == "create":
                    write_password = lambda value: self._member("created-boundary", value)
                    login_name = "created-boundary"
                elif entry == "reset":
                    write_password = lambda value: self.service.update_user(self.admin, member["id"], {"password": value})
                    login_name = "boundary-reset"
                else:
                    write_password = lambda value: self.service.change_current_user_password(member, {
                        "current_password": "old-member-password", "new_password": value
                    })
                    login_name = "boundary-self"
                with self.subTest(contract="reject 1025 characters"):
                    with self.assertRaises(ServiceError) as denied:
                        write_password("x" * 1025)
                    self.assertEqual(denied.exception.status, 400)
                    if entry == "create":
                        self.assertIsNone(self.service.db.query_one(
                            "SELECT id FROM users WHERE username = ?", ("created-boundary",)
                        ))
                    else:
                        self.assertEqual(
                            self.service.authenticate(member["username"], "old-member-password")[1]["id"],
                            member["id"],
                        )
                        self.assertIsNotNone(self.service.user_from_token(old_token))
                with self.subTest(contract="1024 characters authenticate"):
                    if entry == "create":
                        self._member("legal-created-boundary", "x" * 1024)
                        login_name = "legal-created-boundary"
                    elif entry == "self":
                        legal_member = self._member("legal-self-boundary")
                        login_name = "legal-self-boundary"
                        self.service.change_current_user_password(legal_member, {
                            "current_password": "old-member-password", "new_password": "x" * 1024
                        })
                    else:
                        write_password("x" * 1024)
                    self.assertEqual(self.service.authenticate(login_name, "x" * 1024)[1]["username"], login_name)

    def test_http_login_accepts_legal_password_in_utf8_and_json_escape_encodings(self):
        # Astral characters require four UTF-8 bytes or twelve JSON escape bytes each.
        password = "\U0001f9ea" * 1024
        self._member(password=password)
        self.assertEqual(self.service.authenticate("credential-member", password)[1]["username"], "credential-member")
        server, thread = serve_in_thread(self.config, self.service)
        host, port = server.server_address
        try:
            for ensure_ascii in (False, True):
                with self.subTest(ensure_ascii=ensure_ascii):
                    connection = http.client.HTTPConnection(host, port, timeout=5)
                    try:
                        connection.request("POST", "/api/auth/login", body=json.dumps({
                            "username": "credential-member", "password": password
                        }, ensure_ascii=ensure_ascii).encode("utf-8"), headers={
                            "Content-Type": "application/json", "Origin": f"http://{host}:{port}"
                        })
                        response = connection.getresponse()
                        payload = json.loads(response.read())
                        self.assertEqual(response.status, 200, payload)
                        self.assertEqual(payload["user"]["username"], "credential-member")
                        self.assertNotIn("token_version", payload["user"])
                    finally:
                        connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)

    def _seed_oauth(self, access="old-access", refresh="old-refresh", expiry="1"):
        self.service.set_setting("CODEX_OAUTH_ACCESS_TOKEN", access, secret=True)
        self.service.set_setting("CODEX_OAUTH_REFRESH_TOKEN", refresh, secret=True)
        self.service.set_setting("CODEX_OAUTH_EXPIRES_AT", expiry)

    def _read_oauth(self):
        # Independent SQLite connection proves committed state, not a thread-local cache.
        with sqlite3.connect(self.config.db_path) as reader:
            rows = dict(reader.execute("SELECT key, value FROM settings WHERE key IN (?, ?, ?)", (
                "CODEX_OAUTH_ACCESS_TOKEN", "CODEX_OAUTH_REFRESH_TOKEN", "CODEX_OAUTH_EXPIRES_AT"
            )))
        return tuple(rows[key] for key in (
            "CODEX_OAUTH_ACCESS_TOKEN", "CODEX_OAUTH_REFRESH_TOKEN", "CODEX_OAUTH_EXPIRES_AT"
        ))

    def test_oauth_consumers_do_not_commit_partial_credential_groups(self):
        for consumer in ("import", "refresh", "flow"):
            with self.subTest(consumer=consumer):
                self._seed_oauth()
                old = self._read_oauth()
                # Fail the actual second credential INSERT/upsert, including transaction-based implementations.
                self.service.db.execute("""
                    CREATE TRIGGER reject_credential_refresh BEFORE INSERT ON settings
                    WHEN NEW.key = 'CODEX_OAUTH_REFRESH_TOKEN' AND NEW.value = 'new-refresh'
                    BEGIN SELECT RAISE(ABORT, 'injected credential SQL failure'); END
                """)
                try:
                    with self.assertRaises(sqlite3.DatabaseError):
                        if consumer == "import":
                            self.service.import_oauth_credentials(self.admin, {
                                "CODEX_OAUTH_ACCESS_TOKEN": "new-access",
                                "CODEX_OAUTH_REFRESH_TOKEN": "new-refresh",
                                "CODEX_OAUTH_EXPIRES_AT": "4102444800",
                            })
                        elif consumer == "refresh":
                            self.service.resolve_agent_credentials({
                                "provider": "openai-codex", "model": "gpt-5.6-sol", "scope_key": "private:1"
                            })
                        else:
                            flow = self.service.oauth_flows.start("openai-codex")
                            self.service.poll_oauth_verification(self.admin, "openai-codex", {"flow_id": flow["flow_id"]})
                    self.assertEqual(self._read_oauth(), old, "failed credential group was partially committed")
                finally:
                    self.service.db.execute("DROP TRIGGER reject_credential_refresh")

    def test_token_and_model_catalog_cannot_come_from_different_accounts(self):
        self._seed_oauth("account-a-access", "account-a-refresh", "4102444800")
        self.client.responses[CODEX_MODELS_URL] = OAuthHTTPResponse(
            200, {"models": [{"slug": "gpt-5.4", "priority": 0}]}
        )
        self.assertEqual(self.service._oauth_model_catalog("openai-codex")["models"], ["gpt-5.4"])
        entered, resume = threading.Event(), threading.Event()
        original = self.service._oauth_model_catalog
        results, errors = [], []

        def catalog(provider):
            # Pause before entering catalog single-flight, with no auth or catalog lock held.
            if threading.current_thread() is worker and not entered.is_set():
                entered.set()
                if not resume.wait(10):
                    raise AssertionError("catalog barrier timed out")
            return original(provider)

        def resolve():
            try:
                results.append(self.service.resolve_agent_credentials({
                    "provider": "openai-codex", "model": "gpt-5.6-sol", "scope_key": "private:1"
                }))
            except BaseException as exc:
                errors.append(exc)

        worker = threading.Thread(target=resolve, daemon=True)
        with patch.object(self.service, "_oauth_model_catalog", side_effect=catalog):
            worker.start()
            try:
                self.assertTrue(entered.wait(5), "credential request did not reach catalog boundary")
                self._seed_oauth("account-b-access", "account-b-refresh", "4102444800")
                self.client.responses[CODEX_MODELS_URL] = OAuthHTTPResponse(
                    200, {"models": [{"slug": "gpt-5.6-sol", "priority": 0}]}
                )
                self.service.model_catalogs.invalidate_oauth("openai-codex")
                self.assertEqual(original("openai-codex")["models"], ["gpt-5.6-sol"])
            finally:
                resume.set()
                worker.join(10)
        self.assertFalse(worker.is_alive(), "credential worker did not stop")
        self.assertEqual(len(results) + len(errors), 1)
        for error in errors:
            self.assertIsInstance(error, ServiceError)
            self.assertIn(error.status, (409, 503))
        for result in results:
            self.assertEqual(result["access_token"], "account-b-access", "account A token was authorized using account B model catalog")
            self.assertEqual(result["model"], "gpt-5.6-sol")

    def test_restored_token_cannot_authorize_model_from_intervening_account(self):
        provider = "openai-codex"
        account_a_models = OAuthHTTPResponse(
            200, {"models": [{"slug": "gpt-5.4", "priority": 0}]}
        )
        self._seed_oauth("account-a-access", "account-a-refresh", "4102444800")
        self.client.responses[CODEX_MODELS_URL] = account_a_models
        original = self.service._oauth_model_catalog
        self.assertEqual(original(provider)["models"], ["gpt-5.4"])
        entered, fetch_catalog = threading.Event(), threading.Event()
        fetched, return_catalog = threading.Event(), threading.Event()
        results, errors, fetched_models = [], [], []

        def catalog(requested_provider):
            if threading.current_thread() is worker and not entered.is_set():
                # Neither barrier holds an auth/catalog lock: account switches
                # complete before the in-flight request resumes.
                entered.set()
                if not fetch_catalog.wait(10):
                    raise AssertionError("catalog entry barrier timed out")
                snapshot = original(requested_provider)
                fetched_models.append(list(snapshot["models"]))
                fetched.set()
                if not return_catalog.wait(10):
                    raise AssertionError("catalog return barrier timed out")
                return snapshot
            return original(requested_provider)

        def resolve():
            try:
                results.append(self.service.resolve_agent_credentials({
                    "provider": provider, "model": "gpt-5.6-sol", "scope_key": "private:1",
                }))
            except BaseException as exc:
                errors.append(exc)

        worker = threading.Thread(target=resolve, daemon=True)
        with patch.object(self.service, "_oauth_model_catalog", side_effect=catalog):
            worker.start()
            try:
                self.assertTrue(entered.wait(5), "request did not reach catalog entry")
                self._seed_oauth("account-b-access", "account-b-refresh", "4102444800")
                self.client.responses[CODEX_MODELS_URL] = OAuthHTTPResponse(
                    200, {"models": [{"slug": "gpt-5.6-sol", "priority": 0}]}
                )
                self.service.model_catalogs.invalidate_oauth(provider)
                fetch_catalog.set()
                self.assertTrue(fetched.wait(5), "request did not fetch account B catalog")
                self.assertEqual(fetched_models, [["gpt-5.6-sol"]])
                # Restore the exact original token contents while the request
                # still owns B's model snapshot: value equality misses this ABA.
                self._seed_oauth("account-a-access", "account-a-refresh", "4102444800")
                self.client.responses[CODEX_MODELS_URL] = account_a_models
                self.service.model_catalogs.invalidate_oauth(provider)
                return_catalog.set()
            finally:
                fetch_catalog.set()
                return_catalog.set()
                worker.join(10)
        self.assertFalse(worker.is_alive(), "credential worker did not stop")
        self.assertEqual(results, [], "restored account A authorized an account B-only model")
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ServiceError)
        self.assertIn(errors[0].status, (409, 503))


if __name__ == "__main__":
    unittest.main()
