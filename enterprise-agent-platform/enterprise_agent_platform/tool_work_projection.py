from __future__ import annotations

import re
import urllib.parse
from pathlib import Path
from typing import Any

from .container_contract_generated import CONTAINER_PATHS


COMPUTER_WORKSPACE_PATH_MAX = 240


def agent_tool_detail(event: dict[str, Any]) -> str:
    """Return a bounded, secret-redacted summary for a visible tool row.

    Raw tool arguments are never copied wholesale into message metadata. Only
    a small allowlist of useful fields is considered, and write/patch bodies are
    intentionally excluded. Terminal is the deliberate exception to the old
    action-only summary: the command that reached ``tool.started`` has already
    passed Runtime approval and is useful execution context, so retain its
    structure and parameters after secret redaction.
    """

    tool = str(event.get("tool") or event.get("tool_name") or "").strip().lower()
    arguments = event.get("arguments")
    if tool == "session_search":
        # Cross-session queries commonly contain exact user phrases and may
        # include credentials. Regex-based secret scrubbing cannot make
        # arbitrary prose safe to persist in visible work records, so retain
        # only the bounded action name.
        action = (
            _safe_tool_summary_text(arguments.get("action"), limit=40)
            if isinstance(arguments, dict)
            else ""
        )
        return action or "session_search"
    if tool == "terminal":
        # Only the Runtime's actual tool arguments are authoritative here. Do
        # not fall back to an event label/preview: those strings are not proof
        # that a command passed approval and was sent to the terminal tool.
        return (
            _safe_terminal_command_preview(arguments.get("command"))
            if isinstance(arguments, dict)
            else ""
        )
    explicit = str(event.get("label") or event.get("preview") or "").strip()
    if explicit and explicit.lower() not in {tool, "tool"}:
        return _safe_tool_summary_text(explicit)
    if not isinstance(arguments, dict):
        return ""

    if tool == "process":
        return _safe_tool_summary_text(arguments.get("action"))
    if tool in {"read_file", "write_file", "patch_file"}:
        return _safe_tool_path(arguments.get("path"))
    if tool == "search_files":
        parts = [
            _safe_tool_summary_text(arguments.get("query")),
            _safe_tool_path(arguments.get("path")),
        ]
        return " · ".join(part for part in parts if part and part != ".")[:160]

    action = _safe_tool_summary_text(arguments.get("action"), limit=40)
    nested = arguments.get("arguments")
    nested = nested if isinstance(nested, dict) else {}
    if tool == "skill" and action in {"load", "read"}:
        skill_id = _safe_skill_trace_id(nested.get("id"))
        if not skill_id:
            return action
        parts = [action, skill_id]
        if action == "read":
            file_path = _safe_skill_trace_file_path(nested.get("file_path"))
            if file_path:
                parts.append(file_path)
        return " · ".join(parts)
    if tool in {"web", "memory", "session", "session_search"}:
        query = _safe_tool_summary_text(nested.get("query") or nested.get("q"))
        url = _safe_tool_url(nested.get("url"))
        identifier = _safe_tool_summary_text(nested.get("document_id") or nested.get("id"), limit=40)
        primary = query or url or identifier
        if primary:
            return primary
    if tool == "browser":
        url = _safe_tool_url(nested.get("url"))
        parts = [action, url]
        return " · ".join(part for part in parts if part)[:160]
    return action


_RESULT_OMITTED_TOOLS = frozenset(
    {"mail", "mcp", "memory", "session", "session_search"}
)
_AGENT_WORK_TARGET_VALUES = frozenset({"sandbox", "host"})
_AGENT_WORK_BACKGROUND_KINDS = frozenset({"task", "service"})
_AGENT_WORK_DELEGATE_ROLES = frozenset({"leaf", "orchestrator"})


