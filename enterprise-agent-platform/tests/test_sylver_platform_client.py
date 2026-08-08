from __future__ import annotations

import http.client
import json
import unittest
from typing import Any
from unittest.mock import patch

from enterprise_agent_platform.sylver_platform_client import (
    SylverPlatformClient,
    SylverPlatformError,
    SylverPlatformValidationError,
    normalize_base_url,
    validate_personal_token,
)


class RecordingTransport:
    def __init__(self, responses: list[Any]):
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: bytes | None,
        timeout_seconds: float,
        max_response_bytes: int,
    ) -> tuple[int, str, bytes]:
        self.calls.append(
            {
                "url": url,
                "method": method,
                "headers": dict(headers),
                "body": body,
                "timeout_seconds": timeout_seconds,
                "max_response_bytes": max_response_bytes,
            }
        )
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if isinstance(response, tuple):
            return response
        return 200, "application/json; charset=utf-8", json.dumps(response).encode()


class IncompleteReadResponse:
    status = 200
    headers = {"Content-Type": "application/json"}

    def __enter__(self) -> IncompleteReadResponse:
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self, _amount: int) -> bytes:
        raise http.client.IncompleteRead(b'{"partial":')


class IncompleteReadOpener:
    def open(self, *_args: Any, **_kwargs: Any) -> IncompleteReadResponse:
        return IncompleteReadResponse()


