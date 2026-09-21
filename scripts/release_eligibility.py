#!/usr/bin/env python3
"""Skip automatic releases only for cumulative, non-packaged prose changes."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import subprocess
import sys


COMMIT = re.compile(r"[0-9a-f]{40}")
RAW_CHANGE = re.compile(rb":([0-7]{6}) ([0-7]{6}) [0-9a-f]{40} [0-9a-f]{40} ([ADMT])")
PROSE_DIRECTORIES = {"design", "reference", "operations", "development", "decisions"}


def _git(repo: Path, *args: str, allowed: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        ["git", "--no-replace-objects", "-C", str(repo), *args],
        capture_output=True,
        check=False,
    )
    if result.returncode not in allowed:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"Git {args[0]} failed ({result.returncode}): {detail}")
    return result


def _validate_commit(repo: Path, commit: str, label: str) -> None:
    if COMMIT.fullmatch(commit) is None:
        raise ValueError(f"{label} must be a full lowercase 40-hex commit")
    if _git(repo, "cat-file", "-t", commit).stdout != b"commit\n":
        raise ValueError(f"{label} must identify a commit object")


def _is_prose(path: bytes) -> bool:
    try:
        name = path.decode("utf-8")
    except UnicodeDecodeError:
        return False
    if not name.isprintable():
        return False
    if name in {"AGENTS.md", "README.md", "docs/README.md"}:
        return True
    parts = name.split("/")
    return (
        len(parts) == 3
        and parts[0] == "docs"
        and parts[1] in PROSE_DIRECTORIES
        and parts[2].endswith(".md")
        and parts[2] != ".md"
    )


def release_required(repo: Path, source: str, published: str | None, manual: bool) -> tuple[bool, str]:
    _validate_commit(repo, source, "source")
    if published is not None:
        _validate_commit(repo, published, "published")
        if _git(repo, "merge-base", "--is-ancestor", published, source, allowed=(0, 1)).returncode:
            raise ValueError("published generation is not an ancestor of source")
    if manual:
        return True, "Manual release requested after commit and ancestry validation"
    if published is None:
        return True, "No published generation; initial release required"

    # Compare trees, not a push range or the last commit. Disable rename and local
    # diff customizations so both sides of moves and every submodule change count.
    raw = _git(
        repo, "diff-tree", "--raw", "-z", "--no-abbrev", "-r", "--no-renames",
        "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--ignore-submodules=none",
        published, source, "--",
    ).stdout
    if not raw:
        return False, "No cumulative changes since the published generation"
    fields = raw.split(b"\0")
    if fields[-1] != b"" or len(fields) % 2 != 1:
        raise ValueError("Malformed NUL-delimited Git diff")
    required_path = None
    for index in range(0, len(fields) - 1, 2):
        change = RAW_CHANGE.fullmatch(fields[index])
        path = fields[index + 1]
        if change is None or not path:
            raise ValueError("Malformed raw Git change")
        old_mode, new_mode, status = change.groups()
        ordinary = (
            (status == b"A" and old_mode == b"000000" and new_mode == b"100644")
            or (status == b"D" and old_mode == b"100644" and new_mode == b"000000")
            or (status == b"M" and old_mode == new_mode == b"100644")
        )
        if required_path is None and (not ordinary or not _is_prose(path)):
            required_path = path
    if required_path is not None:
        return True, f"Cumulative artifact-bearing or unclassified change: {required_path!r}"
    return False, "All cumulative changes are allowlisted, regular non-executable prose"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--published")
    parser.add_argument("--manual", action="store_true")
    args = parser.parse_args()
    try:
        required, reason = release_required(args.repo, args.source, args.published, args.manual)
    except (ValueError, OSError) as exc:
        print(f"Release eligibility failed: {exc}", file=sys.stderr)
        return 1
    print(reason, file=sys.stderr)
    print("true" if required else "false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
