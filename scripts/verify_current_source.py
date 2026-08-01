#!/usr/bin/env python3
"""Reject retired technical identities and one-time migration code."""

from __future__ import annotations

import argparse
import os
import stat
import sys
from pathlib import Path, PurePosixPath
from typing import Iterable


SOURCE_ROOTS = (
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
IGNORED_DIRECTORIES = frozenset(
    {"__pycache__", ".venv", "node_modules", "dist", "build", "static", "test", "tests", "testdata", "__tests__"}
)
TEXT_SUFFIXES = frozenset(
    {".cjs", ".css", ".go", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".mod", ".py", ".scss", ".sh", ".svg", ".sum", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"}
)
SPECIAL_TEXT_NAMES = frozenset({"Dockerfile", ".dockerignore", "dev.env.example"})
MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024

FORBIDDEN_PATHS = (
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
FORBIDDEN_MARKERS = (
    "UBITECH_",
    "ENTERPRISE_",
    "ubitech-agent-v1",
    "ubitech-agent",
    "ubitech-manager",
    "io.ubitech.",
    "namespace_handoff",
    "namespace-handoff",
    "release-transition",
    "release_transition",
    "handoff-fs-helper",
    "SOURCE_TECHNICAL_PROFILE",
    "SOURCE_PROFILE_ID",
)


class SourceTreeGateError(RuntimeError):
    """The current production source boundary is not closed."""


def _is_test_file(relative: PurePosixPath) -> bool:
    name = relative.name
    return (
        name.endswith("_test.go")
        or name.startswith("test_") and name.endswith(".py")
        or ".test." in name
        or ".spec." in name
    )


def _walk(path: Path, relative: PurePosixPath) -> Iterable[tuple[Path, PurePosixPath]]:
    try:
        info = path.lstat()
    except OSError as exc:
        raise SourceTreeGateError(f"cannot inspect source root {relative}: {exc}") from exc
    if path.is_symlink():
        raise SourceTreeGateError(f"source root is a symlink: {relative}")
    if stat.S_ISREG(info.st_mode):
        yield path, relative
        return
    if not stat.S_ISDIR(info.st_mode):
        raise SourceTreeGateError(f"source root has unsupported type: {relative}")
    try:
        entries = sorted(os.scandir(path), key=lambda entry: entry.name)
    except OSError as exc:
        raise SourceTreeGateError(f"cannot enumerate source root {relative}: {exc}") from exc
    for entry in entries:
        child_relative = relative / entry.name
        if entry.is_symlink():
            raise SourceTreeGateError(f"production source contains a symlink: {child_relative}")
        if entry.is_dir(follow_symlinks=False):
            if entry.name not in IGNORED_DIRECTORIES:
                yield from _walk(Path(entry.path), child_relative)
        elif entry.is_file(follow_symlinks=False):
            yield Path(entry.path), child_relative
        else:
            raise SourceTreeGateError(
                f"production source has unsupported entry: {child_relative}"
            )


def verify_source_tree(root: Path) -> int:
    try:
        root_info = root.lstat()
    except OSError as exc:
        raise SourceTreeGateError(f"cannot inspect repository root: {exc}") from exc
    if root.is_symlink() or not stat.S_ISDIR(root_info.st_mode):
        raise SourceTreeGateError("repository root must be a real directory")

    scanned = 0
    for configured in SOURCE_ROOTS:
        relative_root = PurePosixPath(configured)
        source_root = root.joinpath(*relative_root.parts)
        for source_path, relative in _walk(source_root, relative_root):
            rendered = relative.as_posix()
            if any(rendered == item or rendered.startswith(item + "/") for item in FORBIDDEN_PATHS):
                raise SourceTreeGateError(f"retired executable path remains: {relative}")
            if _is_test_file(relative):
                continue
            if not (
                source_path.suffix.lower() in TEXT_SUFFIXES
                or source_path.name in SPECIAL_TEXT_NAMES
                or source_path.name.endswith(".Dockerfile")
                or source_path.name.endswith(".Dockerfile.dockerignore")
            ):
                raise SourceTreeGateError(f"unknown production source type: {relative}")
            try:
                info = source_path.lstat()
                if info.st_size > MAX_SOURCE_FILE_BYTES:
                    raise SourceTreeGateError(f"production source is too large: {relative}")
                content = source_path.read_text(encoding="utf-8")
            except UnicodeDecodeError as exc:
                raise SourceTreeGateError(f"production source is not UTF-8: {relative}") from exc
            except OSError as exc:
                raise SourceTreeGateError(f"cannot read production source {relative}: {exc}") from exc
            for marker in FORBIDDEN_MARKERS:
                if marker in content:
                    raise SourceTreeGateError(
                        f"retired technical identity {marker!r} remains in {relative}"
                    )
            scanned += 1
    return scanned


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    arguments = parser.parse_args(argv)
    try:
        scanned = verify_source_tree(arguments.root.absolute())
    except SourceTreeGateError as exc:
        print(f"current source-tree gate failed: {exc}", file=sys.stderr)
        return 1
    print(f"current source-tree gate passed: {scanned} production files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
