#!/usr/bin/env python3
"""Fail closed when a target-only release still contains source-era code.

The transition release workflow must retain enough policy to verify the sealed
Bridge and Cleanup releases.  This gate deliberately scans only source that is
compiled, packaged, or copied into a product artifact.  Its boundary is closed
and cannot be widened by command-line allowlists.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


ENFORCED_STAGES = frozenset({"cleanup", "target_baseline"})
SKIPPED_STAGES = frozenset({"bridge"})

# Exact authored roots that enter a product binary, Python/Node package, static
# frontend build, container image, Compose deployment, or fresh installer.
SCAN_ROOTS = (
    "install.sh",
    "containers",
    "manager/go.mod",
    "manager/cmd",
    "manager/internal",
    "enterprise-agent-platform/pyproject.toml",
    "enterprise-agent-platform/enterprise_agent_platform",
    "enterprise-agent-platform/agent-runtime/package.json",
    "enterprise-agent-platform/agent-runtime/package-lock.json",
    "enterprise-agent-platform/agent-runtime/src",
    "enterprise-agent-platform/camofox-runtime/package.json",
    "enterprise-agent-platform/camofox-runtime/package-lock.json",
    "enterprise-agent-platform/camofox-runtime/loopback-preload.cjs",
    "enterprise-agent-platform/camofox-runtime/patch-runtime.cjs",
    "enterprise-agent-platform/frontend/package.json",
    "enterprise-agent-platform/frontend/package-lock.json",
    "enterprise-agent-platform/frontend/src",
)

# Generated dependencies and separately verified generated browser output are
# not authored source.  Tests are the only place where historical user-data
# fixtures may retain source values.
EXCLUDED_DIRECTORY_NAMES = frozenset(
    {"__pycache__", ".venv", "node_modules", "dist", "build", "static"}
)
TEST_DIRECTORY_NAMES = frozenset({"test", "tests", "testdata", "__tests__"})

TEXT_SUFFIXES = frozenset(
    {
        ".cjs",
        ".css",
        ".go",
        ".html",
        ".js",
        ".json",
        ".jsx",
        ".md",
        ".mjs",
        ".mod",
        ".py",
        ".scss",
        ".sh",
        ".svg",
        ".sum",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".yaml",
        ".yml",
    }
)
SPECIAL_TEXT_NAMES = frozenset({"Dockerfile", ".dockerignore", "dev.env.example"})
MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024

# These paths are one-time executable capabilities, not historical data.  A
# target-only tree must physically delete them rather than merely stop imports.
FORBIDDEN_PATH_PREFIXES = (
    "containers/handoff-fs-helper.Dockerfile",
    "containers/handoff-fs-helper.Dockerfile.dockerignore",
    "manager/cmd/handoff-fs-helper",
    "manager/cmd/ubitech-manager",
    "manager/internal/attestation",
    "manager/internal/handoff",
    "manager/internal/handoffcontrol",
    "manager/internal/handoffevidence",
    "manager/internal/handofffd",
    "manager/internal/handoffhelper",
    "manager/internal/handoffhost",
    "manager/internal/handofflisteners",
    "manager/internal/handoffowner",
    "manager/internal/handoffsource",
    "manager/internal/handoffstartup",
    "manager/internal/handofftransform",
    "manager/internal/contract/release_transition_generated.go",
    "enterprise-agent-platform/enterprise_agent_platform/handoff_evidence.py",
    "enterprise-agent-platform/enterprise_agent_platform/release_transition_contract_generated.py",
)

FORBIDDEN_FILE_NAME_FRAGMENTS = (
    "handoff_",
    "_handoff",
    "release_transition",
    "transition_observer",
    "startup_locator",
)

# Deliberately exact technical identifiers.  Generic words such as "source",
# "migration", and browser-assistance "handoff" are not forbidden because they
# have legitimate target-only meanings.
FORBIDDEN_TEXT_MARKERS = (
    "UBITECH_",
    "ENTERPRISE_",
    "SOURCE_TECHNICAL_PROFILE",
    "ubitech-agent-v1",
    "ubitech-agent",
    "ubitech-manager",
    "ubitech-compose.yaml",
    ".ubitech",
    ".enterprise-platform.lock",
    "enterprise_session",
    "io.ubitech.",
    "namespace_handoff",
    "namespace-handoff",
    "release-transition",
    "release_transition",
    "handoff-fs-helper",
    "P1_SOURCE_HANDOFF",
    "P1SourceHandoff",
    "p1_source_handoff",
    "AgentRuntimeP1",
    "SOURCE_PROFILE_ID",
    "ReleaseTransitionSourceProfileID",
    "SourceProfile()",
    "SourceActiveProfile()",
    '"source_profile"',
    '"source_owner"',
)


class SourceTreeGateError(RuntimeError):
    """The target-only production tree is not closed."""


@dataclass(frozen=True)
class GateResult:
    stage: str
    skipped: bool
    scanned_files: int


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise SourceTreeGateError(f"transition contract has duplicate field {key!r}")
        result[key] = value
    return result


def read_stage(contract_path: Path) -> str:
    try:
        info = contract_path.lstat()
    except OSError as exc:
        raise SourceTreeGateError(f"cannot inspect transition contract: {exc}") from exc
    if contract_path.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise SourceTreeGateError("transition contract must be a regular non-symlink file")
    if info.st_size <= 0 or info.st_size > 64 * 1024:
        raise SourceTreeGateError("transition contract has an invalid size")
    try:
        value = json.loads(
            contract_path.read_text(encoding="utf-8"), object_pairs_hook=_strict_object
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceTreeGateError(f"cannot decode transition contract: {exc}") from exc
    if not isinstance(value, dict):
        raise SourceTreeGateError("transition contract must be an object")
    stage = value.get("stage")
    if stage not in ENFORCED_STAGES | SKIPPED_STAGES:
        raise SourceTreeGateError("transition contract has an unsupported stage")
    return stage


def _is_test_file(relative: PurePosixPath) -> bool:
    if any(part in TEST_DIRECTORY_NAMES for part in relative.parts):
        return True
    name = relative.name
    return (
        name.endswith("_test.go")
        or name.startswith("test_") and name.endswith(".py")
        or ".test." in name
        or ".spec." in name
    )


def _forbidden_path(relative: PurePosixPath) -> str | None:
    rendered = relative.as_posix()
    for prefix in FORBIDDEN_PATH_PREFIXES:
        if rendered == prefix or rendered.startswith(prefix + "/"):
            return prefix
    if not _is_test_file(relative):
        lowered = relative.name.lower()
        for fragment in FORBIDDEN_FILE_NAME_FRAGMENTS:
            if fragment in lowered:
                return fragment
    return None


def _is_text_source(path: Path) -> bool:
    return (
        path.suffix.lower() in TEXT_SUFFIXES
        or path.name in SPECIAL_TEXT_NAMES
        or path.name.endswith(".Dockerfile")
        or path.name.endswith(".Dockerfile.dockerignore")
    )


def _walk_source(root: Path, relative: PurePosixPath) -> Iterable[tuple[Path, PurePosixPath]]:
    try:
        info = root.lstat()
    except OSError as exc:
        raise SourceTreeGateError(f"cannot inspect scan root {relative}: {exc}") from exc
    if root.is_symlink():
        raise SourceTreeGateError(f"scan root is a symlink: {relative}")
    if stat.S_ISREG(info.st_mode):
        yield root, relative
        return
    if not stat.S_ISDIR(info.st_mode):
        raise SourceTreeGateError(f"scan root has an unsupported type: {relative}")

    def descend(directory: Path, current: PurePosixPath) -> Iterable[tuple[Path, PurePosixPath]]:
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as exc:
            raise SourceTreeGateError(f"cannot enumerate {current}: {exc}") from exc
        for entry in entries:
            child_relative = current / entry.name
            if entry.is_symlink():
                raise SourceTreeGateError(f"production source contains a symlink: {child_relative}")
            try:
                if entry.is_dir(follow_symlinks=False):
                    if entry.name in EXCLUDED_DIRECTORY_NAMES or entry.name in TEST_DIRECTORY_NAMES:
                        continue
                    yield from descend(Path(entry.path), child_relative)
                elif entry.is_file(follow_symlinks=False):
                    yield Path(entry.path), child_relative
                else:
                    raise SourceTreeGateError(
                        f"production source has an unsupported filesystem entry: {child_relative}"
                    )
            except OSError as exc:
                raise SourceTreeGateError(f"cannot inspect {child_relative}: {exc}") from exc

    yield from descend(root, relative)


def verify_source_tree(root: Path, stage: str) -> GateResult:
    if stage in SKIPPED_STAGES:
        return GateResult(stage=stage, skipped=True, scanned_files=0)
    if stage not in ENFORCED_STAGES:
        raise SourceTreeGateError(f"unsupported transition stage: {stage}")
    try:
        root_info = root.lstat()
    except OSError as exc:
        raise SourceTreeGateError(f"cannot inspect repository root: {exc}") from exc
    if root.is_symlink() or not stat.S_ISDIR(root_info.st_mode):
        raise SourceTreeGateError("repository root must be a real directory")

    scanned = 0
    for configured in SCAN_ROOTS:
        relative_root = PurePosixPath(configured)
        path = root.joinpath(*relative_root.parts)
        for source_path, relative in _walk_source(path, relative_root):
            path_marker = _forbidden_path(relative)
            if path_marker is not None:
                raise SourceTreeGateError(
                    f"target-only tree retains forbidden path {relative} ({path_marker})"
                )
            if _is_test_file(relative):
                continue
            if not _is_text_source(source_path):
                raise SourceTreeGateError(f"production source has an unknown file type: {relative}")
            try:
                info = source_path.lstat()
                if info.st_size > MAX_SOURCE_FILE_BYTES:
                    raise SourceTreeGateError(f"production source file is too large: {relative}")
                content = source_path.read_text(encoding="utf-8")
            except UnicodeDecodeError as exc:
                raise SourceTreeGateError(f"production source is not UTF-8 text: {relative}") from exc
            except OSError as exc:
                raise SourceTreeGateError(f"cannot read production source {relative}: {exc}") from exc
            for marker in FORBIDDEN_TEXT_MARKERS:
                if marker in content:
                    raise SourceTreeGateError(
                        f"target-only tree retains {marker!r} in {relative}"
                    )
            scanned += 1
    return GateResult(stage=stage, skipped=False, scanned_files=scanned)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--contract",
        type=Path,
        default=Path("docs/contracts/release-transition.json"),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        root = arguments.root.absolute()
        contract = arguments.contract
        if not contract.is_absolute():
            contract = root / contract
        stage = read_stage(contract)
        result = verify_source_tree(root, stage)
    except SourceTreeGateError as exc:
        print(f"target-baseline source-tree gate failed: {exc}", file=sys.stderr)
        return 1
    if result.skipped:
        print("target-baseline source-tree gate skipped for Bridge")
    else:
        print(
            f"target-baseline source-tree gate passed for {result.stage}: "
            f"{result.scanned_files} production files"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