def workspace_relative_path(value: Any) -> str:
    """Return a stable /workspace-relative path, or empty when not a descendant."""

    raw = str(value or "").strip().replace("\\", "/")
    if (
        not raw
        or len(raw) > COMPUTER_WORKSPACE_PATH_MAX
        or any(ord(character) < 32 or ord(character) == 127 for character in raw)
    ):
        return ""
    logical = Path(CONTAINER_PATHS["workspace"])
    try:
        supplied = Path(raw)
        relative = supplied.relative_to(logical) if supplied.is_absolute() else supplied
    except ValueError:
        return ""
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        return ""
    rendered = relative.as_posix()
    return rendered if len(rendered) <= COMPUTER_WORKSPACE_PATH_MAX else ""


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def agent_tool_parameters(event: dict[str, Any]) -> dict[str, Any]:
    """Return a closed-world, secret-redacted argument map for expanded work details."""

    tool = str(event.get("tool") or event.get("tool_name") or "").strip().lower()
    arguments = event.get("arguments")
    if not isinstance(arguments, dict):
        return {}
    if tool == "session_search":
        action = _safe_tool_summary_text(arguments.get("action"), limit=40)
        return {"action": action} if action else {}
    if tool == "terminal":
        parameters: dict[str, Any] = {}
        command = _safe_terminal_command_preview(arguments.get("command"))
        if command:
            parameters["command"] = command
        if arguments.get("background") is True:
            parameters["background"] = True
        kind = str(arguments.get("background_kind") or "").strip().lower()
        if kind in _AGENT_WORK_BACKGROUND_KINDS:
            parameters["background_kind"] = kind
        timeout_ms = _optional_int(arguments.get("timeout_ms"))
        if timeout_ms is not None:
            parameters["timeout_ms"] = timeout_ms
        target = str(arguments.get("target") or "").strip().lower()
        if target in _AGENT_WORK_TARGET_VALUES:
            parameters["target"] = target
        cwd = _safe_tool_path(arguments.get("cwd")) if arguments.get("cwd") else ""
        if cwd:
            parameters["cwd"] = cwd
        return parameters
    if tool in {"read_file", "write_file", "patch_file"}:
        parameters = {}
        path = _safe_tool_path(arguments.get("path"))
        if path:
            parameters["path"] = path
        target = str(arguments.get("target") or "").strip().lower()
        if target in _AGENT_WORK_TARGET_VALUES:
            parameters["target"] = target
        if target != "host":
            workspace_path = workspace_relative_path(arguments.get("path"))
            if workspace_path:
                parameters["workspace_path"] = workspace_path
        if tool == "read_file":
            offset = _optional_int(arguments.get("offset"))
            if offset is not None:
                parameters["offset"] = offset
            limit = _optional_int(arguments.get("limit"))
            if limit is not None:
                parameters["limit"] = limit
        return parameters
    if tool == "search_files":
        parameters = {}
        query = _safe_tool_summary_text(arguments.get("query"), limit=240)
        if query:
            parameters["query"] = query
        path = _safe_tool_path(arguments.get("path"))
        if path and path != ".":
            parameters["path"] = path
        if arguments.get("regex") is True:
            parameters["regex"] = True
        max_results = _optional_int(arguments.get("max_results"))
        if max_results is not None:
            parameters["max_results"] = max_results
        return parameters
    if tool == "process":
        parameters = {}
        action = _safe_tool_summary_text(arguments.get("action"), limit=40)
        if action:
            parameters["action"] = action
        process_id = _safe_tool_summary_text(arguments.get("process_id"), limit=80)
        if process_id:
            parameters["process_id"] = process_id
        timeout_ms = _optional_int(arguments.get("timeout_ms"))
        if timeout_ms is not None:
            parameters["timeout_ms"] = timeout_ms
        return parameters
    if tool == "delegate_task":
        parameters = {}
        role = str(arguments.get("role") or "").strip().lower()
        if role in _AGENT_WORK_DELEGATE_ROLES:
            parameters["role"] = role
        tasks = arguments.get("tasks")
        if isinstance(tasks, list):
            parameters["task_count"] = len(tasks)
        return parameters

    action = _safe_tool_summary_text(arguments.get("action"), limit=40)
    nested = arguments.get("arguments")
    nested = nested if isinstance(nested, dict) else {}
    if tool == "mail":
        return {"action": action} if action else {}
    if tool == "skill":
        parameters = {}
        if action:
            parameters["action"] = action
        skill_id = _safe_skill_trace_id(nested.get("id"))
        if skill_id:
            parameters["id"] = skill_id
        if action == "read":
            file_path = _safe_skill_trace_file_path(nested.get("file_path"))
            if file_path:
                parameters["file_path"] = file_path
        return parameters
    if tool == "mcp":
        parameters = {"action": action} if action else {}
        server = str(nested.get("server") or "").strip()
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", server):
            parameters["server"] = server
        tool_name = _safe_tool_summary_text(
            nested.get("tool"),
            limit=256,
            redact_paths=False,
        )
        if tool_name:
            parameters["tool"] = tool_name
        return parameters
    if tool in {"web", "memory", "session", "browser", "schedule"}:
        parameters = {}
        if action:
            parameters["action"] = action
        if tool == "browser":
            host = _safe_tool_url(nested.get("url") or arguments.get("url"))
            if host:
                parameters["host"] = host
            return parameters
        if tool in {"schedule", "memory", "session"}:
            return parameters
        query = _safe_tool_summary_text(nested.get("query") or nested.get("q"), limit=240)
        if query:
            parameters["query"] = query
        host = _safe_tool_url(nested.get("url"))
        if host:
            parameters["host"] = host
        identifier = _safe_tool_summary_text(
            nested.get("document_id") or nested.get("id"),
            limit=80,
        )
        if identifier:
            parameters["id"] = identifier
        return parameters
    return {"action": action} if action else {}


