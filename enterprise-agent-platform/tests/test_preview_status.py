from __future__ import annotations

import http.client
import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService

from test_platform import RecordingAgent, make_config


class StatusAgent(RecordingAgent):
    def __init__(self) -> None:
        super().__init__()
        self.running_terminal_count = 0
        self.summary_calls: list[tuple[str, str]] = []

    def terminal_preview_summary(self, scope_key: str, lifecycle_id: str) -> dict:
        self.summary_calls.append((scope_key, lifecycle_id))
        return {"running_terminal_count": self.running_terminal_count}

    def terminal_previews(self, _scope_key: str, _lifecycle_id: str) -> dict:
        raise AssertionError("status polling must not transfer terminal output")


class PreviewStatusServiceTests(unittest.TestCase):
    def test_uninitialized_scope_is_inactive_without_starting_any_runtime(self):
        with tempfile.TemporaryDirectory() as td:
            agent = StatusAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _token, actor = service.authenticate("admin", "admin")
                access_key_path = service.config.runtime_dir / "camofox" / "access-key"
                with (
                    mock.patch.object(service.agent_scopes, "ensure_private_scope") as ensure_scope,
                    mock.patch.object(service.runtimes, "ensure_camofox_ready") as ensure_browser,
                    mock.patch.object(service.runtimes, "_camofox_access_key") as create_access_key,
                    mock.patch.object(service, "_runtime_json_request") as runtime_json,
                    mock.patch.object(service, "_runtime_binary_request") as runtime_binary,
                ):
                    status = service.agent_preview_status(
                        actor,
                        "private",
                        str(actor["id"]),
                    )

                self.assertEqual(
                    status,
                    {"browser_active": False, "running_terminal_count": 0},
                )
                self.assertFalse(access_key_path.exists())
                self.assertEqual(agent.summary_calls, [])
                ensure_scope.assert_not_called()
                ensure_browser.assert_not_called()
                create_access_key.assert_not_called()
                runtime_json.assert_not_called()
                runtime_binary.assert_not_called()
            finally:
                service.close()

    def test_live_browser_status_lists_tabs_without_capturing_a_frame(self):
        with tempfile.TemporaryDirectory() as td:
            agent = StatusAgent()
            agent.running_terminal_count = 3
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _token, actor = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(actor["id"]))
                listed = mock.Mock(
                    return_value={
                        "tabs": [
                            {
                                "tabId": "tab-live",
                                "title": "Live tab",
                                "url": "https://example.test/private?secret=hidden",
                            }
                        ]
                    }
                )
                with (
                    mock.patch.object(
                        service,
                        "_browser_preview_existing_access_key",
                        return_value="x" * 32,
                    ),
                    mock.patch.object(service, "_runtime_json_request", listed),
                    mock.patch.object(service, "_runtime_binary_request") as capture,
                    mock.patch.object(service.runtimes, "ensure_camofox_ready") as ensure_browser,
                    mock.patch.object(service.runtimes, "_camofox_access_key") as create_access_key,
                ):
                    status = service.agent_preview_status(
                        actor,
                        "private",
                        str(actor["id"]),
                    )

                self.assertEqual(
                    status,
                    {"browser_active": True, "running_terminal_count": 3},
                )
                self.assertEqual(agent.summary_calls, [(scope.scope_key, scope.lifecycle_id)])
                self.assertEqual(listed.call_count, 1)
                request_url = urllib.parse.urlparse(listed.call_args.args[0])
                self.assertEqual(request_url.path, "/tabs")
                self.assertEqual(listed.call_args.kwargs["method"], "GET")
                capture.assert_not_called()
                ensure_browser.assert_not_called()
                create_access_key.assert_not_called()
            finally:
                service.close()

    def test_initialized_scope_with_no_open_tab_is_browser_inactive(self):
        with tempfile.TemporaryDirectory() as td:
            agent = StatusAgent()
            agent.running_terminal_count = 1
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _token, actor = service.authenticate("admin", "admin")
                service.agent_scopes.ensure_private_scope(int(actor["id"]))
                with (
                    mock.patch.object(
                        service,
                        "_browser_preview_existing_access_key",
                        return_value="x" * 32,
                    ),
                    mock.patch.object(
                        service,
                        "_runtime_json_request",
                        return_value={"tabs": []},
                    ),
                    mock.patch.object(service, "_runtime_binary_request") as capture,
                ):
                    status = service.agent_preview_status(
                        actor,
                        "private",
                        str(actor["id"]),
                    )

                self.assertEqual(
                    status,
                    {"browser_active": False, "running_terminal_count": 1},
                )
                capture.assert_not_called()
            finally:
                service.close()


class PreviewStatusHTTPTests(unittest.TestCase):
    def test_status_is_authenticated_query_strict_and_conditionally_cacheable(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=StatusAgent())
            service.agent_preview_status = mock.Mock(
                return_value={
                    "browser_active": True,
                    "running_terminal_count": 2,
                }
            )
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            connection = http.client.HTTPConnection(host, port, timeout=5)
            try:
                token, actor = service.authenticate("admin", "admin")
                path = (
                    "/api/agent-previews/status?scope_type=private&scope_id="
                    + str(actor["id"])
                )

                connection.request("GET", path)
                unauthorized = connection.getresponse()
                unauthorized.read()
                self.assertEqual(unauthorized.status, 401)

                headers = {"Authorization": f"Bearer {token}"}
                for invalid_path in (
                    path + "&unexpected=1",
                    path + "&scope_id=" + str(actor["id"]),
                    "/api/agent-previews/status?scope_type=private",
                ):
                    connection.request("GET", invalid_path, headers=headers)
                    invalid = connection.getresponse()
                    invalid.read()
                    self.assertEqual(invalid.status, 400)

                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                body = json.loads(response.read().decode("utf-8"))
                etag = response.getheader("ETag")
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    body,
                    {"browser_active": True, "running_terminal_count": 2},
                )
                self.assertTrue(etag)
                self.assertEqual(
                    response.getheader("Cache-Control"),
                    "private, no-cache, max-age=0",
                )
                self.assertEqual(
                    response.getheader("Cross-Origin-Resource-Policy"),
                    "same-origin",
                )

                connection.request(
                    "GET",
                    path,
                    headers={**headers, "If-None-Match": str(etag)},
                )
                unchanged = connection.getresponse()
                self.assertEqual(unchanged.status, 304)
                self.assertEqual(unchanged.getheader("Content-Length"), "0")
                self.assertEqual(unchanged.read(), b"")
                self.assertEqual(service.agent_preview_status.call_count, 2)
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
