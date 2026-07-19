from __future__ import annotations

import gzip
import http.client
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import enterprise_agent_platform.server as server_module
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, UploadedFile

from test_platform import RecordingAgent, make_config


class BackendPerformanceServiceTests(unittest.TestCase):
    def test_message_delta_batches_attachments_and_hide_forces_full_sync(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)), agent_client=RecordingAgent()
            )
            try:
                _, actor = service.authenticate("admin", "admin")
                first = service.send_channel_message(actor, 1, "first")[
                    "user_message"
                ]
                first_sync = service.message_sync(actor, "channel", "1")
                second = service.send_channel_message(
                    actor,
                    1,
                    "second",
                )["user_message"]
                delta = service.message_sync(
                    actor,
                    "channel",
                    "1",
                    after_id=int(first["id"]),
                    since_revision=int(first_sync["message_revision"]),
                )
                self.assertEqual(delta["mode"], "delta")
                self.assertEqual(
                    [message["id"] for message in delta["messages"]],
                    [second["id"]],
                )
                self.assertEqual(delta["next_after_id"], second["id"])

                third = service.send_channel_message(
                    actor,
                    1,
                    "third",
                    [UploadedFile("note.txt", "text/plain", b"note")],
                )["user_message"]

                original_query = service.db.query
                attachment_queries: list[str] = []

                def counting_query(sql, params=()):
                    if "FROM attachments" in sql:
                        attachment_queries.append(sql)
                    return original_query(sql, params)

                with mock.patch.object(
                    service.db, "query", side_effect=counting_query
                ):
                    attachment_sync = service.message_sync(
                        actor,
                        "channel",
                        "1",
                        after_id=int(second["id"]),
                        since_revision=int(delta["message_revision"]),
                    )

                # The message row is visible before its attachment transaction
                # completes. Finalizing metadata advances a reset revision so a
                # client that observed that intermediate row is forced through
                # a complete, attachment-consistent window.
                self.assertEqual(attachment_sync["mode"], "full")
                self.assertEqual(
                    [message["id"] for message in attachment_sync["messages"]],
                    [first["id"], second["id"], third["id"]],
                )
                self.assertEqual(
                    attachment_sync["messages"][-1]["attachments"][0]["filename"],
                    "note.txt",
                )
                self.assertEqual(len(attachment_queries), 1)

                service.delete_channel_message(
                    actor, 1, int(third["id"])
                )
                reset = service.message_sync(
                    actor,
                    "channel",
                    "1",
                    after_id=int(third["id"]),
                    since_revision=int(attachment_sync["message_revision"]),
                )
                self.assertEqual(reset["mode"], "full")
                self.assertGreaterEqual(
                    int(reset["reset_revision"]),
                    int(reset["message_revision"]),
                )
                self.assertEqual(
                    [message["id"] for message in reset["messages"]],
                    [first["id"], second["id"]],
                )
            finally:
                service.close()

    def test_session_lookup_reads_users_once_and_bootstrap_has_shell_schema(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)), agent_client=RecordingAgent()
            )
            try:
                token, actor = service.authenticate("admin", "admin")
                original_query_one = service.db.query_one
                user_queries = 0

                def counting_query_one(sql, params=()):
                    nonlocal user_queries
                    if "FROM users WHERE id = ?" in sql:
                        user_queries += 1
                    return original_query_one(sql, params)

                with mock.patch.object(
                    service.db, "query_one", side_effect=counting_query_one
                ):
                    resolved = service.user_from_token(token)
                self.assertEqual(resolved["id"], actor["id"])
                self.assertEqual(user_queries, 1)

                bootstrap = service.session_bootstrap(actor)
                self.assertEqual(
                    {
                        "user",
                        "channels",
                        "mention_targets",
                        "active_scope",
                        "messages",
                        "agent_status",
                        "typing",
                        "message_revision",
                        "next_after_id",
                    },
                    set(bootstrap),
                )
                self.assertEqual(
                    bootstrap["active_scope"],
                    {"scope_type": "channel", "scope_id": "1"},
                )
            finally:
                service.close()

    def test_schedule_list_batches_latest_runs(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)), agent_client=RecordingAgent()
            )
            try:
                _, actor = service.authenticate("admin", "admin")
                rows = [
                    {
                        "id": schedule_id,
                        "name": f"schedule-{schedule_id}",
                        "prompt": "check",
                        "timezone": "UTC",
                        "delivery": "chat",
                        "state": "active",
                        "enabled": 1,
                        "next_run_at": None,
                        "created_at": 1,
                        "updated_at": 1,
                    }
                    for schedule_id in (1, 2)
                ]
                latest_rows = [
                    {
                        "id": 10,
                        "schedule_id": 1,
                        "scheduled_for": 1,
                        "status": "succeeded",
                        "source_message_id": None,
                        "response_message_id": None,
                        "started_at": 1,
                        "finished_at": 1,
                        "error": "",
                    }
                ]
                with (
                    mock.patch.object(
                        service.schedules, "list", return_value=rows
                    ),
                    mock.patch.object(
                        service.schedules,
                        "decoded_schedule",
                        return_value={"kind": "interval", "seconds": 60},
                    ),
                    mock.patch.object(
                        service.schedules, "latest_run"
                    ) as latest_run,
                    mock.patch.object(
                        service.db, "query", return_value=latest_rows
                    ) as batch_query,
                ):
                    result = service.list_private_schedules(actor)

                self.assertEqual(len(result["schedules"]), 2)
                self.assertEqual(
                    result["schedules"][0]["last_run"]["id"], 10
                )
                self.assertIsNone(result["schedules"][1]["last_run"])
                latest_run.assert_not_called()
                batch_query.assert_called_once()
            finally:
                service.close()


