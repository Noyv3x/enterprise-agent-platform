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
import json
import os
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
REQUIRED_LEGACY_TOP_LEVEL_FILES = {"agents.md", "claude.md"}
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
REQUIRED_OWNED_CODE_PROBES = {
    ".gitmodules": frozenset({"repository-development"}),
    "cognee": frozenset({"integrations"}),
    "firecrawl": frozenset({"integrations"}),
    ".github/workflows/quality.yml": frozenset({"repository-development"}),
    "deploy.sh": frozenset({"deployment"}),
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
    legacy_top_level_files: tuple[str, ...]
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
        {"version", "legacy_top_level_files", "coverage", "domains", "contracts"},
        "documentation manifest",
    )
    if raw.get("version") != 1:
        raise DocsSyncError("documentation manifest version must be 1")

    legacy = _expect_string_list(
        raw.get("legacy_top_level_files"),
        "legacy_top_level_files",
    )
    for path in legacy:
        if "/" in path or "\\" in path:
            raise DocsSyncError("legacy_top_level_files may contain only top-level file names")
    missing_legacy_guards = REQUIRED_LEGACY_TOP_LEVEL_FILES - {
        path.casefold() for path in legacy
    }
    if missing_legacy_guards:
        raise DocsSyncError(
            "legacy_top_level_files must permanently forbid: "
            + ", ".join(sorted(missing_legacy_guards))
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
            if not _is_beneath(document, "docs"):
                raise DocsSyncError(f"{label}.documents must stay under docs/: {document}")
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
        if not isinstance(targets_raw, list) or not targets_raw:
            raise DocsSyncError(f"{label}.targets must be a non-empty JSON array")
        targets: list[ContractTarget] = []
        for target_index, target_item in enumerate(targets_raw):
            target_label = f"{label}.targets[{target_index}]"
            target_raw = _expect_object(target_item, target_label)
            _reject_unknown_keys(target_raw, {"path", "format"}, target_label)
            target_path = target_raw.get("path")
            target_format = target_raw.get("format")
            if not isinstance(target_path, str) or not target_path:
                raise DocsSyncError(f"{target_label}.path must be a non-empty string")
            if target_format not in {"python-runtime-policy", "typescript-runtime-policy"}:
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
        version=1,
        legacy_top_level_files=legacy,
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
    if value.get("version") != 1:
        raise DocsSyncError(f"{label} version must be 1")

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

    legacy_raw = value.get("legacy_top_level_files", [])
    legacy = _expect_string_list(
        legacy_raw,
        f"{label}.legacy_top_level_files",
        allow_empty=True,
    )
    return Manifest(1, legacy, coverage, tuple(domains), tuple(contracts))


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


def render_contract(root: Path, contract: Contract) -> dict[str, str]:
    raw = _read_json(_safe_path(root, contract.source), f"contract {contract.identifier}")
    if contract.identifier != "runtime-policy":
        raise DocsSyncError(f"unsupported contract id: {contract.identifier}")
    parsed = _validate_runtime_contract(raw, f"contract {contract.identifier}")
    rendered: dict[str, str] = {}
    for target in contract.targets:
        if target.format == "python-runtime-policy":
            content = _render_python_runtime_policy(parsed, contract.source)
        elif target.format == "typescript-runtime-policy":
            content = _render_typescript_runtime_policy(parsed, contract.source)
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
    legacy_names = {name.casefold() for name in manifest.legacy_top_level_files}
    for entry in root.iterdir():
        if entry.name.casefold() in legacy_names:
            errors.append(f"legacy top-level instruction file is forbidden: {entry.name}")

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
