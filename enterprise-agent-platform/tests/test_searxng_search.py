from __future__ import annotations

import http.client
import json
import os
import urllib.error
import urllib.parse
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.service import EnterpriseService, ServiceError


class _HTTPResponse:
    def __init__(self, payload: object = None, *, raw: bytes | None = None):
        self._raw = raw if raw is not None else json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return None

    def read(self, limit: int) -> bytes:
        return self._raw[:limit]


def _config(**overrides) -> PlatformConfig:
    config = PlatformConfig(
        data_dir=Path("/tmp/ubitech-searxng-tests"),
        host="127.0.0.1",
        port=8765,
        public_base_url="http://127.0.0.1:8765",
        token_secret="test-secret",
        token_ttl_seconds=3600,
        agent_tool_token=None,
        knowledge_backend="local",
        cognee_dataset="knowledge",
        cognee_ingest_background=False,
        cognee_repo=Path("/tmp/ubitech-searxng-tests/cognee"),
        manage_cognee=False,
        manage_camofox=False,
        manage_firecrawl=False,
        firecrawl_api_url="http://127.0.0.1:13002",
        searxng_api_url="http://127.0.0.1:13003",
        searxng_timeout_seconds=20.0,
        manage_agent_runtime=False,
    )
    return replace(config, **overrides)


def _service(config: PlatformConfig | None = None) -> EnterpriseService:
    service = object.__new__(EnterpriseService)
    service.config = config or _config()
    service.runtimes = SimpleNamespace(
        searxng_loopback_url=lambda: service.config.searxng_api_url,
    )
    return service