class BackendPerformanceHTTPTests(unittest.TestCase):
    def test_login_embeds_bootstrap_and_large_json_uses_gzip(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                connection = http.client.HTTPConnection(host, port, timeout=5)
                connection.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps(
                        {"username": "admin", "password": "admin"}
                    ),
                    headers={
                        "Accept-Encoding": "gzip",
                        "Content-Type": "application/json",
                        "Origin": origin,
                    },
                )
                response = connection.getresponse()
                compressed = response.read()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Content-Encoding"), "gzip")
                self.assertEqual(response.getheader("Vary"), "Accept-Encoding")
                self.assertTrue(
                    response.getheader("Server-Timing").startswith("app;dur=")
                )
                payload = json.loads(gzip.decompress(compressed))
                self.assertEqual(payload["user"]["username"], "admin")
                self.assertEqual(
                    payload["bootstrap"]["active_scope"]["scope_type"],
                    "channel",
                )
                self.assertIn("message_revision", payload["bootstrap"])
                cookie = response.getheader("Set-Cookie")

                export = http.client.HTTPConnection(host, port, timeout=5)
                export.request(
                    "GET",
                    "/api/system/oauth/credentials/export",
                    headers={
                        "Accept-Encoding": "gzip",
                        "Cookie": cookie,
                    },
                )
                exported = export.getresponse()
                exported.read()
                self.assertEqual(exported.status, 200)
                self.assertIsNone(exported.getheader("Content-Encoding"))
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_static_prefers_precompressed_variant_and_supports_etag(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            package = root / "package"
            static = package / "static"
            static.mkdir(parents=True)
            fake_server_file = package / "server.py"
            fake_server_file.write_text("", encoding="utf-8")
            source = b"const payload = '" + (b"x" * 2048) + b"';"
            compressed = b"prebuilt-brotli-variant"
            (static / "app-abcdefgh.js").write_bytes(source)
            (static / "app-abcdefgh.js.br").write_bytes(compressed)
            (static / "index.html").write_text("index", encoding="utf-8")

            config = make_config(root / "data")
            service = EnterpriseService(config, agent_client=RecordingAgent())
            with mock.patch.object(
                server_module, "__file__", str(fake_server_file)
            ):
                server, thread = serve_in_thread(config, service)
                host, port = server.server_address
                try:
                    connection = http.client.HTTPConnection(
                        host, port, timeout=5
                    )
                    connection.request(
                        "GET",
                        "/app-abcdefgh.js",
                        headers={"Accept-Encoding": "br, gzip"},
                    )
                    response = connection.getresponse()
                    self.assertEqual(response.read(), compressed)
                    self.assertEqual(response.status, 200)
                    self.assertEqual(
                        response.getheader("Content-Encoding"), "br"
                    )
                    self.assertEqual(
                        response.getheader("Vary"), "Accept-Encoding"
                    )
                    self.assertIn("immutable", response.getheader("Cache-Control"))
                    etag = response.getheader("ETag")

                    conditional = http.client.HTTPConnection(
                        host, port, timeout=5
                    )
                    conditional.request(
                        "GET",
                        "/app-abcdefgh.js",
                        headers={
                            "Accept-Encoding": "br",
                            "If-None-Match": etag,
                        },
                    )
                    unchanged = conditional.getresponse()
                    self.assertEqual(unchanged.status, 304)
                    self.assertEqual(unchanged.read(), b"")
                    self.assertEqual(unchanged.getheader("ETag"), etag)
                finally:
                    server.shutdown()
                    server.server_close()
                    service.close()
                    thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
