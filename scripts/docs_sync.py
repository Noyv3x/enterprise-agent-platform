#!/usr/bin/env python3
"""Keep canonical design documents, executable contracts, and code in sync.

The checker deliberately uses only the Python standard library so it can run
before project dependencies are installed.  ``sync`` writes deterministic
generated contract modules; ``check`` validates the current tree; and
``check-change`` additionally verifies bidirectional document/code co-changes
between two Git revisions.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import posixpath
import re
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence
from urllib.parse import unquote, urlsplit


MANIFEST_PATH = PurePosixPath("docs/domains.json")
REQUIRED_RUNTIME_POLICIES = {
    "run_idle_timeout",
    "max_turns_per_run",
    "terminal_timeout",
}
REQUIRED_FORBIDDEN_TOP_LEVEL_FILES = {"claude.md"}
MARKDOWN_LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
DOMAIN_ID_RE = re.compile(r"^[a-z][a-z0-9-]*$")
ZERO_SHA_RE = re.compile(r"^0+$")
WORKTREE_REVISION = "WORKTREE"
INDEX_REVISION = "INDEX"
JAVASCRIPT_MAX_SAFE_INTEGER = (1 << 53) - 1
NODE_MAX_TIMER_MILLISECONDS = 2_147_483_647
ENTRY_MARKDOWN_PATHS = (
    "README.md",
    "enterprise-agent-platform/README.md",
    "enterprise-agent-platform/agent-runtime/README.md",
)
REQUIRED_RUNTIME_POLICY_SOURCE = "docs/contracts/runtime-policy.json"
REQUIRED_RUNTIME_POLICY_DOMAINS = frozenset({"platform", "agent-runtime", "frontend"})
REQUIRED_RUNTIME_POLICY_TARGETS = {
    "enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py": "python-runtime-policy",
    "enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts": "typescript-runtime-policy",
    "enterprise-agent-platform/frontend/src/design-contract.generated.ts": "typescript-runtime-policy",
}
REQUIRED_UPSTREAM_SOURCES_SOURCE = "docs/contracts/upstream-sources.json"
REQUIRED_UPSTREAM_SOURCES_DOMAINS = frozenset({"integrations", "platform"})
REQUIRED_UPSTREAM_SOURCES_TARGETS: dict[str, str] = {}
REQUIRED_CONTAINER_PLATFORM_SOURCE = "docs/contracts/container-platform.json"
REQUIRED_CONTAINER_PLATFORM_DOMAINS = frozenset(
    {"deployment", "platform", "agent-runtime", "frontend"}
)
REQUIRED_CONTAINER_PLATFORM_TARGETS = {
    "manager/internal/contract/generated.go": "go-container-platform",
    "enterprise-agent-platform/enterprise_agent_platform/container_contract_generated.py": "python-container-platform",
    "enterprise-agent-platform/agent-runtime/src/container-contract.generated.ts": "typescript-container-platform",
    "enterprise-agent-platform/frontend/src/container-contract.generated.ts": "typescript-container-platform",
}
REQUIRED_RELEASE_TRANSITION_SOURCE = "docs/contracts/release-transition.json"
REQUIRED_RELEASE_TRANSITION_CHALLENGE_SCHEMA = (
    "docs/contracts/release-transition-challenge.schema.json"
)
REQUIRED_RELEASE_TRANSITION_RECEIPT_SCHEMA = (
    "docs/contracts/release-transition-receipt.schema.json"
)
REQUIRED_RELEASE_TRANSITION_DOCUMENTS = frozenset(
    {
        REQUIRED_RELEASE_TRANSITION_SOURCE,
        REQUIRED_RELEASE_TRANSITION_CHALLENGE_SCHEMA,
        REQUIRED_RELEASE_TRANSITION_RECEIPT_SCHEMA,
    }
)
REQUIRED_OWNED_CODE_PROBES = {
    ".gitignore": frozenset({"repository-development"}),
    ".github/workflows/quality.yml": frozenset({"repository-development"}),
    "scripts/docs_sync.py": frozenset({"documentation-governance"}),
    "scripts/release.sh": frozenset({"documentation-governance"}),
    "enterprise-agent-platform/pyproject.toml": frozenset({"platform"}),
    "enterprise-agent-platform/enterprise_agent_platform/service.py": frozenset({"platform"}),
    "enterprise-agent-platform/enterprise_agent_platform/bundled_skills/example/scripts/helper.py": frozenset({"integrations"}),
    "enterprise-agent-platform/agent-runtime/package-lock.json": frozenset({"agent-runtime"}),
    "enterprise-agent-platform/agent-runtime/tsconfig.json": frozenset({"agent-runtime"}),
    "enterprise-agent-platform/agent-runtime/src/index.ts": frozenset({"agent-runtime"}),
    "enterprise-agent-platform/camofox-runtime/package-lock.json": frozenset({"integrations"}),
    "enterprise-agent-platform/camofox-runtime/patch-runtime.cjs": frozenset({"integrations"}),
    "enterprise-agent-platform/frontend/package-lock.json": frozenset({"frontend"}),
    "enterprise-agent-platform/frontend/tsconfig.json": frozenset({"frontend"}),
    "enterprise-agent-platform/frontend/vite.config.ts": frozenset({"frontend"}),
    "enterprise-agent-platform/frontend/public/theme-init.js": frozenset({"frontend"}),
    "enterprise-agent-platform/frontend/src/main.tsx": frozenset({"frontend"}),
}


class DocsSyncError(RuntimeError):
    """Raised when the documentation contract is malformed or out of sync."""


@dataclass(frozen=True)
class Domain:
    identifier: str
    documents: tuple[str, ...]
    code: tuple[str, ...]
    tests: tuple[str, ...]


@dataclass(frozen=True)
class ContractTarget:
    path: str
    format: str


@dataclass(frozen=True)
class Contract:
    identifier: str
    source: str
    domains: tuple[str, ...]
    targets: tuple[ContractTarget, ...]


@dataclass(frozen=True)
class Coverage:
    code_include: tuple[str, ...]
    code_exclude: tuple[str, ...]
    document_include: tuple[str, ...]
    document_exclude: tuple[str, ...]


@dataclass(frozen=True)
class Manifest:
    version: int
    forbidden_top_level_files: tuple[str, ...]
    coverage: Coverage
    domains: tuple[Domain, ...]
    contracts: tuple[Contract, ...]


@dataclass(frozen=True)
class GitTreeEntry:
    mode: str
    object_type: str
    object_id: str
    path: str


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


def _is_beneath(relative: str, parent: str) -> bool:
    parts = PurePosixPath(relative).parts
    parent_parts = PurePosixPath(parent).parts
    return len(parts) > len(parent_parts) and parts[: len(parent_parts)] == parent_parts


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

    Release-transition inputs are signed or drive release visibility, so the
    ordinary last-member-wins behavior of ``json.loads`` is not acceptable.
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
    """Validate the closed Draft-2020-12 subset used by receipt contracts.

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


def validate_release_transition_contract(value: Any, label: str) -> dict[str, Any]:
    contract = _expect_object(value, label)
    _reject_unknown_keys(
        contract,
        {
            "schema_version",
            "transition_id",
            "stage",
            "predecessor_generation",
            "source_owner_compat",
            "source_profile_id",
            "target_profile_id",
            "manifest_protocol",
            "promotion",
            "deployment_receipt",
        },
        label,
    )
    required_keys = {
        "schema_version", "transition_id", "stage", "predecessor_generation",
        "source_profile_id", "target_profile_id", "manifest_protocol",
        "promotion", "deployment_receipt",
    }
    if set(contract) not in {frozenset(required_keys), frozenset(required_keys | {"source_owner_compat"})}:
        raise DocsSyncError(f"{label} must contain the complete closed transition contract")
    if (
        type(contract["schema_version"]) is not int
        or contract["schema_version"] != 1
        or contract["transition_id"] != "technical-namespace-v1"
    ):
        raise DocsSyncError(f"{label} has an unsupported schema or transition id")
    if contract["stage"] not in {"source_owner", "bridge", "cleanup", "target_baseline"}:
        raise DocsSyncError(
            f"{label}.stage must be source_owner, bridge, cleanup, or target_baseline"
        )
    if not isinstance(contract["predecessor_generation"], str) or re.fullmatch(r"[0-9a-f]{40}", contract["predecessor_generation"]) is None:
        raise DocsSyncError(f"{label}.predecessor_generation must be a lowercase 40-character commit")
    compat = contract.get("source_owner_compat")
    if contract["stage"] == "source_owner":
        compat = _expect_object(compat, f"{label}.source_owner_compat")
        _reject_unknown_keys(
            compat,
            {"generation", "manifest_sha256", "compose_sha256", "managed_images"},
            f"{label}.source_owner_compat",
        )
        if set(compat) != {"generation", "manifest_sha256", "compose_sha256", "managed_images"}:
            raise DocsSyncError(f"{label}.source_owner_compat must be complete")
        if compat["generation"] != contract["predecessor_generation"]:
            raise DocsSyncError(f"{label}.source_owner_compat.generation must equal predecessor_generation")
        canonical_p1 = {
            "generation": "983f79b4900502f35fac6de8154eb344fc9f143b",
            "manifest_sha256": "8772fc457552c48cb5c9623b4411647e78dde18065df07d6520ac6b9d32520c1",
            "compose_sha256": "ebe1ce922cd33c9acb816bf9af175fc7e3838835cb413ab3ee91b91808698954",
        }
        if any(compat.get(name) != value for name, value in canonical_p1.items()):
            raise DocsSyncError(
                f"{label}.source_owner_compat is limited to the canonical P1 generation and bytes"
            )
        for name in ("manifest_sha256", "compose_sha256"):
            if not isinstance(compat[name], str) or re.fullmatch(r"[0-9a-f]{64}", compat[name]) is None:
                raise DocsSyncError(f"{label}.source_owner_compat.{name} must be a lowercase SHA-256")
        expected_compat_images = [
            "agent-runtime", "agent-sandbox", "camofox", "firecrawl-api",
            "firecrawl-playwright", "firecrawl-postgres", "firecrawl-rabbitmq",
            "firecrawl-redis", "platform", "searxng",
        ]
        if compat["managed_images"] != expected_compat_images:
            raise DocsSyncError(f"{label}.source_owner_compat.managed_images must preserve the exact P1 closed set")
    elif compat is not None:
        raise DocsSyncError(f"{label}.source_owner_compat is permitted only for source_owner")
    if contract["source_profile_id"] != "ubitech-agent-v1" or contract["target_profile_id"] != "agent-platform-v1":
        raise DocsSyncError(f"{label} must bind the canonical source and target profiles")
    protocol = _expect_object(contract["manifest_protocol"], f"{label}.manifest_protocol")
    _reject_unknown_keys(protocol, {"ordinary_schema_version", "bridge_schema_version", "cleanup_schema_version"}, f"{label}.manifest_protocol")
    expected_protocol = {
        "ordinary_schema_version": 1,
        "bridge_schema_version": 1,
        "cleanup_schema_version": 2,
    }
    if json.dumps(protocol, sort_keys=True) != json.dumps(expected_protocol, sort_keys=True):
        raise DocsSyncError(f"{label}.manifest_protocol must preserve the v1 ordinary/bridge and v2 cleanup barrier")
    promotion = _expect_object(contract["promotion"], f"{label}.promotion")
    _reject_unknown_keys(promotion, {"draft_stages", "require_direct_predecessor", "concurrency_group"}, f"{label}.promotion")
    expected_promotion = {
        "draft_stages": ["bridge", "cleanup"],
        "require_direct_predecessor": True,
        "concurrency_group": "container-channel-main",
    }
    if json.dumps(promotion, sort_keys=True) != json.dumps(expected_promotion, sort_keys=True):
        raise DocsSyncError(f"{label}.promotion must preserve serialized direct-predecessor draft gates")
    receipt = _expect_object(contract["deployment_receipt"], f"{label}.deployment_receipt")
    _reject_unknown_keys(
        receipt,
        {
            "schema_version", "algorithm", "canonicalization", "state_root",
            "challenge_ttl_seconds", "receipt_ttl_seconds",
            "source_owner_receipt_type", "target_commit_receipt_type",
        },
        f"{label}.deployment_receipt",
    )
    expected_receipt = {
        "schema_version": 1,
        "algorithm": "Ed25519",
        "canonicalization": "RFC8785",
        "state_root": "$XDG_STATE_HOME/agent-platform/release-transition",
        "challenge_ttl_seconds": 300,
        "receipt_ttl_seconds": 300,
        "source_owner_receipt_type": "source_owner_ready",
        "target_commit_receipt_type": "target_handoff_committed",
    }
    if json.dumps(receipt, sort_keys=True) != json.dumps(expected_receipt, sort_keys=True):
        raise DocsSyncError(f"{label}.deployment_receipt does not match the one-time Ed25519 receipt policy")
    return contract


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