class SearXNGConfigTests(unittest.TestCase):
    def test_from_env_has_private_search_defaults_and_explicit_overrides(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            default = PlatformConfig.from_env(Path("/tmp/ubitech-searxng-config"))
        self.assertTrue(default.manage_searxng)
        self.assertEqual(default.searxng_api_url, "http://127.0.0.1:13003")
        self.assertEqual(default.searxng_timeout_seconds, 20.0)

        with mock.patch.dict(
            os.environ,
            {
                "ENTERPRISE_MANAGE_SEARXNG": "0",
                "ENTERPRISE_SEARXNG_API_URL": "http://127.0.0.1:14567/",
                "ENTERPRISE_SEARXNG_TIMEOUT_SECONDS": "7.5",
            },
            clear=True,
        ):
            configured = PlatformConfig.from_env(Path("/tmp/ubitech-searxng-config"))
        self.assertFalse(configured.manage_searxng)
        self.assertEqual(configured.searxng_api_url, "http://127.0.0.1:14567")
        self.assertEqual(configured.searxng_timeout_seconds, 7.5)

    def test_timeout_environment_value_is_bounded(self):
        for value in ("0", "121", "nan", "inf", "-inf"):
            with self.subTest(value=value), mock.patch.dict(
                os.environ,
                {"ENTERPRISE_SEARXNG_TIMEOUT_SECONDS": value},
                clear=True,
            ):
                with self.assertRaises(ValueError):
                    PlatformConfig.from_env(Path("/tmp/ubitech-searxng-config"))


class SearXNGSearchTests(unittest.TestCase):
    def test_search_uses_direct_get_contract_and_hides_provider_diagnostics(self):
        payload = {
            "results": [
                {
                    "url": "https://example.test/result",
                    "title": "Example result",
                    "content": "Example content",
                },
                {
                    "url": "https://example.test/ignored",
                    "title": "Beyond requested limit",
                    "content": "ignored",
                },
            ],
            "unresponsive_engines": [
                ["duckduckgo", "CAPTCHA"],
                {
                    "engine": "bing",
                    "message": "token=provider-secret",
                    "api_key": "must-not-leak",
                },
            ],
            "warnings": [
                "SearXNG partial results",
                {
                    "message": "Authorization: Bearer provider-bearer-secret",
                    "password": "must-not-leak",
                },
            ],
            "secret": "ignored-top-level-secret",
        }
        service = _service()
        with (
            mock.patch(
                "enterprise_agent_platform.service.open_loopback_url",
                return_value=_HTTPResponse(payload),
            ) as urlopen,
        ):
            result = service._agent_web_tool(
                "search",
                {
                    "query": "实时 搜索",
                    "limit": 1,
                    "language": "zh-CN",
                },
            )

        request = urlopen.call_args.args[0]
        query = urllib.parse.parse_qs(
            urllib.parse.urlsplit(request.full_url).query,
            keep_blank_values=True,
        )
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertEqual(
            urllib.parse.urlsplit(request.full_url).path,
            "/search",
        )
        self.assertEqual(
            query,
            {
                "q": ["实时 搜索"],
                "format": ["json"],
                "pageno": ["1"],
                "categories": ["general"],
                "language": ["zh-CN"],
            },
        )
        self.assertGreater(urlopen.call_args.kwargs["timeout"], 0.0)
        self.assertLessEqual(urlopen.call_args.kwargs["timeout"], 20.0)
        self.assertEqual(
            result["web"],
            [
                {
                    "title": "Example result",
                    "url": "https://example.test/result",
                    "description": "Example content",
                    "position": 1,
                }
            ],
        )
        self.assertEqual(result["source"], "managed_search")
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertEqual(
            result["warnings"],
            [
                "Some managed search sources were unavailable; "
                "results may be incomplete."
            ],
        )
        self.assertNotIn("CAPTCHA", serialized)
        self.assertNotIn("partial results", serialized)
        self.assertNotIn("duckduckgo", serialized)
        self.assertNotIn("bing", serialized)
        self.assertNotIn("searxng", serialized.lower())
        self.assertNotIn("provider-secret", serialized)
        self.assertNotIn("provider-bearer-secret", serialized)
        self.assertNotIn("must-not-leak", serialized)

    def test_empty_results_are_a_success_and_language_may_be_omitted(self):
        service = _service()
        with mock.patch(
            "enterprise_agent_platform.service.open_loopback_url",
            return_value=_HTTPResponse(
                {
                    "results": [],
                    "warnings": ["No engine returned a result"],
                }
            ),
        ) as urlopen:
            result = service._agent_web_tool(
                "query",
                {"query": "nothing here"},
            )

        parsed = urllib.parse.urlsplit(urlopen.call_args.args[0].full_url)
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        self.assertNotIn("language", query)
        self.assertEqual(
            result,
            {
                "web": [],
                "source": "managed_search",
                "warnings": [
                    "Some managed search sources were unavailable; "
                    "results may be incomplete."
                ],
            },
        )

    def test_large_limit_paginates_deduplicates_and_shares_timeout_budget(self):
        service = _service()
        responses = [
            _HTTPResponse(
                {
                    "results": [
                        {
                            "url": "https://example.test/one",
                            "title": "One",
                        },
                        {
                            "url": "https://example.test/two",
                            "title": "Two",
                        },
                    ],
                    "warnings": ["page one warning"],
                }
            ),
            _HTTPResponse(
                {
                    "results": [
                        {
                            "url": "https://example.test/two",
                            "title": "Duplicate",
                        },
                        {
                            "url": "https://example.test/three",
                            "title": "Three",
                        },
                    ],
                    "warnings": ["page two warning"],
                }
            ),
            _HTTPResponse({"results": []}),
        ]
        with (
            mock.patch(
                "enterprise_agent_platform.service.time.monotonic",
                side_effect=[100.0, 101.0, 108.0, 115.0],
            ),
            mock.patch(
                "enterprise_agent_platform.service.open_loopback_url",
                side_effect=responses,
            ) as urlopen,
        ):
            result = service._agent_web_tool(
                "search",
                {"query": "several pages", "limit": 100},
            )

        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual(
            [
                urllib.parse.parse_qs(
                    urllib.parse.urlsplit(call.args[0].full_url).query
                )["pageno"]
                for call in urlopen.call_args_list
            ],
            [["1"], ["2"], ["3"]],
        )
        self.assertEqual(
            [call.kwargs["timeout"] for call in urlopen.call_args_list],
            [19.0, 12.0, 5.0],
        )
        self.assertEqual(
            [item["url"] for item in result["web"]],
            [
                "https://example.test/one",
                "https://example.test/two",
                "https://example.test/three",
            ],
        )
        self.assertEqual(
            [item["position"] for item in result["web"]],
            [1, 2, 3],
        )
        self.assertEqual(
            result["warnings"],
            [
                "Some managed search sources were unavailable; "
                "results may be incomplete."
            ],
        )

    def test_search_stops_after_five_pages(self):
        service = _service()

        def search_page(request, *, timeout):
            query = urllib.parse.parse_qs(
                urllib.parse.urlsplit(request.full_url).query
            )
            page_number = int(query["pageno"][0])
            return _HTTPResponse(
                {
                    "results": [
                        {
                            "url": f"https://example.test/page-{page_number}",
                            "title": f"Page {page_number}",
                        }
                    ]
                }
            )

        with (
            mock.patch(
                "enterprise_agent_platform.service.open_loopback_url",
                side_effect=search_page,
            ) as urlopen,
        ):
            result = service._agent_web_tool(
                "search",
                {"query": "hard page cap", "limit": 100},
            )

        self.assertEqual(urlopen.call_count, 5)
        self.assertEqual(
            [
                urllib.parse.parse_qs(
                    urllib.parse.urlsplit(call.args[0].full_url).query
                )["pageno"]
                for call in urlopen.call_args_list
            ],
            [["1"], ["2"], ["3"], ["4"], ["5"]],
        )
        self.assertEqual(len(result["web"]), 5)

    def test_deadline_exhaustion_prevents_the_next_page_request(self):
        service = _service()
        with (
            mock.patch(
                "enterprise_agent_platform.service.time.monotonic",
                side_effect=[100.0, 101.0, 121.0],
            ),
            mock.patch(
                "enterprise_agent_platform.service.open_loopback_url",
                return_value=_HTTPResponse(
                    {
                        "results": [
                            {
                                "url": "https://example.test/page-one",
                                "title": "Page one",
                            }
                        ]
                    }
                ),
            ) as urlopen,
        ):
            with self.assertRaises(ServiceError) as raised:
                service._agent_web_tool(
                    "search",
                    {"query": "deadline", "limit": 100},
                )

        self.assertEqual(raised.exception.status, 502)
        self.assertIn("request timed out", raised.exception.message)
        self.assertEqual(urlopen.call_count, 1)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 19.0)

    def test_runtime_loopback_endpoint_takes_precedence_over_static_config(self):
        service = _service(_config(searxng_api_url="https://invalid.example"))
        service.runtimes = SimpleNamespace(
            searxng_loopback_url=lambda: "http://127.0.0.1:14567",
        )
        with mock.patch(
            "enterprise_agent_platform.service.open_loopback_url",
            return_value=_HTTPResponse({"results": []}),
        ) as urlopen:
            service._agent_web_tool("search", {"query": "runtime endpoint"})

        self.assertTrue(
            urlopen.call_args.args[0].full_url.startswith(
                "http://127.0.0.1:14567/search?"
            )
        )

    def test_search_endpoint_rejects_non_literal_loopback_hostnames(self):
        service = _service(
            _config(searxng_api_url="http://localhost.localdomain:13003")
        )
        with mock.patch(
            "enterprise_agent_platform.service.open_loopback_url",
        ) as urlopen:
            with self.assertRaises(ServiceError) as raised:
                service._agent_web_tool("search", {"query": "local search"})

        self.assertEqual(raised.exception.status, 503)
        urlopen.assert_not_called()

    def test_transport_and_response_failures_are_explicit_and_never_fall_back(self):
        service = _service()
        cases = (
            (
                urllib.error.URLError("connection refused"),
                None,
                "managed web search request failed",
            ),
            (
                None,
                _HTTPResponse(raw=b"<html>not json</html>"),
                "managed web search request failed",
            ),
            (
                None,
                _HTTPResponse({"web": []}),
                "managed web search returned an invalid response",
            ),
        )
        for side_effect, response, expected in cases:
            with self.subTest(expected=expected), mock.patch(
                "enterprise_agent_platform.service.open_loopback_url",
                side_effect=side_effect,
                return_value=response,
            ) as urlopen:
                with self.assertRaises(ServiceError) as raised:
                    service._agent_web_tool("search", {"query": "failure"})
                self.assertEqual(raised.exception.status, 502)
                self.assertIn(expected, raised.exception.message)
                self.assertEqual(urlopen.call_count, 1)
                self.assertTrue(
                    urlopen.call_args.args[0].full_url.startswith(
                        "http://127.0.0.1:13003/search?"
                    )
                )
                self.assertNotIn("13002", urlopen.call_args.args[0].full_url)

    def test_provider_identity_and_secrets_are_removed_from_errors(self):
        service = _service()
        service._runtime_json_request = mock.Mock(
            side_effect=ServiceError(
                502,
                "SearXNG request failed with token=provider-secret",
            )
        )

        with self.assertRaises(ServiceError) as raised:
            service._agent_web_tool("search", {"query": "failure"})

        message = raised.exception.message.lower()
        self.assertNotIn("searxng", message)
        self.assertNotIn("provider-secret", message)
        self.assertIn("managed web search request failed", message)

    def test_interrupted_chunked_response_is_a_controlled_search_failure(self):
        service = _service()
        response = _HTTPResponse({"results": []})
        response.read = mock.Mock(
            side_effect=http.client.IncompleteRead(b'{"results":', 20)
        )

        with mock.patch(
            "enterprise_agent_platform.service.open_loopback_url",
            return_value=response,
        ):
            with self.assertRaises(ServiceError) as raised:
                service._agent_web_tool("search", {"query": "interrupted"})

        self.assertEqual(raised.exception.status, 502)
        self.assertEqual(
            raised.exception.message,
            "managed web search request failed",
        )

    def test_search_endpoint_must_be_a_credential_free_loopback_base_url(self):
        invalid_urls = (
            "",
            "http://localhost:13003",
            "http://localhost.localdomain:13003",
            "http://127.0.0.1",
            "https://example.com",
            "http://169.254.169.254:13003",
            "http://127.0.0.1:13003/v1",
            "http://user:password@127.0.0.1:13003",
            "http://127.0.0.1:13003?target=http://169.254.169.254",
            "http://127.0.0.1:13003#fragment",
        )
        for url in invalid_urls:
            with self.subTest(url=url), mock.patch(
                "enterprise_agent_platform.service.open_loopback_url"
            ) as urlopen:
                with self.assertRaises(ServiceError) as raised:
                    _service(_config(searxng_api_url=url))._agent_web_tool(
                        "search",
                        {"query": "safe"},
                    )
                self.assertEqual(raised.exception.status, 503)
                self.assertIn(
                    "endpoint configuration is invalid",
                    raised.exception.message,
                )
                urlopen.assert_not_called()

    def test_untrusted_result_urls_are_skipped_without_discarding_public_results(self):
        service = _service()
        with mock.patch(
            "enterprise_agent_platform.service.open_loopback_url",
            return_value=_HTTPResponse(
                {
                    "results": [
                        {
                            "url": "http://127.0.0.1:8765/admin",
                            "title": "Internal service",
                            "content": "must not be exposed",
                        },
                        {
                            "url": "https://public.example/result",
                            "title": "Public result",
                            "content": "safe",
                        },
                        {
                            "url": "https://public.example/private?token=secret",
                            "title": "Sensitive URL",
                            "content": "must not be exposed",
                        },
                    ]
                }
            ),
        ):
            result = service._agent_web_tool("search", {"query": "internal"})

        self.assertEqual(
            result["web"],
            [
                {
                    "title": "Public result",
                    "url": "https://public.example/result",
                    "description": "safe",
                    "position": 1,
                }
            ],
        )

    def test_search_result_filter_does_not_perform_dns_resolution(self):
        service = _service()
        with (
            mock.patch(
                "enterprise_agent_platform.service.open_loopback_url",
                return_value=_HTTPResponse(
                    {
                        "results": [
                            {
                                "url": "https://public.example/result",
                                "title": "Public result",
                            }
                        ]
                    }
                ),
            ),
            mock.patch(
                "enterprise_agent_platform.service.socket.getaddrinfo",
                side_effect=AssertionError("search result filtering must not resolve DNS"),
            ) as resolve,
        ):
            result = service._agent_web_tool("search", {"query": "bounded"})

        self.assertEqual(len(result["web"]), 1)
        resolve.assert_not_called()

    def test_extract_still_uses_firecrawl(self):
        service = _service()
        service.get_secret = lambda _key: "firecrawl-key"
        service._validate_external_url = lambda _url: None
        calls: list[dict[str, object]] = []

        def request(url, body, *, headers, timeout, method="POST"):
            calls.append(
                {
                    "url": url,
                    "body": body,
                    "headers": headers,
                    "timeout": timeout,
                    "method": method,
                }
            )
            return {
                "data": {
                    "markdown": "# Extracted",
                    "metadata": {
                        "sourceURL": "https://example.test/page",
                        "title": "Example",
                    },
                }
            }

        service._runtime_json_request = request
        result = service._agent_web_tool(
            "extract",
            {"url": "https://example.test/page"},
        )

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["url"], "http://127.0.0.1:13002/v1/scrape")
        self.assertEqual(calls[0]["method"], "POST")
        self.assertEqual(
            calls[0]["headers"],
            {"Authorization": "Bearer firecrawl-key"},
        )
        self.assertEqual(result["results"][0]["content"], "# Extracted")

    def test_extract_prefers_runtime_firecrawl_endpoint_when_available(self):
        service = _service()
        service.runtimes.firecrawl_loopback_url = (
            lambda: "http://127.0.0.1:14566"
        )
        service.get_secret = lambda _key: ""
        service._validate_external_url = lambda _url: None
        calls: list[str] = []

        def request(url, _body, *, headers, timeout, method="POST"):
            calls.append(url)
            return {"data": {"markdown": "Extracted"}}

        service._runtime_json_request = request
        service._agent_web_tool(
            "extract",
            {"url": "https://example.test/page"},
        )

        self.assertEqual(calls, ["http://127.0.0.1:14566/v1/scrape"])


if __name__ == "__main__":
    unittest.main()
