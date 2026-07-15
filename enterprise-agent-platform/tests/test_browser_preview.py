from __future__ import annotations

import hashlib
import http.client
import json
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError

from test_platform import RecordingAgent, make_config


def png_fixture(width: int = 960, height: int = 540, suffix: bytes = b"") -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\x0dIHDR"
        + int(width).to_bytes(4, "big")
        + int(height).to_bytes(4, "big")
        + b"\x08\x06\x00\x00\x00"
        + suffix
    )


class BrowserPreviewServiceTests(unittest.TestCase):
    def _service(self, root: Path) -> EnterpriseService:
        return EnterpriseService(make_config(root), agent_client=RecordingAgent())

    def test_uninitialized_preview_is_idle_and_has_no_runtime_side_effect(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                with (
                    mock.patch.object(service.agent_scopes, "ensure_private_scope") as ensure,
                    mock.patch.object(service, "_runtime_json_request") as runtime_request,
                ):
                    preview = service.browser_preview(
                        actor,
                        "private",
                        str(actor["id"]),
                    )
                self.assertFalse(preview["active"])
                self.assertEqual(preview["reason"], "scope_not_initialized")
                self.assertEqual(preview["status"], "idle")
                self.assertTrue(preview["etag"].startswith('"idle-'))
                ensure.assert_not_called()
                runtime_request.assert_not_called()
            finally:
                service.close()

    def test_preview_uses_most_recent_delegate_without_changing_agent_current_tab(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                root = service.agent_scopes.ensure_private_scope(actor["id"])
                child_scope = root.scope_key + "/delegate/research"
                service._agent_browser_remember_current_tab(root.scope_key, "root-tab")
                service._agent_browser_remember_current_tab(child_scope, "child-tab")
                before_tabs = dict(service._agent_browser_current_tabs)
                child_user = service._agent_browser_user_id(child_scope)
                root_user = service._agent_browser_user_id(root.scope_key)
                calls: list[str] = []
                titles = ["Delegate title", "Delegate title"]

                def request(url, body, *, headers, timeout, method="POST"):
                    calls.append(url)
                    parsed = urllib.parse.urlparse(url)
                    query = urllib.parse.parse_qs(parsed.query)
                    if parsed.path.endswith("/tabs"):
                        user_id = query["userId"][0]
                        if user_id == child_user:
                            return {
                                "tabs": [
                                    {
                                        "tabId": "child-tab",
                                        "title": "Delegate title",
                                        "url": "https://example.test/work?token=secret#fragment",
                                    }
                                ]
                            }
                        if user_id == root_user:
                            return {"tabs": [{"tabId": "root-tab"}]}
                    if "/stats" in parsed.path:
                        return {
                            "url": "https://user:pass@example.test/work?token=secret#fragment",
                            "title": titles.pop(0),
                        }
                    raise AssertionError(url)

                binary = mock.Mock(return_value=(png_fixture(), "image/png"))
                service._runtime_json_request = request
                service._runtime_binary_request = binary
                service._validate_browser_page_url = lambda _value: None
                service._browser_preview_existing_access_key = lambda: "x" * 32

                preview = service.browser_preview(actor, "private", str(actor["id"]))
                cached = service.browser_preview(actor, "private", str(actor["id"]))

                self.assertTrue(preview["active"])
                self.assertEqual(preview["tab_id"], "child-tab")
                self.assertTrue(preview["session"].startswith("delegate-"))
                self.assertNotIn(root.scope_key, preview["session"])
                self.assertEqual(preview["url"], "https://example.test/work")
                self.assertNotIn("secret", json.dumps({key: value for key, value in preview.items() if key != "image"}))
                self.assertEqual((preview["width"], preview["height"]), (960, 540))
                self.assertEqual(cached["etag"], preview["etag"])
                self.assertEqual(binary.call_count, 1)
                self.assertEqual(service._agent_browser_current_tabs, before_tabs)
                self.assertTrue(all("fullPage=false" in call.args[0] for call in binary.call_args_list))
                self.assertEqual(sum("/tabs?" in url for url in calls), 2)
            finally:
                service.close()

    def test_transport_failure_is_not_retried_for_each_delegate(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                root = service.agent_scopes.ensure_private_scope(actor["id"])
                for index in range(20):
                    service._agent_browser_remember_current_tab(
                        f"{root.scope_key}/delegate/{index}",
                        f"tab-{index}",
                    )
                failed = mock.Mock(side_effect=ServiceError(502, "runtime down"))
                service._runtime_json_request = failed
                service._browser_preview_existing_access_key = lambda: "x" * 32

                preview = service.browser_preview(actor, "private", str(actor["id"]))

                self.assertFalse(preview["active"])
                self.assertEqual(preview["reason"], "browser_unavailable")
                failed.assert_called_once()
            finally:
                service.close()

    def test_initialized_preview_does_not_materialize_a_missing_access_key(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, actor = service.authenticate("admin", "admin")
                service.agent_scopes.ensure_private_scope(actor["id"])
                access_key = service.config.runtime_dir / "camofox" / "access-key"
                self.assertFalse(access_key.exists())
                runtime_request = mock.Mock()
                service._runtime_json_request = runtime_request

                preview = service.browser_preview(actor, "private", str(actor["id"]))

                self.assertFalse(preview["active"])
                self.assertEqual(preview["reason"], "browser_unavailable")
                self.assertFalse(access_key.exists())
                runtime_request.assert_not_called()
            finally:
                service.close()

    def test_etag_includes_public_metadata_not_only_pixel_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                image = png_fixture()
                common = {
                    "root_scope_key": "private:1",
                    "selected_scope_key": "private:1",
                    "selected_tab_id": "tab-1",
                    "selected_tab": {"title": "first"},
                    "tab_count": 1,
                    "user_id": "agent-test",
                    "base_url": "http://127.0.0.1:9377",
                    "headers": {"Authorization": "Bearer test"},
                }
                current = {"title": "first"}

                def request(*_args, **_kwargs):
                    return {"url": "https://example.test/page", "title": current["title"]}

                service._runtime_json_request = request
                service._runtime_binary_request = lambda *_args, **_kwargs: (image, "image/png")
                service._validate_browser_page_url = lambda _value: None
                first = service._capture_browser_preview_frame(**common)
                with service._agent_browser_tabs_lock:
                    service._browser_preview_cache[("private:1", "tab-1")]["captured_monotonic"] = 0
                current["title"] = "second"
                second = service._capture_browser_preview_frame(**common)

                self.assertNotEqual(first["etag"], second["etag"])
            finally:
                service.close()

    def test_png_with_excessive_declared_dimensions_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                service._runtime_json_request = lambda *_args, **_kwargs: {
                    "url": "https://example.test/page",
                    "title": "Page",
                }
                service._runtime_binary_request = lambda *_args, **_kwargs: (
                    png_fixture(20_000, 20_000),
                    "image/png",
                )
                service._validate_browser_page_url = lambda _value: None

                preview = service._capture_browser_preview_frame(
                    root_scope_key="private:1",
                    selected_scope_key="private:1",
                    selected_tab_id="tab-1",
                    selected_tab={"title": "Page"},
                    tab_count=1,
                    user_id="agent-test",
                    base_url="http://127.0.0.1:9377",
                    headers={"Authorization": "Bearer test"},
                )

                self.assertFalse(preview["active"])
                self.assertEqual(preview["reason"], "browser_unavailable")
                cached = service._browser_preview_cache[("private:1", "tab-1")]
                self.assertFalse(cached["frame"]["active"])
                self.assertEqual(service._browser_preview_cache_bytes, 0)
            finally:
                service.close()

    def test_capture_failure_is_shortly_negative_cached_for_other_observers(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                stats = mock.Mock(return_value={
                    "url": "https://example.test/page",
                    "title": "Page",
                })
                screenshot = mock.Mock(side_effect=ServiceError(502, "capture failed"))
                service._runtime_json_request = stats
                service._runtime_binary_request = screenshot
                service._validate_browser_page_url = lambda _value: None
                arguments = {
                    "root_scope_key": "private:1",
                    "selected_scope_key": "private:1",
                    "selected_tab_id": "tab-1",
                    "selected_tab": {"title": "Page"},
                    "tab_count": 1,
                    "user_id": "agent-test",
                    "base_url": "http://127.0.0.1:9377",
                    "headers": {"Authorization": "Bearer test"},
                }

                first = service._capture_browser_preview_frame(**arguments)
                second = service._capture_browser_preview_frame(**arguments)

                self.assertFalse(first["active"])
                self.assertEqual(second, first)
                stats.assert_called_once()
                screenshot.assert_called_once()
            finally:
                service.close()

    def test_preview_cache_has_a_global_byte_ceiling(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                with mock.patch(
                    "enterprise_agent_platform.service.MAX_BROWSER_PREVIEW_CACHE_BYTES",
                    10,
                ):
                    with service._agent_browser_tabs_lock:
                        for index in range(3):
                            service._browser_preview_cache_put_unlocked(
                                ("private:1", f"tab-{index}"),
                                {
                                    "captured_monotonic": time.monotonic(),
                                    "frame": {"image": bytes([index]) * 6},
                                },
                            )
                self.assertLessEqual(service._browser_preview_cache_bytes, 10)
                self.assertEqual(len(service._browser_preview_cache), 1)
                self.assertIn(("private:1", "tab-2"), service._browser_preview_cache)
            finally:
                service.close()

    def test_root_cleanup_reclaims_every_tracked_delegate_without_preview_cap(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            root = service.agent_scopes.ensure_private_scope(1)
            children = [f"{root.scope_key}/delegate/{index}" for index in range(70)]
            for index, child in enumerate(children):
                service._agent_browser_remember_current_tab(child, f"tab-{index}")
            cleaned: list[str] = []

            def browser_tool(scope_key, action, arguments):
                self.assertEqual(action, "cleanup")
                cleaned.append(scope_key)
                service._agent_browser_forget_scope(scope_key)
                return {"ok": True}

            try:
                with mock.patch.object(service, "_agent_browser_tool", side_effect=browser_tool):
                    service._cleanup_agent_scope(root.scope_key)
                    self.assertEqual(set(cleaned), {root.scope_key, *children})
                    self.assertFalse(service._agent_browser_current_tabs)
                    self.assertFalse(service._agent_browser_activity)
            finally:
                with mock.patch.object(service, "_agent_browser_tool", return_value={"ok": True}):
                    service.close()


class BrowserPreviewHTTPTests(unittest.TestCase):
    def test_binary_frame_is_authenticated_conditional_and_same_origin_only(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            image = png_fixture(800, 450)
            etag = '"' + hashlib.sha256(b"preview").hexdigest() + '"'
            preview = {
                "active": True,
                "status": "live",
                "state": "live",
                "image": image,
                "mime_type": "image/png",
                "etag": etag,
                "captured_at": 123456789,
                "tab_id": "tab/one",
                "tab_count": 2,
                "session": "main",
                "url": "https://example.test/path",
                "title": "A title 中文",
                "width": 800,
                "height": 450,
                "refresh_interval_ms": 2000,
            }
            service.browser_preview = mock.Mock(return_value=preview)
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, actor = service.authenticate("admin", "admin")
                path = (
                    "/api/agent-previews/browser?scope_type=private&scope_id="
                    + str(actor["id"])
                )
                unauthenticated = http.client.HTTPConnection(host, port, timeout=5)
                unauthenticated.request("GET", path)
                denied = unauthenticated.getresponse()
                denied.read()
                self.assertEqual(denied.status, 401)

                connection = http.client.HTTPConnection(host, port, timeout=5)
                connection.request("GET", path, headers={"Authorization": f"Bearer {token}"})
                response = connection.getresponse()
                self.assertEqual(response.read(), image)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Content-Type"), "image/png")
                self.assertEqual(response.getheader("ETag"), etag)
                self.assertEqual(response.getheader("Cache-Control"), "private, no-cache, max-age=0")
                self.assertEqual(response.getheader("Vary"), "Cookie, Authorization")
                self.assertEqual(response.getheader("Content-Disposition"), "inline")
                self.assertEqual(response.getheader("Cross-Origin-Resource-Policy"), "same-origin")
                self.assertEqual(response.getheader("X-Preview-Tab-Id"), "tab%2Fone")
                self.assertEqual(response.getheader("X-Preview-URL"), "https%3A%2F%2Fexample.test%2Fpath")
                self.assertEqual(urllib.parse.unquote(response.getheader("X-Preview-Title")), "A title 中文")

                conditional = http.client.HTTPConnection(host, port, timeout=5)
                conditional.request(
                    "GET",
                    path,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "If-None-Match": "W/" + etag,
                    },
                )
                not_modified = conditional.getresponse()
                self.assertEqual(not_modified.status, 304)
                self.assertEqual(not_modified.read(), b"")
                self.assertEqual(not_modified.getheader("ETag"), etag)
                self.assertEqual(not_modified.getheader("Cross-Origin-Resource-Policy"), "same-origin")
                self.assertEqual(not_modified.getheader("Vary"), "Cookie, Authorization")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_idle_preview_is_json_with_public_state_and_etag(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            service.browser_preview = mock.Mock(
                return_value={
                    "active": False,
                    "status": "idle",
                    "state": "idle",
                    "reason": "no_open_tab",
                    "refresh_interval_ms": 2000,
                    "etag": '"idle-test"',
                }
            )
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, actor = service.authenticate("admin", "admin")
                connection = http.client.HTTPConnection(host, port, timeout=5)
                connection.request(
                    "GET",
                    f"/api/agent-previews/browser?scope_type=private&scope_id={actor['id']}",
                    headers={"Authorization": f"Bearer {token}"},
                )
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    payload,
                    {
                        "active": False,
                        "status": "idle",
                        "state": "idle",
                        "reason": "no_open_tab",
                        "refresh_interval_ms": 2000,
                    },
                )
                self.assertEqual(response.getheader("ETag"), '"idle-test"')
                self.assertEqual(response.getheader("Cross-Origin-Resource-Policy"), "same-origin")
                self.assertEqual(response.getheader("Cache-Control"), "private, no-cache, max-age=0")
                self.assertEqual(response.getheader("Vary"), "Cookie, Authorization")

                conditional = http.client.HTTPConnection(host, port, timeout=5)
                conditional.request(
                    "GET",
                    f"/api/agent-previews/browser?scope_type=private&scope_id={actor['id']}",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "If-None-Match": '"idle-test"',
                    },
                )
                unchanged = conditional.getresponse()
                self.assertEqual(unchanged.status, 304)
                self.assertEqual(unchanged.read(), b"")
                self.assertEqual(unchanged.getheader("Cache-Control"), "private, no-cache, max-age=0")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_browser_preview_rejects_unknown_and_repeated_query_parameters(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            service.browser_preview = mock.Mock()
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, actor = service.authenticate("admin", "admin")
                headers = {"Authorization": f"Bearer {token}"}
                paths = (
                    f"/api/agent-previews/browser?scope_type=private&scope_id={actor['id']}&extra=",
                    f"/api/agent-previews/browser?scope_type=private&scope_type=channel&scope_id={actor['id']}",
                    f"/api/agent-previews/browser?scope_type=private&scope_id={actor['id']}&tab_id=a&tab_id=b",
                )
                for path in paths:
                    connection = http.client.HTTPConnection(host, port, timeout=5)
                    connection.request("GET", path, headers=headers)
                    response = connection.getresponse()
                    response.read()
                    self.assertEqual(response.status, 400, path)
                service.browser_preview.assert_not_called()
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