def load_manifest(root: Path) -> Manifest:
    manifest_path = _reject_symlink_chain(
        root,
        MANIFEST_PATH.as_posix(),
        "documentation manifest",
    )
    _require_regular_file(
        manifest_path,
        "documentation manifest",
        MANIFEST_PATH.as_posix(),
    )
    raw = _expect_object(
        _read_json(manifest_path, "documentation manifest"),
        "documentation manifest",
    )
    _reject_unknown_keys(
        raw,
        {"version", "forbidden_top_level_files", "coverage", "domains", "contracts"},
        "documentation manifest",
    )
    if raw.get("version") != 3:
        raise DocsSyncError("documentation manifest version must be 3")

    forbidden = _expect_string_list(
        raw.get("forbidden_top_level_files"),
        "forbidden_top_level_files",
    )
    for path in forbidden:
        if "/" in path or "\\" in path:
            raise DocsSyncError("forbidden_top_level_files may contain only top-level file names")
    missing_guards = REQUIRED_FORBIDDEN_TOP_LEVEL_FILES - {
        path.casefold() for path in forbidden
    }
    if missing_guards:
        raise DocsSyncError(
            "forbidden_top_level_files must permanently forbid: "
            + ", ".join(sorted(missing_guards))
        )

    coverage_raw = _expect_object(raw.get("coverage"), "coverage")
    _reject_unknown_keys(
        coverage_raw,
        {"code_include", "code_exclude", "document_include", "document_exclude"},
        "coverage",
    )
    coverage = Coverage(
        code_include=_expect_string_list(coverage_raw.get("code_include"), "coverage.code_include"),
        code_exclude=_expect_string_list(
            coverage_raw.get("code_exclude", []),
            "coverage.code_exclude",
            allow_empty=True,
        ),
        document_include=_expect_string_list(
            coverage_raw.get("document_include"),
            "coverage.document_include",
        ),
        document_exclude=_expect_string_list(
            coverage_raw.get("document_exclude", []),
            "coverage.document_exclude",
            allow_empty=True,
        ),
    )
    for label, patterns in (
        ("coverage.code_include", coverage.code_include),
        ("coverage.code_exclude", coverage.code_exclude),
        ("coverage.document_include", coverage.document_include),
        ("coverage.document_exclude", coverage.document_exclude),
    ):
        for pattern in patterns:
            try:
                _glob_regex(pattern)
            except DocsSyncError as exc:
                raise DocsSyncError(f"{label}: {exc}") from exc
    uncovered_probes = [
        path
        for path in REQUIRED_OWNED_CODE_PROBES
        if not path_matches(path, coverage.code_include)
        or path_matches(path, coverage.code_exclude)
    ]
    if uncovered_probes:
        raise DocsSyncError(
            "coverage must include owned production probes without excluding them: "
            + ", ".join(uncovered_probes)
        )

    domains_raw = raw.get("domains")
    if not isinstance(domains_raw, list) or not domains_raw:
        raise DocsSyncError("domains must be a non-empty JSON array")
    domains: list[Domain] = []
    seen_domain_ids: set[str] = set()
    for index, item in enumerate(domains_raw):
        label = f"domains[{index}]"
        domain_raw = _expect_object(item, label)
        _reject_unknown_keys(domain_raw, {"id", "documents", "code", "tests"}, label)
        identifier = domain_raw.get("id")
        if not isinstance(identifier, str) or not DOMAIN_ID_RE.fullmatch(identifier):
            raise DocsSyncError(f"{label}.id must match {DOMAIN_ID_RE.pattern}")
        if identifier in seen_domain_ids:
            raise DocsSyncError(f"duplicate domain id: {identifier}")
        seen_domain_ids.add(identifier)
        documents = _expect_string_list(domain_raw.get("documents"), f"{label}.documents")
        code = _expect_string_list(domain_raw.get("code"), f"{label}.code")
        tests = _expect_string_list(
            domain_raw.get("tests", []),
            f"{label}.tests",
            allow_empty=True,
        )
        for document in documents:
            _reject_symlink_chain(root, document, f"{label}.document")
            if document != "AGENTS.md" and not _is_beneath(document, "docs"):
                raise DocsSyncError(
                    f"{label}.documents must stay under docs/ (except behavior-only AGENTS.md): {document}"
                )
        for pattern in (*code, *tests):
            _glob_regex(pattern)
        domains.append(
            Domain(
                identifier=identifier,
                documents=documents,
                code=code,
                tests=tests,
            )
        )

    deployment_domains = [domain for domain in domains if domain.identifier == "deployment"]
    if len(deployment_domains) != 1:
        raise DocsSyncError("manifest must define exactly one deployment domain")
    missing_transition_documents = sorted(
        REQUIRED_RELEASE_TRANSITION_DOCUMENTS
        - set(deployment_domains[0].documents)
    )
    if missing_transition_documents:
        raise DocsSyncError(
            "deployment domain must own all release-transition contracts: "
            + ", ".join(missing_transition_documents)
        )
    transition_path = _reject_symlink_chain(
        root,
        REQUIRED_RELEASE_TRANSITION_SOURCE,
        "release-transition contract",
    )
    challenge_schema_path = _reject_symlink_chain(
        root,
        REQUIRED_RELEASE_TRANSITION_CHALLENGE_SCHEMA,
        "release-transition challenge schema",
    )
    receipt_schema_path = _reject_symlink_chain(
        root,
        REQUIRED_RELEASE_TRANSITION_RECEIPT_SCHEMA,
        "release-transition receipt schema",
    )
    for path, label, relative in (
        (transition_path, "release-transition contract", REQUIRED_RELEASE_TRANSITION_SOURCE),
        (challenge_schema_path, "release-transition challenge schema", REQUIRED_RELEASE_TRANSITION_CHALLENGE_SCHEMA),
        (receipt_schema_path, "release-transition receipt schema", REQUIRED_RELEASE_TRANSITION_RECEIPT_SCHEMA),
    ):
        _require_regular_file(path, label, relative)
    transition_contract = validate_release_transition_contract(
        read_strict_json(transition_path, "release-transition contract"),
        "release-transition contract",
    )
    challenge_schema = read_strict_json(
        challenge_schema_path,
        "release-transition challenge schema",
    )
    receipt_schema = read_strict_json(
        receipt_schema_path,
        "release-transition receipt schema",
    )
    # Validate the schemas themselves through representative values derived
    # from the transition contract. Runtime/CI consumers read these same files.
    source_receipt_type = transition_contract["deployment_receipt"]["source_owner_receipt_type"]
    sample_challenge = {
        "schema_version": 1,
        "transition_id": transition_contract["transition_id"],
        "challenge_id": "challenge_" + "0" * 32,
        "nonce": "A" * 43,
        "receipt_type": source_receipt_type,
        "deployment_id": "deployment",
        "key_id": "primary",
        "predecessor_generation": "0" * 40,
        "candidate_generation": "1" * 40,
        "expected_observed_generation": "0" * 40,
        "expected_profile_id": transition_contract["source_profile_id"],
        "expected_capability": "source_owner",
        "expected_status": "idle",
        "issued_at": "2026-01-01T00:00:00Z",
        "expires_at": "2026-01-01T00:05:00Z",
    }
    validate_closed_json_schema_instance(sample_challenge, challenge_schema, "release-transition challenge")
    sample_receipt = {
        "schema_version": 1,
        "transition_id": transition_contract["transition_id"],
        "challenge_id": sample_challenge["challenge_id"],
        "nonce": sample_challenge["nonce"],
        "receipt_type": source_receipt_type,
        "deployment_id": sample_challenge["deployment_id"],
        "key_id": sample_challenge["key_id"],
        "predecessor_generation": sample_challenge["predecessor_generation"],
        "candidate_generation": sample_challenge["candidate_generation"],
        "observed_generation": sample_challenge["expected_observed_generation"],
        "profile_id": sample_challenge["expected_profile_id"],
        "capability": sample_challenge["expected_capability"],
        "status": sample_challenge["expected_status"],
        "architecture": "amd64",
        "manager_sha256": "2" * 64,
        "evidence_sha256": "3" * 64,
        "issued_at": sample_challenge["issued_at"],
        "expires_at": sample_challenge["expires_at"],
    }
    validate_closed_json_schema_instance(sample_receipt, receipt_schema, "release-transition receipt")

    contracts_raw = raw.get("contracts")
    if not isinstance(contracts_raw, list) or not contracts_raw:
        raise DocsSyncError("contracts must be a non-empty JSON array")
    contracts: list[Contract] = []
    seen_contract_ids: set[str] = set()
    for index, item in enumerate(contracts_raw):
        label = f"contracts[{index}]"
        contract_raw = _expect_object(item, label)
        _reject_unknown_keys(contract_raw, {"id", "source", "domains", "targets"}, label)
        identifier = contract_raw.get("id")
        if not isinstance(identifier, str) or not DOMAIN_ID_RE.fullmatch(identifier):
            raise DocsSyncError(f"{label}.id must match {DOMAIN_ID_RE.pattern}")
        if identifier in seen_contract_ids:
            raise DocsSyncError(f"duplicate contract id: {identifier}")
        seen_contract_ids.add(identifier)
        source = contract_raw.get("source")
        if not isinstance(source, str) or not source:
            raise DocsSyncError(f"{label}.source must be a non-empty string")
        source_path = _reject_symlink_chain(root, source, f"{label}.source")
        if not _is_beneath(source, "docs/contracts"):
            raise DocsSyncError(f"{label}.source must stay under docs/contracts/: {source}")
        _require_regular_file(source_path, f"{label}.source", source)
        domain_ids = _expect_string_list(contract_raw.get("domains"), f"{label}.domains")
        # All domains are available in seen_domain_ids only if the manifest is
        # ordered. Re-check against the complete set after parsing as well.
        targets_raw = contract_raw.get("targets")
        if not isinstance(targets_raw, list):
            raise DocsSyncError(f"{label}.targets must be a JSON array")
        targets: list[ContractTarget] = []
        for target_index, target_item in enumerate(targets_raw):
            target_label = f"{label}.targets[{target_index}]"
            target_raw = _expect_object(target_item, target_label)
            _reject_unknown_keys(target_raw, {"path", "format"}, target_label)
            target_path = target_raw.get("path")
            target_format = target_raw.get("format")
            if not isinstance(target_path, str) or not target_path:
                raise DocsSyncError(f"{target_label}.path must be a non-empty string")
            if target_format not in {
                "python-runtime-policy",
                "typescript-runtime-policy",
                "python-container-platform",
                "typescript-container-platform",
                "go-container-platform",
                "go-release-transition",
                "python-release-transition",
            }:
                raise DocsSyncError(f"{target_label}.format is unsupported: {target_format!r}")
            _reject_symlink_chain(root, target_path, f"{target_label}.path")
            targets.append(ContractTarget(path=target_path, format=target_format))
        contracts.append(
            Contract(
                identifier=identifier,
                source=source,
                domains=domain_ids,
                targets=tuple(targets),
            )
        )

    all_domain_ids = {domain.identifier for domain in domains}
    for contract in contracts:
        missing = sorted(set(contract.domains) - all_domain_ids)
        if missing:
            raise DocsSyncError(
                f"contract {contract.identifier} references unknown domains: {', '.join(missing)}"
            )

    manifest = Manifest(
        version=3,
        forbidden_top_level_files=forbidden,
        coverage=coverage,
        domains=tuple(domains),
        contracts=tuple(contracts),
    )

    for probe, required_domains in REQUIRED_OWNED_CODE_PROBES.items():
        owners = {domain.identifier for domain in domains_for_code(manifest, probe)}
        missing_owners = sorted(required_domains - owners)
        if missing_owners:
            raise DocsSyncError(
                f"owned production probe {probe} must belong to: "
                + ", ".join(missing_owners)
            )

    canonical_documents = {
        document for domain in manifest.domains for document in domain.documents
    } | {contract.source for contract in manifest.contracts}
    for document in sorted(canonical_documents):
        code_domains = domains_for_code(manifest, document)
        test_domains = domains_for_test(manifest, document)
        if code_domains or test_domains:
            categories = [
                *(f"code:{domain.identifier}" for domain in code_domains),
                *(f"test:{domain.identifier}" for domain in test_domains),
            ]
            raise DocsSyncError(
                f"canonical document cannot masquerade as code or a test: {document} "
                f"({', '.join(categories)})"
            )

    runtime_contracts = [
        contract for contract in manifest.contracts if contract.identifier == "runtime-policy"
    ]
    if len(runtime_contracts) != 1:
        raise DocsSyncError("manifest must define exactly one runtime-policy contract")
    runtime_contract = runtime_contracts[0]
    if runtime_contract.source != REQUIRED_RUNTIME_POLICY_SOURCE:
        raise DocsSyncError(
            f"runtime-policy source must be {REQUIRED_RUNTIME_POLICY_SOURCE}"
        )
    if set(runtime_contract.domains) != REQUIRED_RUNTIME_POLICY_DOMAINS:
        raise DocsSyncError(
            "runtime-policy domains must be exactly: "
            + ", ".join(sorted(REQUIRED_RUNTIME_POLICY_DOMAINS))
        )
    runtime_targets = {target.path: target.format for target in runtime_contract.targets}
    if len(runtime_targets) != len(runtime_contract.targets) or runtime_targets != REQUIRED_RUNTIME_POLICY_TARGETS:
        raise DocsSyncError("runtime-policy targets and formats must match the required platform, runtime, and frontend targets")

    upstream_contracts = [
        contract for contract in manifest.contracts if contract.identifier == "upstream-sources"
    ]
    if len(upstream_contracts) != 1:
        raise DocsSyncError("manifest must define exactly one upstream-sources contract")
    upstream_contract = upstream_contracts[0]
    if upstream_contract.source != REQUIRED_UPSTREAM_SOURCES_SOURCE:
        raise DocsSyncError(
            f"upstream-sources source must be {REQUIRED_UPSTREAM_SOURCES_SOURCE}"
        )
    if set(upstream_contract.domains) != REQUIRED_UPSTREAM_SOURCES_DOMAINS:
        raise DocsSyncError(
            "upstream-sources domains must be exactly: integrations, platform"
        )
    upstream_targets = {
        target.path: target.format for target in upstream_contract.targets
    }
    if (
        len(upstream_targets) != len(upstream_contract.targets)
        or upstream_targets != REQUIRED_UPSTREAM_SOURCES_TARGETS
    ):
        raise DocsSyncError(
            "upstream-sources must not define generated targets; direct consumers read its validated JSON"
        )

    container_contracts = [
        contract
        for contract in manifest.contracts
        if contract.identifier == "container-platform"
    ]
    if len(container_contracts) != 1:
        raise DocsSyncError("manifest must define exactly one container-platform contract")
    container_contract = container_contracts[0]
    if container_contract.source != REQUIRED_CONTAINER_PLATFORM_SOURCE:
        raise DocsSyncError(
            f"container-platform source must be {REQUIRED_CONTAINER_PLATFORM_SOURCE}"
        )
    if set(container_contract.domains) != REQUIRED_CONTAINER_PLATFORM_DOMAINS:
        raise DocsSyncError(
            "container-platform domains must be exactly: "
            + ", ".join(sorted(REQUIRED_CONTAINER_PLATFORM_DOMAINS))
        )
    container_targets = {
        target.path: target.format for target in container_contract.targets
    }
    if (
        len(container_targets) != len(container_contract.targets)
        or container_targets != REQUIRED_CONTAINER_PLATFORM_TARGETS
    ):
        raise DocsSyncError(
            "container-platform targets and formats must match the required Go, Python, Runtime and frontend targets"
        )

    for contract in manifest.contracts:
        if not _is_covered_document(manifest, contract.source):
            raise DocsSyncError(
                f"contract source must be covered as canonical documentation: {contract.source}"
            )
        for target in contract.targets:
            if not _is_covered_code(manifest, target.path):
                raise DocsSyncError(
                    f"contract target must be covered production code: {target.path}"
                )
            owners = domains_for_code(manifest, target.path)
            if not owners:
                raise DocsSyncError(
                    f"contract target has no documentation domain: {target.path}"
                )
            outside_domains = sorted(
                domain.identifier
                for domain in owners
                if domain.identifier not in contract.domains
            )
            if outside_domains:
                raise DocsSyncError(
                    f"contract target {target.path} is owned outside contract {contract.identifier}: "
                    + ", ".join(outside_domains)
                )
    return manifest


