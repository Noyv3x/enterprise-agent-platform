from __future__ import annotations

import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


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

    def run_fixture(self, root: Path, test_body: str) -> subprocess.CompletedProcess[str]:
        scripts = root / "scripts"
        scripts.mkdir()
        runner = scripts / "python_test_shard.py"
        runner.write_bytes((ROOT / "scripts/python_test_shard.py").read_bytes())
        platform = root / "enterprise-agent-platform"
        tests = platform / "tests"
        tests.mkdir(parents=True)
        package = platform / "enterprise_agent_platform"
        package.mkdir()
        (package / "__init__.py").write_text("VALUE = 17\n")
        (tests / "fixture_helper.py").write_text("VALUE = 25\n")
        (tests / "test_imports.py").write_text(
            "import unittest\n"
            "from pathlib import Path\n"
            "import enterprise_agent_platform\n"
            "import fixture_helper\n\n"
            "class ImportTests(unittest.TestCase):\n"
            "    def test_child(self):\n"
            + test_body
        )
        return subprocess.run(
            [sys.executable, str(runner), "--shard-index", "0", "--shard-count", "1"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )

    def test_runner_imports_sibling_fixtures_and_platform_in_a_real_child(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = self.run_fixture(
                root,
                "        total = enterprise_agent_platform.VALUE + fixture_helper.VALUE\n"
                "        self.assertEqual(total, 42)\n"
                "        Path('child-observation').write_text(str(total))\n",
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(
                (root / "enterprise-agent-platform/child-observation").read_text(),
                "42",
            )

    def test_runner_propagates_a_real_child_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            result = self.run_fixture(
                Path(temporary),
                "        self.fail('real child failure reached')\n",
            )
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("real child failure reached", result.stderr)


if __name__ == "__main__":
    unittest.main()