class SylverPlatformClientTests(unittest.TestCase):
    def test_accepts_only_the_fixed_https_origin(self) -> None:
        self.assertEqual(
            normalize_base_url("https://DEVOPS.SYLVER-LINING.ORG:443/"),
            "https://devops.sylver-lining.org",
        )
        for value in (
            "https://example.com",
            "http://example.com",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://user@example.com",
            "https://example.com/api",
            "https://example.com/?token=x",
            " https://example.com",
        ):
            with self.subTest(value=value), self.assertRaises(SylverPlatformValidationError):
                normalize_base_url(value)

    def test_rejects_unsafe_tokens(self) -> None:
        self.assertEqual(validate_personal_token("secret-token"), "secret-token")
        for token in (
            "",
            " secret",
            "secret token",
            "secret\nheader",
            "令牌",
            "x" * 4097,
        ):
            with self.subTest(token=token[:20]), self.assertRaises(
                SylverPlatformValidationError
            ):
                validate_personal_token(token)

    def test_identity_probe_projects_only_public_identity(self) -> None:
        transport = RecordingTransport(
            [
                {
                    "id": 13,
                    "username": "eysocatc",
                    "full_name": "華仔",
                    "email": "person@example.com",
                    "role": "member",
                    "server_secret": "must not be projected",
                }
            ]
        )
        result = SylverPlatformClient(transport=transport).verify_identity(
            "https://devops.sylver-lining.org", "personal-secret"
        )
        self.assertEqual(result["remote_user_id"], 13)
        self.assertEqual(result["username"], "eysocatc")
        self.assertNotIn("server_secret", result)
        call = transport.calls[0]
        self.assertEqual(call["url"], "https://devops.sylver-lining.org/api/auth/me")
        self.assertEqual(call["headers"]["Authorization"], "Bearer personal-secret")
        self.assertNotIn(b"personal-secret", call["body"] or b"")

    def test_read_actions_build_only_fixed_routes(self) -> None:
        transport = RecordingTransport([[], [], [], [], {}])
        client = SylverPlatformClient(transport=transport)
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "tasks",
            {"project_id": 4, "assigned_to_me": True},
        )
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "wiki_read",
            {"document_id": 9},
        )
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "approvals",
            {"box": "outbox"},
        )
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "notifications",
            {"unread_only": False},
        )
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "approval",
            {"approval_id": 12},
        )
        self.assertEqual(
            [call["url"] for call in transport.calls],
            [
                "https://devops.sylver-lining.org/api/tasks?assignee=me&project_id=4",
                "https://devops.sylver-lining.org/api/wiki/documents/9",
                "https://devops.sylver-lining.org/api/approvals?box=outbox",
                "https://devops.sylver-lining.org/api/notifications",
                "https://devops.sylver-lining.org/api/approvals/12",
            ],
        )

    def test_read_collections_apply_safe_default_query_arguments(self) -> None:
        transport = RecordingTransport([[], [], []])
        client = SylverPlatformClient(transport=transport)

        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "tasks",
            {},
        )
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "notifications",
            {},
        )
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "approvals",
            {},
        )

        self.assertEqual(
            [call["url"] for call in transport.calls],
            [
                "https://devops.sylver-lining.org/api/tasks?assignee=me",
                "https://devops.sylver-lining.org/api/notifications?unread_only=true",
                "https://devops.sylver-lining.org/api/approvals?box=inbox",
            ],
        )

    def test_create_task_strips_unknown_or_unsafe_fields(self) -> None:
        client = SylverPlatformClient(transport=RecordingTransport([{}]))
        valid = {
            "project_id": 2,
            "title": "Prepare report",
            "tag_ids": [5, 7],
            "start_date": "2026-08-08",
            "due_date": "2026-08-10",
            "milestone_id": None,
        }
        with self.assertRaises(SylverPlatformValidationError):
            client.execute(
                "https://devops.sylver-lining.org",
                "secret",
                "create_task",
                {**valid, "status_id": 1},
            )
        with self.assertRaises(SylverPlatformValidationError):
            client.execute(
                "https://devops.sylver-lining.org",
                "secret",
                "create_task",
                {**valid, "tag_ids": [5, 5]},
            )
        with self.assertRaises(SylverPlatformValidationError):
            client.execute(
                "https://devops.sylver-lining.org",
                "secret",
                "create_task",
                {**valid, "description": "\ud800"},
            )
        for description in (
            "- Missing summary",
            "Summary\nprose instead of a bullet",
            "   ",
        ):
            with self.subTest(description=description), self.assertRaises(
                SylverPlatformValidationError
            ):
                client.execute(
                    "https://devops.sylver-lining.org",
                    "secret",
                    "create_task",
                    {**valid, "description": description},
                )
        without_milestone = dict(valid)
        without_milestone.pop("milestone_id")
        with self.assertRaisesRegex(
            SylverPlatformValidationError,
            "milestone_id",
        ):
            client.execute(
                "https://devops.sylver-lining.org",
                "secret",
                "create_task",
                without_milestone,
            )

    def test_wiki_proposal_and_approval_comment_have_fixed_shapes(self) -> None:
        transport = RecordingTransport([{"id": 1}, {"id": 2}])
        client = SylverPlatformClient(transport=transport)
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "propose_wiki",
            {
                "project_slug": "project-a",
                "title": "Overview",
                "slug": "overview",
                "content": "# Overview",
                "source_document_id": "project-a/overview",
                "content_format": "markdown",
                "order": 0,
                "change_summary": "  Create overview\n",
            },
        )
        client.execute(
            "https://devops.sylver-lining.org",
            "secret",
            "comment_approval",
            {"approval_id": 8, "body": "Checked the relevant details."},
        )
        wiki_body = json.loads(transport.calls[0]["body"] or b"{}")
        comment_body = json.loads(transport.calls[1]["body"] or b"{}")
        self.assertEqual(transport.calls[0]["url"], "https://devops.sylver-lining.org/api/wiki/proposals")
        self.assertEqual(wiki_body["content_format"], "markdown")
        self.assertEqual(wiki_body["order"], 0)
        self.assertEqual(wiki_body["change_summary"], "  Create overview\n")
        self.assertEqual(comment_body, {"body": "Checked the relevant details.", "kind": "comment"})

    def test_create_task_preserves_proposal_gate_or_selects_unique_backlog(self) -> None:
        arguments = {
            "project_id": 2,
            "title": "Prepare report",
            "description": "Prepare the report\n- Gather data\n- Draft findings",
            "tag_ids": [5],
            "start_date": "2026-08-08",
            "due_date": "2026-08-10",
            "milestone_id": 3,
        }
        cases = (
            (
                [{"id": 8, "category": "proposed"}, {"id": 9, "category": "backlog"}],
                None,
            ),
            ([{"id": 9, "category": "backlog"}], 9),
        )
        for statuses, expected_status_id in cases:
            with self.subTest(expected_status_id=expected_status_id):
                transport = RecordingTransport(
                    [
                        {"id": 2, "workflow_id": 4},
                        [{"id": 4, "statuses": statuses}],
                        {"id": 17},
                    ]
                )
                result = SylverPlatformClient(transport=transport).execute(
                    "https://devops.sylver-lining.org",
                    "secret",
                    "create_task",
                    arguments,
                )
                self.assertEqual(result["id"], 17)
                body = json.loads(transport.calls[-1]["body"] or b"{}")
                if expected_status_id is None:
                    self.assertNotIn("status_id", body)
                else:
                    self.assertEqual(body["status_id"], expected_status_id)
                self.assertEqual(body["description"], arguments["description"])

    def test_create_task_rejects_proposal_approver_before_post_without_proposed_status(
        self,
    ) -> None:
        transport = RecordingTransport(
            [
                {"id": 2, "workflow_id": 4},
                [{"id": 4, "statuses": [{"id": 9, "category": "backlog"}]}],
            ]
        )

        with self.assertRaisesRegex(
            SylverPlatformValidationError,
            "proposal_approver_id requires a proposed workflow status",
        ):
            SylverPlatformClient(transport=transport).execute(
                "https://devops.sylver-lining.org",
                "secret",
                "create_task",
                {
                    "project_id": 2,
                    "title": "Prepare report",
                    "tag_ids": [5],
                    "start_date": "2026-08-08",
                    "due_date": "2026-08-10",
                    "milestone_id": None,
                    "proposal_approver_id": 13,
                },
            )

        self.assertEqual([call["method"] for call in transport.calls], ["GET", "GET"])

    def test_create_task_preserves_proposal_approver_for_unique_proposed_status(
        self,
    ) -> None:
        transport = RecordingTransport(
            [
                {"id": 2, "workflow_id": 4},
                [{"id": 4, "statuses": [{"id": 8, "category": "proposed"}]}],
                {"id": 17},
            ]
        )

        result = SylverPlatformClient(transport=transport).execute(
            "https://devops.sylver-lining.org",
            "secret",
            "create_task",
            {
                "project_id": 2,
                "title": "Prepare report",
                "tag_ids": [5],
                "start_date": "2026-08-08",
                "due_date": "2026-08-10",
                "milestone_id": None,
                "proposal_approver_id": 13,
            },
        )

        self.assertEqual(result["id"], 17)
        body = json.loads(transport.calls[-1]["body"] or b"{}")
        self.assertEqual(body["proposal_approver_id"], 13)
        self.assertNotIn("status_id", body)

    def test_create_task_fails_before_post_for_ambiguous_workflow(self) -> None:
        transport = RecordingTransport(
            [
                {"id": 2, "workflow_id": 4},
                [{"id": 4, "statuses": [
                    {"id": 8, "category": "backlog"},
                    {"id": 9, "category": "backlog"},
                ]}],
            ]
        )
        with self.assertRaisesRegex(SylverPlatformError, "backlog status"):
            SylverPlatformClient(transport=transport).execute(
                "https://devops.sylver-lining.org",
                "secret",
                "create_task",
                {
                    "project_id": 2,
                    "title": "Prepare report",
                    "tag_ids": [5],
                    "start_date": "2026-08-08",
                    "due_date": "2026-08-10",
                    "milestone_id": 3,
                },
            )
        self.assertEqual([call["method"] for call in transport.calls], ["GET", "GET"])

    def test_start_task_fails_closed_before_patch_on_ambiguous_workflow(self) -> None:
        transport = RecordingTransport(
            [
                {"id": 8, "project_id": 4},
                {"id": 4, "workflow_id": 2},
                [{"id": 2, "statuses": [{"id": 5, "category": "backlog"}]}],
            ]
        )
        with self.assertRaisesRegex(SylverPlatformError, "active status"):
            SylverPlatformClient(transport=transport).execute(
                "https://devops.sylver-lining.org",
                "secret",
                "start_task",
                {"task_id": 8, "note": "Starting task"},
            )
        self.assertEqual([call["method"] for call in transport.calls], ["GET", "GET", "GET"])

    def test_start_task_reports_partial_completion_without_blind_retry(self) -> None:
        transport = RecordingTransport(
            [
                {"id": 8, "project_id": 4},
                {"id": 4, "workflow_id": 2},
                [{"id": 2, "statuses": [{"id": 6, "category": "active"}]}],
                {"id": 8, "status_id": 6},
                SylverPlatformError("remote platform is unreachable", retryable=True),
            ]
        )
        result = SylverPlatformClient(transport=transport).execute(
            "https://devops.sylver-lining.org",
            "secret",
            "start_task",
            {"task_id": 8, "note": "Starting now"},
        )
        self.assertTrue(result["partial"])
        self.assertTrue(result["outcome_unknown"])
        self.assertEqual(result["activity"]["status"], "outcome_unknown")
        self.assertEqual(result["task"]["status_id"], 6)
        self.assertNotIn("secret", json.dumps(result))

    def test_mutation_text_rejects_invisible_controls_before_transport(self) -> None:
        transport = RecordingTransport([{}])
        with self.assertRaises(SylverPlatformValidationError):
            SylverPlatformClient(transport=transport).execute(
                "https://devops.sylver-lining.org",
                "secret",
                "add_task_activity",
                {"task_id": 8, "detail": "visible\u202ehidden"},
            )
        self.assertEqual(transport.calls, [])

    def test_mutations_require_all_user_visible_effective_arguments(self) -> None:
        client = SylverPlatformClient(transport=RecordingTransport([]))
        with self.assertRaises(SylverPlatformValidationError):
            client.execute(
                "https://devops.sylver-lining.org",
                "secret",
                "start_task",
                {"task_id": 8},
            )
        with self.assertRaisesRegex(
            SylverPlatformValidationError, "content_format and order"
        ):
            client.execute(
                "https://devops.sylver-lining.org",
                "secret",
                "propose_wiki",
                {
                    "project_slug": "project-a",
                    "title": "Overview",
                    "slug": "overview",
                    "content": "# Overview",
                    "source_document_id": "project-a/overview",
                    "change_summary": "Create overview",
                },
            )

    def test_remote_json_scrubs_credentials_without_removing_authors(self) -> None:
        token = "personal-secret"
        transport = RecordingTransport(
            [
                {
                    "author_name": "Alice",
                    "access_token": token,
                    "detail": f"Authorization: Bearer {token}",
                },
                {
                    "authorization": f"Bearer {token}",
                    "status": f"saved with {token}",
                },
            ]
        )
        client = SylverPlatformClient(transport=transport)
        read_result = client.execute(
            "https://devops.sylver-lining.org", token, "tasks", {}
        )
        mutation_result = client.execute(
            "https://devops.sylver-lining.org",
            token,
            "add_task_activity",
            {"task_id": 8, "detail": "Progress"},
        )
        combined = repr((read_result, mutation_result))
        self.assertNotIn(token, combined)
        self.assertEqual(read_result["author_name"], "Alice")
        self.assertEqual(read_result["access_token"], "[redacted]")
        self.assertEqual(read_result["detail"], "Authorization: Bearer [redacted]")
        self.assertEqual(mutation_result["authorization"], "[redacted]")

    def test_identity_rejects_a_token_echo_without_leaking_it(self) -> None:
        token = "personal-secret"
        transport = RecordingTransport(
            [{"id": 13, "username": f"alice-{token}", "full_name": "Alice"}]
        )
        with self.assertRaises(SylverPlatformError) as caught:
            SylverPlatformClient(transport=transport).verify_identity(
                "https://devops.sylver-lining.org", token
            )
        self.assertNotIn(token, str(caught.exception))
        self.assertNotIn(token, repr(caught.exception))

    def test_malformed_remote_identity_and_workflow_are_gateway_failures(self) -> None:
        with self.assertRaises(SylverPlatformError):
            SylverPlatformClient(
                transport=RecordingTransport([{"id": "invalid", "username": "alice"}])
            ).verify_identity("https://devops.sylver-lining.org", "secret")

        transport = RecordingTransport(
            [
                {"id": 8, "project_id": 4},
                {"id": 4, "workflow_id": "invalid"},
                [],
            ]
        )
        with self.assertRaises(SylverPlatformError):
            SylverPlatformClient(transport=transport).execute(
                "https://devops.sylver-lining.org",
                "secret",
                "start_task",
                {"task_id": 8, "note": "Starting task"},
            )

    def test_mutation_transport_and_response_failures_are_outcome_unknown(self) -> None:
        failures = (
            SylverPlatformError("transport dropped"),
            (503, "application/json", b'{}'),
            (200, "text/plain", b'ok'),
            (200, "application/json", b'{'),
            (200, "application/json", json.dumps({"value": "x" * 1_000_001}).encode()),
        )
        for response in failures:
            with self.subTest(response=type(response).__name__):
                client = SylverPlatformClient(transport=RecordingTransport([response]))
                with self.assertRaises(SylverPlatformError) as caught:
                    client.execute(
                        "https://devops.sylver-lining.org",
                        "secret",
                        "add_task_activity",
                        {"task_id": 8, "detail": "Progress"},
                    )
                self.assertTrue(caught.exception.outcome_unknown)
                self.assertFalse(caught.exception.retryable)
                self.assertIn("inspect remote state", str(caught.exception))

        definite = SylverPlatformClient(
            transport=RecordingTransport([(422, "application/json", b'{}')])
        )
        with self.assertRaises(SylverPlatformError) as caught:
            definite.execute(
                "https://devops.sylver-lining.org",
                "secret",
                "add_task_activity",
                {"task_id": 8, "detail": "Progress"},
            )
        self.assertFalse(caught.exception.outcome_unknown)

    def test_pathological_json_parse_failures_are_bounded_by_request_kind(self) -> None:
        pathological_documents = (
            b"[" * 2_000 + b"0" + b"]" * 2_000,
            b"1" * 5_000,
            b"NaN",
            b"1e999",
        )
        for response_body in pathological_documents:
            with self.subTest(kind="read", length=len(response_body)):
                client = SylverPlatformClient(
                    transport=RecordingTransport(
                        [(200, "application/json", response_body)]
                    )
                )
                with self.assertRaises(SylverPlatformError) as caught:
                    client.execute(
                        "https://devops.sylver-lining.org",
                        "secret",
                        "tasks",
                        {},
                    )
                self.assertFalse(caught.exception.outcome_unknown)
                self.assertEqual(
                    str(caught.exception),
                    "remote platform returned invalid JSON",
                )

            with self.subTest(kind="mutation", length=len(response_body)):
                client = SylverPlatformClient(
                    transport=RecordingTransport(
                        [(200, "application/json", response_body)]
                    )
                )
                with self.assertRaises(SylverPlatformError) as caught:
                    client.execute(
                        "https://devops.sylver-lining.org",
                        "secret",
                        "add_task_activity",
                        {"task_id": 8, "detail": "Progress"},
                    )
                self.assertTrue(caught.exception.outcome_unknown)
                self.assertFalse(caught.exception.retryable)
                self.assertIn("inspect remote state", str(caught.exception))

    def test_default_transport_converts_incomplete_reads_without_leaking_token(
        self,
    ) -> None:
        with patch(
            "enterprise_agent_platform.sylver_platform_client."
            "build_trusted_service_opener",
            return_value=IncompleteReadOpener(),
        ):
            client = SylverPlatformClient()
            with self.assertRaises(SylverPlatformError) as read_caught:
                client.execute(
                    "https://devops.sylver-lining.org",
                    "personal-secret",
                    "tasks",
                    {},
                )
            with self.assertRaises(SylverPlatformError) as mutation_caught:
                client.execute(
                    "https://devops.sylver-lining.org",
                    "personal-secret",
                    "add_task_activity",
                    {"task_id": 8, "detail": "Progress"},
                )

        self.assertEqual(str(read_caught.exception), "remote platform is unreachable")
        self.assertTrue(read_caught.exception.retryable)
        self.assertFalse(read_caught.exception.outcome_unknown)
        self.assertTrue(mutation_caught.exception.outcome_unknown)
        self.assertFalse(mutation_caught.exception.retryable)
        self.assertIn("inspect remote state", str(mutation_caught.exception))
        self.assertNotIn("personal-secret", str(read_caught.exception))
        self.assertNotIn("personal-secret", str(mutation_caught.exception))

    def test_remote_error_never_includes_response_body_or_token(self) -> None:
        transport = RecordingTransport([(401, "application/json", b'{"detail":"secret body"}')])
        with self.assertRaises(SylverPlatformError) as caught:
            SylverPlatformClient(transport=transport).verify_identity(
                "https://devops.sylver-lining.org", "personal-secret"
            )
        message = str(caught.exception)
        self.assertIn("HTTP 401", message)
        self.assertNotIn("secret body", message)
        self.assertNotIn("personal-secret", message)


if __name__ == "__main__":
    unittest.main()