def _parse_historical_manifest(raw: Any, label: str) -> Manifest:
    value = _expect_object(raw, label)
    version = value.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise DocsSyncError(f"{label} version must be a positive integer")

    coverage_raw = _expect_object(value.get("coverage"), f"{label}.coverage")
    coverage = Coverage(
        code_include=_expect_string_list(
            coverage_raw.get("code_include"), f"{label}.coverage.code_include"
        ),
        code_exclude=_expect_string_list(
            coverage_raw.get("code_exclude", []),
            f"{label}.coverage.code_exclude",
            allow_empty=True,
        ),
        document_include=_expect_string_list(
            coverage_raw.get("document_include"),
            f"{label}.coverage.document_include",
        ),
        document_exclude=_expect_string_list(
            coverage_raw.get("document_exclude", []),
            f"{label}.coverage.document_exclude",
            allow_empty=True,
        ),
    )
    for pattern in (
        *coverage.code_include,
        *coverage.code_exclude,
        *coverage.document_include,
        *coverage.document_exclude,
    ):
        _glob_regex(pattern)

    domains_raw = value.get("domains")
    if not isinstance(domains_raw, list) or not domains_raw:
        raise DocsSyncError(f"{label}.domains must be a non-empty JSON array")
    domains: list[Domain] = []
    domain_ids: set[str] = set()
    for index, item in enumerate(domains_raw):
        domain_label = f"{label}.domains[{index}]"
        domain_raw = _expect_object(item, domain_label)
        identifier = domain_raw.get("id")
        if not isinstance(identifier, str) or not DOMAIN_ID_RE.fullmatch(identifier):
            raise DocsSyncError(f"{domain_label}.id must match {DOMAIN_ID_RE.pattern}")
        if identifier in domain_ids:
            raise DocsSyncError(f"{label} contains duplicate domain id: {identifier}")
        domain_ids.add(identifier)
        documents = _expect_string_list(
            domain_raw.get("documents"), f"{domain_label}.documents"
        )
        code = _expect_string_list(domain_raw.get("code"), f"{domain_label}.code")
        tests = _expect_string_list(
            domain_raw.get("tests", []),
            f"{domain_label}.tests",
            allow_empty=True,
        )
        for document in documents:
            _relative_path(document)
        for pattern in (*code, *tests):
            _glob_regex(pattern)
        domains.append(Domain(identifier, documents, code, tests))

    contracts_raw = value.get("contracts", [])
    if not isinstance(contracts_raw, list):
        raise DocsSyncError(f"{label}.contracts must be a JSON array")
    contracts: list[Contract] = []
    contract_ids: set[str] = set()
    for index, item in enumerate(contracts_raw):
        contract_label = f"{label}.contracts[{index}]"
        contract_raw = _expect_object(item, contract_label)
        identifier = contract_raw.get("id")
        if not isinstance(identifier, str) or not DOMAIN_ID_RE.fullmatch(identifier):
            raise DocsSyncError(f"{contract_label}.id must match {DOMAIN_ID_RE.pattern}")
        if identifier in contract_ids:
            raise DocsSyncError(f"{label} contains duplicate contract id: {identifier}")
        contract_ids.add(identifier)
        source = contract_raw.get("source")
        if not isinstance(source, str):
            raise DocsSyncError(f"{contract_label}.source must be a string")
        _relative_path(source)
        contract_domains = _expect_string_list(
            contract_raw.get("domains"), f"{contract_label}.domains"
        )
        unknown_domains = sorted(set(contract_domains) - domain_ids)
        if unknown_domains:
            raise DocsSyncError(
                f"{contract_label} references unknown domains: {', '.join(unknown_domains)}"
            )
        targets_raw = contract_raw.get("targets", [])
        if not isinstance(targets_raw, list):
            raise DocsSyncError(f"{contract_label}.targets must be a JSON array")
        targets: list[ContractTarget] = []
        for target_index, target_item in enumerate(targets_raw):
            target_label = f"{contract_label}.targets[{target_index}]"
            target_raw = _expect_object(target_item, target_label)
            target_path = target_raw.get("path")
            target_format = target_raw.get("format")
            if not isinstance(target_path, str) or not isinstance(target_format, str):
                raise DocsSyncError(f"{target_label} path and format must be strings")
            _relative_path(target_path)
            targets.append(ContractTarget(target_path, target_format))
        contracts.append(
            Contract(identifier, source, contract_domains, tuple(targets))
        )

    # Historical manifests are used only to classify paths in a Git diff.
    # Current repository guards never inherit policy fields from old commits.
    return Manifest(
        version,
        (),
        coverage,
        tuple(domains),
        tuple(contracts),
    )


