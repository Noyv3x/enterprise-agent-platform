from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import python_test_shard as shard_runner  # noqa: E402


class PythonTestShardTests(unittest.TestCase):
    def test_partition_is_deterministic_and_exact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            modules = []
            for index, size in enumerate((100, 90, 80, 70, 60, 50, 40)):
                module = root / f"test_{index}.py"
                module.write_bytes(b"x" * size)
                modules.append(module)

            first = shard_runner.partition_modules(tuple(reversed(modules)), 4)
            second = shard_runner.partition_modules(modules, 4)
            self.assertEqual(first, second)
            flattened = [module for partition in first for module in partition]
            self.assertEqual(len(flattened), len(modules))
            self.assertEqual(set(flattened), set(modules))

    def test_four_listed_shards_cover_the_closed_world_once(self) -> None:
        expected = set(shard_runner.discover_test_modules())
        listed: list[Path] = []
        for shard_index in range(4):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(
                    shard_runner.main(
                        [
                            "--shard-index",
                            str(shard_index),
                            "--shard-count",
                            "4",
                            "--list",
                        ]
                    ),
                    0,
                )
            listed.extend(ROOT / line for line in output.getvalue().splitlines())

        self.assertEqual(len(listed), len(expected))
        self.assertEqual(set(listed), expected)

    def test_invalid_shard_parameters_are_rejected(self) -> None:
        modules = shard_runner.discover_test_modules()
        for shard_index, shard_count in ((0, 0), (-1, 4), (4, 4), (0, len(modules) + 1)):
            with self.subTest(shard_index=shard_index, shard_count=shard_count):
                with self.assertRaises(shard_runner.ShardConfigurationError):
                    shard_runner.select_shard(modules, shard_index, shard_count)

    def test_runner_uses_discovery_compatible_top_level_module_imports(self) -> None:
        completed = mock.Mock(returncode=0)
        with mock.patch.object(
            shard_runner,
            "discover_test_modules",
            return_value=(shard_runner.TEST_DIRECTORY / "test_mail.py",),
        ), mock.patch.object(shard_runner.subprocess, "run", return_value=completed) as run:
            self.assertEqual(
                shard_runner.main(
                    ["--shard-index", "0", "--shard-count", "1"]
                ),
                0,
            )

        command = run.call_args.args[0]
        self.assertEqual(command[-1], "test_mail")
        self.assertEqual(run.call_args.kwargs["cwd"], shard_runner.PLATFORM_ROOT)
        python_path = run.call_args.kwargs["env"]["PYTHONPATH"].split(os.pathsep)
        self.assertEqual(Path(python_path[0]), shard_runner.TEST_DIRECTORY)
        self.assertEqual(Path(python_path[1]), shard_runner.PLATFORM_ROOT)


if __name__ == "__main__":
    unittest.main()
