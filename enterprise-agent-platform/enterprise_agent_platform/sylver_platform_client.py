from __future__ import annotations

import datetime as dt
import http.client
import json
import math
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

from .loopback_http import build_trusted_service_opener


DEFAULT_TIMEOUT_SECONDS = 20.0
SYLVER_PLATFORM_BASE_URL = "https://devops.sylver-lining.org"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_TOKEN_CHARACTERS = 4096
MAX_TEXT_CHARACTERS = 64 * 1024
MAX_CONTENT_CHARACTERS = 1_000_000
MAX_JSON_DEPTH = 20
MAX_JSON_NODES = 50_000

READ_ACTIONS = frozenset(
    {
        "whoami",
        "projects",
        "project",
        "project_context",
        "tasks",
        "task",
        "task_activity",
        "wiki_list",
        "wiki_read",
        "approvals",
        "approval",
        "approval_comments",
        "notifications",
    }
)
MUTATION_ACTIONS = frozenset(
    {
        "create_task",
        "start_task",
        "add_task_activity",
        "propose_wiki",
        "comment_approval",
    }
)
SUPPORTED_ACTIONS = READ_ACTIONS | MUTATION_ACTIONS

_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
_FORBIDDEN_TEXT_CONTROLS_RE = re.compile(
    r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f"
    r"\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]"
)
_SENSITIVE_RESPONSE_KEYS = frozenset(
    {
        "auth",
        "authorization",
        "cookie",
        "credential",
        "password",
        "passwd",
        "secret",
        "token",
    }
)
_Transport = Callable[
    [str, str, dict[str, str], bytes | None, float, int],
    tuple[int, str, bytes],
]


