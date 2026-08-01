#!/usr/bin/env python3
"""Run one deterministic, module-level shard of the Platform Python tests."""

from __future__ import annotations

import argparse
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Sequence


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
PLATFORM_ROOT = REPOSITORY_ROOT / "enterprise-agent-platform"
TEST_DIRECTORY = PLATFORM_ROOT / "tests"


class ShardConfigurationError(ValueError):
    """Raised when a requested shard cannot cover the closed test world."""


def discover_test_modules(test_directory: Path = TEST_DIRECTORY) -> tuple[Path, ...]:
    if not test_directory.is_dir():
        raise ShardConfigurationError(f"test directory does not exist: {test_directory}")
    entries = tuple(sorted(test_directory.glob("test_*.py"), key=lambda path: path.name))
    invalid = [path for path in entries if not stat.S_ISREG(path.lstat().st_mode)]
    if invalid:
        raise ShardConfigurationError(f"test module is not a regular file: {invalid[0]}")
    if not entries:
        raise ShardConfigurationError(f"no test_*.py modules found in {test_directory}")
    return entries


def partition_modules(
    modules: Sequence[Path], shard_count: int
) -> tuple[tuple[Path, ...], ...]:
    if shard_count < 1:
        raise ShardConfigurationError("shard count must be at least 1")
    ordered = tuple(sorted(modules, key=lambda path: path.as_posix()))
    if len(set(ordered)) != len(ordered):
        raise ShardConfigurationError("test module list contains duplicates")
    if shard_count > len(ordered):
        raise ShardConfigurationError("shard count cannot exceed test module count")

    shards: list[list[Path]] = [[] for _ in range(shard_count)]
    weights = [0] * shard_count
    for module in sorted(ordered, key=lambda path: (-path.stat().st_size, path.as_posix())):
        shard_index = min(
            range(shard_count),
            key=lambda index: (weights[index], len(shards[index]), index),
        )
        shards[shard_index].append(module)
        weights[shard_index] += module.stat().st_size

    result = tuple(tuple(sorted(shard, key=lambda path: path.as_posix())) for shard in shards)
    assigned = tuple(module for shard in result for module in shard)
    if len(assigned) != len(ordered) or set(assigned) != set(ordered):
        raise RuntimeError("internal error: shards do not exactly cover test modules")
    return result


def select_shard(
    modules: Sequence[Path], shard_index: int, shard_count: int
) -> tuple[Path, ...]:
    partitions = partition_modules(modules, shard_count)
    if shard_index < 0 or shard_index >= shard_count:
        raise ShardConfigurationError(
            f"shard index must be between 0 and {shard_count - 1}"
        )
    return partitions[shard_index]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard-index", required=True, type=int)
    parser.add_argument("--shard-count", required=True, type=int)
    parser.add_argument(
        "--list",
        action="store_true",
        help="list repository-relative test modules without running them",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        modules = discover_test_modules()
        selected = select_shard(modules, args.shard_index, args.shard_count)
    except ShardConfigurationError as error:
        parser.error(str(error))

    if args.list:
        for module in selected:
            print(module.relative_to(REPOSITORY_ROOT).as_posix())
        return 0

    module_names = [module.stem for module in selected]
    print(
        f"Python test shard {args.shard_index + 1}/{args.shard_count}: "
        f"{len(module_names)} modules",
        flush=True,
    )
    environment = os.environ.copy()
    python_path = environment.get("PYTHONPATH")
    environment["PYTHONPATH"] = os.pathsep.join(
        part
        for part in (str(TEST_DIRECTORY), str(PLATFORM_ROOT), python_path)
        if part
    )
    return subprocess.run(
        [sys.executable, "-m", "unittest", "-v", *module_names],
        cwd=PLATFORM_ROOT,
        env=environment,
        check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
