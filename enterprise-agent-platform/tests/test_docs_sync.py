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
            "docs/contracts/container-platform.json": json.dumps(
                {
                    "schema_version": 2,
                    "policy": "container-platform",
                    "release_channel": "main",
                    "database_schema_version": 2026072401,
                    "container_paths": {
                        "data_root": "/var/lib/agent-platform",
                        "workspace": "/workspace",
                        "agent_home": "/home/agent",
                        "agent_env": "/opt/agent-env",
                    },
                    "execution_targets": ["sandbox", "host"],
                    "persistent_data_owners": {
                        "searxng": [],
                        "firecrawl-redis": [
                            {"uid": 999, "gid": 0},
                            {"uid": 999, "gid": 1000},
                        ],
                        "firecrawl-rabbitmq": [
                            {"uid": 999, "gid": 0},
                            {"uid": 999, "gid": 999},
                        ],
                        "firecrawl-postgres": [
                            {"uid": 999, "gid": 0},
                            {"uid": 999, "gid": 999},
                        ],
                    },
                    "sandbox_idle_seconds": 1800,
                    "migration_backup_retention_seconds": 604800,
                    "obsolete_artifact_retention_seconds": 3600,
                    "update_pre_download_min_free_bytes": 8589934592,
                    "update_pre_cutover_min_free_bytes": 2147483648,
                    "update_min_free_inodes": 4096,
                    "managed_image_capacity_estimates": {
                        "agent-sandbox": {
                            "compressed_bytes": 4294967296,
                            "unpacked_bytes": 8589934592,
                        },
                        "platform": {
                            "compressed_bytes": 8589934592,
                            "unpacked_bytes": 17179869184,
                        },
                        "agent-runtime": {
                            "compressed_bytes": 4294967296,
                            "unpacked_bytes": 8589934592,
                        },
                        "camofox": {
                            "compressed_bytes": 4294967296,
                            "unpacked_bytes": 8589934592,
                        },
                        "searxng": {
                            "compressed_bytes": 2147483648,
                            "unpacked_bytes": 4294967296,
                        },
                        "firecrawl-api": {
                            "compressed_bytes": 8589934592,
                            "unpacked_bytes": 17179869184,
                        },
                        "firecrawl-playwright": {
                            "compressed_bytes": 8589934592,
                            "unpacked_bytes": 17179869184,
                        },
                        "firecrawl-postgres": {
                            "compressed_bytes": 2147483648,
                            "unpacked_bytes": 4294967296,
                        },
                        "firecrawl-redis": {
                            "compressed_bytes": 1073741824,
                            "unpacked_bytes": 2147483648,
                        },
                        "firecrawl-rabbitmq": {
                            "compressed_bytes": 1073741824,
                            "unpacked_bytes": 2147483648,
                        },
                    },
                    "public_update_states": [
                        "idle",
                        "waiting_for_tasks",
                        "updating",
                        "failed",
                    ],
                    "operations": ["install", "update", "restart", "rollback", "repair"],
                    "operation_phases": [
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
                    ],
                },
                indent=2,
            )
            + "\n",
            "docs/contracts/upstream-sources.json": json.dumps(
                {
                    "schema_version": 1,
                    "sources": {
                        "firecrawl": {
                            "repository_url": "https://example.invalid/firecrawl.git",
                            "revision": "2" * 40,
                            "required_paths": ["docker-compose.yaml"],
                            "compose_services": ["api", "redis"],
                        },
                    },
                },
                indent=2,
            )
            + "\n",
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

        first = self.run_command("sync", expect=0)
        self.assertIn("design_contract_generated.py", first.stdout)
        second = self.run_command("sync", expect=0)
        self.assertIn("already current", second.stdout)

        generated_paths = [
            self.root / "manager/internal/executor/runtime_policy_generated.go",
            self.root
            / "enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py",
            self.root
            / "enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts",
            self.root
            / "enterprise-agent-platform/frontend/src/design-contract.generated.ts",
        ]
        for path in generated_paths:
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        generated = generated_paths[0]
        generated.write_text(generated.read_text(encoding="utf-8") + "# stale\n", encoding="utf-8")
        stale = self.run_command("check", expect=1)
        self.assertIn("generated contract target is stale", stale.stderr)
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)

        for path in generated_paths:
            path.chmod(0o600)
        self.run_command("check", expect=0)
        self.run_command("sync", expect=0)
        for path in generated_paths:
            self.assertEqual(path.stat().st_mode & 0o777, 0o644)

        generated.chmod(0o755)
        executable = self.run_command("check", expect=1)
        self.assertIn("target must not be executable", executable.stderr)
        self.run_command("sync", expect=0)

    def test_check_rejects_broken_links_and_missing_heading_anchors(self) -> None:
        self.initialize_git()
        self.write_fixture()
        self.run_command("sync", expect=0)

        feature = self.root / "docs/design/feature.md"
        feature.write_text("# Feature\n\n[Missing](missing.md)\n", encoding="utf-8")
        broken = self.run_command("check", expect=1)
        self.assertIn("broken relative link", broken.stderr)

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
        missing = self.run_command("check", expect=1)
        self.assertIn("missing heading anchor: runtime.md#会话压缩", missing.stderr)

        feature.write_text("# Feature\n\n[self](#nowhere)\n", encoding="utf-8")
        self_missing = self.run_command("check", expect=1)
        self.assertIn("missing heading anchor: #nowhere", self_missing.stderr)

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
        result = self.run_command("sync", expect=1)
        self.assertIn("0 <= minimum <= default <= maximum", result.stderr)

    def test_technical_profiles_are_closed_and_generate_minimal_consumers(self) -> None:
        self.initialize_git()
        self.write_fixture()
        self.run_command("sync", expect=0)

        go_projection = (
            self.root
            / "manager/internal/identity/technical_profiles_generated.go"
        ).read_text(encoding="utf-8")
        python_projection = (
            self.root
            / "enterprise-agent-platform/enterprise_agent_platform/technical_profile_generated.py"
        ).read_text(encoding="utf-8")
        runtime_projection = (
            self.root
            / "enterprise-agent-platform/agent-runtime/src/technical-profile.generated.ts"
        ).read_text(encoding="utf-8")
        self.assertIn('ManagerBinary:              "agent-platform-manager"', go_projection)
        self.assertIn("'database_baseline_name': 'agent-platform-container-baseline-v1'", python_projection)
        self.assertIn(
            'TARGET_MANAGER_EXECUTOR_SOCKET_PATH = "/run/agent-platform-manager/manager.sock"',
            runtime_projection,
        )
        self.assertNotIn("repository", runtime_projection)
        self.assertNotIn("module", runtime_projection)

        runtime_path = (
            self.root
            / "enterprise-agent-platform/agent-runtime/src/technical-profile.generated.ts"
        )
        runtime_path.write_text(runtime_projection + "// stale\n", encoding="utf-8")
        stale = self.run_command("check", expect=1)
        self.assertIn(
            "generated contract target is stale: "
            "enterprise-agent-platform/agent-runtime/src/technical-profile.generated.ts",
            stale.stderr,
        )
        self.run_command("sync", expect=0)

        path = self.root / "docs/contracts/technical-profiles.json"
        contract = json.loads(path.read_text(encoding="utf-8"))
        contract["profiles"]["target"]["unknown"] = True
        path.write_text(json.dumps(contract), encoding="utf-8")
        closed = self.run_command("sync", expect=1)
        self.assertIn("contains unknown keys: unknown", closed.stderr)

    def test_container_contract_rejects_incomplete_image_capacity_estimates(self) -> None:
        self.initialize_git()
        self.write_fixture()
        path = self.root / "docs/contracts/container-platform.json"
        contract = json.loads(path.read_text(encoding="utf-8"))
        del contract["managed_image_capacity_estimates"]["agent-runtime"][
            "unpacked_bytes"
        ]
        path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")
        result = self.run_command("sync", expect=1)
        self.assertIn(
            "must contain exactly compressed_bytes and unpacked_bytes",
            result.stderr,
        )

    def test_container_contract_rejects_unknown_top_level_field(self) -> None:
        self.initialize_git()
        self.write_fixture()
        path = self.root / "docs/contracts/container-platform.json"
        contract = json.loads(path.read_text(encoding="utf-8"))
        contract["unexpected"] = {}
        path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")
        result = self.run_command("sync", expect=1)
        self.assertIn("contains unknown keys: unexpected", result.stderr)

    def test_container_contract_capacity_change_drives_all_generated_targets(self) -> None:
        self.initialize_git()
        self.write_fixture()
        path = self.root / "docs/contracts/container-platform.json"
        contract = json.loads(path.read_text(encoding="utf-8"))
        contract["managed_image_capacity_estimates"]["agent-runtime"][  # type: ignore[index]
            "compressed_bytes"
        ] = 123_457
        path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")

        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)
        generated = {
            "python": self.root
            / "enterprise-agent-platform/enterprise_agent_platform/container_contract_generated.py",
            "runtime": self.root
            / "enterprise-agent-platform/agent-runtime/src/container-contract.generated.ts",
            "frontend": self.root
            / "enterprise-agent-platform/frontend/src/container-contract.generated.ts",
            "go": self.root / "manager/internal/contract/generated.go",
        }
        self.assertIn(
            "'compressed_bytes': 123457",
            generated["python"].read_text(encoding="utf-8"),
        )
        for name in ("runtime", "frontend"):
            self.assertIn(
                '"compressed_bytes": 123457',
                generated[name].read_text(encoding="utf-8"),
            )
        self.assertTrue(
            any(
                "CompressedBytes: 123457" in line
                for line in generated["go"].read_text(encoding="utf-8").splitlines()
            )
        )

    def test_container_contract_requires_exact_ten_image_set(self) -> None:
        self.initialize_git()
        self.write_fixture()
        path = self.root / "docs/contracts/container-platform.json"
        contract = json.loads(path.read_text(encoding="utf-8"))
        contract["managed_image_capacity_estimates"]["extra-image"] = {
            "compressed_bytes": 1,
            "unpacked_bytes": 1,
        }
        path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")
        result = self.run_command("sync", expect=1)
        self.assertIn("exactly the current ten-image set", result.stderr)


    def test_contract_change_passes_after_generated_targets_are_synchronized(self) -> None:
        self.ready_repository()
        contract = self.contract()
        contract["max_turns_per_run"]["default"] = 91  # type: ignore[index]
        contract_path = self.root / "docs/contracts/runtime-policy.json"
        contract_path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")

        stale = self.run_command("check", expect=1)
        self.assertIn("generated contract target is stale", stale.stderr)
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)


    def test_entry_readmes_are_link_checked(self) -> None:
        self.ready_repository()
        (self.root / "README.md").write_text("# Project\n\n[Missing](missing.md)\n", encoding="utf-8")

        result = self.run_command("check", expect=1)
        self.assertIn("README.md has a broken relative link", result.stderr)

    def test_contract_sources_and_documents_reject_symlinks(self) -> None:
        self.ready_repository()
        source = self.root / "docs/contracts/runtime-policy.json"
        source_copy = self.root / "runtime-policy-copy.json"
        source_copy.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        source.unlink()
        source.symlink_to(source_copy)
        source_result = self.run_command("check", expect=1)
        self.assertIn("source must not use symlinks", source_result.stderr)

        source.unlink()
        source.write_text(source_copy.read_text(encoding="utf-8"), encoding="utf-8")
        document = self.root / "docs/design/feature.md"
        document_copy = self.root / "feature-copy.md"
        document_copy.write_text(document.read_text(encoding="utf-8"), encoding="utf-8")
        document.unlink()
        document.symlink_to(document_copy)
        document_result = self.run_command("check", expect=1)
        self.assertIn("documentation file must not be a symlink", document_result.stderr)

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

        checked = self.run_command("check", expect=1)
        self.assertIn("must not use symlinks", checked.stderr)
        synced = self.run_command("sync", expect=1)
        self.assertIn("must not use symlinks", synced.stderr)
        self.assertEqual(victim.read_text(encoding="utf-8"), "SENTINEL = True\n")

    def test_generated_targets_reject_non_regular_files_and_symlinked_parents(self) -> None:
        self.ready_repository()
        runtime_target = (
            self.root
            / "enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts"
        )
        runtime_target.unlink()
        runtime_target.mkdir()
        non_regular = self.run_command("check", expect=1)
        self.assertIn("target must be a regular file", non_regular.stderr)
        sync_non_regular = self.run_command("sync", expect=1)
        self.assertIn("target must be a regular file", sync_non_regular.stderr)

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

        parent_result = self.run_command("sync", expect=1)
        self.assertIn("must not use symlinks", parent_result.stderr)
        self.assertFalse((redirected_parent / frontend_target.name).exists())

    def test_upstream_source_contract_rejects_floating_or_credentialed_sources(self) -> None:
        self.initialize_git()
        self.write_fixture()
        self.run_command("sync", expect=0)
        self.assertFalse(
            (
                self.root
                / "enterprise-agent-platform/enterprise_agent_platform/upstream_sources_generated.py"
            ).exists()
        )
        path = self.root / "docs/contracts/upstream-sources.json"
        contract = json.loads(path.read_text(encoding="utf-8"))
        contract["sources"]["firecrawl"]["revision"] = "main"
        path.write_text(json.dumps(contract), encoding="utf-8")
        floating = self.run_command("sync", expect=1)
        self.assertIn("40-character commit SHA", floating.stderr)

        contract["sources"]["firecrawl"]["revision"] = "2" * 40
        contract["sources"]["firecrawl"]["repository_url"] = (
            "https://token@example.invalid/firecrawl.git"
        )
        path.write_text(json.dumps(contract), encoding="utf-8")
        credentialed = self.run_command("sync", expect=1)
        self.assertIn("credential-free HTTPS URL", credentialed.stderr)

        contract["sources"]["firecrawl"]["repository_url"] = (
            "https://example.invalid/firecrawl.git"
        )
        contract["sources"]["firecrawl"]["compose_services"] = ["redis", "api"]
        path.write_text(json.dumps(contract), encoding="utf-8")
        unsorted = self.run_command("sync", expect=1)
        self.assertIn("compose_services must be sorted", unsorted.stderr)

    def test_upstream_source_contract_rejects_extra_sources(self) -> None:
        self.initialize_git()
        self.write_fixture()
        path = self.root / "docs/contracts/upstream-sources.json"
        contract = json.loads(path.read_text(encoding="utf-8"))
        contract["sources"]["unused"] = {
            "repository_url": "https://example.invalid/unused.git",
            "revision": "3" * 40,
            "required_paths": ["README.md"],
        }
        path.write_text(json.dumps(contract), encoding="utf-8")

        invalid = self.run_command("sync", expect=1)
        self.assertIn("sources must be exactly: firecrawl", invalid.stderr)

    def test_runtime_contract_requires_positive_guards_and_safe_milliseconds(self) -> None:
        self.initialize_git()
        self.write_fixture()

        contract = self.contract()
        contract["max_turns_per_run"]["minimum"] = 0  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n", encoding="utf-8"
        )
        turns = self.run_command("sync", expect=1)
        self.assertIn("max_turns_per_run.minimum must be greater than zero", turns.stderr)

        contract = self.contract()
        contract["terminal_timeout"]["minimum_milliseconds"] = 0  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n", encoding="utf-8"
        )
        terminal = self.run_command("sync", expect=1)
        self.assertIn("terminal_timeout.minimum_milliseconds must be greater than zero", terminal.stderr)

        contract = self.contract()
        contract["process_wait_timeout"]["minimum_milliseconds"] = 0  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n", encoding="utf-8"
        )
        process_wait = self.run_command("sync", expect=1)
        self.assertIn(
            "process_wait_timeout.minimum_milliseconds must be greater than zero",
            process_wait.stderr,
        )

        contract = self.contract()
        unsafe_seconds = ((1 << 53) - 1) // 1000 + 1
        contract["run_idle_timeout"]["maximum_seconds"] = unsafe_seconds  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n", encoding="utf-8"
        )
        unsafe = self.run_command("sync", expect=1)
        self.assertIn("safe when converted to JavaScript milliseconds", unsafe.stderr)

        contract = self.contract()
        contract["max_turns_per_run"]["maximum"] = (1 << 53)  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n", encoding="utf-8"
        )
        unsafe_turns = self.run_command("sync", expect=1)
        self.assertIn("max_turns_per_run.maximum must be a JavaScript safe integer", unsafe_turns.stderr)

        contract = self.contract()
        contract["terminal_timeout"]["default_milliseconds"] = (1 << 53)  # type: ignore[index]
        contract["terminal_timeout"]["maximum_milliseconds"] = (1 << 53)  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n", encoding="utf-8"
        )
        unsafe_terminal = self.run_command("sync", expect=1)
        self.assertIn("terminal_timeout.default_milliseconds must be a JavaScript safe integer", unsafe_terminal.stderr)

        contract = self.contract()
        contract["terminal_timeout"]["maximum_milliseconds"] = 2_147_483_648  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n", encoding="utf-8"
        )
        node_timer = self.run_command("sync", expect=1)
        self.assertIn("must not exceed the Node.js timer limit", node_timer.stderr)

        contract = self.contract()
        contract["process_wait_timeout"]["maximum_milliseconds"] = 2_147_483_648  # type: ignore[index]
        (self.root / "docs/contracts/runtime-policy.json").write_text(
            json.dumps(contract, indent=2) + "\n", encoding="utf-8"
        )
        process_wait_timer = self.run_command("sync", expect=1)
        self.assertIn(
            "process_wait_timeout.maximum_milliseconds must not exceed the Node.js timer limit",
            process_wait_timer.stderr,
        )



if __name__ == "__main__":
    unittest.main()