def load_manifest_at_revision(root: Path, revision: str) -> Manifest | None:
    result = _git(
        root,
        ["show", f"{revision}:{MANIFEST_PATH.as_posix()}"],
        check=False,
    )
    if result.returncode != 0:
        return None
    label = f"historical documentation manifest at {revision}"
    try:
        raw = json.loads(result.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DocsSyncError(f"{label} is not valid UTF-8 JSON: {exc}") from exc
    return _parse_historical_manifest(raw, label)


@lru_cache(maxsize=None)
def _glob_regex(pattern: str) -> re.Pattern[str]:
    if not pattern or pattern.startswith("/") or "\\" in pattern or ".." in PurePosixPath(pattern).parts:
        raise DocsSyncError(f"unsafe or invalid path pattern: {pattern!r}")
    pieces: list[str] = ["^"]
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "*":
            if index + 1 < len(pattern) and pattern[index + 1] == "*":
                index += 2
                if index < len(pattern) and pattern[index] == "/":
                    pieces.append("(?:.*/)?")
                    index += 1
                else:
                    pieces.append(".*")
                continue
            pieces.append("[^/]*")
        elif character == "?":
            pieces.append("[^/]")
        else:
            pieces.append(re.escape(character))
        index += 1
    pieces.append("$")
    return re.compile("".join(pieces))


def path_matches(path: str, patterns: Iterable[str]) -> bool:
    return any(_glob_regex(pattern).fullmatch(path) is not None for pattern in patterns)


def _git(root: Path, arguments: Sequence[str], *, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            ["git", "-C", str(root), *arguments],
            check=check,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise DocsSyncError("git is required for documentation change checks") from exc
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", errors="replace").strip()
        raise DocsSyncError(f"git {' '.join(arguments)} failed: {detail or exc.returncode}") from exc


def _index_tree(root: Path) -> str:
    result = _git(root, ["write-tree"])
    tree = result.stdout.decode("ascii", errors="strict").strip()
    if not tree:
        raise DocsSyncError("git write-tree returned no index snapshot")
    return tree


def _tree_entries(root: Path, tree: str) -> tuple[GitTreeEntry, ...]:
    result = _git(root, ["ls-tree", "-r", "--full-tree", "-z", tree])
    entries: list[GitTreeEntry] = []
    for record in result.stdout.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", 1)
            raw_mode, raw_type, raw_object = metadata.split(b" ", 2)
            mode = raw_mode.decode("ascii")
            object_type = raw_type.decode("ascii")
            object_id = raw_object.decode("ascii")
            path = raw_path.decode("utf-8", errors="surrogateescape")
        except (UnicodeDecodeError, ValueError) as exc:
            raise DocsSyncError("git index tree contains malformed metadata") from exc
        _relative_path(path)
        entries.append(GitTreeEntry(mode, object_type, object_id, path))
    return tuple(entries)


def _materialize_index_tree(root: Path, destination: Path) -> tuple[str, ...]:
    tree = _index_tree(root)
    entries = _tree_entries(root, tree)
    blob_entries = [entry for entry in entries if entry.object_type == "blob"]
    if blob_entries:
        with tempfile.TemporaryFile() as error_stream:
            try:
                process = subprocess.Popen(
                    ["git", "-C", str(root), "cat-file", "--batch"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=error_stream,
                )
            except FileNotFoundError as exc:
                raise DocsSyncError("git is required for index snapshot checks") from exc
            assert process.stdin is not None
            assert process.stdout is not None
            try:
                for entry in blob_entries:
                    process.stdin.write(entry.object_id.encode("ascii") + b"\n")
                    process.stdin.flush()
                    header = process.stdout.readline().rstrip(b"\n")
                    header_parts = header.split(b" ")
                    if len(header_parts) != 3 or header_parts[1] != b"blob":
                        raise DocsSyncError(
                            f"could not read staged blob for index path: {entry.path}"
                        )
                    try:
                        size = int(header_parts[2])
                    except ValueError as exc:
                        raise DocsSyncError(
                            f"staged blob has an invalid size for index path: {entry.path}"
                        ) from exc
                    content = process.stdout.read(size)
                    terminator = process.stdout.read(1)
                    if len(content) != size or terminator != b"\n":
                        raise DocsSyncError(
                            f"staged blob ended unexpectedly for index path: {entry.path}"
                        )
                    target = destination / Path(*PurePosixPath(entry.path).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        if entry.mode == "120000":
                            os.symlink(os.fsdecode(content), target)
                        elif entry.mode in {"100644", "100755"}:
                            with target.open("wb") as handle:
                                handle.write(content)
                            target.chmod(0o755 if entry.mode == "100755" else 0o644)
                        else:
                            raise DocsSyncError(
                                f"unsupported staged blob mode {entry.mode} for index path: {entry.path}"
                            )
                    except (OSError, ValueError) as exc:
                        raise DocsSyncError(
                            f"could not materialize staged index path {entry.path}: {exc}"
                        ) from exc
            finally:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
                return_code = process.wait()
                error_stream.seek(0)
                process_error = error_stream.read().decode(
                    "utf-8", errors="replace"
                ).strip()
            if return_code != 0:
                raise DocsSyncError(
                    "git cat-file failed while materializing the index: "
                    f"{process_error or return_code}"
                )

    for entry in entries:
        if entry.object_type == "blob":
            continue
        target = destination / Path(*PurePosixPath(entry.path).parts)
        if entry.mode == "160000" and entry.object_type == "commit":
            target.mkdir(parents=True, exist_ok=True)
            continue
        raise DocsSyncError(
            f"unsupported staged object {entry.mode} {entry.object_type} at index path: {entry.path}"
        )
    return tuple(entry.path for entry in entries)


def list_repository_files(root: Path) -> tuple[str, ...]:
    result = _git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], check=False)
    if result.returncode == 0:
        deleted_result = _git(root, ["ls-files", "--deleted", "-z"], check=False)
        deleted = {
            item.decode("utf-8", errors="surrogateescape")
            for item in deleted_result.stdout.split(b"\0")
            if item
        } if deleted_result.returncode == 0 else set()
        return tuple(
            sorted(
                item.decode("utf-8", errors="surrogateescape")
                for item in result.stdout.split(b"\0")
                if item and item.decode("utf-8", errors="surrogateescape") not in deleted
            )
        )

    ignored_directories = {
        ".git",
        ".venv",
        "__pycache__",
        "build",
        "data",
        "dist",
        "node_modules",
    }
    files: list[str] = []
    for current, directories, names in os.walk(root):
        directories[:] = sorted(name for name in directories if name not in ignored_directories)
        current_path = Path(current)
        for name in sorted(names):
            files.append((current_path / name).relative_to(root).as_posix())
    return tuple(files)


def domains_for_code(manifest: Manifest, path: str) -> tuple[Domain, ...]:
    return tuple(domain for domain in manifest.domains if path_matches(path, domain.code))


def domains_for_test(manifest: Manifest, path: str) -> tuple[Domain, ...]:
    return tuple(domain for domain in manifest.domains if path_matches(path, domain.tests))


def domains_for_document(manifest: Manifest, path: str) -> set[str]:
    identifiers = {
        domain.identifier
        for domain in manifest.domains
        if path in domain.documents
    }
    for contract in manifest.contracts:
        if path == contract.source:
            identifiers.update(contract.domains)
    return identifiers


def _is_covered_code(manifest: Manifest, path: str) -> bool:
    coverage = manifest.coverage
    return path_matches(path, coverage.code_include) and not path_matches(path, coverage.code_exclude)


def _is_covered_document(manifest: Manifest, path: str) -> bool:
    coverage = manifest.coverage
    return path_matches(path, coverage.document_include) and not path_matches(path, coverage.document_exclude)


def _validate_runtime_contract(raw: Any, label: str) -> dict[str, Any]:
    contract = _expect_object(raw, label)
    _reject_unknown_keys(contract, {"schema_version", "policy", "run_idle_timeout", "max_turns_per_run", "terminal_timeout"}, label)
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
    if terminal["maximum_milliseconds"] > NODE_MAX_TIMER_MILLISECONDS:
        raise DocsSyncError(
            f"{label}.terminal_timeout.maximum_milliseconds must not exceed the Node.js timer limit "
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
'''


def _typescript_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _render_typescript_runtime_policy(contract: dict[str, Any], source: str) -> str:
    idle = contract["run_idle_timeout"]
    turns = contract["max_turns_per_run"]
    terminal = contract["terminal_timeout"]
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
'''


def _validate_container_platform_contract(raw: Any, label: str) -> dict[str, Any]:
    contract = _expect_object(raw, label)
    _reject_unknown_keys(
        contract,
        {
            "schema_version",
            "policy",
            "release_channel",
            "database_schema_version",
            "container_paths",
            "execution_targets",
            "persistent_data_owners",
            "agent_runtime_handoff",
            "p1_source_handoff",
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
        },
        label,
    )
    if contract.get("schema_version") != 1:
        raise DocsSyncError(f"{label}.schema_version must be 1")
    if contract.get("policy") != "container-platform":
        raise DocsSyncError(f"{label}.policy must be 'container-platform'")
    if contract.get("release_channel") != "main":
        raise DocsSyncError(f"{label}.release_channel must be 'main'")

    paths = _expect_object(contract.get("container_paths"), f"{label}.container_paths")
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
            raise DocsSyncError(f"{label}.container_paths.{name} must be a canonical absolute path")

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
        values = _expect_string_list(contract.get(field), f"{label}.{field}")
        if values != expected:
            raise DocsSyncError(
                f"{label}.{field} must exactly match the documented ordered values"
            )

    persistent_owners = _expect_object(
        contract.get("persistent_data_owners"),
        f"{label}.persistent_data_owners",
    )
    expected_owner_sets = {
        "cognee",
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

    runtime_handoff = _expect_object(
        contract.get("agent_runtime_handoff"),
        f"{label}.agent_runtime_handoff",
    )
    _reject_unknown_keys(
        runtime_handoff,
        {
            "validation_limits",
            "current_roots",
            "ephemeral_roots",
            "p1_retired_roots",
        },
        f"{label}.agent_runtime_handoff",
    )
    if set(runtime_handoff) != {
        "validation_limits",
        "current_roots",
        "ephemeral_roots",
        "p1_retired_roots",
    }:
        raise DocsSyncError(f"{label}.agent_runtime_handoff must be complete")
    validation_limits = _expect_object(
        runtime_handoff["validation_limits"],
        f"{label}.agent_runtime_handoff.validation_limits",
    )
    expected_validation_limits = {
        "maximum_identity_records",
        "maximum_jsonl_bytes",
        "maximum_jsonl_records",
        "maximum_directory_entries",
    }
    _reject_unknown_keys(
        validation_limits,
        expected_validation_limits,
        f"{label}.agent_runtime_handoff.validation_limits",
    )
    if set(validation_limits) != expected_validation_limits:
        raise DocsSyncError(
            f"{label}.agent_runtime_handoff.validation_limits must be complete"
        )
    for field in sorted(expected_validation_limits):
        value = validation_limits[field]
        if (
            type(value) is not int
            or value <= 0
            or value > JAVASCRIPT_MAX_SAFE_INTEGER
        ):
            raise DocsSyncError(
                f"{label}.agent_runtime_handoff.validation_limits.{field} "
                "must be a positive JavaScript-safe integer"
            )
    if _expect_string_list(
        runtime_handoff["current_roots"],
        f"{label}.agent_runtime_handoff.current_roots",
    ) != ("sessions", "approvals", "idempotency"):
        raise DocsSyncError(
            f"{label}.agent_runtime_handoff.current_roots must match the current Runtime schema"
        )
    if _expect_string_list(
        runtime_handoff["ephemeral_roots"],
        f"{label}.agent_runtime_handoff.ephemeral_roots",
    ) != ("logs",):
        raise DocsSyncError(
            f"{label}.agent_runtime_handoff.ephemeral_roots must contain only logs"
        )
    retired = _expect_object(
        runtime_handoff["p1_retired_roots"],
        f"{label}.agent_runtime_handoff.p1_retired_roots",
    )
    if set(retired) != {"app", "home", "memory", "migration"}:
        raise DocsSyncError(
            f"{label}.agent_runtime_handoff.p1_retired_roots must contain exactly app, home, memory and migration"
        )
    app = _expect_object(retired["app"], f"{label}.agent_runtime_handoff.p1_retired_roots.app")
    app_keys = {
        "mode", "top_level_entries", "inventory_algorithm", "inventory_sha256",
        "inventory_entries", "inventory_regular_bytes", "install_source_signature",
        "package_name", "package_version", "allowed_symlinks",
    }
    _reject_unknown_keys(app, app_keys, f"{label}.agent_runtime_handoff.p1_retired_roots.app")
    if set(app) != app_keys or app.get("mode") != 0o755:
        raise DocsSyncError(f"{label}.agent_runtime_handoff.p1_retired_roots.app is incomplete")
    expected_top = (
        ".gitignore", "README.md", "dist", "install.json", "node_modules",
        "package-lock.json", "package.json", "src", "test", "tsconfig.json",
    )
    if _expect_string_list(app["top_level_entries"], f"{label}.agent_runtime_handoff.p1_retired_roots.app.top_level_entries") != expected_top:
        raise DocsSyncError(f"{label}.agent_runtime_handoff P1 app top-level inventory is invalid")
    if app.get("inventory_algorithm") != "runtime-retired-tree-v1":
        raise DocsSyncError(f"{label}.agent_runtime_handoff P1 app inventory algorithm is invalid")
    for field in ("inventory_sha256", "install_source_signature"):
        value = app.get(field)
        if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
            raise DocsSyncError(f"{label}.agent_runtime_handoff P1 app {field} must be a SHA-256")
    for field in ("inventory_entries", "inventory_regular_bytes"):
        value = app.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > JAVASCRIPT_MAX_SAFE_INTEGER:
            raise DocsSyncError(f"{label}.agent_runtime_handoff P1 app {field} must be positive")
    if app.get("package_name") != "@ubitech/agent-runtime" or app.get("package_version") != "0.1.0":
        raise DocsSyncError(f"{label}.agent_runtime_handoff P1 app package identity is invalid")
    symlinks = _expect_object(app["allowed_symlinks"], f"{label}.agent_runtime_handoff.p1_retired_roots.app.allowed_symlinks")
    expected_symlinks = {
        "node_modules/.bin/anthropic-ai-sdk": "../@anthropic-ai/sdk/bin/cli",
        "node_modules/.bin/openai": "../openai/bin/cli",
        "node_modules/.bin/pi-ai": "../@earendil-works/pi-ai/dist/cli.js",
        "node_modules/.bin/yaml": "../yaml/bin.mjs",
    }
    if symlinks != expected_symlinks:
        raise DocsSyncError(f"{label}.agent_runtime_handoff P1 app symlink set is invalid")
    for path_value, target_value in symlinks.items():
        resolved = posixpath.normpath(
            posixpath.join(posixpath.dirname(path_value), target_value)
        )
        if (
            path_value.startswith("/")
            or target_value.startswith("/")
            or resolved in {"", ".", ".."}
            or resolved.startswith("../")
        ):
            raise DocsSyncError(f"{label}.agent_runtime_handoff P1 app symlink escapes its root")

    for root_name, expected_mode in (("home", 0o755), ("memory", 0o700)):
        empty_root = _expect_object(retired[root_name], f"{label}.agent_runtime_handoff.p1_retired_roots.{root_name}")
        if empty_root != {"mode": expected_mode, "empty": True}:
            raise DocsSyncError(f"{label}.agent_runtime_handoff P1 {root_name} must be an exact empty directory")
    migration = _expect_object(retired["migration"], f"{label}.agent_runtime_handoff.p1_retired_roots.migration")
    migration_keys = {"mode", "file_name", "file_mode", "schema_version", "phase", "fields"}
    _reject_unknown_keys(migration, migration_keys, f"{label}.agent_runtime_handoff.p1_retired_roots.migration")
    expected_migration_fields = (
        "attachments_skipped", "attachments_verified", "imported", "memories_imported",
        "memories_skipped", "oauth_cleared", "oauth_imported", "oauth_skipped",
        "phase", "session_manifests", "session_messages", "skipped", "updated_at",
        "version", "workspaces_skipped", "workspaces_verified",
    )
    if (
        set(migration) != migration_keys
        or migration.get("mode") != 0o700
        or migration.get("file_name") != "hermes-cutover.json"
        or migration.get("file_mode") != 0o600
        or migration.get("schema_version") != 1
        or migration.get("phase") != "finalized"
        or _expect_string_list(migration.get("fields"), f"{label}.agent_runtime_handoff.p1_retired_roots.migration.fields") != expected_migration_fields
    ):
        raise DocsSyncError(f"{label}.agent_runtime_handoff P1 migration marker contract is invalid")

    p1_source = _expect_object(
        contract.get("p1_source_handoff"),
        f"{label}.p1_source_handoff",
    )
    p1_keys = {
        "layouts", "empty_files", "empty_directories", "fixed_sha256",
        "secret_files", "secret_line_pattern", "manager_secret_names",
        "workspace_namespace", "camofox_home", "manager_migration",
        "firecrawl_environment",
    }
    _reject_unknown_keys(p1_source, p1_keys, f"{label}.p1_source_handoff")
    if set(p1_source) != p1_keys:
        raise DocsSyncError(f"{label}.p1_source_handoff must be complete")
    layouts = _expect_object(p1_source["layouts"], f"{label}.p1_source_handoff.layouts")
    expected_layout_roots = {
        ".", "data", "data/runtimes", "data/runtimes/camofox",
        "data/runtimes/cognee", "data/runtimes/firecrawl",
        "data/runtimes/searxng", "manager",
    }
    if set(layouts) != expected_layout_roots:
        raise DocsSyncError(f"{label}.p1_source_handoff.layouts has an invalid closed root set")
    layout_entries: dict[str, dict[str, Any]] = {}
    dispositions = {"retained", "copied", "generated", "retired", "ephemeral"}
    for relative, raw_layout in layouts.items():
        layout = _expect_object(raw_layout, f"{label}.p1_source_handoff.layouts.{relative}")
        if set(layout) != {"mode", "entries"} or layout["mode"] != 0o700:
            raise DocsSyncError(f"{label}.p1_source_handoff.layouts.{relative} must be an owner-only directory")
        entries = _expect_object(layout["entries"], f"{label}.p1_source_handoff.layouts.{relative}.entries")
        if not entries:
            raise DocsSyncError(f"{label}.p1_source_handoff.layouts.{relative}.entries cannot be empty")
        layout_entries[relative] = entries
        for name, raw_entry in entries.items():
            if (
                not isinstance(name, str) or name in {"", ".", ".."}
                or "/" in name or "\\" in name or "\x00" in name
            ):
                raise DocsSyncError(f"{label}.p1_source_handoff contains an unsafe entry name")
            entry = _expect_object(raw_entry, f"{label}.p1_source_handoff.layouts.{relative}.entries.{name}")
            if set(entry) != {"type", "disposition", "mode", "required"}:
                raise DocsSyncError(f"{label}.p1_source_handoff entry must contain type, disposition, mode and required")
            if entry["type"] not in {"directory", "file"} or entry["disposition"] not in dispositions:
                raise DocsSyncError(f"{label}.p1_source_handoff entry has an invalid type or disposition")
            if entry["mode"] not in {0o600, 0o644, 0o700, 0o755} or not isinstance(entry["required"], bool):
                raise DocsSyncError(f"{label}.p1_source_handoff entry has an invalid mode or required flag")
    for relative in expected_layout_roots - {"."}:
        parent, name = posixpath.split(relative)
        parent = parent or "."
        parent_entry = layout_entries.get(parent, {}).get(name)
        if not isinstance(parent_entry, dict) or parent_entry.get("type") != "directory" or not parent_entry.get("required"):
            raise DocsSyncError(f"{label}.p1_source_handoff layout root {relative} is not required by its parent")

    def p1_path_list(field: str, expected_disposition: str | None = None) -> tuple[str, ...]:
        values = _expect_string_list(p1_source[field], f"{label}.p1_source_handoff.{field}")
        if tuple(sorted(values)) != values or len(set(values)) != len(values):
            raise DocsSyncError(f"{label}.p1_source_handoff.{field} must be sorted and unique")
        for value in values:
            parent, name = posixpath.split(value)
            parent = parent or "."
            entry = layout_entries.get(parent, {}).get(name)
            if not isinstance(entry, dict) or not entry.get("required"):
                raise DocsSyncError(f"{label}.p1_source_handoff.{field} references an unknown optional object")
            if expected_disposition is not None and entry.get("disposition") != expected_disposition:
                raise DocsSyncError(f"{label}.p1_source_handoff.{field} has the wrong disposition")
        return values

    empty_files = p1_path_list("empty_files", "ephemeral")
    empty_directories = p1_path_list("empty_directories")
    secret_files = p1_path_list("secret_files", "retired")
    for value in empty_files + secret_files:
        parent, name = posixpath.split(value)
        if layout_entries[parent or "."][name]["type"] != "file":
            raise DocsSyncError(f"{label}.p1_source_handoff expected a file at {value}")
    for value in empty_directories:
        parent, name = posixpath.split(value)
        if layout_entries[parent or "."][name]["type"] != "directory":
            raise DocsSyncError(f"{label}.p1_source_handoff expected a directory at {value}")
    if p1_source["secret_line_pattern"] != r"^[A-Za-z0-9_-]{64}\n$":
        raise DocsSyncError(f"{label}.p1_source_handoff.secret_line_pattern is invalid")
    manager_secret_names = _expect_string_list(
        p1_source["manager_secret_names"],
        f"{label}.p1_source_handoff.manager_secret_names",
    )
    expected_manager_secret_names = (
        "agent-runtime-token",
        "agent-tool-token",
        "camofox-access-key",
        "firecrawl-bull-auth-key",
        "firecrawl-postgres-password",
        "manager-executor-token",
        "manager-token",
        "session-secret",
    )
    if manager_secret_names != expected_manager_secret_names:
        raise DocsSyncError(
            f"{label}.p1_source_handoff.manager_secret_names must match the audited P1 closed set"
        )
    workspace_namespace = _expect_object(
        p1_source["workspace_namespace"],
        f"{label}.p1_source_handoff.workspace_namespace",
    )
    workspace_namespace_keys = {
        "source_directory", "target_directory", "required", "mode",
        "root_owned_empty_mount",
    }
    if set(workspace_namespace) != workspace_namespace_keys:
        raise DocsSyncError(
            f"{label}.p1_source_handoff.workspace_namespace must be complete"
        )
    root_owned_mount = _expect_object(
        workspace_namespace["root_owned_empty_mount"],
        f"{label}.p1_source_handoff.workspace_namespace.root_owned_empty_mount",
    )
    if (
        workspace_namespace["source_directory"] != ".ubitech"
        or workspace_namespace["target_directory"] != ".agent-platform"
        or workspace_namespace["required"] is not True
        or workspace_namespace["mode"] != 0o755
        or root_owned_mount != {
            "relative_path": "attachments",
            "mode": 0o755,
            "uid": 0,
            "gid": 0,
        }
    ):
        raise DocsSyncError(
            f"{label}.p1_source_handoff.workspace_namespace is not the audited P1 mapping"
        )
    fixed = _expect_object(p1_source["fixed_sha256"], f"{label}.p1_source_handoff.fixed_sha256")
    expected_fixed = {
        "data/runtimes/cognee/python-install.json",
        "data/runtimes/firecrawl/docker-compose.enterprise.yaml",
        "data/runtimes/firecrawl/docker-compose.ubitech.yaml",
        "data/runtimes/searxng/docker-compose.ubitech.yaml",
    }
    if set(fixed) != expected_fixed or any(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None for value in fixed.values()):
        raise DocsSyncError(f"{label}.p1_source_handoff.fixed_sha256 is invalid")

    camofox_home = _expect_object(p1_source["camofox_home"], f"{label}.p1_source_handoff.camofox_home")
    if set(camofox_home) != {"path", "mode", "top_level_entries", "allowed_symlinks"} or camofox_home["path"] != "data/runtimes/camofox/home" or camofox_home["mode"] != 0o755:
        raise DocsSyncError(f"{label}.p1_source_handoff.camofox_home identity is invalid")
    if _expect_string_list(camofox_home["top_level_entries"], f"{label}.p1_source_handoff.camofox_home.top_level_entries") != (".cache", ".camoufox", "Downloads", "camoufox"):
        raise DocsSyncError(f"{label}.p1_source_handoff.camofox_home top-level set is invalid")
    expected_camofox_symlinks = {
        ".cache/camoufox/camofox-bin": "/opt/camofox/browser/camoufox",
        ".cache/camoufox/fontconfig": "/opt/camofox/browser/fontconfig",
        ".cache/camoufox/properties.json": "/opt/camofox/browser/properties.json",
    }
    if _expect_object(camofox_home["allowed_symlinks"], f"{label}.p1_source_handoff.camofox_home.allowed_symlinks") != expected_camofox_symlinks:
        raise DocsSyncError(f"{label}.p1_source_handoff.camofox_home symlink set is invalid")

    manager_migration = _expect_object(p1_source["manager_migration"], f"{label}.p1_source_handoff.manager_migration")
    migration_source_keys = {
        "path", "mode", "schema_version", "status", "legacy_id_pattern",
        "operation_id_pattern", "commit_pattern", "campaign_pattern",
        "fields", "retirement_status", "retirement_fields",
    }
    if set(manager_migration) != migration_source_keys or manager_migration["path"] != "manager/migration.json" or manager_migration["mode"] != 0o600 or manager_migration["schema_version"] != 1 or manager_migration["status"] != "purged" or manager_migration["retirement_status"] != "completed":
        raise DocsSyncError(f"{label}.p1_source_handoff.manager_migration identity is invalid")
    expected_migration_patterns = {
        "legacy_id_pattern": r"^legacy-[0-9a-f]{16}$",
        "operation_id_pattern": r"^op_[0-9a-f]{32}$",
        "commit_pattern": r"^[0-9a-f]{40}$",
        "campaign_pattern": r"^source-v1-retirement-[0-9]{4}-[0-9]{2}$",
    }
    if any(manager_migration[name] != value for name, value in expected_migration_patterns.items()):
        raise DocsSyncError(f"{label}.p1_source_handoff.manager_migration patterns are invalid")
    expected_manager_fields = ("created_at", "expected_source_commit", "id", "operation_id", "retirement", "schema_version", "status", "updated_at")
    expected_retirement_fields = ("campaign_id", "completed_at", "docker_removed", "generation_id", "recovery_removed", "source_state_removed", "started_at", "status", "systemd_removed")
    if _expect_string_list(manager_migration["fields"], f"{label}.p1_source_handoff.manager_migration.fields") != expected_manager_fields or _expect_string_list(manager_migration["retirement_fields"], f"{label}.p1_source_handoff.manager_migration.retirement_fields") != expected_retirement_fields:
        raise DocsSyncError(f"{label}.p1_source_handoff.manager_migration fields are invalid")

    firecrawl_environment = _expect_object(p1_source["firecrawl_environment"], f"{label}.p1_source_handoff.firecrawl_environment")
    if set(firecrawl_environment) != {"path", "mode", "keys", "bull_auth_pattern", "literal_values"} or firecrawl_environment["path"] != "data/runtimes/firecrawl/.env" or firecrawl_environment["mode"] != 0o600 or firecrawl_environment["bull_auth_pattern"] != r"^[A-Za-z0-9_-]{32}$":
        raise DocsSyncError(f"{label}.p1_source_handoff.firecrawl_environment identity is invalid")
    if _expect_string_list(firecrawl_environment["keys"], f"{label}.p1_source_handoff.firecrawl_environment.keys") != ("BULL_AUTH_KEY", "HOST", "PORT", "USE_DB_AUTHENTICATION") or _expect_object(firecrawl_environment["literal_values"], f"{label}.p1_source_handoff.firecrawl_environment.literal_values") != {"HOST": '"0.0.0.0"', "PORT": '"127.0.0.1:3002"', "USE_DB_AUTHENTICATION": '"false"'}:
        raise DocsSyncError(f"{label}.p1_source_handoff.firecrawl_environment values are invalid")

    for field in (
        "database_schema_version",
        "sandbox_idle_seconds",
        "migration_backup_retention_seconds",
        "obsolete_artifact_retention_seconds",
        "update_pre_download_min_free_bytes",
        "update_pre_cutover_min_free_bytes",
        "update_min_free_inodes",
    ):
        value = contract.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise DocsSyncError(f"{label}.{field} must be a positive integer")
        if value > JAVASCRIPT_MAX_SAFE_INTEGER:
            raise DocsSyncError(f"{label}.{field} must be a JavaScript safe integer")

    estimates = _expect_object(
        contract.get("managed_image_capacity_estimates"),
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
        "handoff-fs-helper",
    }
    if set(estimates) != managed_images:
        raise DocsSyncError(
            f"{label}.managed_image_capacity_estimates must contain exactly the current managed image set"
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
    runtime_handoff = contract["agent_runtime_handoff"]
    p1_source_handoff = contract["p1_source_handoff"]
    return f'''# Generated from {source} by scripts/docs_sync.py; do not edit.
from __future__ import annotations

CONTAINER_PLATFORM_SCHEMA_VERSION = {contract["schema_version"]}
RELEASE_CHANNEL = {contract["release_channel"]!r}
DATABASE_SCHEMA_VERSION = {contract["database_schema_version"]}
CONTAINER_PATHS = {paths!r}
EXECUTION_TARGETS = {tuple(contract["execution_targets"])!r}
PERSISTENT_DATA_OWNERS = {persistent_owners!r}
AGENT_RUNTIME_HANDOFF = {runtime_handoff!r}
P1_SOURCE_HANDOFF = {p1_source_handoff!r}
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
    estimates = json.dumps(contract["managed_image_capacity_estimates"], ensure_ascii=False, indent=2)
    persistent_owners = json.dumps(contract["persistent_data_owners"], ensure_ascii=False, indent=2)
    runtime_handoff = json.dumps(contract["agent_runtime_handoff"], ensure_ascii=False, indent=2)
    p1_source_handoff = json.dumps(contract["p1_source_handoff"], ensure_ascii=False, indent=2)
    return f'''// Generated from {source} by scripts/docs_sync.py; do not edit.
export const CONTAINER_PLATFORM_SCHEMA_VERSION = {contract["schema_version"]} as const;
export const RELEASE_CHANNEL = {_typescript_string(contract["release_channel"])} as const;
export const DATABASE_SCHEMA_VERSION = {contract["database_schema_version"]} as const;
export const CONTAINER_PATHS = {paths} as const;
export const EXECUTION_TARGETS = {targets} as const;
export type ExecutionTarget = (typeof EXECUTION_TARGETS)[number];
export const PERSISTENT_DATA_OWNERS = {persistent_owners} as const;
export const AGENT_RUNTIME_HANDOFF = {runtime_handoff} as const;
export const P1_SOURCE_HANDOFF = {p1_source_handoff} as const;
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
    runtime_limits = contract["agent_runtime_handoff"]["validation_limits"]

    def strings(values: Sequence[str]) -> str:
        return ", ".join(_go_string(value) for value in values)

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
        (
            "AgentRuntimeMaximumIdentityRecords",
            str(runtime_limits["maximum_identity_records"]),
        ),
        (
            "AgentRuntimeMaximumJSONLBytes",
            str(runtime_limits["maximum_jsonl_bytes"]),
        ),
        (
            "AgentRuntimeMaximumJSONLRecords",
            str(runtime_limits["maximum_jsonl_records"]),
        ),
        (
            "AgentRuntimeMaximumDirectoryEntries",
            str(runtime_limits["maximum_directory_entries"]),
        ),
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
    runtime_handoff = contract["agent_runtime_handoff"]
    retired = runtime_handoff["p1_retired_roots"]
    app = retired["app"]
    migration = retired["migration"]
    symlink_items = [
        (_go_string(path), _go_string(target))
        for path, target in sorted(app["allowed_symlinks"].items())
    ]
    symlink_key_width = max(len(path) for path, _ in symlink_items)
    symlink_lines = "\n".join(
        f"\t{path}:{' ' * (symlink_key_width - len(path) + 1)}{target},"
        for path, target in symlink_items
    )
    p1_source = contract["p1_source_handoff"]
    p1_layout_lines: list[str] = []
    for relative, layout in sorted(p1_source["layouts"].items()):
        rendered_names = [_go_string(name) for name in layout["entries"]]
        rendered_name_width = max(len(name) for name in rendered_names)
        entry_lines = "\n".join(
            "\t\t"
            + _go_string(name)
            + ":"
            + " " * (rendered_name_width - len(_go_string(name)) + 1)
            + "{Type: "
            + _go_string(value["type"])
            + ", Disposition: "
            + _go_string(value["disposition"])
            + ", Mode: "
            + str(value["mode"])
            + ", Required: "
            + str(value["required"]).lower()
            + "},"
            for name, value in sorted(layout["entries"].items())
        )
        p1_layout_lines.append(
            "\t"
            + _go_string(relative)
            + ": {Mode: "
            + str(layout["mode"])
            + ", Entries: map[string]P1SourceObject{\n"
            + entry_lines
            + "\n\t}},"
        )
    p1_fixed_names = [_go_string(path) for path in p1_source["fixed_sha256"]]
    p1_fixed_width = max(len(name) for name in p1_fixed_names)
    p1_fixed_lines = "\n".join(
        f"\t{_go_string(path)}:{' ' * (p1_fixed_width - len(_go_string(path)) + 1)}{_go_string(value)},"
        for path, value in sorted(p1_source["fixed_sha256"].items())
    )
    p1_camofox = p1_source["camofox_home"]
    p1_camofox_symlink_names = [_go_string(path) for path in p1_camofox["allowed_symlinks"]]
    p1_camofox_symlink_width = max(len(name) for name in p1_camofox_symlink_names)
    p1_camofox_symlink_lines = "\n".join(
        f"\t{_go_string(path)}:{' ' * (p1_camofox_symlink_width - len(_go_string(path)) + 1)}{_go_string(value)},"
        for path, value in sorted(p1_camofox["allowed_symlinks"].items())
    )
    p1_migration = p1_source["manager_migration"]
    p1_firecrawl = p1_source["firecrawl_environment"]
    p1_workspace = p1_source["workspace_namespace"]
    p1_workspace_mount = p1_workspace["root_owned_empty_mount"]
    p1_firecrawl_literal_names = [_go_string(name) for name in p1_firecrawl["literal_values"]]
    p1_firecrawl_literal_width = max(len(name) for name in p1_firecrawl_literal_names)
    p1_firecrawl_literal_lines = "\n".join(
        f"\t{_go_string(name)}:{' ' * (p1_firecrawl_literal_width - len(_go_string(name)) + 1)}{_go_string(value)},"
        for name, value in sorted(p1_firecrawl["literal_values"].items())
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

const (
\tAgentRuntimeP1AppMode             = {app["mode"]}
\tAgentRuntimeP1AppInventorySHA256  = {_go_string(app["inventory_sha256"])}
\tAgentRuntimeP1AppInventoryEntries = {app["inventory_entries"]}
\tAgentRuntimeP1AppRegularBytes     = {app["inventory_regular_bytes"]}
\tAgentRuntimeP1InstallSignature    = {_go_string(app["install_source_signature"])}
\tAgentRuntimeP1PackageName         = {_go_string(app["package_name"])}
\tAgentRuntimeP1PackageVersion      = {_go_string(app["package_version"])}
\tAgentRuntimeP1HomeMode            = {retired["home"]["mode"]}
\tAgentRuntimeP1MemoryMode          = {retired["memory"]["mode"]}
\tAgentRuntimeP1MigrationMode       = {migration["mode"]}
\tAgentRuntimeP1MigrationFile       = {_go_string(migration["file_name"])}
\tAgentRuntimeP1MigrationFileMode   = {migration["file_mode"]}
\tAgentRuntimeP1MigrationSchema     = {migration["schema_version"]}
\tAgentRuntimeP1MigrationPhase      = {_go_string(migration["phase"])}
)

var AgentRuntimeCurrentRoots = []string{{{strings(runtime_handoff["current_roots"])}}}
var AgentRuntimeEphemeralRoots = []string{{{strings(runtime_handoff["ephemeral_roots"])}}}
var AgentRuntimeP1RetiredRoots = []string{{{strings(retired.keys())}}}
var AgentRuntimeP1AppTopLevelEntries = []string{{{strings(app["top_level_entries"])}}}
var AgentRuntimeP1AppAllowedSymlinks = map[string]string{{
{symlink_lines}
}}
var AgentRuntimeP1MigrationFields = []string{{{strings(migration["fields"])}}}

type P1SourceObject struct {{
	Type        string
	Disposition string
	Mode        uint32
	Required    bool
}}

type P1SourceDirectory struct {{
	Mode    uint32
	Entries map[string]P1SourceObject
}}

var P1SourceLayouts = map[string]P1SourceDirectory{{
{chr(10).join(p1_layout_lines)}
}}

var P1SourceEmptyFiles = []string{{{strings(p1_source["empty_files"])}}}
var P1SourceEmptyDirectories = []string{{{strings(p1_source["empty_directories"])}}}
var P1SourceSecretFiles = []string{{{strings(p1_source["secret_files"])}}}
var P1ManagerSecretNames = []string{{{strings(p1_source["manager_secret_names"])}}}
var P1SourceFixedSHA256 = map[string]string{{
{p1_fixed_lines}
}}

const P1SourceSecretLinePattern = {_go_string(p1_source["secret_line_pattern"])}
const P1WorkspaceSourceDirectory = {_go_string(p1_workspace["source_directory"])}
const P1WorkspaceTargetDirectory = {_go_string(p1_workspace["target_directory"])}
const P1WorkspaceNamespaceRequired = {str(p1_workspace["required"]).lower()}
const P1WorkspaceNamespaceMode = {p1_workspace["mode"]}
const P1WorkspaceRootOwnedMountPath = {_go_string(p1_workspace_mount["relative_path"])}
const P1WorkspaceRootOwnedMountMode = {p1_workspace_mount["mode"]}
const P1WorkspaceRootOwnedUID = {p1_workspace_mount["uid"]}
const P1WorkspaceRootOwnedGID = {p1_workspace_mount["gid"]}
const P1CamofoxHomePath = {_go_string(p1_camofox["path"])}
const P1CamofoxHomeMode = {p1_camofox["mode"]}
const P1ManagerMigrationPath = {_go_string(p1_migration["path"])}
const P1ManagerMigrationMode = {p1_migration["mode"]}
const P1ManagerMigrationSchema = {p1_migration["schema_version"]}
const P1ManagerMigrationStatus = {_go_string(p1_migration["status"])}
const P1ManagerRetirementStatus = {_go_string(p1_migration["retirement_status"])}
const P1ManagerLegacyIDPattern = {_go_string(p1_migration["legacy_id_pattern"])}
const P1ManagerOperationIDPattern = {_go_string(p1_migration["operation_id_pattern"])}
const P1ManagerCommitPattern = {_go_string(p1_migration["commit_pattern"])}
const P1ManagerCampaignPattern = {_go_string(p1_migration["campaign_pattern"])}
const P1FirecrawlEnvironmentPath = {_go_string(p1_firecrawl["path"])}
const P1FirecrawlEnvironmentMode = {p1_firecrawl["mode"]}
const P1FirecrawlBullAuthPattern = {_go_string(p1_firecrawl["bull_auth_pattern"])}

var P1CamofoxHomeTopLevelEntries = []string{{{strings(p1_camofox["top_level_entries"])}}}
var P1CamofoxHomeAllowedSymlinks = map[string]string{{
{p1_camofox_symlink_lines}
}}
var P1ManagerMigrationFields = []string{{{strings(p1_migration["fields"])}}}
var P1ManagerRetirementFields = []string{{{strings(p1_migration["retirement_fields"])}}}
var P1FirecrawlEnvironmentKeys = []string{{{strings(p1_firecrawl["keys"])}}}
var P1FirecrawlEnvironmentLiteralValues = map[string]string{{
{p1_firecrawl_literal_lines}
}}

var ExecutionTargets = []string{{{strings(contract["execution_targets"])}}}
var PublicUpdateStates = []string{{{strings(contract["public_update_states"])}}}
var Operations = []string{{{strings(contract["operations"])}}}
var OperationPhases = []string{{{strings(contract["operation_phases"])}}}
'''


def _render_go_release_transition(contract: dict[str, Any], source: str) -> str:
    compat = contract.get("source_owner_compat")
    if compat is None:
        return f'''// Code generated from {source} by scripts/docs_sync.py; DO NOT EDIT.
package contract
'''
    images = ", ".join(_go_string(value) for value in compat["managed_images"])
    return f'''// Code generated from {source} by scripts/docs_sync.py; DO NOT EDIT.
package contract

const (
\tSourceOwnerCompatGeneration     = {_go_string(compat["generation"])}
\tSourceOwnerCompatManifestSHA256 = {_go_string(compat["manifest_sha256"])}
\tSourceOwnerCompatComposeSHA256  = {_go_string(compat["compose_sha256"])}
)

var SourceOwnerCompatManagedImages = []string{{{images}}}
'''


def _render_python_release_transition(
    contract: dict[str, Any], source: str
) -> str:
    compat = contract.get("source_owner_compat")
    compat_generation = compat["generation"] if compat is not None else None
    return f'''# Generated from {source} by scripts/docs_sync.py; do not edit.
from __future__ import annotations

RELEASE_TRANSITION_STAGE = {contract["stage"]!r}
PREDECESSOR_GENERATION = {contract["predecessor_generation"]!r}
SOURCE_PROFILE_ID = {contract["source_profile_id"]!r}
TARGET_PROFILE_ID = {contract["target_profile_id"]!r}
SOURCE_OWNER_COMPAT_GENERATION = {compat_generation!r}
'''


def _validate_upstream_sources_contract(raw: Any, label: str) -> dict[str, Any]:
    contract = _expect_object(raw, label)
    _reject_unknown_keys(contract, {"schema_version", "sources"}, label)
    if contract.get("schema_version") != 1:
        raise DocsSyncError(f"{label}.schema_version must be 1")
    sources = _expect_object(contract.get("sources"), f"{label}.sources")
    if set(sources) != {"cognee", "firecrawl"}:
        raise DocsSyncError(
            f"{label}.sources must contain exactly cognee and firecrawl"
        )
    for name in sorted(sources):
        source_label = f"{label}.sources.{name}"
        source = _expect_object(sources[name], source_label)
        _reject_unknown_keys(
            source,
            {"repository_url", "revision", "required_paths", "compose_services"},
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


def render_contract(root: Path, contract: Contract) -> dict[str, str]:
    raw = _read_json(_safe_path(root, contract.source), f"contract {contract.identifier}")
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
    elif contract.identifier == "release-transition":
        parsed = validate_release_transition_contract(raw, f"contract {contract.identifier}")
    else:
        raise DocsSyncError(f"unsupported contract id: {contract.identifier}")
    rendered: dict[str, str] = {}
    for target in contract.targets:
        if target.format == "python-runtime-policy":
            content = _render_python_runtime_policy(parsed, contract.source)
        elif target.format == "typescript-runtime-policy":
            content = _render_typescript_runtime_policy(parsed, contract.source)
        elif target.format == "python-container-platform":
            content = _render_python_container_platform(parsed, contract.source)
        elif target.format == "typescript-container-platform":
            content = _render_typescript_container_platform(parsed, contract.source)
        elif target.format == "go-container-platform":
            content = _render_go_container_platform(parsed, contract.source)
        elif target.format == "go-release-transition":
            content = _render_go_release_transition(parsed, contract.source)
        elif target.format == "python-release-transition":
            content = _render_python_release_transition(parsed, contract.source)
        else:  # Protected by manifest validation; keep defense in depth.
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


def sync_contracts(root: Path, manifest: Manifest) -> tuple[str, ...]:
    written: list[str] = []
    seen_targets: set[str] = set()
    for contract in manifest.contracts:
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


def _link_path(raw_target: str) -> str | None:
    target = raw_target.strip()
    if not target:
        return None
    if target.startswith("<") and ">" in target:
        target = target[1 : target.index(">")]
    else:
        target = target.split(maxsplit=1)[0]
    target = unquote(target)
    if not target or target.startswith("#") or target.startswith("//"):
        return None
    parsed = urlsplit(target)
    if parsed.scheme:
        return None
    return parsed.path or None


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
    for document in sorted(documents):
        if document.is_symlink():
            errors.append(f"documentation file must not be a symlink: {_display_path(document, root)}")
            continue
        text = _markdown_without_fenced_code(document.read_text(encoding="utf-8"))
        for match in MARKDOWN_LINK_RE.finditer(text):
            linked = _link_path(match.group(1))
            if linked is None:
                continue
            if linked.startswith("/"):
                target = root / linked.lstrip("/")
            else:
                target = document.parent / linked
            resolved = target.resolve()
            resolved_root = root.resolve()
            if resolved != resolved_root and resolved_root not in resolved.parents:
                errors.append(
                    f"{_display_path(document, root)} links outside the repository: {match.group(1)}"
                )
            elif not resolved.exists():
                errors.append(
                    f"{_display_path(document, root)} has a broken relative link: {match.group(1)}"
                )
    return errors


def validate_current_tree(
    root: Path,
    manifest: Manifest,
    repository_files: Sequence[str] | None = None,
) -> list[str]:
    errors: list[str] = []
    forbidden_names = {name.casefold() for name in manifest.forbidden_top_level_files}
    for entry in root.iterdir():
        if entry.name.casefold() in forbidden_names:
            errors.append(f"top-level instruction file is forbidden: {entry.name}")

    files = (
        tuple(repository_files)
        if repository_files is not None
        else list_repository_files(root)
    )
    document_owners: dict[str, set[str]] = {}
    for domain in manifest.domains:
        for document in domain.documents:
            try:
                _safe_path(root, document)
            except DocsSyncError as exc:
                errors.append(str(exc))
                continue
            if document in document_owners:
                errors.append(
                    f"canonical document {document} belongs to multiple domains: "
                    + ", ".join(sorted(document_owners[document] | {domain.identifier}))
                )
            document_owners.setdefault(document, set()).add(domain.identifier)
            if not _is_covered_document(manifest, document):
                errors.append(f"canonical document is outside document coverage: {document}")
            document_path = _safe_path(root, document)
            if not document_path.exists():
                errors.append(f"canonical document for {domain.identifier} is missing: {document}")
            elif not stat.S_ISREG(document_path.lstat().st_mode):
                errors.append(f"canonical document must be a regular file: {document}")

    for contract in manifest.contracts:
        document_owners.setdefault(contract.source, set()).update(contract.domains)

    for domain in manifest.domains:
        for code_pattern in domain.code:
            if not any(
                _is_covered_code(manifest, path)
                and path_matches(path, (code_pattern,))
                for path in files
            ):
                errors.append(
                    f"domain {domain.identifier} code pattern matches no covered production files: {code_pattern}"
                )
        for test_pattern in domain.tests:
            if not any(path_matches(path, (test_pattern,)) for path in files):
                errors.append(f"domain {domain.identifier} test pattern matches no files: {test_pattern}")

    for path in files:
        code_domains = domains_for_code(manifest, path) if _is_covered_code(manifest, path) else ()
        test_domains = domains_for_test(manifest, path)
        document_domains = domains_for_document(manifest, path)
        if _is_covered_code(manifest, path) and not code_domains:
            errors.append(f"covered production path has no documentation domain: {path}")
        if _is_covered_document(manifest, path) and not document_domains:
            errors.append(f"canonical document has no code domain: {path}")
        categories = sum(
            (
                bool(code_domains),
                bool(test_domains),
                bool(document_domains) or _is_covered_document(manifest, path),
            )
        )
        if categories > 1:
            errors.append(f"repository path cannot be both code, test, or documentation: {path}")

    seen_targets: set[str] = set()
    for contract in manifest.contracts:
        if not _safe_path(root, contract.source).is_file():
            errors.append(f"contract source is missing: {contract.source}")
            continue
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
            target = _safe_path(root, target_path)
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


def _git_object_exists(root: Path, revision: str) -> bool:
    if not revision or ZERO_SHA_RE.fullmatch(revision):
        return False
    result = _git(root, ["cat-file", "-e", f"{revision}^{{commit}}"], check=False)
    return result.returncode == 0


def _manifest_exists_at_revision(root: Path, revision: str) -> bool:
    result = _git(root, ["cat-file", "-e", f"{revision}:{MANIFEST_PATH.as_posix()}"], check=False)
    return result.returncode == 0


def _merge_base(root: Path, base: str, head: str) -> str:
    result = _git(root, ["merge-base", base, head])
    revision = result.stdout.decode("ascii", errors="strict").strip()
    if not revision:
        raise DocsSyncError(f"revisions do not share a merge base: {base}, {head}")
    return revision


def _decode_path_output(*outputs: bytes) -> tuple[str, ...]:
    return tuple(
        sorted(
            {
                item.decode("utf-8", errors="surrogateescape")
                for output in outputs
                for item in output.split(b"\0")
                if item
            }
        )
    )


def changed_paths(root: Path, base: str, head: str) -> tuple[str, ...]:
    if not _git_object_exists(root, base):
        raise DocsSyncError(f"base revision is not a commit: {base}")
    if head in {WORKTREE_REVISION, INDEX_REVISION}:
        if not _git_object_exists(root, "HEAD"):
            raise DocsSyncError("HEAD is not a commit")
        comparison_base = _merge_base(root, base, "HEAD")
        committed = _git(
            root,
            [
                "diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", "-z",
                comparison_base, "HEAD", "--",
            ],
        )
        staged = _git(
            root,
            [
                "diff", "--cached", "--no-renames", "--name-only",
                "--diff-filter=ACDMRTUXB", "-z", comparison_base, "--",
            ],
        )
        if head == INDEX_REVISION:
            return _decode_path_output(committed.stdout, staged.stdout)
        unstaged = _git(
            root,
            ["diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", "-z", "--"],
        )
        untracked = _git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
        return _decode_path_output(
            committed.stdout,
            staged.stdout,
            unstaged.stdout,
            untracked.stdout,
        )
    else:
        if not _git_object_exists(root, head):
            raise DocsSyncError(
                f"head revision is not a commit, {INDEX_REVISION}, or {WORKTREE_REVISION}: {head}"
            )
        comparison_base = _merge_base(root, base, head)
        result = _git(
            root,
            [
                "diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", "-z",
                comparison_base, head, "--",
            ],
        )
        return _decode_path_output(result.stdout)


def validate_change(root: Path, manifest: Manifest, base: str, head: str) -> tuple[list[str], bool]:
    if head not in {WORKTREE_REVISION, INDEX_REVISION} and not _git_object_exists(root, head):
        raise DocsSyncError(
            f"head revision is not a commit, {INDEX_REVISION}, or {WORKTREE_REVISION}: {head}"
        )
    if not _git_object_exists(root, base):
        if ZERO_SHA_RE.fullmatch(base):
            return [], True
        raise DocsSyncError(f"base revision is not a commit: {base}")
    if not _manifest_exists_at_revision(root, base):
        return [], True

    comparison_head = "HEAD" if head in {WORKTREE_REVISION, INDEX_REVISION} else head
    comparison_base = _merge_base(root, base, comparison_head)
    historical_manifest = load_manifest_at_revision(root, comparison_base)
    classification_manifests = tuple(
        candidate
        for candidate in (historical_manifest, manifest)
        if candidate is not None
    )
    paths = changed_paths(root, base, head)
    domain_ids = {
        domain.identifier
        for candidate in classification_manifests
        for domain in candidate.domains
    }
    changed_documents: dict[str, set[str]] = {identifier: set() for identifier in domain_ids}
    changed_code: dict[str, set[str]] = {identifier: set() for identifier in domain_ids}
    changed_implementation: dict[str, set[str]] = {identifier: set() for identifier in domain_ids}

    for path in paths:
        for candidate in classification_manifests:
            for domain_id in domains_for_document(candidate, path):
                changed_documents[domain_id].add(path)
            if _is_covered_code(candidate, path):
                for domain in domains_for_code(candidate, path):
                    changed_code[domain.identifier].add(path)
                    changed_implementation[domain.identifier].add(path)
            for domain in domains_for_test(candidate, path):
                changed_implementation[domain.identifier].add(path)

    errors: list[str] = []
    for identifier in sorted(domain_ids):
        if changed_code[identifier] and not changed_documents[identifier]:
            errors.append(
                f"code changed in domain {identifier} without its canonical documentation: "
                f"{', '.join(sorted(changed_code[identifier]))}"
            )
        if changed_documents[identifier] and not changed_implementation[identifier]:
            errors.append(
                f"canonical documentation changed in domain {identifier} without code, generated contract, or tests: "
                f"{', '.join(sorted(changed_documents[identifier]))}"
            )
    return errors, False


def _print_errors(errors: Sequence[str]) -> None:
    print("documentation sync check failed:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)


def command_sync(root: Path) -> int:
    try:
        manifest = load_manifest(root)
        written = sync_contracts(root, manifest)
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
        manifest = load_manifest(root)
        errors = validate_current_tree(root, manifest)
    except DocsSyncError as exc:
        errors = [str(exc)]
    if errors:
        _print_errors(errors)
        return 1
    print("documentation tree and generated contracts are in sync")
    return 0


def command_check_change(root: Path, base: str, head: str) -> int:
    try:
        if head == INDEX_REVISION:
            with tempfile.TemporaryDirectory(prefix="docs-sync-index-") as temporary:
                snapshot_root = Path(temporary)
                repository_files = _materialize_index_tree(root, snapshot_root)
                manifest = load_manifest(snapshot_root)
                errors = validate_current_tree(
                    snapshot_root,
                    manifest,
                    repository_files=repository_files,
                )
        else:
            manifest = load_manifest(root)
            errors = validate_current_tree(root, manifest)
        if not errors:
            change_errors, bootstrap = validate_change(root, manifest, base, head)
            errors.extend(change_errors)
        else:
            bootstrap = False
    except DocsSyncError as exc:
        errors = [str(exc)]
        bootstrap = False
    if errors:
        _print_errors(errors)
        return 1
    if bootstrap:
        print("documentation sync bootstrap detected; current-tree checks passed")
    else:
        print("documentation and code changes are synchronized")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("sync", "check"):
        command = subparsers.add_parser(name)
        command.add_argument("--root", type=Path, default=_repo_root_from_script())
    change = subparsers.add_parser("check-change")
    change.add_argument("--root", type=Path, default=_repo_root_from_script())
    change.add_argument("--base", required=True)
    change.add_argument(
        "--head",
        required=True,
        help=(
            f"Git commit to check, {INDEX_REVISION} for committed and staged files, "
            f"or {WORKTREE_REVISION} for committed, staged, unstaged, and untracked files"
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = args.root.resolve()
    if args.command == "sync":
        return command_sync(root)
    if args.command == "check":
        return command_check(root)
    if args.command == "check-change":
        return command_check_change(root, args.base, args.head)
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
