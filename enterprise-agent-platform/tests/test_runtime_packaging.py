from __future__ import annotations

import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import enterprise_agent_platform.runtimes as runtime_module
from enterprise_agent_platform.runtimes import PlatformRuntimeManager


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _runtime_source_files(root: Path) -> set[str]:
    runtime = root / "agent-runtime"
    files = {
        "README.md",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
    }
    files.update(
        path.relative_to(runtime).as_posix()
        for folder in (runtime / "src", runtime / "test")
        for path in folder.glob("*.ts")
    )
    return files


class AgentRuntimePackagingTests(unittest.TestCase):
    def test_runtime_source_locator_falls_back_to_wheel_data_directory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            installed = root / "share" / "ubitech-agent" / "agent-runtime"
            (installed / "src").mkdir(parents=True)
            for name in ("package.json", "package-lock.json", "tsconfig.json"):
                (installed / name).write_text("{}\n", encoding="utf-8")

            fake_module = root / "lib" / "python3.11" / "site-packages" / "enterprise_agent_platform" / "runtimes.py"
            manager = PlatformRuntimeManager.__new__(PlatformRuntimeManager)
            with (
                mock.patch.object(runtime_module, "__file__", str(fake_module)),
                mock.patch.object(runtime_module.sysconfig, "get_path", return_value=str(root)),
            ):
                source = manager._agent_runtime_source_dir()

            self.assertEqual(source, installed)

    def test_wheel_and_sdist_contain_complete_runtime_build_source(self):
        expected = _runtime_source_files(PROJECT_ROOT)
        self.assertTrue(expected)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source = root / "source"
            source.mkdir()
            for name in ("README.md", "pyproject.toml"):
                shutil.copy2(PROJECT_ROOT / name, source / name)
            shutil.copytree(
                PROJECT_ROOT / "enterprise_agent_platform",
                source / "enterprise_agent_platform",
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
            shutil.copytree(
                PROJECT_ROOT / "agent-runtime",
                source / "agent-runtime",
                ignore=shutil.ignore_patterns(
                    "node_modules", "dist", "coverage", ".cache"
                ),
            )
            shutil.copytree(PROJECT_ROOT / "camofox-runtime", source / "camofox-runtime")

            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    (
                        "from setuptools.build_meta import build_sdist, build_wheel; "
                        "build_sdist('dist'); build_wheel('dist')"
                    ),
                ],
                cwd=source,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            wheel = next((source / "dist").glob("*.whl"))
            with zipfile.ZipFile(wheel) as archive:
                marker = "/share/ubitech-agent/agent-runtime/"
                wheel_files = {
                    name.split(marker, 1)[1]
                    for name in archive.namelist()
                    if marker in name and not name.endswith("/")
                }
            self.assertEqual(wheel_files, expected)
            with zipfile.ZipFile(wheel) as archive:
                camofox_marker = "/share/ubitech-agent/camofox-runtime/"
                camofox_files = {
                    name.split(camofox_marker, 1)[1]
                    for name in archive.namelist()
                    if camofox_marker in name and not name.endswith("/")
                }
            self.assertEqual(
                camofox_files,
                {
                    "package.json",
                    "package-lock.json",
                    "loopback-preload.cjs",
                    "patch-runtime.cjs",
                },
            )

            sdist = next((source / "dist").glob("*.tar.gz"))
            with tarfile.open(sdist, "r:gz") as archive:
                marker = "/agent-runtime/"
                sdist_files = {
                    member.name.split(marker, 1)[1]
                    for member in archive.getmembers()
                    if marker in member.name and member.isfile()
                }
            self.assertTrue(expected.issubset(sdist_files))


if __name__ == "__main__":
    unittest.main()
