from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DOCS_SYNC = REPOSITORY_ROOT / "scripts" / "docs_sync.py"


class DocsSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def run_command(self, *arguments: str, expect: int | None = None) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [sys.executable, str(DOCS_SYNC), *arguments, "--root", str(self.root)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if expect is not None:
            self.assertEqual(result.returncode, expect, result.stdout + result.stderr)
        return result

    def git(self, *arguments: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.root), *arguments],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ).stdout.strip()

    def initialize_git(self) -> None:
        self.git("init", "--quiet")

    @staticmethod
    def contract() -> dict[str, object]:
        return {
            "schema_version": 1,
            "policy": "runtime-policy",
            "run_idle_timeout": {
                "default_seconds": 1800,
                "minimum_seconds": 0,
                "maximum_seconds": 86400,
                "platform_environment_variable": "PLATFORM_IDLE_SECONDS",
                "runtime_environment_variable": "RUNTIME_IDLE_MS",
                "semantics": "Activity refreshes an idle deadline.",
            },
            "max_turns_per_run": {
                "default": 90,
                "minimum": 1,
                "maximum": 1000,
                "runtime_environment_variable": "RUNTIME_MAX_TURNS",
                "semantics": "Turns are bounded independently for each run.",
            },
            "terminal_timeout": {
                "default_milliseconds": 180000,
                "minimum_milliseconds": 100,
                "maximum_milliseconds": 3600000,
                "runtime_environment_variable": "RUNTIME_TERMINAL_TIMEOUT_MS",
                "semantics": "Foreground commands have their own timeout.",
            },
            "process_wait_timeout": {
                "default_milliseconds": 1800000,
                "minimum_milliseconds": 100,
                "maximum_milliseconds": 3600000,
                "semantics": "Wait calls observe a process without stopping it.",
            },
        }

    def write_fixture(self) -> None:
        files: dict[str, str] = {
            "docs/contracts/runtime-policy.json": json.dumps(self.contract(), indent=2) + "\n",
            "docs/contracts/technical-profiles.json": (
                REPOSITORY_ROOT / "docs/contracts/technical-profiles.json"
            ).read_text(encoding="utf-8"),
            "docs/contracts/container-platform.json": (
                REPOSITORY_ROOT / "docs/contracts/container-platform.json"
            ).read_text(encoding="utf-8"),
            "docs/contracts/upstream-sources.json": (
                REPOSITORY_ROOT / "docs/contracts/upstream-sources.json"
            ).read_text(encoding="utf-8"),
            "docs/design/feature.md": "# Feature\n\nThe current feature design.\n",
            "docs/design/repository.md": "# Repository\n\nThe repository policy.\n",
            "docs/design/deployment.md": "# Deployment\n\nThe deployment policy.\n",
            "docs/design/security.md": "# Security\n\nThe security policy.\n",
            "docs/design/integrations.md": "# Integrations\n\nThe integration policy.\n",
            "docs/design/runtime.md": "# Runtime\n\nThe current runtime design.\n",
            "docs/design/frontend.md": "# Frontend\n\nThe current frontend design.\n",
            "docs/README.md": "# Docs\n\n[Feature](design/feature.md)\n",
            "AGENTS.md": "# Agents\n\n[Docs](docs/README.md)\n",
            "README.md": "# Project\n\n[Docs](docs/README.md)\n",
            "enterprise-agent-platform/README.md": "# Platform\n\n[Docs](../docs/README.md)\n",
            "enterprise-agent-platform/agent-runtime/README.md": "# Runtime\n\n[Docs](../../docs/README.md)\n",
            ".gitignore": "data/\n/firecrawl/\n",
            ".github/workflows/quality.yml": "name: fixture\n",
            "scripts/policy.py": "POLICY = True\n",
            "enterprise-agent-platform/pyproject.toml": "[project]\nname = 'fixture'\nversion = '0'\n",
            "enterprise-agent-platform/enterprise_agent_platform/bundled_skills/example/scripts/helper.py": "HELPER = True\n",
            "enterprise-agent-platform/camofox-runtime/patch-runtime.cjs": "module.exports = {};\n",
            "src/main.py": "VALUE = 1\n",
            "src/keep.py": "KEEP = True\n",
            "tests/test_feature.py": "# acceptance test marker\n",
        }
        for relative, content in files.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    def ready_repository(self) -> None:
        self.initialize_git()
        self.write_fixture()
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)
        self.git("add", "--all")

    def test_sync_is_deterministic_and_check_rejects_stale_generated_code(self) -> None:
        self.initialize_git()
        self.write_fixture()

        self.run_command("sync", expect=0)

        generated_paths = [
            self.root / "manager/internal/executor/runtime_policy_generated.go",
            self.root
            / "enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py",
            self.root
            / "enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts",
            self.root
            / "enterprise-agent-platform/frontend/src/design-contract.generated.ts",
        ]
        original = {path: path.read_bytes() for path in generated_paths}
        self.run_command("sync", expect=0)
        self.assertEqual(original, {path: path.read_bytes() for path in generated_paths})
        for path in generated_paths:
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        generated = generated_paths[0]
        generated.write_text(generated.read_text(encoding="utf-8") + "# stale\n", encoding="utf-8")
        self.run_command("check", expect=1)
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)
        self.assertEqual(generated.read_bytes(), original[generated])

        for path in generated_paths:
            path.chmod(0o600)
        self.run_command("check", expect=0)
        self.run_command("sync", expect=0)
        for path in generated_paths:
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)

        generated.chmod(0o755)
        self.run_command("check", expect=1)
        self.run_command("sync", expect=0)

    def test_check_rejects_broken_links_and_missing_heading_anchors(self) -> None:
        self.initialize_git()
        self.write_fixture()
        self.run_command("sync", expect=0)

        feature = self.root / "docs/design/feature.md"
        feature.write_text("# Feature\n\n[Missing](missing.md)\n", encoding="utf-8")
        self.run_command("check", expect=1)

        runtime = self.root / "docs/design/runtime.md"
        runtime.write_text("# Runtime\n\n## 会话与压缩\n\n## Run 状态机\n\n## Run 状态机\n", encoding="utf-8")
        feature.write_text(
            "# Feature\n\n"
            "[ok](runtime.md#会话与压缩) [ok](runtime.md#run-状态机) [dup](runtime.md#run-状态机-1) "
            "[self](#feature) [code](runtime.md)\n",
            encoding="utf-8",
        )
        self.run_command("check", expect=0)

        feature.write_text("# Feature\n\n[gone](runtime.md#会话压缩)\n", encoding="utf-8")
        self.run_command("check", expect=1)

        feature.write_text("# Feature\n\n[self](#nowhere)\n", encoding="utf-8")
        self.run_command("check", expect=1)

        feature.write_text("# Feature\n\n```md\n[fenced](runtime.md#nowhere)\n```\n", encoding="utf-8")
        self.run_command("check", expect=0)

    def test_check_rejects_invalid_contract_bounds(self) -> None:
        self.initialize_git()
        self.write_fixture()
        contract = self.contract()
        contract["max_turns_per_run"]["default"] = 1001  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n",
            encoding="utf-8",
        )
        self.run_command("sync", expect=1)

    def test_technical_profile_consumer_edits_are_regenerated(self) -> None:
        self.ready_repository()
        target = (
            self.root
            / "enterprise-agent-platform/agent-runtime/src/technical-profile.generated.ts"
        )
        original = target.read_bytes()
        target.write_bytes(original + b"// stale\n")
        self.run_command("check", expect=1)
        self.run_command("sync", expect=0)
        self.assertEqual(target.read_bytes(), original)
        self.run_command("check", expect=0)

    def test_container_contract_capacity_change_drives_all_generated_targets(self) -> None:
        self.ready_repository()
        path = self.root / "docs/contracts/container-platform.json"
        original_source = path.read_bytes()
        generated = [
            self.root
            / "enterprise-agent-platform/enterprise_agent_platform/container_contract_generated.py",
            self.root
            / "enterprise-agent-platform/agent-runtime/src/container-contract.generated.ts",
            self.root
            / "enterprise-agent-platform/frontend/src/container-contract.generated.ts",
            self.root / "manager/internal/contract/generated.go",
        ]
        original = {target: target.read_bytes() for target in generated}
        contract = json.loads(original_source)
        contract["managed_image_capacity_estimates"]["agent-runtime"]["compressed_bytes"] = 123_457
        path.write_text(json.dumps(contract), encoding="utf-8")
        self.run_command("check", expect=1)
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)
        for target in generated:
            self.assertNotEqual(target.read_bytes(), original[target])
        path.write_bytes(original_source)
        self.run_command("sync", expect=0)
        self.assertEqual(original, {target: target.read_bytes() for target in generated})


    def test_contract_change_passes_after_generated_targets_are_synchronized(self) -> None:
        self.ready_repository()
        contract = self.contract()
        contract["max_turns_per_run"]["default"] = 91  # type: ignore[index]
        contract_path = self.root / "docs/contracts/runtime-policy.json"
        contract_path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")

        self.run_command("check", expect=1)
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)


    def test_entry_readmes_are_link_checked(self) -> None:
        self.ready_repository()
        (self.root / "README.md").write_text("# Project\n\n[Missing](missing.md)\n", encoding="utf-8")

        self.run_command("check", expect=1)

    def test_contract_sources_and_documents_reject_symlinks(self) -> None:
        self.ready_repository()
        source = self.root / "docs/contracts/runtime-policy.json"
        source_copy = self.root / "runtime-policy-copy.json"
        source_copy.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        source.unlink()
        source.symlink_to(source_copy)
        self.run_command("check", expect=1)

        source.unlink()
        source.write_text(source_copy.read_text(encoding="utf-8"), encoding="utf-8")
        document = self.root / "docs/design/feature.md"
        document_copy = self.root / "feature-copy.md"
        document_copy.write_text(document.read_text(encoding="utf-8"), encoding="utf-8")
        document.unlink()
        document.symlink_to(document_copy)
        self.run_command("check", expect=1)

    def test_sync_never_overwrites_a_generated_target_symlink(self) -> None:
        self.ready_repository()
        target = (
            self.root
            / "enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py"
        )
        victim = self.root / "victim.py"
        victim.write_text("SENTINEL = True\n", encoding="utf-8")
        target.unlink()
        target.symlink_to(victim)

        self.run_command("check", expect=1)
        self.run_command("sync", expect=1)
        self.assertEqual(victim.read_text(encoding="utf-8"), "SENTINEL = True\n")

    def test_generated_targets_reject_non_regular_files_and_symlinked_parents(self) -> None:
        self.ready_repository()
        runtime_target = (
            self.root
            / "enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts"
        )
        runtime_target.unlink()
        runtime_target.mkdir()
        self.run_command("check", expect=1)
        self.run_command("sync", expect=1)

        runtime_target.rmdir()
        self.run_command("sync", expect=0)
        frontend_target = (
            self.root
            / "enterprise-agent-platform/frontend/src/design-contract.generated.ts"
        )
        frontend_parent = frontend_target.parent
        frontend_target.unlink()
        frontend_target.with_name("container-contract.generated.ts").unlink()
        frontend_parent.rmdir()
        redirected_parent = self.root / "redirected-frontend-src"
        redirected_parent.mkdir()
        frontend_parent.symlink_to(redirected_parent, target_is_directory=True)

        self.run_command("sync", expect=1)
        self.assertFalse((redirected_parent / frontend_target.name).exists())

    def test_runtime_contract_requires_positive_guards_and_safe_milliseconds(self) -> None:
        self.initialize_git()
        self.write_fixture()
        invalid_values = [
            ("max_turns_per_run", "minimum", 0),
            ("terminal_timeout", "minimum_milliseconds", 0),
            ("process_wait_timeout", "minimum_milliseconds", 0),
            ("run_idle_timeout", "maximum_seconds", ((1 << 53) - 1) // 1000 + 1),
            ("max_turns_per_run", "maximum", 1 << 53),
            ("terminal_timeout", "default_milliseconds", 1 << 53),
            ("terminal_timeout", "maximum_milliseconds", 2_147_483_648),
            ("process_wait_timeout", "maximum_milliseconds", 2_147_483_648),
        ]
        for section, field, value in invalid_values:
            with self.subTest(section=section, field=field, value=value):
                contract = self.contract()
                contract[section][field] = value  # type: ignore[index]
                if section == "terminal_timeout" and field == "default_milliseconds":
                    contract[section]["maximum_milliseconds"] = value  # type: ignore[index]
                (self.root / "docs/contracts/runtime-policy.json").write_text(
                    json.dumps(contract), encoding="utf-8"
                )
                self.run_command("sync", expect=1)

if __name__ == "__main__":
    unittest.main()