def _tool_result_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return _safe_tool_summary_text(
            value,
            limit=4096,
            preserve_whitespace=True,
            redact_paths=False,
        )
    if not isinstance(value, dict):
        return ""
    content = value.get("content")
    if isinstance(content, str):
        return _safe_tool_summary_text(
            content,
            limit=4096,
            preserve_whitespace=True,
            redact_paths=False,
        )
    if isinstance(content, list):
        texts = [
            str(block.get("text") or "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        joined = "\n".join(part for part in texts if part)
        if joined:
            return _safe_tool_summary_text(
                joined,
                limit=4096,
                preserve_whitespace=True,
                redact_paths=False,
            )
    details = value.get("details")
    if isinstance(details, (str, int, float)) and not isinstance(details, bool):
        return _safe_tool_summary_text(
            details,
            limit=1024,
            preserve_whitespace=True,
            redact_paths=False,
        )
    return ""


def agent_tool_result_preview(event: dict[str, Any]) -> str:
    """Return a bounded, secret-redacted result or error for expanded work details."""

    tool = str(event.get("tool") or event.get("tool_name") or "").strip().lower()
    if tool in _RESULT_OMITTED_TOOLS:
        return ""
    event_type = str(
        event.get("event") or event.get("type") or event.get("event_type") or ""
    ).strip().lower()
    if event_type not in {"tool.completed", "tool.failed", "completed", "failed", "error"}:
        return ""
    parts: list[str] = []
    error = str(event.get("error") or event.get("reason") or "").strip()
    if error and (event.get("is_error") is True or event_type in {"tool.failed", "failed", "error"}):
        redacted = _safe_tool_summary_text(
            error,
            limit=500,
            preserve_whitespace=True,
            redact_paths=False,
        )
        if redacted:
            parts.append(redacted)
    preview = _tool_result_text(event.get("result"))
    if preview:
        parts.append(preview)
    return "\n\n".join(parts)


def _tool_work_detail_fields(event: dict[str, Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    parameters = agent_tool_parameters(event)
    if parameters:
        fields["parameters"] = parameters
    result = agent_tool_result_preview(event)
    if result:
        fields["result"] = result
    return fields


_SKILL_TRACE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_SKILL_TRACE_FILE_ROOTS = frozenset({"references", "templates", "scripts", "assets"})


def _safe_skill_trace_id(value: Any) -> str:
    """Return only a canonical Skill package id for a learning trace."""

    raw = str(value or "").strip()
    return raw if _SKILL_TRACE_ID_RE.fullmatch(raw) else ""


def _safe_skill_trace_file_path(value: Any) -> str:
    """Return a bounded relative Skill support path with secrets redacted."""

    raw = str(value or "").strip()
    if (
        not raw
        or len(raw) > 240
        or raw.startswith("/")
        or "\\" in raw
        or any(ord(character) < 32 or ord(character) == 127 for character in raw)
    ):
        return ""
    parts = raw.split("/")
    if (
        parts[0] not in _SKILL_TRACE_FILE_ROOTS
        or any(
            not part
            or part in {".", ".."}
            or len(part.encode("utf-8")) > 255
            for part in parts
        )
    ):
        return ""
    return _safe_tool_summary_text(raw, limit=240, redact_paths=False)


def _safe_tool_path(value: Any) -> str:
    clean = _safe_tool_summary_text(value, limit=120)
    if not clean:
        return ""
    path = Path(clean)
    if path.is_absolute():
        return f"…/{path.name}" if path.name else "…"
    return clean


def _safe_terminal_command_preview(value: Any) -> str:
    """Return the approved command with useful arguments and secrets masked.

    The preview preserves a command-centric terminal display instead of reducing
    a call to executable names. It stays bounded because this value is copied
    into live status and persisted message metadata. Newlines are preserved so
    compound commands remain readable in the UI.
    """

    return _redact_terminal_command_credentials(
        _safe_tool_summary_text(
            value,
            limit=4096,
            preserve_whitespace=True,
            redact_paths=False,
        )
    )


def _safe_tool_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urllib.parse.urlsplit(raw)
        hostname = parsed.hostname or ""
        if not hostname and "://" not in raw and not raw.startswith(("/", "?", "#")):
            hostname = urllib.parse.urlsplit(f"//{raw}").hostname or ""
    except ValueError:
        return ""
    # Userinfo, path parameters, query strings and fragments may all carry
    # credentials. The host is enough context for a compact activity row.
    return _safe_tool_summary_text(hostname)


def _safe_tool_summary_text(
    value: Any,
    *,
    limit: int = 160,
    preserve_whitespace: bool = False,
    redact_paths: bool = True,
) -> str:
    raw = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    if preserve_whitespace:
        clean = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+", " ", raw).strip()
    else:
        clean = re.sub(r"[\x00-\x1f\x7f]+", " ", raw)
        clean = re.sub(r"\s+", " ", clean).strip()
    if not clean:
        return ""
    clean = re.sub(
        r"(?i)([\"'])((?:authorization|(?:set-)?cookie)\s*:).*?\1",
        lambda match: f"{match.group(1)}{match.group(2)} •••{match.group(1)}",
        clean,
    )
    # Handle multi-token authentication headers before the generic named-secret
    # matcher. Otherwise the generic rule consumes only ``Bearer``/``Basic`` as
    # the value of ``Authorization`` and leaves the actual credential behind.
    clean = re.sub(
        r"(?i)\b(authorization(?:\s*:\s*|\s+)(?:bearer|basic))\s+\S+",
        r"\1 •••",
        clean,
    )

    def redact_named_secret(match: re.Match[str]) -> str:
        name = match.group("name")
        separator = match.group("separator")
        value = match.group("value")
        # Special Authorization handling above intentionally retains the auth
        # scheme. Do not let the generic pass consume ``Bearer``/``Basic`` or
        # disturb a value that was already replaced.
        if "•••" in value or (
            "authorization" in name.lower()
            and value.strip("\"'").lower() in {"bearer", "basic"}
        ):
            return match.group(0)
        quote = value[0] if value[:1] in {"\"", "'"} else ""
        return f"{name}{separator}{quote}•••{quote}"

    # These are conventional password environment variables, but ``PWD`` by
    # itself is the ordinary working-directory variable. Match the exact
    # credential names instead of broadening the generic secret-name heuristic.
    clean = re.sub(
        r"(?i)\b(?P<name>MYSQL_PWD|SSHPASS)\b"
        r"(?P<separator>\s*=\s*)"
        r"(?P<value>\"[^\"]*\"|'[^']*'|(?:\\[^\r\n]|[^\s,;&|\"'])+)",
        redact_named_secret,
        clean,
    )
    clean = re.sub(
        r"(?i)\b(?P<name>[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|signature|auth(?:orization)?|pat|session(?:[_-]?(?:id|token|key|secret))?)[A-Za-z0-9_.-]*)\b"
        r"(?P<separator>\s*[:=]\s*)"
        r"(?P<value>\"[^\"]*\"|'[^']*'|(?:\\[^\r\n]|[^\s,;&|\"'])+)",
        redact_named_secret,
        clean,
    )
    clean = re.sub(
        r"(?i)([?&][A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|cookie|auth(?:orization)?|pat|session)[A-Za-z0-9_.-]*=)[^&#\s\"';|]+",
        r"\1•••",
        clean,
    )
    clean = re.sub(r"(?i)\b((?:set-)?cookie\s*:)\s*[^\s,;]+", r"\1 •••", clean)
    clean = re.sub(
        r"(?i)((?<!\S)--cookie(?:\s*=\s*|\s+))(?:\"[^\"]*\"|'[^']*'|(?:\\[^\r\n]|[^\s,;&|])+)",
        r"\1•••",
        clean,
    )
    clean = re.sub(r"([A-Za-z][A-Za-z0-9+.-]*://)[^/\s:@]+:[^@/\s]+@", r"\1•••@", clean)
    clean = re.sub(
        r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b",
        "•••",
        clean,
    )
    clean = re.sub(
        r"\b(?:github_pat_|gh[pousr]_|glpat-|sk-)[A-Za-z0-9_-]{16,}\b",
        "•••",
        clean,
        flags=re.IGNORECASE,
    )
    def redact_long_opaque_value(match: re.Match[str]) -> str:
        candidate = match.group(0)
        # Preserve recognizable filesystem roots used by Agent workspaces and
        # host tools. A leading slash alone is not enough: it is also a valid
        # first character of standard Base64 and previously leaked such tokens.
        path_prefixes = (
            "/app/", "/code/", "/data/", "/dev/", "/etc/", "/home/",
            "/media/", "/mnt/", "/opt/", "/proc/", "/project/", "/root/",
            "/run/", "/srv/", "/sys/", "/tmp/", "/usr/", "/var/",
            "/workspace/",
        )
        relative_roots = (
            "agent-runtime/", "app/", "apps/", "backend/", "config/", "data/",
            "docs/", "enterprise-agent-platform/", "frontend/", "lib/", "packages/",
            "scripts/", "src/", "test/", "tests/", "workspaces/",
        )
        prefix = clean[max(0, match.start() - 12):match.start()]
        explicit_relative = (
            candidate.startswith("/")
            and prefix.endswith((".", "..", "~", "$HOME", "${HOME}"))
        ) or (candidate.startswith("HOME/") and prefix.endswith("$"))
        recognizable_path = (
            candidate.startswith(path_prefixes)
            or candidate.startswith(relative_roots)
            or explicit_relative
        )
        return candidate if recognizable_path else "•••"

    clean = re.sub(
        r"(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{48,}(?![A-Za-z0-9_+/=-])",
        redact_long_opaque_value,
        clean,
    )
    clean = re.sub(r"\b[A-Fa-f0-9]{32,}\b", "•••", clean)
    if redact_paths:
        clean = re.sub(
            r"(?<![A-Za-z0-9:])/(?:home|root|tmp|var|opt|srv)/(?:[^\s\"';&|]+/)*([^\s\"';&|/]*)",
            lambda match: f"…/{match.group(1)}" if match.group(1) else "…",
            clean,
        )
    if len(clean) > limit:
        clean = clean[: max(1, limit - 1)].rstrip() + "…"
    return clean


def _redact_terminal_command_credentials(command: str) -> str:
    """Mask shell credential arguments while preserving command structure.

    Short flags are command-specific because a global ``-p`` or ``-u`` rule
    would hide ordinary ports, Python's unbuffered flag, and other harmless
    parameters. Long credential flags are unambiguous and can be handled
    generically.
    """

    if not command:
        return ""

    value_pattern = r'(?P<value>"[^"]*"|\'[^\']*\'|(?:\\[^\r\n]|[^\s;&|])+)'
    contextual_value_pattern = (
        r'(?P<value>(?!["\']?•••["\']?(?=$|[\s;&|]))'
        r'(?:"[^"]*"|\'[^\']*\'|(?:\\[^\r\n]|[^\s;&|])+))'
    )

    def mask_argument(match: re.Match[str]) -> str:
        value = match.group("value")
        quote = value[0] if value[:1] in {"\"", "'"} else ""
        return f"{match.group('prefix')}{quote}•••{quote}"

    def mask_smb_user_password(match: re.Match[str]) -> str:
        value = match.group("value")
        quote = value[0] if len(value) >= 2 and value[0] == value[-1] and value[0] in {"\"", "'"} else ""
        inner = value[1:-1] if quote else value
        if "%" not in inner:
            # ``smbclient -U alice`` carries only a username. It is useful
            # execution context and is not itself a credential.
            return match.group(0)
        username, _password = inner.split("%", 1)
        return f"{match.group('prefix')}{quote}{username}%•••{quote}"

    # Unambiguously secret long flags used by CLIs and HTTP clients. Keep the
    # option and original separator/quoting so the preview remains recognizable.
    # ``--user`` is intentionally not global: Docker, PostgreSQL and many other
    # tools use it for a harmless execution identity rather than a credential.
    command = re.sub(
        r"(?i)(?P<prefix>(?<![A-Za-z0-9_-])--(?:password|passwd|token|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?|cookie)(?:\s*=\s*|\s+))"
        + value_pattern,
        mask_argument,
        command,
    )

    # Context-sensitive credential switches. The executable prefix is bounded
    # to one shell segment so similarly named arguments belonging to another
    # command remain visible.
    contextual_argument_patterns = (
        r"(?P<prefix>\b(?i:sshpass|mysql(?:admin|dump)?|docker\s+login)\b[^\n;&|]*?(?<!\S)-p(?:\s*=\s*|\s+))",
        r"(?P<prefix>\b(?i:redis-cli)\b[^\n;&|]*?(?<!\S)-a(?:\s*=\s*|\s+))",
        r"(?P<prefix>\b(?i:curl)\b[^\n;&|]*?(?<!\S)(?:-(?:u|U|b)|--(?:user|proxy-user|oauth2-bearer))(?:\s*=\s*|\s+))",
        r"(?P<prefix>\b(?i:aws)\b[^\n;&|]*?\b(?i:configure)\s+(?i:set)\s+(?i:aws_secret_access_key)(?:\s*=\s*|\s+))",
        r"(?P<prefix>\b(?i:npm)\b[^\n;&|]*?\b(?i:config)\s+(?i:set)\s+(?:\"[^\"]*(?i:_authtoken)\"|'[^']*(?i:_authtoken)'|(?:\\[^\r\n]|[^\s;&|])*(?i:_authtoken))(?:\s*=\s*|\s+))",
    )
    for prefix_pattern in contextual_argument_patterns:
        # A single command can carry several credentials (for example curl
        # with both a cookie and basic auth). The executable-anchored pattern
        # sees only the first matching flag per pass, so repeat while skipping
        # values already replaced with the marker.
        while True:
            updated, replacements = re.subn(
                prefix_pattern + contextual_value_pattern,
                mask_argument,
                command,
            )
            command = updated
            if replacements == 0:
                break

    # A positional ``vault login`` value is a token. Method/options begin with
    # a dash and must remain visible instead of being mistaken for the token.
    command = re.sub(
        r"(?P<prefix>\b(?i:vault)\b[^\n;&|]*?\b(?i:login)\s+)(?!-)" + value_pattern,
        mask_argument,
        command,
    )

    # smbclient combines username and password as ``user%password``. Preserve
    # the non-secret identity while masking only the password portion.
    smb_separated_prefix = (
        r"(?P<prefix>\b(?i:smbclient)\b[^\n;&|]*?(?<!\S)(?:-U|--user)(?:\s*=\s*|\s+))"
    )
    command = re.sub(
        smb_separated_prefix + value_pattern,
        mask_smb_user_password,
        command,
    )

    attached_short_patterns = (
        r"(?P<prefix>\b(?i:sshpass|mysql(?:admin|dump)?|docker\s+login)\b[^\n;&|]*?(?<!\S)-p)",
        r"(?P<prefix>\b(?i:redis-cli)\b[^\n;&|]*?(?<!\S)-a)",
        r"(?P<prefix>\b(?i:curl)\b[^\n;&|]*?(?<!\S)-(?:u|U|b))",
    )
    for prefix_pattern in attached_short_patterns:
        while True:
            updated, replacements = re.subn(
                prefix_pattern + contextual_value_pattern,
                mask_argument,
                command,
            )
            command = updated
            if replacements == 0:
                break
    command = re.sub(
        r"(?P<prefix>\b(?i:smbclient)\b[^\n;&|]*?(?<!\S)-U)" + value_pattern,
        mask_smb_user_password,
        command,
    )

    # OpenSSL password sources encode the secret after ``pass:`` rather than as
    # a standalone option value.
    command = re.sub(
        r"(?P<prefix>\b(?i:openssl)\b[^\n;&|]*?(?<!\S)-pass(?:in|out)(?:\s*=\s*|\s+)pass:)"
        + value_pattern,
        mask_argument,
        command,
    )
    command = re.sub(
        r"(?P<prefix>\b(?i:openssl)\b[^\n;&|]*?(?<!\S)-pass(?:in|out)(?:\s*=\s*|\s+)(?P<quote>[\"'])pass:)"
        r"(?P<value>[^\"']*)(?P=quote)",
        lambda match: f"{match.group('prefix')}•••{match.group('quote')}",
        command,
    )
    return command