class SylverPlatformError(RuntimeError):
    """A bounded connector failure that is safe to return without remote data."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retryable: bool = False,
        outcome_unknown: bool = False,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.retryable = bool(retryable)
        self.outcome_unknown = bool(outcome_unknown)


class SylverPlatformValidationError(ValueError):
    pass


def normalize_base_url(value: Any) -> str:
    if not isinstance(value, str):
        raise SylverPlatformValidationError("platform URL must be a string")
    raw = value
    if (
        not raw
        or len(raw) > 2048
        or raw != raw.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in raw)
    ):
        raise SylverPlatformValidationError("platform URL is invalid")
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise SylverPlatformValidationError("platform URL is invalid") from exc
    hostname = str(parsed.hostname or "")
    if (
        parsed.scheme.casefold() != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or (port is not None and not 1 <= port <= 65_535)
    ):
        raise SylverPlatformValidationError(
            "platform URL must be a credential-free HTTPS origin"
        )
    scheme = parsed.scheme.casefold()
    try:
        ascii_hostname = hostname.encode("idna").decode("ascii").casefold()
    except UnicodeError as exc:
        raise SylverPlatformValidationError("platform URL hostname is invalid") from exc
    if ":" in ascii_hostname:
        ascii_hostname = f"[{ascii_hostname}]"
    default_port = 443 if scheme == "https" else 80
    authority = ascii_hostname
    if port is not None and port != default_port:
        authority = f"{authority}:{port}"
    normalized = urllib.parse.urlunsplit((scheme, authority, "", "", ""))
    if normalized != SYLVER_PLATFORM_BASE_URL:
        raise SylverPlatformValidationError(
            "platform URL must be the fixed Sylver Lining origin"
        )
    return normalized


def validate_personal_token(value: Any) -> str:
    if not isinstance(value, str):
        raise SylverPlatformValidationError("Personal API Token must be a string")
    if (
        not value
        or len(value) > MAX_TOKEN_CHARACTERS
        or value != value.strip()
        or any(ord(character) < 33 or ord(character) > 126 for character in value)
    ):
        raise SylverPlatformValidationError("Personal API Token is invalid")
    return value


def _default_transport(
    url: str,
    method: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout_seconds: float,
    max_response_bytes: int,
) -> tuple[int, str, bytes]:
    request = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method=method,
    )
    try:
        opener = build_trusted_service_opener()
        with opener.open(
            request, timeout=timeout_seconds
        ) as response:
            payload = response.read(max_response_bytes + 1)
            if len(payload) > max_response_bytes:
                raise SylverPlatformError(
                    "remote platform response exceeds the size limit"
                )
            return (
                int(response.status),
                str(response.headers.get("Content-Type") or ""),
                payload,
            )
    except urllib.error.HTTPError as exc:
        exc.close()
        raise SylverPlatformError(
            f"remote platform returned HTTP {int(exc.code)}",
            status_code=int(exc.code),
            retryable=int(exc.code) == 429 or 500 <= int(exc.code) <= 599,
        ) from exc
    except (
        urllib.error.URLError,
        http.client.HTTPException,
        TimeoutError,
        OSError,
    ) as exc:
        mutation = method in {"POST", "PUT", "PATCH", "DELETE"}
        raise SylverPlatformError(
            (
                "remote platform mutation outcome is unknown; inspect remote state "
                "before any retry"
                if mutation
                else "remote platform is unreachable"
            ),
            retryable=not mutation,
            outcome_unknown=mutation,
        ) from exc


def _closed(arguments: Mapping[str, Any], allowed: set[str]) -> dict[str, Any]:
    unknown = sorted(set(arguments) - allowed)
    if unknown:
        raise SylverPlatformValidationError(
            "unsupported platform tool arguments: " + ", ".join(unknown)
        )
    return dict(arguments)


def _positive_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise SylverPlatformValidationError(f"{field} must be a positive integer")
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise SylverPlatformValidationError(
            f"{field} must be a positive integer"
        ) from exc
    if result <= 0 or result > 9_007_199_254_740_991 or str(value).strip() != str(result):
        raise SylverPlatformValidationError(f"{field} must be a positive integer")
    return result


def _integer(value: Any, *, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise SylverPlatformValidationError(f"{field} must be an integer")
    if value < minimum or value > maximum:
        raise SylverPlatformValidationError(f"{field} is outside the supported range")
    return value


def _boolean(value: Any, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise SylverPlatformValidationError(f"{field} must be a boolean")
    return value


def _text(
    value: Any,
    *,
    field: str,
    maximum: int = MAX_TEXT_CHARACTERS,
    required: bool = True,
    strip: bool = True,
) -> str:
    if not isinstance(value, str):
        raise SylverPlatformValidationError(f"{field} must be a string")
    result = value.strip() if strip else value
    if (
        (required and not result.strip())
        or len(result) > maximum
        or _FORBIDDEN_TEXT_CONTROLS_RE.search(result)
    ):
        raise SylverPlatformValidationError(f"{field} is invalid")
    try:
        result.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise SylverPlatformValidationError(f"{field} is invalid") from exc
    return result


def _remote_positive_int(value: Any, *, field: str) -> int:
    try:
        return _positive_int(value, field=field)
    except SylverPlatformValidationError as exc:
        raise SylverPlatformError("remote platform returned invalid structured data") from exc


def _remote_text(
    value: Any,
    *,
    field: str,
    maximum: int,
    required: bool = True,
) -> str:
    try:
        return _text(value, field=field, maximum=maximum, required=required)
    except SylverPlatformValidationError as exc:
        raise SylverPlatformError("remote platform returned invalid structured data") from exc


def _date(value: Any, *, field: str) -> str:
    result = _text(value, field=field, maximum=10)
    try:
        parsed = dt.date.fromisoformat(result)
    except ValueError as exc:
        raise SylverPlatformValidationError(f"{field} must use YYYY-MM-DD") from exc
    if parsed.isoformat() != result:
        raise SylverPlatformValidationError(f"{field} must use YYYY-MM-DD")
    return result


def _validated_json_tree(value: Any) -> Any:
    nodes = 0
    stack: list[tuple[Any, int]] = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > MAX_JSON_NODES or depth > MAX_JSON_DEPTH:
            raise SylverPlatformError("remote platform returned overly complex JSON")
        if isinstance(current, str):
            if len(current) > MAX_CONTENT_CHARACTERS:
                raise SylverPlatformError("remote platform returned an oversized JSON value")
        elif isinstance(current, dict):
            for key, item in current.items():
                if not isinstance(key, str) or len(key) > 256:
                    raise SylverPlatformError("remote platform returned invalid JSON fields")
                stack.append((item, depth + 1))
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, float) and not math.isfinite(current):
            raise SylverPlatformError("remote platform returned invalid JSON")
        elif current is not None and not isinstance(current, (bool, int, float)):
            raise SylverPlatformError("remote platform returned unsupported JSON data")
    return value


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"unsupported JSON constant: {value}")


def _task_description(value: Any) -> str:
    result = _text(
        value,
        field="description",
        maximum=200_000,
        strip=False,
    )
    lines = result.splitlines()
    if not lines or not lines[0].strip() or lines[0].strip().startswith("- "):
        raise SylverPlatformValidationError(
            "description must start with a one-line summary"
        )
    if any(
        line.strip() and not line.strip().startswith("- ")
        for line in lines[1:]
    ):
        raise SylverPlatformValidationError(
            "description lines after the summary must start with '- '"
        )
    return result


def _scrub_remote_json(value: Any, token: str) -> tuple[Any, bool]:
    """Remove credential echoes before remote JSON crosses the connector boundary."""
    if isinstance(value, str):
        echoed = token in value
        return value.replace(token, "[redacted]"), echoed
    if isinstance(value, list):
        result: list[Any] = []
        echoed = False
        for item in value:
            scrubbed, item_echoed = _scrub_remote_json(item, token)
            result.append(scrubbed)
            echoed = echoed or item_echoed
        return result, echoed
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        echoed = False
        for key, item in value.items():
            key_echoed = token in key
            scrubbed_key = key.replace(token, "[redacted]")
            scrubbed_item, item_echoed = _scrub_remote_json(item, token)
            echoed = echoed or key_echoed or item_echoed
            result[scrubbed_key] = (
                "[redacted]"
                if _is_sensitive_response_key(scrubbed_key)
                else scrubbed_item
            )
        return result, echoed
    return value, False


def _is_sensitive_response_key(key: str) -> bool:
    normalized = re.sub(r"(?<!^)(?=[A-Z])", "_", key).replace("-", "_").casefold()
    return normalized in _SENSITIVE_RESPONSE_KEYS or normalized.endswith(
        (
            "_token",
            "_password",
            "_passwd",
            "_secret",
            "_api_key",
            "_credential",
            "_cookie",
            "_authorization",
        )
    )


class SylverPlatformClient:
    def __init__(
        self,
        *,
        transport: _Transport | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        max_response_bytes: int = MAX_RESPONSE_BYTES,
    ):
        self._transport = transport or _default_transport
        self._timeout_seconds = max(1.0, min(float(timeout_seconds), 120.0))
        self._max_response_bytes = max(
            1024, min(int(max_response_bytes), 16 * 1024 * 1024)
        )

    def verify_identity(self, base_url: Any, token: Any) -> dict[str, Any]:
        normalized_url = normalize_base_url(base_url)
        validated_token = validate_personal_token(token)
        payload = self._request_json(
            normalized_url,
            validated_token,
            "GET",
            "/api/auth/me",
            reject_token_echo=True,
        )
        if not isinstance(payload, dict):
            raise SylverPlatformError("remote platform returned an invalid identity")
        remote_user_id = _remote_positive_int(
            payload.get("id"), field="remote identity id"
        )
        username = _remote_text(
            payload.get("username"), field="remote identity username", maximum=255
        )
        identity: dict[str, Any] = {
            "remote_user_id": remote_user_id,
            "username": username,
        }
        for field, maximum in (
            ("full_name", 512),
            ("title", 255),
            ("email", 320),
            ("role", 128),
        ):
            raw = payload.get(field)
            identity[field] = (
                _remote_text(
                    raw,
                    field=f"remote identity {field}",
                    maximum=maximum,
                    required=False,
                )
                if isinstance(raw, str)
                else ""
            )
        return identity

    def execute(
        self,
        base_url: Any,
        token: Any,
        action: Any,
        arguments: Mapping[str, Any],
    ) -> Any:
        normalized_url = normalize_base_url(base_url)
        validated_token = validate_personal_token(token)
        if not isinstance(action, str) or action not in SUPPORTED_ACTIONS:
            raise SylverPlatformValidationError("platform action is not supported")
        if not isinstance(arguments, Mapping):
            raise SylverPlatformValidationError("platform tool arguments must be an object")
        if action == "whoami":
            _closed(arguments, set())
            return self.verify_identity(normalized_url, validated_token)
        if action == "create_task":
            return self._create_task(
                normalized_url,
                validated_token,
                arguments,
            )
        method, path, query, body = self._operation(action, arguments)
        if action == "start_task":
            return self._start_task(
                normalized_url,
                validated_token,
                arguments,
            )
        return self._request_json(
            normalized_url,
            validated_token,
            method,
            path,
            query=query,
            body=body,
        )

    def _operation(
        self, action: str, arguments: Mapping[str, Any]
    ) -> tuple[str, str, list[tuple[str, str]], dict[str, Any] | None]:
        if action == "projects":
            values = _closed(arguments, {"include_archived"})
            include_archived = _boolean(
                values.get("include_archived", False), field="include_archived"
            )
            query = [("include_archived", "true")] if include_archived else []
            return "GET", "/api/projects", query, None
        if action in {"project", "project_context"}:
            values = _closed(arguments, {"project_id"})
            project_id = _positive_int(values.get("project_id"), field="project_id")
            suffix = "/context" if action == "project_context" else ""
            return "GET", f"/api/projects/{project_id}{suffix}", [], None
        if action == "tasks":
            values = _closed(arguments, {"project_id", "assigned_to_me"})
            query: list[tuple[str, str]] = []
            if _boolean(values.get("assigned_to_me", True), field="assigned_to_me"):
                query.append(("assignee", "me"))
            if "project_id" in values:
                query.append(
                    (
                        "project_id",
                        str(_positive_int(values["project_id"], field="project_id")),
                    )
                )
            return "GET", "/api/tasks", query, None
        if action in {"task", "task_activity"}:
            values = _closed(arguments, {"task_id"})
            task_id = _positive_int(values.get("task_id"), field="task_id")
            suffix = "/activity" if action == "task_activity" else ""
            return "GET", f"/api/tasks/{task_id}{suffix}", [], None
        if action == "wiki_list":
            values = _closed(arguments, {"project_id"})
            project_id = _positive_int(values.get("project_id"), field="project_id")
            return "GET", "/api/wiki/documents", [("project_id", str(project_id))], None
        if action == "wiki_read":
            values = _closed(arguments, {"document_id"})
            document_id = _positive_int(values.get("document_id"), field="document_id")
            return "GET", f"/api/wiki/documents/{document_id}", [], None
        if action == "approvals":
            values = _closed(arguments, {"box"})
            box = _text(values.get("box", "inbox"), field="box", maximum=16)
            if box not in {"inbox", "outbox", "all"}:
                raise SylverPlatformValidationError("box is invalid")
            return "GET", "/api/approvals", [("box", box)], None
        if action in {"approval", "approval_comments"}:
            values = _closed(arguments, {"approval_id"})
            approval_id = _positive_int(values.get("approval_id"), field="approval_id")
            suffix = "/comments" if action == "approval_comments" else ""
            return "GET", f"/api/approvals/{approval_id}{suffix}", [], None
        if action == "notifications":
            values = _closed(arguments, {"unread_only"})
            unread_only = _boolean(
                values.get("unread_only", True), field="unread_only"
            )
            query = [("unread_only", "true")] if unread_only else []
            return "GET", "/api/notifications", query, None
        if action == "create_task":
            allowed = {
                "project_id", "title", "tag_ids", "start_date", "due_date",
                "description", "milestone_id", "assignee_id", "proposal_approver_id",
            }
            values = _closed(arguments, allowed)
            if "milestone_id" not in values:
                raise SylverPlatformValidationError(
                    "milestone_id must be a positive integer or explicit null"
                )
            raw_tag_ids = values.get("tag_ids")
            if not isinstance(raw_tag_ids, list) or not raw_tag_ids or len(raw_tag_ids) > 50:
                raise SylverPlatformValidationError("tag_ids must be a non-empty array")
            tag_ids = [_positive_int(value, field="tag_ids") for value in raw_tag_ids]
            if len(set(tag_ids)) != len(tag_ids):
                raise SylverPlatformValidationError("tag_ids must be unique")
            start_date = _date(values.get("start_date"), field="start_date")
            due_date = _date(values.get("due_date"), field="due_date")
            if due_date < start_date:
                raise SylverPlatformValidationError("due_date must not precede start_date")
            body: dict[str, Any] = {
                "project_id": _positive_int(values.get("project_id"), field="project_id"),
                "title": _text(values.get("title"), field="title", maximum=512),
                "tag_ids": tag_ids,
                "start_date": start_date,
                "due_date": due_date,
            }
            if "description" in values:
                body["description"] = _task_description(values["description"])
            if values["milestone_id"] is not None:
                body["milestone_id"] = _positive_int(
                    values["milestone_id"], field="milestone_id"
                )
            for field in ("assignee_id", "proposal_approver_id"):
                if field in values:
                    body[field] = _positive_int(values[field], field=field)
            return "POST", "/api/tasks", [], body
        if action == "add_task_activity":
            values = _closed(arguments, {"task_id", "detail"})
            task_id = _positive_int(values.get("task_id"), field="task_id")
            detail = _text(
                values.get("detail"), field="detail", maximum=200_000, strip=False
            )
            return "POST", f"/api/tasks/{task_id}/activity", [], {"detail": detail}
        if action == "propose_wiki":
            allowed = {
                "project_slug", "title", "slug", "content", "content_format",
                "source_document_id", "order", "change_summary", "discussion_ref",
            }
            values = _closed(arguments, allowed)
            project_slug = _text(
                values.get("project_slug"), field="project_slug", maximum=200
            )
            slug = _text(values.get("slug"), field="slug", maximum=200)
            if not _SLUG_RE.fullmatch(project_slug) or not _SLUG_RE.fullmatch(slug):
                raise SylverPlatformValidationError("wiki project_slug or slug is invalid")
            if "content_format" not in values or "order" not in values:
                raise SylverPlatformValidationError(
                    "content_format and order must be explicit"
                )
            content_format = _text(
                values.get("content_format"),
                field="content_format",
                maximum=16,
            )
            if content_format not in {"markdown", "html", "html_full"}:
                raise SylverPlatformValidationError("content_format is invalid")
            body = {
                "project_slug": project_slug,
                "title": _text(values.get("title"), field="title", maximum=512),
                "slug": slug,
                "content": _text(
                    values.get("content"),
                    field="content",
                    maximum=MAX_CONTENT_CHARACTERS,
                    strip=False,
                ),
                "content_format": content_format,
                "source_document_id": _text(
                    values.get("source_document_id"),
                    field="source_document_id",
                    maximum=512,
                ),
                "order": _integer(
                    values.get("order"),
                    field="order",
                    minimum=-9_007_199_254_740_991,
                    maximum=9_007_199_254_740_991,
                ),
                "change_summary": _text(
                    values.get("change_summary"),
                    field="change_summary",
                    maximum=20_000,
                    strip=False,
                ),
            }
            if "discussion_ref" in values:
                body["discussion_ref"] = _text(
                    values["discussion_ref"],
                    field="discussion_ref",
                    maximum=20_000,
                    required=False,
                    strip=False,
                )
            return "POST", "/api/wiki/proposals", [], body
        if action == "comment_approval":
            values = _closed(arguments, {"approval_id", "body"})
            approval_id = _positive_int(values.get("approval_id"), field="approval_id")
            comment = _text(
                values.get("body"), field="body", maximum=200_000, strip=False
            )
            return (
                "POST",
                f"/api/approvals/{approval_id}/comments",
                [],
                {"body": comment, "kind": "comment"},
            )
        if action == "start_task":
            _closed(arguments, {"task_id", "note"})
            return "PATCH", "", [], None
        raise SylverPlatformValidationError("platform action is not supported")

    def _project_workflow_statuses(
        self,
        base_url: str,
        token: str,
        project_id: int,
    ) -> list[dict[str, Any]]:
        project = self._request_json(
            base_url, token, "GET", f"/api/projects/{project_id}"
        )
        workflows = self._request_json(base_url, token, "GET", "/api/workflows")
        if not isinstance(project, dict) or not isinstance(workflows, list):
            raise SylverPlatformError("remote platform returned invalid workflow data")
        workflow_id = _remote_positive_int(
            project.get("workflow_id"), field="remote project workflow_id"
        )
        matches: list[dict[str, Any]] = []
        for item in workflows:
            if not isinstance(item, dict):
                continue
            try:
                candidate_id = _remote_positive_int(
                    item.get("id"), field="remote workflow id"
                )
            except SylverPlatformError:
                continue
            if candidate_id == workflow_id:
                matches.append(item)
        if len(matches) != 1 or not isinstance(matches[0].get("statuses"), list):
            raise SylverPlatformError("remote project workflow is unavailable")
        return [
            item
            for item in matches[0]["statuses"]
            if isinstance(item, dict)
        ]

    @staticmethod
    def _workflow_category_ids(
        statuses: list[dict[str, Any]],
        category: str,
    ) -> list[int]:
        result: list[int] = []
        for item in statuses:
            if item.get("category") != category:
                continue
            result.append(
                _remote_positive_int(
                    item.get("id"), field=f"remote {category} status id"
                )
            )
        return result

    def _create_task(
        self,
        base_url: str,
        token: str,
        arguments: Mapping[str, Any],
    ) -> Any:
        method, path, query, body = self._operation("create_task", arguments)
        assert body is not None
        project_id = int(body["project_id"])
        statuses = self._project_workflow_statuses(base_url, token, project_id)
        proposed_ids = self._workflow_category_ids(statuses, "proposed")
        if len(proposed_ids) > 1:
            raise SylverPlatformError(
                "remote project workflow has ambiguous proposed statuses"
            )
        if not proposed_ids:
            if "proposal_approver_id" in body:
                raise SylverPlatformValidationError(
                    "proposal_approver_id requires a proposed workflow status"
                )
            backlog_ids = self._workflow_category_ids(statuses, "backlog")
            if len(backlog_ids) != 1:
                raise SylverPlatformError(
                    "remote project workflow has no unambiguous backlog status"
                )
            body["status_id"] = backlog_ids[0]
        return self._request_json(
            base_url,
            token,
            method,
            path,
            query=query,
            body=body,
        )

    def _start_task(
        self,
        base_url: str,
        token: str,
        arguments: Mapping[str, Any],
    ) -> dict[str, Any]:
        values = _closed(arguments, {"task_id", "note"})
        task_id = _positive_int(values.get("task_id"), field="task_id")
        note = _text(values.get("note"), field="note", maximum=20_000, strip=False)
        task = self._request_json(base_url, token, "GET", f"/api/tasks/{task_id}")
        if not isinstance(task, dict):
            raise SylverPlatformError("remote platform returned an invalid task")
        project_id = _remote_positive_int(
            task.get("project_id"), field="remote task project_id"
        )
        statuses = self._project_workflow_statuses(base_url, token, project_id)
        active_ids = self._workflow_category_ids(statuses, "active")
        if len(active_ids) != 1:
            raise SylverPlatformError(
                "remote project workflow has no unambiguous active status"
            )
        active_status_id = active_ids[0]
        updated = self._request_json(
            base_url,
            token,
            "PATCH",
            f"/api/tasks/{task_id}",
            body={"status_id": active_status_id},
        )
        try:
            activity = self._request_json(
                base_url,
                token,
                "POST",
                f"/api/tasks/{task_id}/activity",
                body={"detail": note},
            )
        except SylverPlatformError as exc:
            return {
                "task": updated,
                "activity": {
                    "status": (
                        "outcome_unknown" if exc.outcome_unknown else "failed"
                    ),
                    "error": str(exc),
                },
                "partial": True,
                "outcome_unknown": exc.outcome_unknown,
            }
        return {"task": updated, "activity": activity, "partial": False}

    def _request_json(
        self,
        base_url: str,
        token: str,
        method: str,
        path: str,
        *,
        query: list[tuple[str, str]] | None = None,
        body: dict[str, Any] | None = None,
        reject_token_echo: bool = False,
    ) -> Any:
        if not path.startswith("/api/") or "?" in path or "#" in path:
            raise RuntimeError("connector attempted an invalid fixed API path")
        url = base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        payload = (
            json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if body is not None
            else None
        )
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "agent-platform-sylver-connector/1",
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        mutation = method in {"POST", "PUT", "PATCH", "DELETE"}
        try:
            status, content_type, response_body = self._transport(
                url,
                method,
                headers,
                payload,
                self._timeout_seconds,
                self._max_response_bytes,
            )
        except SylverPlatformError as exc:
            if mutation and not (
                exc.status_code is not None and 400 <= exc.status_code < 500
            ):
                if exc.outcome_unknown:
                    raise
                raise SylverPlatformError(
                    "remote platform mutation outcome is unknown; inspect remote state "
                    "before any retry",
                    outcome_unknown=True,
                ) from exc
            raise
        if status < 200 or status >= 300:
            if mutation and status >= 500:
                raise SylverPlatformError(
                    "remote platform mutation outcome is unknown; inspect remote state "
                    "before any retry",
                    status_code=status,
                    outcome_unknown=True,
                )
            raise SylverPlatformError(
                f"remote platform returned HTTP {status}",
                status_code=status,
                retryable=status == 429 or 500 <= status <= 599,
            )
        if content_type.split(";", 1)[0].strip().casefold() != "application/json":
            if mutation:
                raise SylverPlatformError(
                    "remote platform mutation outcome is unknown; inspect remote state "
                    "before any retry",
                    outcome_unknown=True,
                )
            raise SylverPlatformError("remote platform returned a non-JSON response")
        try:
            result = json.loads(
                response_body,
                parse_constant=_reject_json_constant,
            )
        except (UnicodeDecodeError, ValueError, RecursionError) as exc:
            if mutation:
                raise SylverPlatformError(
                    "remote platform mutation outcome is unknown; inspect remote state "
                    "before any retry",
                    outcome_unknown=True,
                ) from exc
            raise SylverPlatformError("remote platform returned invalid JSON") from exc
        try:
            validated = _validated_json_tree(result)
        except SylverPlatformError as exc:
            if mutation:
                raise SylverPlatformError(
                    "remote platform mutation outcome is unknown; inspect remote state "
                    "before any retry",
                    outcome_unknown=True,
                ) from exc
            raise
        scrubbed, token_echoed = _scrub_remote_json(validated, token)
        if reject_token_echo and token_echoed:
            raise SylverPlatformError(
                "remote platform returned an unsafe identity response"
            )
        return scrubbed
