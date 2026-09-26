#!/usr/bin/env python3
"""Keep machine contracts, their generated consumers, and documentation links in sync.

The checker deliberately uses only the Python standard library so it can run
before project dependencies are installed.  ``sync`` writes deterministic
generated contract modules; ``check`` validates the current tree: every
contract parses and matches its generated targets byte for byte, and every
local Markdown link (including heading anchors) resolves.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Sequence
from urllib.parse import unquote, urlsplit


REQUIRED_RUNTIME_POLICIES = {
    "run_idle_timeout",
    "max_turns_per_run",
    "terminal_timeout",
    "process_wait_timeout",
}
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t#]*$")
JAVASCRIPT_MAX_SAFE_INTEGER = (1 << 53) - 1
NODE_MAX_TIMER_MILLISECONDS = 2_147_483_647
ENTRY_MARKDOWN_PATHS = (
    "AGENTS.md",
    "README.md",
    "enterprise-agent-platform/README.md",
    "enterprise-agent-platform/agent-runtime/README.md",
)


class DocsSyncError(RuntimeError):
    """Raised when the documentation contract is malformed or out of sync."""


@dataclass(frozen=True)
class ContractTarget:
    path: str
    format: str


@dataclass(frozen=True)
class Contract:
    identifier: str
    source: str
    targets: tuple[ContractTarget, ...]


def _targets(*pairs: tuple[str, str]) -> tuple[ContractTarget, ...]:
    return tuple(ContractTarget(path=path, format=target_format) for path, target_format in pairs)


# The complete, closed set of machine contracts. Each source lives under
# docs/contracts/ and is rendered byte-for-byte into every listed consumer.
CONTRACTS: tuple[Contract, ...] = (
    Contract(
        identifier="container-platform",
        source="docs/contracts/container-platform.json",
        targets=_targets(
            ("manager/internal/contract/generated.go", "go-container-platform"),
            ("enterprise-agent-platform/enterprise_agent_platform/container_contract_generated.py", "python-container-platform"),
            ("enterprise-agent-platform/agent-runtime/src/container-contract.generated.ts", "typescript-container-platform"),
            ("enterprise-agent-platform/frontend/src/container-contract.generated.ts", "typescript-container-platform"),
        ),
    ),
    # Direct consumers read the validated JSON; nothing is generated.
    Contract(
        identifier="upstream-sources",
        source="docs/contracts/upstream-sources.json",
        targets=(),
    ),
    Contract(
        identifier="technical-profiles",
        source="docs/contracts/technical-profiles.json",
        targets=_targets(
            ("manager/internal/identity/technical_profiles_generated.go", "go-technical-profiles"),
            ("enterprise-agent-platform/enterprise_agent_platform/technical_profile_generated.py", "python-technical-profiles"),
            ("enterprise-agent-platform/agent-runtime/src/technical-profile.generated.ts", "typescript-technical-profile"),
        ),
    ),
    Contract(
        identifier="runtime-policy",
        source="docs/contracts/runtime-policy.json",
        targets=_targets(
            ("manager/internal/executor/runtime_policy_generated.go", "go-runtime-policy"),
            ("enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py", "python-runtime-policy"),
            ("enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts", "typescript-runtime-policy"),
            ("enterprise-agent-platform/frontend/src/design-contract.generated.ts", "typescript-runtime-policy"),
        ),
    ),
)


def _repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def _display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return str(path)


def _relative_path(relative: str) -> PurePosixPath:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise DocsSyncError(f"invalid repository-relative path: {relative!r}")
    candidate = PurePosixPath(relative)
    if candidate.is_absolute() or ".." in candidate.parts or candidate.as_posix() != relative:
        raise DocsSyncError(f"unsafe repository-relative path: {relative!r}")
    return candidate


def _safe_path(root: Path, relative: str) -> Path:
    candidate = _relative_path(relative)
    lexical = root / Path(*candidate.parts)
    try:
        resolved_root = root.resolve()
        resolved = lexical.resolve()
    except (OSError, RuntimeError) as exc:
        raise DocsSyncError(
            f"could not safely resolve repository-relative path {relative!r}: {exc}"
        ) from exc
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise DocsSyncError(f"path escapes repository root: {relative!r}")
    return lexical


def _reject_symlink_chain(root: Path, relative: str, label: str) -> Path:
    path = _safe_path(root, relative)
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        try:
            current_stat = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(current_stat.st_mode):
            raise DocsSyncError(f"{label} must not use symlinks: {relative}")
    return path


def _require_regular_file(path: Path, label: str, relative: str) -> None:
    try:
        path_stat = path.lstat()
    except FileNotFoundError as exc:
        raise DocsSyncError(f"{label} is missing: {relative}") from exc
    if not stat.S_ISREG(path_stat.st_mode):
        raise DocsSyncError(f"{label} must be a regular file: {relative}")


def _read_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise DocsSyncError(f"{label} is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise DocsSyncError(
            f"{label} is not valid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc


def read_strict_json(path: Path, label: str) -> Any:
    """Read JSON while rejecting duplicate object members.

    Signed and release-critical inputs cannot use the ordinary
    last-member-wins behavior of ``json.loads``.
    """

    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise DocsSyncError(f"{label} contains duplicate key: {key}")
            result[key] = value
        return result

    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=object_pairs,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"non-finite number {value}")
            ),
        )
    except FileNotFoundError as exc:
        raise DocsSyncError(f"{label} is missing: {path}") from exc
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise DocsSyncError(f"{label} is not strict JSON: {exc}") from exc


def _parse_rfc3339(value: str, label: str) -> dt.datetime:
    if not value.endswith("Z"):
        raise DocsSyncError(f"{label} must be an RFC3339 UTC timestamp ending in Z")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise DocsSyncError(f"{label} must be a valid RFC3339 date-time") from exc
    if parsed.tzinfo != dt.timezone.utc:
        raise DocsSyncError(f"{label} must use UTC")
    return parsed


def validate_closed_json_schema_instance(
    value: Any,
    schema: Any,
    label: str,
) -> dict[str, Any]:
    """Validate the closed Draft-2020-12 subset used by repository contracts.

    The field list and constraints remain in the canonical schema documents;
    this interpreter intentionally supports only their fail-closed subset.
    """

    schema_object = _expect_object(schema, f"{label} schema")
    if schema_object.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        raise DocsSyncError(f"{label} schema must use JSON Schema draft 2020-12")
    if schema_object.get("type") != "object" or schema_object.get("additionalProperties") is not False:
        raise DocsSyncError(f"{label} schema must describe a closed object")
    properties = _expect_object(schema_object.get("properties"), f"{label} schema.properties")
    required = _expect_string_list(schema_object.get("required"), f"{label} schema.required")
    if set(required) != set(properties):
        raise DocsSyncError(f"{label} schema must require every declared property")
    instance = _expect_object(value, label)
    _reject_unknown_keys(instance, set(properties), label)
    missing = sorted(set(required) - set(instance))
    if missing:
        raise DocsSyncError(f"{label} is missing required keys: {', '.join(missing)}")
    for name, rule_value in properties.items():
        rule = _expect_object(rule_value, f"{label} schema property {name}")
        _reject_unknown_keys(rule, {"const", "enum", "type", "pattern", "format"}, f"{label} schema property {name}")
        item = instance[name]
        if "const" in rule and (
            type(item) is not type(rule["const"]) or item != rule["const"]
        ):
            raise DocsSyncError(f"{label}.{name} must equal {rule['const']!r}")
        if "enum" in rule:
            enum = rule["enum"]
            if not isinstance(enum, list) or not enum or len({json.dumps(entry, sort_keys=True) for entry in enum}) != len(enum):
                raise DocsSyncError(f"{label} schema property {name}.enum must be a unique non-empty array")
            if not any(type(item) is type(entry) and item == entry for entry in enum):
                raise DocsSyncError(f"{label}.{name} is not an allowed value")
        expected_type = rule.get("type")
        if expected_type == "string" and not isinstance(item, str):
            raise DocsSyncError(f"{label}.{name} must be a string")
        if expected_type is not None and expected_type != "string":
            raise DocsSyncError(f"{label} schema property {name} uses unsupported type {expected_type!r}")
        pattern = rule.get("pattern")
        if pattern is not None:
            if not isinstance(pattern, str):
                raise DocsSyncError(f"{label} schema property {name}.pattern must be a string")
            try:
                matched = re.fullmatch(pattern, item)
            except (re.error, TypeError) as exc:
                raise DocsSyncError(f"{label} schema property {name} has an invalid pattern") from exc
            if matched is None:
                raise DocsSyncError(f"{label}.{name} does not match its canonical pattern")
        value_format = rule.get("format")
        if value_format is not None:
            if value_format != "date-time" or not isinstance(item, str):
                raise DocsSyncError(f"{label} schema property {name} uses an unsupported format")
            _parse_rfc3339(item, f"{label}.{name}")
    return instance


def _expect_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DocsSyncError(f"{label} must be a JSON object")
    return value


def _expect_string_list(value: Any, label: str, *, allow_empty: bool = False) -> tuple[str, ...]:
    if not isinstance(value, list) or (not value and not allow_empty):
        suffix = "" if allow_empty else " and must not be empty"
        raise DocsSyncError(f"{label} must be a JSON array of strings{suffix}")
    if any(not isinstance(item, str) or not item for item in value):
        raise DocsSyncError(f"{label} must contain only non-empty strings")
    if len(set(value)) != len(value):
        raise DocsSyncError(f"{label} contains duplicate entries")
    return tuple(value)


def _reject_unknown_keys(value: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise DocsSyncError(f"{label} contains unknown keys: {', '.join(unknown)}")


def _validate_runtime_contract(raw: Any, label: str) -> dict[str, Any]:
    contract = _expect_object(raw, label)
    _reject_unknown_keys(
        contract,
        {
            "schema_version",
            "policy",
            "run_idle_timeout",
            "max_turns_per_run",
            "terminal_timeout",
            "process_wait_timeout",
        },
        label,
    )
    if contract.get("schema_version") != 1:
        raise DocsSyncError(f"{label}.schema_version must be 1")
    if contract.get("policy") != "runtime-policy":
        raise DocsSyncError(f"{label}.policy must be 'runtime-policy'")
    if not REQUIRED_RUNTIME_POLICIES.issubset(contract):
        missing = sorted(REQUIRED_RUNTIME_POLICIES - set(contract))
        raise DocsSyncError(f"{label} is missing policies: {', '.join(missing)}")

    idle = _expect_object(contract["run_idle_timeout"], f"{label}.run_idle_timeout")
    _reject_unknown_keys(
        idle,
        {
            "default_seconds",
            "minimum_seconds",
            "maximum_seconds",
            "platform_environment_variable",
            "runtime_environment_variable",
            "semantics",
        },
        f"{label}.run_idle_timeout",
    )
    turns = _expect_object(contract["max_turns_per_run"], f"{label}.max_turns_per_run")
    _reject_unknown_keys(
        turns,
        {"default", "minimum", "maximum", "runtime_environment_variable", "semantics"},
        f"{label}.max_turns_per_run",
    )
    terminal = _expect_object(contract["terminal_timeout"], f"{label}.terminal_timeout")
    _reject_unknown_keys(
        terminal,
        {"default_milliseconds", "minimum_milliseconds", "maximum_milliseconds", "runtime_environment_variable", "semantics"},
        f"{label}.terminal_timeout",
    )
    process_wait = _expect_object(
        contract["process_wait_timeout"],
        f"{label}.process_wait_timeout",
    )
    _reject_unknown_keys(
        process_wait,
        {"default_milliseconds", "minimum_milliseconds", "maximum_milliseconds", "semantics"},
        f"{label}.process_wait_timeout",
    )

    numeric_groups = (
        (idle, "default_seconds", "minimum_seconds", "maximum_seconds", "run_idle_timeout"),
        (turns, "default", "minimum", "maximum", "max_turns_per_run"),
        (
            terminal,
            "default_milliseconds",
            "minimum_milliseconds",
            "maximum_milliseconds",
            "terminal_timeout",
        ),
        (
            process_wait,
            "default_milliseconds",
            "minimum_milliseconds",
            "maximum_milliseconds",
            "process_wait_timeout",
        ),
    )
    for group, default_key, minimum_key, maximum_key, group_label in numeric_groups:
        values = [group.get(minimum_key), group.get(default_key), group.get(maximum_key)]
        if any(isinstance(value, bool) or not isinstance(value, int) for value in values):
            raise DocsSyncError(f"{label}.{group_label} bounds/default must be integers")
        minimum, default, maximum = values
        if minimum < 0 or not minimum <= default <= maximum:
            raise DocsSyncError(
                f"{label}.{group_label} must satisfy 0 <= minimum <= default <= maximum"
            )

    if turns["minimum"] <= 0:
        raise DocsSyncError(f"{label}.max_turns_per_run.minimum must be greater than zero")
    if terminal["minimum_milliseconds"] <= 0:
        raise DocsSyncError(f"{label}.terminal_timeout.minimum_milliseconds must be greater than zero")
    if process_wait["minimum_milliseconds"] <= 0:
        raise DocsSyncError(
            f"{label}.process_wait_timeout.minimum_milliseconds must be greater than zero"
        )
    for key in ("minimum", "default", "maximum"):
        if turns[key] > JAVASCRIPT_MAX_SAFE_INTEGER:
            raise DocsSyncError(
                f"{label}.max_turns_per_run.{key} must be a JavaScript safe integer"
            )
    for key in ("minimum_milliseconds", "default_milliseconds", "maximum_milliseconds"):
        if terminal[key] > JAVASCRIPT_MAX_SAFE_INTEGER:
            raise DocsSyncError(
                f"{label}.terminal_timeout.{key} must be a JavaScript safe integer"
            )
        if process_wait[key] > JAVASCRIPT_MAX_SAFE_INTEGER:
            raise DocsSyncError(
                f"{label}.process_wait_timeout.{key} must be a JavaScript safe integer"
            )
    if terminal["maximum_milliseconds"] > NODE_MAX_TIMER_MILLISECONDS:
        raise DocsSyncError(
            f"{label}.terminal_timeout.maximum_milliseconds must not exceed the Node.js timer limit "
            f"of {NODE_MAX_TIMER_MILLISECONDS}"
        )
    if process_wait["maximum_milliseconds"] > NODE_MAX_TIMER_MILLISECONDS:
        raise DocsSyncError(
            f"{label}.process_wait_timeout.maximum_milliseconds must not exceed the Node.js timer limit "
            f"of {NODE_MAX_TIMER_MILLISECONDS}"
        )
    maximum_safe_seconds = JAVASCRIPT_MAX_SAFE_INTEGER // 1_000
    for key in ("minimum_seconds", "default_seconds", "maximum_seconds"):
        if idle[key] > maximum_safe_seconds:
            raise DocsSyncError(
                f"{label}.run_idle_timeout.{key} must remain safe when converted to JavaScript milliseconds"
            )

    environment_fields = (
        (idle, "platform_environment_variable"),
        (idle, "runtime_environment_variable"),
        (turns, "runtime_environment_variable"),
        (terminal, "runtime_environment_variable"),
    )
    for group, key in environment_fields:
        value = group.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]+", value):
            raise DocsSyncError(f"{label}.{key} must be an uppercase environment variable name")
    for group_name in REQUIRED_RUNTIME_POLICIES:
        semantics = contract[group_name].get("semantics")
        if not isinstance(semantics, str) or not semantics.strip():
            raise DocsSyncError(f"{label}.{group_name}.semantics must be non-empty")
    return contract


def _render_python_runtime_policy(contract: dict[str, Any], source: str) -> str:
    idle = contract["run_idle_timeout"]
    turns = contract["max_turns_per_run"]
    terminal = contract["terminal_timeout"]
    process_wait = contract["process_wait_timeout"]
    return f'''# Generated from {source} by scripts/docs_sync.py; do not edit.
from __future__ import annotations

RUNTIME_POLICY_SCHEMA_VERSION = {contract["schema_version"]}

RUN_IDLE_TIMEOUT_DEFAULT_SECONDS = {idle["default_seconds"]}
RUN_IDLE_TIMEOUT_MINIMUM_SECONDS = {idle["minimum_seconds"]}
RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS = {idle["maximum_seconds"]}
RUN_IDLE_TIMEOUT_PLATFORM_ENVIRONMENT_VARIABLE = {idle["platform_environment_variable"]!r}
RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE = {idle["runtime_environment_variable"]!r}

MAX_TURNS_PER_RUN_DEFAULT = {turns["default"]}
MAX_TURNS_PER_RUN_MINIMUM = {turns["minimum"]}
MAX_TURNS_PER_RUN_MAXIMUM = {turns["maximum"]}
MAX_TURNS_PER_RUN_RUNTIME_ENVIRONMENT_VARIABLE = {turns["runtime_environment_variable"]!r}

TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS = {terminal["default_milliseconds"]}
TERMINAL_TIMEOUT_MINIMUM_MILLISECONDS = {terminal["minimum_milliseconds"]}
TERMINAL_TIMEOUT_MAXIMUM_MILLISECONDS = {terminal["maximum_milliseconds"]}
TERMINAL_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE = {terminal["runtime_environment_variable"]!r}

PROCESS_WAIT_TIMEOUT_DEFAULT_MILLISECONDS = {process_wait["default_milliseconds"]}
PROCESS_WAIT_TIMEOUT_MINIMUM_MILLISECONDS = {process_wait["minimum_milliseconds"]}
PROCESS_WAIT_TIMEOUT_MAXIMUM_MILLISECONDS = {process_wait["maximum_milliseconds"]}
'''


def _typescript_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _render_typescript_runtime_policy(contract: dict[str, Any], source: str) -> str:
    idle = contract["run_idle_timeout"]
    turns = contract["max_turns_per_run"]
    terminal = contract["terminal_timeout"]
    process_wait = contract["process_wait_timeout"]
    return f'''// Generated from {source} by scripts/docs_sync.py; do not edit.
export const RUNTIME_POLICY_SCHEMA_VERSION = {contract["schema_version"]} as const;

export const RUN_IDLE_TIMEOUT_DEFAULT_SECONDS = {idle["default_seconds"]} as const;
export const RUN_IDLE_TIMEOUT_MINIMUM_SECONDS = {idle["minimum_seconds"]} as const;
export const RUN_IDLE_TIMEOUT_MAXIMUM_SECONDS = {idle["maximum_seconds"]} as const;
export const RUN_IDLE_TIMEOUT_PLATFORM_ENVIRONMENT_VARIABLE = {_typescript_string(idle["platform_environment_variable"])} as const;
export const RUN_IDLE_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE = {_typescript_string(idle["runtime_environment_variable"])} as const;

export const MAX_TURNS_PER_RUN_DEFAULT = {turns["default"]} as const;
export const MAX_TURNS_PER_RUN_MINIMUM = {turns["minimum"]} as const;
export const MAX_TURNS_PER_RUN_MAXIMUM = {turns["maximum"]} as const;
export const MAX_TURNS_PER_RUN_RUNTIME_ENVIRONMENT_VARIABLE = {_typescript_string(turns["runtime_environment_variable"])} as const;

export const TERMINAL_TIMEOUT_DEFAULT_MILLISECONDS = {terminal["default_milliseconds"]} as const;
export const TERMINAL_TIMEOUT_MINIMUM_MILLISECONDS = {terminal["minimum_milliseconds"]} as const;
export const TERMINAL_TIMEOUT_MAXIMUM_MILLISECONDS = {terminal["maximum_milliseconds"]} as const;
export const TERMINAL_TIMEOUT_RUNTIME_ENVIRONMENT_VARIABLE = {_typescript_string(terminal["runtime_environment_variable"])} as const;

export const PROCESS_WAIT_TIMEOUT_DEFAULT_MILLISECONDS = {process_wait["default_milliseconds"]} as const;
export const PROCESS_WAIT_TIMEOUT_MINIMUM_MILLISECONDS = {process_wait["minimum_milliseconds"]} as const;
export const PROCESS_WAIT_TIMEOUT_MAXIMUM_MILLISECONDS = {process_wait["maximum_milliseconds"]} as const;
'''


def _render_go_runtime_policy(contract: dict[str, Any], source: str) -> str:
    idle = contract["run_idle_timeout"]
    turns = contract["max_turns_per_run"]
    terminal = contract["terminal_timeout"]
    process_wait = contract["process_wait_timeout"]
    constants = (
        ("runtimePolicySchemaVersion", contract["schema_version"]),
        ("runIdleTimeoutDefaultSeconds", idle["default_seconds"]),
        ("runIdleTimeoutMinimumSeconds", idle["minimum_seconds"]),
        ("runIdleTimeoutMaximumSeconds", idle["maximum_seconds"]),
        ("maxTurnsPerRunDefault", turns["default"]),
        ("maxTurnsPerRunMinimum", turns["minimum"]),
        ("maxTurnsPerRunMaximum", turns["maximum"]),
        ("terminalTimeoutDefaultMilliseconds", terminal["default_milliseconds"]),
        ("terminalTimeoutMinimumMilliseconds", terminal["minimum_milliseconds"]),
        ("terminalTimeoutMaximumMilliseconds", terminal["maximum_milliseconds"]),
        ("processWaitTimeoutDefaultMilliseconds", process_wait["default_milliseconds"]),
        ("processWaitTimeoutMinimumMilliseconds", process_wait["minimum_milliseconds"]),
        ("processWaitTimeoutMaximumMilliseconds", process_wait["maximum_milliseconds"]),
    )
    name_width = max(len(name) for name, _ in constants)
    constant_lines = "\n".join(
        f"\t{name:<{name_width}} = {value}" for name, value in constants
    )
    return f'''// Code generated from {source} by scripts/docs_sync.py; DO NOT EDIT.
package executor

const (
{constant_lines}
)
'''



def _validate_container_platform_contract(raw: Any, label: str) -> dict[str, Any]:
    contract = _expect_object(raw, label)
    expected_keys = {
        "schema_version",
        "policy",
        "release_channel",
        "database_schema_version",
        "container_paths",
        "execution_targets",
        "persistent_data_owners",
        "sandbox_idle_seconds",
        "migration_backup_retention_seconds",
        "obsolete_artifact_retention_seconds",
        "update_pre_download_min_free_bytes",
        "update_pre_cutover_min_free_bytes",
        "update_min_free_inodes",
        "managed_image_capacity_estimates",
        "public_update_states",
        "operations",
        "operation_phases",
    }
    _reject_unknown_keys(contract, expected_keys, label)
    if set(contract) != expected_keys:
        missing = ", ".join(sorted(expected_keys - set(contract)))
        raise DocsSyncError(f"{label} is missing required keys: {missing}")
    if contract["schema_version"] != 2:
        raise DocsSyncError(f"{label}.schema_version must be 2")
    if contract["policy"] != "container-platform":
        raise DocsSyncError(f"{label}.policy must be 'container-platform'")
    if contract["release_channel"] != "main":
        raise DocsSyncError(f"{label}.release_channel must be 'main'")

    paths = _expect_object(contract["container_paths"], f"{label}.container_paths")
    expected_paths = {"data_root", "workspace", "agent_home", "agent_env"}
    if set(paths) != expected_paths:
        raise DocsSyncError(
            f"{label}.container_paths must contain exactly: "
            + ", ".join(sorted(expected_paths))
        )
    for name, value in paths.items():
        if (
            not isinstance(value, str)
            or not value.startswith("/")
            or "//" in value
            or value.endswith("/")
            or any(part in {".", ".."} for part in PurePosixPath(value).parts)
        ):
            raise DocsSyncError(
                f"{label}.container_paths.{name} must be a canonical absolute path"
            )

    list_fields = {
        "execution_targets": ("sandbox", "host"),
        "public_update_states": ("idle", "waiting_for_tasks", "updating", "failed"),
        "operations": ("install", "update", "restart", "rollback", "repair"),
        "operation_phases": (
            "validating",
            "pulling",
            "preparing",
            "draining",
            "snapshotting",
            "migrating",
            "starting",
            "probing",
            "committing",
            "rolling_back",
        ),
    }
    for field, expected in list_fields.items():
        values = _expect_string_list(contract[field], f"{label}.{field}")
        if values != expected:
            raise DocsSyncError(
                f"{label}.{field} must exactly match the documented ordered values"
            )

    persistent_owners = _expect_object(
        contract["persistent_data_owners"],
        f"{label}.persistent_data_owners",
    )
    expected_owner_sets = {
        "searxng",
        "firecrawl-redis",
        "firecrawl-rabbitmq",
        "firecrawl-postgres",
    }
    if set(persistent_owners) != expected_owner_sets:
        raise DocsSyncError(
            f"{label}.persistent_data_owners must contain exactly the current persistent service set"
        )
    for service, raw_owners in persistent_owners.items():
        if not isinstance(raw_owners, list):
            raise DocsSyncError(
                f"{label}.persistent_data_owners.{service} must be an array"
            )
        seen_owners: set[tuple[int, int]] = set()
        for index, raw_owner in enumerate(raw_owners):
            owner = _expect_object(
                raw_owner,
                f"{label}.persistent_data_owners.{service}[{index}]",
            )
            if set(owner) != {"uid", "gid"}:
                raise DocsSyncError(
                    f"{label}.persistent_data_owners.{service}[{index}] must contain exactly uid and gid"
                )
            uid, gid = owner["uid"], owner["gid"]
            if (
                isinstance(uid, bool)
                or isinstance(gid, bool)
                or not isinstance(uid, int)
                or not isinstance(gid, int)
                or uid < 0
                or gid < 0
                or uid > 0xFFFFFFFF
                or gid > 0xFFFFFFFF
            ):
                raise DocsSyncError(
                    f"{label}.persistent_data_owners.{service}[{index}] has an invalid uid/gid"
                )
            identity = (uid, gid)
            if identity in seen_owners:
                raise DocsSyncError(
                    f"{label}.persistent_data_owners.{service} contains a duplicate uid/gid"
                )
            seen_owners.add(identity)

    for field in (
        "database_schema_version",
        "sandbox_idle_seconds",
        "migration_backup_retention_seconds",
        "obsolete_artifact_retention_seconds",
        "update_pre_download_min_free_bytes",
        "update_pre_cutover_min_free_bytes",
        "update_min_free_inodes",
    ):
        value = contract[field]
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value <= 0
            or value > JAVASCRIPT_MAX_SAFE_INTEGER
        ):
            raise DocsSyncError(
                f"{label}.{field} must be a positive JavaScript-safe integer"
            )

    estimates = _expect_object(
        contract["managed_image_capacity_estimates"],
        f"{label}.managed_image_capacity_estimates",
    )
    managed_images = {
        "platform",
        "agent-runtime",
        "camofox",
        "agent-sandbox",
        "searxng",
        "firecrawl-api",
        "firecrawl-playwright",
        "firecrawl-postgres",
        "firecrawl-redis",
        "firecrawl-rabbitmq",
    }
    if set(estimates) != managed_images:
        raise DocsSyncError(
            f"{label}.managed_image_capacity_estimates must contain exactly the current ten-image set"
        )
    for image_name, estimate_value in estimates.items():
        estimate = _expect_object(
            estimate_value,
            f"{label}.managed_image_capacity_estimates.{image_name}",
        )
        if set(estimate) != {"compressed_bytes", "unpacked_bytes"}:
            raise DocsSyncError(
                f"{label}.managed_image_capacity_estimates.{image_name} must "
                "contain exactly compressed_bytes and unpacked_bytes"
            )
        for size_name, value in estimate.items():
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or value <= 0
                or value > JAVASCRIPT_MAX_SAFE_INTEGER
            ):
                raise DocsSyncError(
                    f"{label}.managed_image_capacity_estimates.{image_name}."
                    f"{size_name} must be a positive JavaScript-safe integer"
                )
    return contract

def _render_python_container_platform(contract: dict[str, Any], source: str) -> str:
    paths = contract["container_paths"]
    estimates = contract["managed_image_capacity_estimates"]
    persistent_owners = contract["persistent_data_owners"]
    return f'''# Generated from {source} by scripts/docs_sync.py; do not edit.
from __future__ import annotations

CONTAINER_PLATFORM_SCHEMA_VERSION = {contract["schema_version"]}
RELEASE_CHANNEL = {contract["release_channel"]!r}
DATABASE_SCHEMA_VERSION = {contract["database_schema_version"]}
CONTAINER_PATHS = {paths!r}
EXECUTION_TARGETS = {tuple(contract["execution_targets"])!r}
PERSISTENT_DATA_OWNERS = {persistent_owners!r}
SANDBOX_IDLE_SECONDS = {contract["sandbox_idle_seconds"]}
MIGRATION_BACKUP_RETENTION_SECONDS = {contract["migration_backup_retention_seconds"]}
OBSOLETE_ARTIFACT_RETENTION_SECONDS = {contract["obsolete_artifact_retention_seconds"]}
UPDATE_PRE_DOWNLOAD_MIN_FREE_BYTES = {contract["update_pre_download_min_free_bytes"]}
UPDATE_PRE_CUTOVER_MIN_FREE_BYTES = {contract["update_pre_cutover_min_free_bytes"]}
UPDATE_MIN_FREE_INODES = {contract["update_min_free_inodes"]}
MANAGED_IMAGE_CAPACITY_ESTIMATES = {estimates!r}
PUBLIC_UPDATE_STATES = {tuple(contract["public_update_states"])!r}
MANAGER_OPERATIONS = {tuple(contract["operations"])!r}
MANAGER_OPERATION_PHASES = {tuple(contract["operation_phases"])!r}
'''

def _render_typescript_container_platform(contract: dict[str, Any], source: str) -> str:
    paths = json.dumps(contract["container_paths"], ensure_ascii=False, indent=2)
    targets = json.dumps(contract["execution_targets"], ensure_ascii=False)
    states = json.dumps(contract["public_update_states"], ensure_ascii=False)
    operations = json.dumps(contract["operations"], ensure_ascii=False)
    phases = json.dumps(contract["operation_phases"], ensure_ascii=False)
    estimates = json.dumps(
        contract["managed_image_capacity_estimates"], ensure_ascii=False, indent=2
    )
    persistent_owners = json.dumps(
        contract["persistent_data_owners"], ensure_ascii=False, indent=2
    )
    return f'''// Generated from {source} by scripts/docs_sync.py; do not edit.
export const CONTAINER_PLATFORM_SCHEMA_VERSION = {contract["schema_version"]} as const;
export const RELEASE_CHANNEL = {_typescript_string(contract["release_channel"])} as const;
export const DATABASE_SCHEMA_VERSION = {contract["database_schema_version"]} as const;
export const CONTAINER_PATHS = {paths} as const;
export const EXECUTION_TARGETS = {targets} as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];
export const PERSISTENT_DATA_OWNERS = {persistent_owners} as const;
export const SANDBOX_IDLE_SECONDS = {contract["sandbox_idle_seconds"]} as const;
export const MIGRATION_BACKUP_RETENTION_SECONDS = {contract["migration_backup_retention_seconds"]} as const;
export const OBSOLETE_ARTIFACT_RETENTION_SECONDS = {contract["obsolete_artifact_retention_seconds"]} as const;
export const UPDATE_PRE_DOWNLOAD_MIN_FREE_BYTES = {contract["update_pre_download_min_free_bytes"]} as const;
export const UPDATE_PRE_CUTOVER_MIN_FREE_BYTES = {contract["update_pre_cutover_min_free_bytes"]} as const;
export const UPDATE_MIN_FREE_INODES = {contract["update_min_free_inodes"]} as const;
export const MANAGED_IMAGE_CAPACITY_ESTIMATES = {estimates} as const;
export const PUBLIC_UPDATE_STATES = {states} as const;
export type PublicUpdateState = (typeof PUBLIC_UPDATE_STATES)[number];
export const MANAGER_OPERATIONS = {operations} as const;
export type ManagerOperation = (typeof MANAGER_OPERATIONS)[number];
export const MANAGER_OPERATION_PHASES = {phases} as const;
export type ManagerOperationPhase = (typeof MANAGER_OPERATION_PHASES)[number];
'''
def _go_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)



def _render_go_container_platform(contract: dict[str, Any], source: str) -> str:
    paths = contract["container_paths"]
    constants = (
        ("SchemaVersion", str(contract["schema_version"])),
        ("ReleaseChannel", _go_string(contract["release_channel"])),
        ("DatabaseSchemaVersion", str(contract["database_schema_version"])),
        ("ContainerDataRoot", _go_string(paths["data_root"])),
        ("ContainerWorkspace", _go_string(paths["workspace"])),
        ("ContainerAgentHome", _go_string(paths["agent_home"])),
        ("ContainerAgentEnv", _go_string(paths["agent_env"])),
        ("SandboxIdleSeconds", str(contract["sandbox_idle_seconds"])),
        (
            "MigrationBackupRetentionSeconds",
            str(contract["migration_backup_retention_seconds"]),
        ),
        (
            "ObsoleteArtifactRetentionSeconds",
            str(contract["obsolete_artifact_retention_seconds"]),
        ),
        (
            "UpdatePreDownloadMinFreeBytes",
            str(contract["update_pre_download_min_free_bytes"]),
        ),
        (
            "UpdatePreCutoverMinFreeBytes",
            str(contract["update_pre_cutover_min_free_bytes"]),
        ),
        ("UpdateMinFreeInodes", str(contract["update_min_free_inodes"])),
    )
    name_width = max(len(name) for name, _ in constants)
    constant_lines = "\n".join(
        f"\t{name:<{name_width}} = {value}" for name, value in constants
    )
    estimate_lines = "\n".join(
        "\t"
        + _go_string(name)
        + ": {\n\t\tCompressedBytes: "
        + str(value["compressed_bytes"])
        + ",\n\t\tUnpackedBytes:   "
        + str(value["unpacked_bytes"])
        + ",\n\t},"
        for name, value in sorted(contract["managed_image_capacity_estimates"].items())
    )
    owner_names = [_go_string(name) for name in contract["persistent_data_owners"]]
    owner_name_width = max(len(name) for name in owner_names)
    owner_lines = "\n".join(
        "\t"
        + _go_string(name)
        + ":"
        + " " * (owner_name_width - len(_go_string(name)) + 1)
        + "{"
        + ", ".join(
            "{UID: " + str(owner["uid"]) + ", GID: " + str(owner["gid"]) + "}"
            for owner in owners
        )
        + "},"
        for name, owners in sorted(contract["persistent_data_owners"].items())
    )

    return f'''// Code generated from {source} by scripts/docs_sync.py; DO NOT EDIT.
package contract

const (
{constant_lines}
)

type ImageCapacityEstimate struct {{
\tCompressedBytes uint64
\tUnpackedBytes   uint64
}}

var ManagedImageCapacityEstimates = map[string]ImageCapacityEstimate{{
{estimate_lines}
}}

type PersistentDataOwner struct {{
\tUID uint32
\tGID uint32
}}

var PersistentDataOwners = map[string][]PersistentDataOwner{{
{owner_lines}
}}
'''
def _validate_technical_profiles_contract(
    raw: Any,
    label: str,
) -> dict[str, Any]:
    contract = _expect_object(raw, label)
    _reject_unknown_keys(contract, {"schema_version", "profiles"}, label)
    if set(contract) != {"schema_version", "profiles"}:
        raise DocsSyncError(f"{label} must contain schema_version and profiles")
    if contract["schema_version"] != 2:
        raise DocsSyncError(f"{label}.schema_version must be 2")

    profiles = _expect_object(contract["profiles"], f"{label}.profiles")
    if set(profiles) != {"target"}:
        raise DocsSyncError(f"{label}.profiles must contain exactly target")

    profile_keys = {
        "profile_id",
        "manager",
        "container",
        "gateway",
        "compose",
        "environment",
        "labels",
        "workspace",
        "platform",
    }
    group_keys = {
        "manager": {
            "binary",
            "unit",
            "config_directory",
            "config_file",
            "data_directory",
            "state_directory",
            "runtime_socket_path",
            "default_socket_path",
            "default_token_file",
        },
        "container": {"data_root", "secret_root", "control_socket_path"},
        "gateway": {"status_path", "health_path"},
        "compose": {"project", "core_network"},
        "environment": {"manager_prefix", "platform_prefix", "keys"},
        "labels": {
            "prefix",
            "sandbox_container_prefix",
            "migration_container_prefix",
            "watchdog_unit_prefix",
            "recovery_watchdog_unit_prefix",
        },
        "workspace": {"internal_directory", "scope_marker"},
        "platform": {
            "default_data_root",
            "database_baseline",
            "instance_lock",
            "camofox_sidecar",
            "session_namespace",
            "session_cookie",
            "health_service",
            "search_health_service",
            "agent_runtime_health_service",
        },
    }
    environment_key_names = {
        "technical_profile",
        "deployment_mode",
        "manager_socket",
        "manager_token_file",
        "host_data_root",
    }

    def complete_object(
        value: Any, expected: set[str], value_label: str
    ) -> dict[str, Any]:
        item = _expect_object(value, value_label)
        _reject_unknown_keys(item, expected, value_label)
        missing = sorted(expected - set(item))
        if missing:
            raise DocsSyncError(
                f"{value_label} is missing required keys: {', '.join(missing)}"
            )
        return item

    def nonempty_string(value: Any, value_label: str) -> str:
        if (
            not isinstance(value, str)
            or not value
            or value != value.strip()
            or any(character in value for character in ("\x00", "\r", "\n"))
        ):
            raise DocsSyncError(f"{value_label} must be a non-empty canonical string")
        return value

    def absolute_path(value: Any, value_label: str) -> str:
        path = nonempty_string(value, value_label)
        parsed = PurePosixPath(path)
        if (
            not parsed.is_absolute()
            or path.startswith("//")
            or path.endswith("/")
            or parsed.as_posix() != path
            or any(part in {".", ".."} for part in parsed.parts)
        ):
            raise DocsSyncError(f"{value_label} must be a canonical absolute path")
        return path

    def relative_path(value: Any, value_label: str) -> str:
        path = nonempty_string(value, value_label)
        parsed = PurePosixPath(path)
        if (
            parsed.is_absolute()
            or path.endswith("/")
            or parsed.as_posix() != path
            or any(part in {"", ".", ".."} for part in parsed.parts)
        ):
            raise DocsSyncError(f"{value_label} must be a canonical relative path")
        return path

    profile_label = f"{label}.profiles.target"
    profile = complete_object(profiles["target"], profile_keys, profile_label)
    profile_id = nonempty_string(profile["profile_id"], f"{profile_label}.profile_id")
    if re.fullmatch(r"[a-z][a-z0-9-]*-v[1-9][0-9]*", profile_id) is None:
        raise DocsSyncError(
            f"{profile_label}.profile_id must be a versioned lowercase identifier"
        )

    groups = {
        name: complete_object(profile[name], keys, f"{profile_label}.{name}")
        for name, keys in group_keys.items()
    }
    manager = groups["manager"]
    container = groups["container"]
    gateway = groups["gateway"]
    compose = groups["compose"]
    environment = groups["environment"]
    labels = groups["labels"]
    workspace = groups["workspace"]
    platform = groups["platform"]

    for name in (
        "binary",
        "unit",
        "config_directory",
        "config_file",
        "data_directory",
        "state_directory",
    ):
        relative_path(manager[name], f"{profile_label}.manager.{name}")
    if "/" in manager["binary"] or "/" in manager["unit"]:
        raise DocsSyncError(
            f"{profile_label}.manager binary and unit must be base names"
        )
    if not manager["unit"].endswith(".service"):
        raise DocsSyncError(f"{profile_label}.manager.unit must be a service unit")
    relative_path(
        manager["runtime_socket_path"],
        f"{profile_label}.manager.runtime_socket_path",
    )

    for name in ("default_socket_path", "default_token_file"):
        absolute_path(manager[name], f"{profile_label}.manager.{name}")
    for name, value in container.items():
        absolute_path(value, f"{profile_label}.container.{name}")
    for name, value in gateway.items():
        absolute_path(value, f"{profile_label}.gateway.{name}")
    if manager["default_socket_path"] != container["control_socket_path"]:
        raise DocsSyncError(
            f"{profile_label} default and container control sockets must match"
        )

    for name, value in compose.items():
        identifier = nonempty_string(value, f"{profile_label}.compose.{name}")
        if re.fullmatch(r"[a-z0-9][a-z0-9_-]*", identifier) is None:
            raise DocsSyncError(
                f"{profile_label}.compose.{name} must be a lowercase Compose identifier"
            )

    environment_keys = complete_object(
        environment["keys"],
        environment_key_names,
        f"{profile_label}.environment.keys",
    )
    for prefix_name in ("manager_prefix", "platform_prefix"):
        prefix = nonempty_string(
            environment[prefix_name],
            f"{profile_label}.environment.{prefix_name}",
        )
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", prefix) is None:
            raise DocsSyncError(
                f"{profile_label}.environment.{prefix_name} must be an uppercase prefix"
            )
    for name, value in environment_keys.items():
        variable = nonempty_string(
            value, f"{profile_label}.environment.keys.{name}"
        )
        if re.fullmatch(r"[A-Z][A-Z0-9_]*", variable) is None:
            raise DocsSyncError(
                f"{profile_label}.environment.keys.{name} must be an environment variable"
            )
        if not variable.startswith(environment["manager_prefix"] + "_"):
            raise DocsSyncError(
                f"{profile_label}.environment.keys.{name} must use manager_prefix"
            )
    if len(set(environment_keys.values())) != len(environment_keys):
        raise DocsSyncError(f"{profile_label}.environment.keys must be unique")

    label_prefix = nonempty_string(labels["prefix"], f"{profile_label}.labels.prefix")
    if re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)+", label_prefix) is None:
        raise DocsSyncError(
            f"{profile_label}.labels.prefix must be a lowercase label namespace"
        )
    for name in (
        "sandbox_container_prefix",
        "migration_container_prefix",
        "watchdog_unit_prefix",
        "recovery_watchdog_unit_prefix",
    ):
        value = nonempty_string(labels[name], f"{profile_label}.labels.{name}")
        if re.fullmatch(r"[a-z0-9][a-z0-9-]*-", value) is None:
            raise DocsSyncError(
                f"{profile_label}.labels.{name} must be a lowercase name prefix"
            )

    internal_directory = relative_path(
        workspace["internal_directory"],
        f"{profile_label}.workspace.internal_directory",
    )
    if (
        len(PurePosixPath(internal_directory).parts) != 1
        or not internal_directory.startswith(".")
    ):
        raise DocsSyncError(
            f"{profile_label}.workspace.internal_directory must be one hidden directory"
        )
    scope_marker = relative_path(
        workspace["scope_marker"], f"{profile_label}.workspace.scope_marker"
    )
    if (
        len(PurePosixPath(scope_marker).parts) != 1
        or not scope_marker.startswith(".")
    ):
        raise DocsSyncError(
            f"{profile_label}.workspace.scope_marker must be one hidden file"
        )

    if platform["default_data_root"] != container["data_root"]:
        raise DocsSyncError(
            f"{profile_label}.platform.default_data_root must match container.data_root"
        )
    absolute_path(
        platform["default_data_root"],
        f"{profile_label}.platform.default_data_root",
    )
    for name in (
        "database_baseline",
        "instance_lock",
        "camofox_sidecar",
        "session_namespace",
        "session_cookie",
        "health_service",
        "search_health_service",
        "agent_runtime_health_service",
    ):
        relative_path(platform[name], f"{profile_label}.platform.{name}")
        if "/" in platform[name]:
            raise DocsSyncError(
                f"{profile_label}.platform.{name} must be a base name"
            )
    return contract

def _render_go_technical_profiles(contract: dict[str, Any], source: str) -> str:
    field_paths = (
        ("ProfileID", ("profile_id",)),
        ("ManagerBinary", ("manager", "binary")),
        ("ManagerUnit", ("manager", "unit")),
        ("ConfigDirectory", ("manager", "config_directory")),
        ("ConfigFile", ("manager", "config_file")),
        ("DataDirectory", ("manager", "data_directory")),
        ("ManagerStateDirectory", ("manager", "state_directory")),
        ("RuntimeSocketPath", ("manager", "runtime_socket_path")),
        ("ContainerDataRoot", ("container", "data_root")),
        ("ContainerSecretRoot", ("container", "secret_root")),
        ("ContainerControlSocketPath", ("container", "control_socket_path")),
        ("GatewayStatusPath", ("gateway", "status_path")),
        ("GatewayHealthPath", ("gateway", "health_path")),
        ("ComposeProject", ("compose", "project")),
        ("CoreNetwork", ("compose", "core_network")),
        ("EnvironmentPrefix", ("environment", "manager_prefix")),
        ("LabelPrefix", ("labels", "prefix")),
        ("SandboxContainerPrefix", ("labels", "sandbox_container_prefix")),
        ("MigrationContainerPrefix", ("labels", "migration_container_prefix")),
        ("WatchdogUnitPrefix", ("labels", "watchdog_unit_prefix")),
        (
            "RecoveryWatchdogUnitPrefix",
            ("labels", "recovery_watchdog_unit_prefix"),
        ),
        ("InternalWorkspaceDirectory", ("workspace", "internal_directory")),
    )
    field_width = max(len(name) for name, _ in field_paths)
    profile = contract["profiles"]["target"]

    def lookup(path: tuple[str, ...]) -> str:
        value: Any = profile
        for component in path:
            value = value[component]
        return "" if value is None else value

    lines = "\n".join(
        f"\t{name + ':':<{field_width + 1}} {_go_string(lookup(path))},"
        for name, path in field_paths
    )
    return f'''// Code generated from {source} by scripts/docs_sync.py; DO NOT EDIT.
package identity

var generatedTargetProfile = Profile{{
{lines}
}}
'''
def _python_technical_profile_projection(profile: dict[str, Any]) -> dict[str, Any]:
    environment = profile["environment"]
    keys = environment["keys"]
    manager = profile["manager"]
    platform = profile["platform"]
    return {
        "profile_id": profile["profile_id"],
        "selector_environment_variable": keys["technical_profile"],
        "deployment_mode_environment_variable": keys["deployment_mode"],
        "manager_socket_environment_variable": keys["manager_socket"],
        "manager_token_file_environment_variable": keys["manager_token_file"],
        "host_data_root_environment_variable": keys["host_data_root"],
        "manager_environment_prefix": environment["manager_prefix"],
        "platform_environment_prefix": environment["platform_prefix"],
        "default_data_root": platform["default_data_root"],
        "default_manager_socket": manager["default_socket_path"],
        "default_manager_token_file": manager["default_token_file"],
        "database_baseline_name": platform["database_baseline"],
        "instance_lock_name": platform["instance_lock"],
        "scope_marker_name": profile["workspace"]["scope_marker"],
        "camofox_sidecar_name": platform["camofox_sidecar"],
        "workspace_internal_directory": profile["workspace"]["internal_directory"],
        "session_namespace": platform["session_namespace"],
        "session_cookie_name": platform["session_cookie"],
        "health_service": platform["health_service"],
        "search_health_service": platform["search_health_service"],
        "agent_runtime_health_service": platform["agent_runtime_health_service"],
    }



def _render_python_technical_profiles(contract: dict[str, Any], source: str) -> str:
    projection = _python_technical_profile_projection(contract["profiles"]["target"])
    lines = ["    'target': {"]
    lines.extend(
        f"        {name!r}: {value!r},"
        for name, value in projection.items()
    )
    lines.append("    },")
    return f'''# Generated from {source} by scripts/docs_sync.py; do not edit.
from __future__ import annotations

TECHNICAL_PROFILES: dict[str, dict[str, object]] = {{
{chr(10).join(lines)}
}}
'''

def _render_typescript_technical_profile(
    contract: dict[str, Any], source: str
) -> str:
    target_profile = contract["profiles"]["target"]
    return f'''// Generated from {source} by scripts/docs_sync.py; do not edit.
export const TARGET_TECHNICAL_PROFILE_ID = {_typescript_string(target_profile["profile_id"])} as const;
export const TARGET_TECHNICAL_PROFILE_ENVIRONMENT_VARIABLE = {_typescript_string(target_profile["environment"]["keys"]["technical_profile"])} as const;
export const TARGET_MANAGER_EXECUTOR_SOCKET_PATH = {_typescript_string(target_profile["manager"]["default_socket_path"])} as const;
'''
def _validate_upstream_sources_contract(raw: Any, label: str) -> dict[str, Any]:
    contract = _expect_object(raw, label)
    _reject_unknown_keys(contract, {"schema_version", "sources"}, label)
    if contract.get("schema_version") != 1:
        raise DocsSyncError(f"{label}.schema_version must be 1")
    sources = _expect_object(contract.get("sources"), f"{label}.sources")
    required_sources = {"firecrawl"}
    if set(sources) != required_sources:
        raise DocsSyncError(
            f"{label}.sources must be exactly: firecrawl"
        )
    for name in sorted(sources):
        source_label = f"{label}.sources.{name}"
        if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
            raise DocsSyncError(f"{source_label} has an invalid source name")
        source = _expect_object(sources[name], source_label)
        _reject_unknown_keys(
            source,
            {
                "repository_url",
                "revision",
                "required_paths",
                "compose_services",
            },
            source_label,
        )
        repository_url = source.get("repository_url")
        if not isinstance(repository_url, str):
            raise DocsSyncError(f"{source_label}.repository_url must be a string")
        parsed = urlsplit(repository_url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise DocsSyncError(
                f"{source_label}.repository_url must be a credential-free HTTPS URL"
            )
        revision = source.get("revision")
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise DocsSyncError(
                f"{source_label}.revision must be a lowercase 40-character commit SHA"
            )
        required_paths = _expect_string_list(
            source.get("required_paths"), f"{source_label}.required_paths"
        )
        if len(set(required_paths)) != len(required_paths):
            raise DocsSyncError(f"{source_label}.required_paths must be unique")
        for required in required_paths:
            path = PurePosixPath(required)
            if (
                path.is_absolute()
                or not path.parts
                or any(part in {"", ".", ".."} for part in path.parts)
            ):
                raise DocsSyncError(
                    f"{source_label}.required_paths contains an unsafe path: {required}"
                )
        compose_services = source.get("compose_services")
        if name == "firecrawl":
            services = _expect_string_list(
                compose_services,
                f"{source_label}.compose_services",
            )
            if tuple(sorted(services)) != services:
                raise DocsSyncError(
                    f"{source_label}.compose_services must be sorted"
                )
            for service in services:
                if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", service):
                    raise DocsSyncError(
                        f"{source_label}.compose_services contains an invalid service: {service}"
                    )
        elif compose_services is not None:
            raise DocsSyncError(
                f"{source_label}.compose_services is only valid for firecrawl"
            )
    return contract


def _contract_source(root: Path, contract: Contract) -> Path:
    path = _reject_symlink_chain(root, contract.source, f"contract {contract.identifier} source")
    _require_regular_file(path, f"contract {contract.identifier} source", contract.source)
    return path


def render_contract(root: Path, contract: Contract) -> dict[str, str]:
    raw = _read_json(_contract_source(root, contract), f"contract {contract.identifier}")
    if contract.identifier == "runtime-policy":
        parsed = _validate_runtime_contract(raw, f"contract {contract.identifier}")
    elif contract.identifier == "container-platform":
        parsed = _validate_container_platform_contract(
            raw, f"contract {contract.identifier}"
        )
    elif contract.identifier == "upstream-sources":
        parsed = _validate_upstream_sources_contract(
            raw, f"contract {contract.identifier}"
        )
    elif contract.identifier == "technical-profiles":
        parsed = _validate_technical_profiles_contract(
            raw, f"contract {contract.identifier}"
        )
    else:
        raise DocsSyncError(f"unsupported contract id: {contract.identifier}")
    rendered: dict[str, str] = {}
    for target in contract.targets:
        if target.format == "python-runtime-policy":
            content = _render_python_runtime_policy(parsed, contract.source)
        elif target.format == "typescript-runtime-policy":
            content = _render_typescript_runtime_policy(parsed, contract.source)
        elif target.format == "go-runtime-policy":
            content = _render_go_runtime_policy(parsed, contract.source)
        elif target.format == "python-container-platform":
            content = _render_python_container_platform(parsed, contract.source)
        elif target.format == "typescript-container-platform":
            content = _render_typescript_container_platform(parsed, contract.source)
        elif target.format == "go-container-platform":
            content = _render_go_container_platform(parsed, contract.source)
        elif target.format == "go-technical-profiles":
            content = _render_go_technical_profiles(parsed, contract.source)
        elif target.format == "python-technical-profiles":
            content = _render_python_technical_profiles(parsed, contract.source)
        elif target.format == "typescript-technical-profile":
            content = _render_typescript_technical_profile(parsed, contract.source)
        else:  # CONTRACTS is closed; keep defense in depth.
            raise DocsSyncError(f"unsupported target format: {target.format}")
        rendered[target.path] = content
    return rendered


def _atomic_write(root: Path, relative: str, content: str) -> None:
    path = _reject_symlink_chain(root, relative, "generated contract target")
    if path.exists() and not stat.S_ISREG(path.lstat().st_mode):
        raise DocsSyncError(f"generated contract target must be a regular file: {relative}")
    path.parent.mkdir(parents=True, exist_ok=True)
    _reject_symlink_chain(root, relative, "generated contract target")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o644)
        _reject_symlink_chain(root, relative, "generated contract target")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sync_contracts(root: Path) -> tuple[str, ...]:
    written: list[str] = []
    seen_targets: set[str] = set()
    for contract in CONTRACTS:
        for relative, content in render_contract(root, contract).items():
            if relative in seen_targets:
                raise DocsSyncError(f"multiple contracts generate the same target: {relative}")
            seen_targets.add(relative)
            target = _reject_symlink_chain(root, relative, "generated contract target")
            if target.exists() and not stat.S_ISREG(target.lstat().st_mode):
                raise DocsSyncError(
                    f"generated contract target must be a regular file: {relative}"
                )
            current = target.read_text(encoding="utf-8") if target.is_file() else None
            current_mode = stat.S_IMODE(target.stat().st_mode) if target.is_file() else None
            if current != content or current_mode != 0o644:
                _atomic_write(root, relative, content)
                written.append(relative)
    return tuple(written)


def _markdown_without_fenced_code(text: str) -> str:
    kept: list[str] = []
    fence: str | None = None
    for line in text.splitlines():
        stripped = line.lstrip()
        marker = "```" if stripped.startswith("```") else "~~~" if stripped.startswith("~~~") else None
        if fence is None and marker:
            fence = marker
            continue
        if fence is not None:
            if stripped.startswith(fence):
                fence = None
            continue
        kept.append(line)
    return "\n".join(kept)


def _heading_anchors(text: str) -> set[str]:
    """GitHub-style heading anchors: lowercase, drop punctuation, spaces become hyphens, duplicates get -N."""
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    for line in text.splitlines():
        match = MARKDOWN_HEADING_RE.match(line)
        if match is None:
            continue
        slug = re.sub(r"[^\w\- ]", "", match.group(2).strip().lower()).replace(" ", "-")
        seen = counts.get(slug, 0)
        counts[slug] = seen + 1
        anchors.add(slug if seen == 0 else f"{slug}-{seen}")
    return anchors


def _link_parts(raw_target: str) -> tuple[str | None, str | None] | None:
    """Split a Markdown link target into (local path or None for same file, fragment); None when not local."""
    target = raw_target.strip()
    if not target:
        return None
    if target.startswith("<") and ">" in target:
        target = target[1 : target.index(">")]
    else:
        target = target.split(maxsplit=1)[0]
    target = unquote(target)
    if not target or target.startswith("//"):
        return None
    parsed = urlsplit(target)
    if parsed.scheme:
        return None
    return (parsed.path or None, parsed.fragment or None)


def validate_markdown_links(root: Path) -> list[str]:
    errors: list[str] = []
    docs_root = _safe_path(root, "docs")
    if not docs_root.is_dir():
        return ["canonical documentation directory is missing: docs/"]
    documents = set(docs_root.rglob("*.md"))
    for relative in ENTRY_MARKDOWN_PATHS:
        entry = _safe_path(root, relative)
        if not entry.is_file():
            errors.append(f"documentation entry point is missing: {relative}")
        else:
            documents.add(entry)
    resolved_root = root.resolve()
    anchor_cache: dict[Path, set[str]] = {}

    def anchors_of(path: Path) -> set[str]:
        if path not in anchor_cache:
            anchor_cache[path] = _heading_anchors(_markdown_without_fenced_code(path.read_text(encoding="utf-8")))
        return anchor_cache[path]

    for document in sorted(documents):
        label = _display_path(document, root)
        if document.is_symlink():
            errors.append(f"documentation file must not be a symlink: {label}")
            continue
        text = _markdown_without_fenced_code(document.read_text(encoding="utf-8"))
        for match in MARKDOWN_LINK_RE.finditer(text):
            parts = _link_parts(match.group(1))
            if parts is None:
                continue
            linked, fragment = parts
            if linked is None:
                target = document
            elif linked.startswith("/"):
                target = root / linked.lstrip("/")
            else:
                target = document.parent / linked
            resolved = target.resolve()
            if resolved != resolved_root and resolved_root not in resolved.parents:
                errors.append(f"{label} links outside the repository: {match.group(1)}")
            elif not resolved.exists():
                errors.append(f"{label} has a broken relative link: {match.group(1)}")
            elif fragment and resolved.suffix == ".md" and resolved.is_file() and fragment.lower() not in anchors_of(resolved):
                errors.append(f"{label} links to a missing heading anchor: {match.group(1)}")
    return errors


def validate_current_tree(root: Path) -> list[str]:
    errors: list[str] = []
    seen_targets: set[str] = set()
    for contract in CONTRACTS:
        try:
            rendered = render_contract(root, contract)
        except DocsSyncError as exc:
            errors.append(str(exc))
            continue
        for target_path, expected in rendered.items():
            if target_path in seen_targets:
                errors.append(f"multiple contracts generate the same target: {target_path}")
                continue
            seen_targets.add(target_path)
            try:
                target = _reject_symlink_chain(root, target_path, "generated contract target")
            except DocsSyncError as exc:
                errors.append(str(exc))
                continue
            try:
                target_stat = target.lstat()
            except FileNotFoundError:
                errors.append(f"generated contract target is missing: {target_path}; run scripts/docs_sync.py sync")
                continue
            if not stat.S_ISREG(target_stat.st_mode):
                errors.append(f"generated contract target must be a regular file: {target_path}")
                continue
            actual = target.read_text(encoding="utf-8")
            if actual != expected:
                errors.append(f"generated contract target is stale: {target_path}; run scripts/docs_sync.py sync")
            elif stat.S_IMODE(target_stat.st_mode) & 0o111:
                errors.append(
                    f"generated contract target must not be executable: {target_path}; run scripts/docs_sync.py sync"
                )

    errors.extend(validate_markdown_links(root))
    return errors


def _print_errors(errors: Sequence[str]) -> None:
    print("documentation sync check failed:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)


def command_sync(root: Path) -> int:
    try:
        written = sync_contracts(root)
    except DocsSyncError as exc:
        _print_errors([str(exc)])
        return 1
    if written:
        print("updated generated design contracts:")
        for path in written:
            print(f"  - {path}")
    else:
        print("generated design contracts are already current")
    return 0


def command_check(root: Path) -> int:
    try:
        errors = validate_current_tree(root)
    except DocsSyncError as exc:
        errors = [str(exc)]
    if errors:
        _print_errors(errors)
        return 1
    print("generated contracts and documentation links are in sync")
    return 0




def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("sync", "check"):
        command = subparsers.add_parser(name)
        command.add_argument("--root", type=Path, default=_repo_root_from_script())
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    if args.command == "sync":
        return command_sync(root)
    if args.command == "check":
        return command_check(root)
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
