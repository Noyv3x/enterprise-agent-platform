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
        self.git("config", "user.email", "docs-sync@example.invalid")
        self.git("config", "user.name", "Docs Sync Test")

    def commit(self, message: str) -> str:
        self.git("add", "--all")
        self.git("commit", "--quiet", "-m", message)
        return self.git("rev-parse", "HEAD")

    @staticmethod
    def manifest() -> dict[str, object]:
        return {
            "version": 1,
            "legacy_top_level_files": ["AGENTS.md", "CLAUDE.md"],
            "coverage": {
                "code_include": [
                    ".gitignore",
                    ".github/**",
                    "deploy.sh",
                    "manager/**",
                    "scripts/**",
                    "src/*.py",
                    "enterprise-agent-platform/pyproject.toml",
                    "enterprise-agent-platform/enterprise_agent_platform/**",
                    "enterprise-agent-platform/agent-runtime/**",
                    "enterprise-agent-platform/camofox-runtime/**",
                    "enterprise-agent-platform/frontend/**",
                ],
                "code_exclude": [
                    "enterprise-agent-platform/agent-runtime/test/**",
                    "enterprise-agent-platform/frontend/src/**/*.test.ts",
                    "enterprise-agent-platform/frontend/src/**/*.test.tsx",
                ],
                "document_include": [
                    "docs/design/*.md",
                    "docs/contracts/*.json",
                    "docs/domains.json",
                ],
                "document_exclude": [],
            },
            "domains": [
                {
                    "id": "documentation-governance",
                    "documents": ["docs/design/governance.md", "docs/domains.json"],
                    "code": ["scripts/**"],
                    "tests": [],
                },
                {
                    "id": "repository-development",
                    "documents": ["docs/design/repository.md"],
                    "code": [".gitignore", ".github/**"],
                    "tests": [],
                },
                {
                    "id": "deployment",
                    "documents": ["docs/design/deployment.md"],
                    "code": ["deploy.sh", "manager/**"],
                    "tests": [],
                },
                {
                    "id": "integrations",
                    "documents": ["docs/design/integrations.md"],
                    "code": [
                        "enterprise-agent-platform/enterprise_agent_platform/upstream_sources_generated.py",
                        "enterprise-agent-platform/enterprise_agent_platform/bundled_skills/**",
                        "enterprise-agent-platform/camofox-runtime/**",
                    ],
                    "tests": [],
                },
                {
                    "id": "platform",
                    "documents": ["docs/design/feature.md"],
                    "code": [
                        "enterprise-agent-platform/pyproject.toml",
                        "src/*.py",
                        "enterprise-agent-platform/enterprise_agent_platform/**/*.py",
                    ],
                    "tests": ["tests/test_feature.py"],
                },
                {
                    "id": "agent-runtime",
                    "documents": ["docs/design/runtime.md"],
                    "code": ["enterprise-agent-platform/agent-runtime/**"],
                    "tests": [],
                },
                {
                    "id": "frontend",
                    "documents": ["docs/design/frontend.md"],
                    "code": ["enterprise-agent-platform/frontend/**"],
                    "tests": [],
                },
            ],
            "contracts": [
                {
                    "id": "container-platform",
                    "source": "docs/contracts/container-platform.json",
                    "domains": ["deployment", "platform", "agent-runtime", "frontend"],
                    "targets": [
                        {
                            "path": "manager/internal/contract/generated.go",
                            "format": "go-container-platform",
                        },
                        {
                            "path": "enterprise-agent-platform/enterprise_agent_platform/container_contract_generated.py",
                            "format": "python-container-platform",
                        },
                        {
                            "path": "enterprise-agent-platform/agent-runtime/src/container-contract.generated.ts",
                            "format": "typescript-container-platform",
                        },
                        {
                            "path": "enterprise-agent-platform/frontend/src/container-contract.generated.ts",
                            "format": "typescript-container-platform",
                        },
                    ],
                },
                {
                    "id": "upstream-sources",
                    "source": "docs/contracts/upstream-sources.json",
                    "domains": ["integrations", "platform"],
                    "targets": [
                        {
                            "path": "enterprise-agent-platform/enterprise_agent_platform/upstream_sources_generated.py",
                            "format": "python-upstream-sources",
                        }
                    ],
                },
                {
                    "id": "runtime-policy",
                    "source": "docs/contracts/runtime-policy.json",
                    "domains": ["platform", "agent-runtime", "frontend"],
                    "targets": [
                        {
                            "path": "enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py",
                            "format": "python-runtime-policy",
                        },
                        {
                            "path": "enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts",
                            "format": "typescript-runtime-policy",
                        },
                        {
                            "path": "enterprise-agent-platform/frontend/src/design-contract.generated.ts",
                            "format": "typescript-runtime-policy",
                        },
                    ],
                }
            ],
        }

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
        }

    @staticmethod
    def manifest_domain(manifest: dict[str, object], identifier: str) -> dict[str, object]:
        return next(
            domain
            for domain in manifest["domains"]  # type: ignore[index]
            if domain["id"] == identifier
        )

    @staticmethod
    def manifest_contract(manifest: dict[str, object], identifier: str) -> dict[str, object]:
        return next(
            contract
            for contract in manifest["contracts"]  # type: ignore[index]
            if contract["id"] == identifier
        )

    def write_fixture(self, manifest: dict[str, object] | None = None) -> None:
        files: dict[str, str] = {
            "docs/domains.json": json.dumps(manifest or self.manifest(), indent=2) + "\n",
            "docs/contracts/runtime-policy.json": json.dumps(self.contract(), indent=2) + "\n",
            "docs/contracts/container-platform.json": json.dumps(
                {
                    "schema_version": 1,
                    "policy": "container-platform",
                    "release_channel": "main",
                    "database_schema_version": 2026072401,
                    "container_paths": {
                        "data_root": "/var/lib/ubitech-agent",
                        "workspace": "/workspace",
                        "agent_home": "/home/agent",
                        "agent_env": "/opt/agent-env",
                    },
                    "execution_targets": ["sandbox", "host"],
                    "sandbox_idle_seconds": 1800,
                    "migration_backup_retention_seconds": 604800,
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
                        "cognee": {
                            "repository_url": "https://example.invalid/cognee.git",
                            "revision": "1" * 40,
                            "required_paths": ["pyproject.toml", "cognee/__init__.py"],
                        },
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
            "docs/design/governance.md": "# Governance\n\nThe documentation policy.\n",
            "docs/design/repository.md": "# Repository\n\nThe repository policy.\n",
            "docs/design/deployment.md": "# Deployment\n\nThe deployment policy.\n",
            "docs/design/integrations.md": "# Integrations\n\nThe integration policy.\n",
            "docs/design/runtime.md": "# Runtime\n\nThe current runtime design.\n",
            "docs/design/frontend.md": "# Frontend\n\nThe current frontend design.\n",
            "docs/README.md": "# Docs\n\n[Feature](design/feature.md)\n",
            "README.md": "# Project\n\n[Docs](docs/README.md)\n",
            "enterprise-agent-platform/README.md": "# Platform\n\n[Docs](../docs/README.md)\n",
            "enterprise-agent-platform/agent-runtime/README.md": "# Runtime\n\n[Docs](../../docs/README.md)\n",
            ".gitignore": "data/\n/cognee/\n/firecrawl/\n",
            ".github/workflows/quality.yml": "name: fixture\n",
            "deploy.sh": "#!/usr/bin/env bash\n",
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

    def ready_repository(self) -> str:
        self.initialize_git()
        self.write_fixture()
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)
        return self.commit("baseline")

    def test_sync_is_deterministic_and_check_rejects_stale_generated_code(self) -> None:
        self.initialize_git()
        self.write_fixture()

        first = self.run_command("sync", expect=0)
        self.assertIn("design_contract_generated.py", first.stdout)
        second = self.run_command("sync", expect=0)
        self.assertIn("already current", second.stdout)

        generated_paths = [
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

    def test_check_rejects_legacy_file_broken_link_and_unmapped_code(self) -> None:
        self.initialize_git()
        self.write_fixture()
        self.run_command("sync", expect=0)

        (self.root / "AGENTS.md").write_text("legacy\n", encoding="utf-8")
        legacy = self.run_command("check", expect=1)
        self.assertIn("legacy top-level instruction file is forbidden", legacy.stderr)
        (self.root / "AGENTS.md").unlink()

        feature = self.root / "docs/design/feature.md"
        feature.write_text("# Feature\n\n[Missing](missing.md)\n", encoding="utf-8")
        broken = self.run_command("check", expect=1)
        self.assertIn("broken relative link", broken.stderr)
        feature.write_text("# Feature\n", encoding="utf-8")

        manifest = self.manifest()
        manifest["coverage"]["code_include"].append("unowned/*.py")  # type: ignore[index,union-attr]
        (self.root / "docs/domains.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        (self.root / "unowned").mkdir()
        (self.root / "unowned/new.py").write_text("VALUE = 2\n", encoding="utf-8")
        unmapped = self.run_command("check", expect=1)
        self.assertIn("covered production path has no documentation domain", unmapped.stderr)

    def test_manifest_cannot_remove_legacy_file_guards(self) -> None:
        self.initialize_git()
        self.write_fixture()
        manifest = self.manifest()
        manifest["legacy_top_level_files"] = ["CLAUDE.md"]
        (self.root / "docs/domains.json").write_text(
            json.dumps(manifest, indent=2) + "\n",
            encoding="utf-8",
        )
        result = self.run_command("sync", expect=1)
        self.assertIn("must permanently forbid: agents.md", result.stderr)

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

    def test_check_change_requires_documentation_for_code(self) -> None:
        base = self.ready_repository()
        source = self.root / "src/main.py"
        source.write_text("VALUE = 2\n", encoding="utf-8")
        head = self.commit("code only")
        result = self.run_command("check-change", "--base", base, "--head", head, expect=1)
        self.assertIn("code changed in domain platform", result.stderr)

    def test_check_change_requires_implementation_for_documentation(self) -> None:
        base = self.ready_repository()
        document = self.root / "docs/design/feature.md"
        document.write_text("# Feature\n\nA changed design.\n", encoding="utf-8")
        head = self.commit("docs only")
        result = self.run_command("check-change", "--base", base, "--head", head, expect=1)
        self.assertIn("canonical documentation changed in domain platform", result.stderr)

    def test_check_change_accepts_paired_change(self) -> None:
        base = self.ready_repository()
        (self.root / "docs/design/feature.md").write_text("# Feature\n\nVersion two.\n", encoding="utf-8")
        (self.root / "src/main.py").write_text("VALUE = 2\n", encoding="utf-8")
        head = self.commit("paired")
        self.run_command("check-change", "--base", base, "--head", head, expect=0)

    def test_contract_change_passes_after_generated_targets_are_synchronized(self) -> None:
        base = self.ready_repository()
        contract = self.contract()
        contract["max_turns_per_run"]["default"] = 91  # type: ignore[index]
        contract_path = self.root / "docs/contracts/runtime-policy.json"
        contract_path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")

        stale = self.run_command("check", expect=1)
        self.assertIn("generated contract target is stale", stale.stderr)
        self.run_command("sync", expect=0)
        head = self.commit("update contract")
        self.run_command("check-change", "--base", base, "--head", head, expect=0)

    def test_check_change_supports_staged_unstaged_and_untracked_worktree_files(self) -> None:
        base = self.ready_repository()
        source = self.root / "src/main.py"
        source.write_text("VALUE = 2\n", encoding="utf-8")
        self.git("add", "src/main.py")
        document = self.root / "docs/design/feature.md"
        document.write_text("# Feature\n\nWorktree design.\n", encoding="utf-8")
        (self.root / "notes.txt").write_text("untracked and outside coverage\n", encoding="utf-8")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "WORKTREE",
            expect=0,
        )
        self.assertIn("documentation and code changes are synchronized", result.stdout)

    def test_worktree_check_cannot_hide_staged_code_with_an_unstaged_revert(self) -> None:
        base = self.ready_repository()
        source = self.root / "src/main.py"
        source.write_text("VALUE = 2\n", encoding="utf-8")
        self.git("add", "src/main.py")
        source.write_text("VALUE = 1\n", encoding="utf-8")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "WORKTREE",
            expect=1,
        )
        self.assertIn("code changed in domain platform", result.stderr)

    def test_index_check_excludes_unstaged_documentation(self) -> None:
        base = self.ready_repository()
        source = self.root / "src/main.py"
        source.write_text("VALUE = 2\n", encoding="utf-8")
        self.git("add", "src/main.py")
        (self.root / "docs/design/feature.md").write_text(
            "# Feature\n\nUnstaged design.\n",
            encoding="utf-8",
        )

        index = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "INDEX",
            expect=1,
        )
        self.assertIn("code changed in domain platform", index.stderr)
        self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "WORKTREE",
            expect=0,
        )

        help_result = self.run_command("check-change", "--help", expect=0)
        self.assertIn("INDEX", help_result.stdout)

    def test_index_check_reads_staged_legacy_file_after_worktree_deletion(self) -> None:
        base = self.ready_repository()
        legacy = self.root / "AGENTS.md"
        legacy.write_text("staged legacy instructions\n", encoding="utf-8")
        self.git("add", "AGENTS.md")
        legacy.unlink()

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "INDEX",
            expect=1,
        )
        self.assertIn("legacy top-level instruction file is forbidden", result.stderr)

    def test_index_check_reads_staged_manifest_after_worktree_repair(self) -> None:
        base = self.ready_repository()
        manifest_path = self.root / "docs/domains.json"
        original = manifest_path.read_text(encoding="utf-8")
        manifest_path.write_text("{ invalid staged JSON\n", encoding="utf-8")
        self.git("add", "docs/domains.json")
        manifest_path.write_text(original, encoding="utf-8")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "INDEX",
            expect=1,
        )
        self.assertIn("documentation manifest is not valid JSON", result.stderr)

    def test_index_check_reads_staged_generated_code_after_worktree_repair(self) -> None:
        base = self.ready_repository()
        generated = (
            self.root
            / "enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py"
        )
        original = generated.read_text(encoding="utf-8")
        generated.write_text(original + "# staged stale output\n", encoding="utf-8")
        self.git("add", generated.relative_to(self.root).as_posix())
        generated.write_text(original, encoding="utf-8")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "INDEX",
            expect=1,
        )
        self.assertIn("generated contract target is stale", result.stderr)

    def test_index_snapshot_tolerates_legacy_gitlink_outside_owned_tree(self) -> None:
        base = self.ready_repository()
        self.git("update-index", "--add", "--cacheinfo", "160000", base, "cognee")

        self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "INDEX",
            expect=0,
        )

    def test_index_snapshot_rejects_staged_parent_symlink_after_worktree_repair(self) -> None:
        base = self.ready_repository()
        generated = (
            self.root
            / "enterprise-agent-platform/frontend/src/design-contract.generated.ts"
        )
        original = generated.read_text(encoding="utf-8")
        container_generated = generated.with_name("container-contract.generated.ts")
        container_original = container_generated.read_text(encoding="utf-8")
        generated.unlink()
        container_generated.unlink()
        generated.parent.rmdir()
        generated.parent.symlink_to("../redirected-src", target_is_directory=True)
        self.git("add", "-A", "enterprise-agent-platform/frontend/src")

        generated.parent.unlink()
        generated.parent.mkdir()
        generated.write_text(original, encoding="utf-8")
        container_generated.write_text(container_original, encoding="utf-8")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "INDEX",
            expect=1,
        )
        self.assertIn("must not use symlinks", result.stderr)

    def test_index_snapshot_rejects_staged_symlink_loop_without_crashing(self) -> None:
        base = self.ready_repository()
        generated = (
            self.root
            / "enterprise-agent-platform/frontend/src/design-contract.generated.ts"
        )
        original = generated.read_text(encoding="utf-8")
        generated.unlink()
        generated.symlink_to(generated.name)
        self.git("add", generated.relative_to(self.root).as_posix())

        generated.unlink()
        generated.write_text(original, encoding="utf-8")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "INDEX",
            expect=1,
        )
        self.assertIn("could not safely resolve repository-relative path", result.stderr)

    def test_commit_check_uses_merge_base_and_policy_base_for_bootstrap(self) -> None:
        self.initialize_git()
        (self.root / "src").mkdir(parents=True)
        source = self.root / "src/main.py"
        source.write_text("VALUE = 1\n", encoding="utf-8")
        before_docs = self.commit("before docs")
        policy_branch = self.git("branch", "--show-current")

        self.git("checkout", "--quiet", "-b", "topic", before_docs)
        source.write_text("VALUE = 2\n", encoding="utf-8")
        topic_head = self.commit("topic code only")

        self.git("checkout", "--quiet", policy_branch)
        self.write_fixture()
        self.run_command("sync", expect=0)
        policy_base = self.commit("install documentation policy")

        result = self.run_command(
            "check-change",
            "--base",
            policy_base,
            "--head",
            topic_head,
            expect=1,
        )
        self.assertNotIn("bootstrap detected", result.stdout)
        self.assertIn("code changed in domain platform", result.stderr)

    def test_rename_out_of_coverage_still_reports_the_deleted_code_path(self) -> None:
        base = self.ready_repository()
        self.git("mv", "src/main.py", "renamed.txt")
        head = self.commit("rename code out of coverage")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            head,
            expect=1,
        )
        self.assertIn("code changed in domain platform", result.stderr)
        self.assertIn("src/main.py", result.stderr)

    def test_code_change_requires_documents_for_every_matching_domain(self) -> None:
        self.initialize_git()
        manifest = self.manifest()
        runtime = self.manifest_domain(manifest, "agent-runtime")
        runtime["code"].append("src/shared.py")
        self.write_fixture(manifest)
        (self.root / "src/shared.py").write_text("SHARED = 1\n", encoding="utf-8")
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)
        base = self.commit("overlapping domains")

        (self.root / "src/shared.py").write_text("SHARED = 2\n", encoding="utf-8")
        head = self.commit("shared code only")
        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            head,
            expect=1,
        )
        self.assertIn("code changed in domain platform", result.stderr)
        self.assertIn("code changed in domain agent-runtime", result.stderr)

    def test_committed_manifest_cannot_exclude_code_in_the_same_diff(self) -> None:
        base = self.ready_repository()
        manifest_path = self.root / "docs/domains.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["coverage"]["code_exclude"].append("src/main.py")
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        (self.root / "src/main.py").write_text("VALUE = 2\n", encoding="utf-8")
        (self.root / "scripts/policy.py").write_text("POLICY = False\n", encoding="utf-8")
        head = self.commit("try to exclude changed code")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            head,
            expect=1,
        )
        self.assertIn("code changed in domain platform", result.stderr)
        self.assertIn("src/main.py", result.stderr)

    def test_historical_v1_manifest_does_not_require_current_invariants(self) -> None:
        self.initialize_git()
        legacy_manifest = {
            "version": 1,
            "legacy_top_level_files": ["AGENTS.md", "CLAUDE.md"],
            "coverage": {
                "code_include": ["src/*.py"],
                "code_exclude": [],
                "document_include": ["docs/design/*.md"],
                "document_exclude": [],
            },
            "domains": [
                {
                    "id": "feature",
                    "documents": ["docs/design/feature.md"],
                    "code": ["src/*.py"],
                    "tests": [],
                }
            ],
            "contracts": [],
        }
        for relative, content in {
            "docs/domains.json": json.dumps(legacy_manifest, indent=2) + "\n",
            "docs/design/feature.md": "# Feature\n\nThe current feature design.\n",
            "src/main.py": "VALUE = 1\n",
            "src/keep.py": "KEEP = True\n",
        }.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        legacy_base = self.commit("legacy v1 documentation policy")

        self.write_fixture()
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)
        current_head = self.commit("current documentation policy")
        self.run_command(
            "check-change",
            "--base",
            legacy_base,
            "--head",
            current_head,
            expect=0,
        )

    def test_worktree_manifest_cannot_delete_an_existing_domain_owner(self) -> None:
        self.initialize_git()
        manifest = self.manifest()
        runtime = self.manifest_domain(manifest, "agent-runtime")
        runtime["code"].append("src/shared.py")  # type: ignore[union-attr]
        self.write_fixture(manifest)
        (self.root / "src/shared.py").write_text("SHARED = 1\n", encoding="utf-8")
        self.run_command("sync", expect=0)
        self.run_command("check", expect=0)
        base = self.commit("overlapping owner baseline")

        manifest_path = self.root / "docs/domains.json"
        updated = json.loads(manifest_path.read_text(encoding="utf-8"))
        updated_runtime = self.manifest_domain(updated, "agent-runtime")
        updated_runtime["code"].remove("src/shared.py")  # type: ignore[union-attr]
        manifest_path.write_text(json.dumps(updated, indent=2) + "\n", encoding="utf-8")
        (self.root / "src/shared.py").write_text("SHARED = 2\n", encoding="utf-8")
        (self.root / "docs/design/feature.md").write_text(
            "# Feature\n\nShared implementation changed.\n",
            encoding="utf-8",
        )
        (self.root / "scripts/policy.py").write_text("POLICY = False\n", encoding="utf-8")

        result = self.run_command(
            "check-change",
            "--base",
            base,
            "--head",
            "WORKTREE",
            expect=1,
        )
        self.assertIn("code changed in domain agent-runtime", result.stderr)
        self.assertIn("src/shared.py", result.stderr)

    def test_current_tree_does_not_count_deleted_code_or_test_files(self) -> None:
        self.ready_repository()
        (self.root / "src/main.py").unlink()
        (self.root / "src/keep.py").unlink()
        (self.root / "tests/test_feature.py").unlink()

        result = self.run_command("check", expect=1)
        self.assertIn("code pattern matches no covered production files: src/*.py", result.stderr)
        self.assertIn("test pattern matches no files: tests/test_feature.py", result.stderr)

    def test_entry_readmes_are_link_checked(self) -> None:
        self.ready_repository()
        (self.root / "README.md").write_text("# Project\n\n[Missing](missing.md)\n", encoding="utf-8")

        result = self.run_command("check", expect=1)
        self.assertIn("README.md has a broken relative link", result.stderr)

    def test_manifest_and_canonical_documents_reject_symlinks(self) -> None:
        self.ready_repository()
        manifest_path = self.root / "docs/domains.json"
        manifest_copy = self.root / "manifest-copy.json"
        manifest_copy.write_text(manifest_path.read_text(encoding="utf-8"), encoding="utf-8")
        manifest_path.unlink()
        manifest_path.symlink_to(manifest_copy)
        manifest_result = self.run_command("check", expect=1)
        self.assertIn("documentation manifest must not use symlinks", manifest_result.stderr)

        manifest_path.unlink()
        manifest_path.write_text(manifest_copy.read_text(encoding="utf-8"), encoding="utf-8")
        document = self.root / "docs/design/feature.md"
        document_copy = self.root / "feature-copy.md"
        document_copy.write_text(document.read_text(encoding="utf-8"), encoding="utf-8")
        document.unlink()
        document.symlink_to(document_copy)
        document_result = self.run_command("check", expect=1)
        self.assertIn("document must not use symlinks", document_result.stderr)

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

    def test_manifest_requires_minimum_owned_coverage(self) -> None:
        self.initialize_git()
        manifest = self.manifest()
        manifest["coverage"]["code_include"].remove(".gitignore")  # type: ignore[index]
        self.write_fixture(manifest)

        result = self.run_command("sync", expect=1)
        self.assertIn("coverage must include owned production probes", result.stderr)
        self.assertIn(".gitignore", result.stderr)

    def test_manifest_probes_require_their_design_domain_owners(self) -> None:
        self.initialize_git()
        manifest = self.manifest()
        runtime = self.manifest_domain(manifest, "agent-runtime")
        runtime["code"] = [
            "enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts"
        ]
        self.write_fixture(manifest)

        result = self.run_command("sync", expect=1)
        self.assertIn("owned production probe", result.stderr)
        self.assertIn("agent-runtime/package-lock.json", result.stderr)
        self.assertIn("agent-runtime", result.stderr)

    def test_manifest_keeps_documents_sources_and_targets_in_their_categories(self) -> None:
        self.initialize_git()
        manifest = self.manifest()
        platform = self.manifest_domain(manifest, "platform")
        platform["documents"][0] = "README.md"  # type: ignore[index]
        self.write_fixture(manifest)
        outside_docs = self.run_command("sync", expect=1)
        self.assertIn("documents must stay under docs/", outside_docs.stderr)

        manifest = self.manifest()
        self.manifest_contract(manifest, "runtime-policy")["source"] = "docs/runtime-policy.json"
        self.write_fixture(manifest)
        outside_contracts = self.run_command("sync", expect=1)
        self.assertIn("source must stay under docs/contracts/", outside_contracts.stderr)

        manifest = self.manifest()
        manifest["coverage"]["code_exclude"].append(  # type: ignore[index]
            "enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py"
        )
        self.write_fixture(manifest)
        uncovered_target = self.run_command("sync", expect=1)
        self.assertIn("contract target must be covered production code", uncovered_target.stderr)

        manifest = self.manifest()
        platform = self.manifest_domain(manifest, "platform")
        platform["tests"].append("docs/design/feature.md")  # type: ignore[union-attr]
        self.write_fixture(manifest)
        masquerading_document = self.run_command("sync", expect=1)
        self.assertIn("canonical document cannot masquerade", masquerading_document.stderr)

    def test_contract_target_owner_and_document_coverage_are_enforced(self) -> None:
        self.initialize_git()
        manifest = self.manifest()
        manifest["domains"].append(  # type: ignore[union-attr]
            {
                "id": "observer",
                "documents": ["docs/design/observer.md"],
                "code": [
                    "enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py"
                ],
                "tests": [],
            }
        )
        self.write_fixture(manifest)
        outside_owner = self.run_command("sync", expect=1)
        self.assertIn("is owned outside contract runtime-policy", outside_owner.stderr)

        manifest = self.manifest()
        manifest["coverage"]["document_include"].remove("docs/contracts/*.json")  # type: ignore[index]
        self.write_fixture(manifest)
        uncovered_source = self.run_command("sync", expect=1)
        self.assertIn("contract source must be covered", uncovered_source.stderr)

    def test_runtime_policy_domains_and_targets_are_fixed(self) -> None:
        self.initialize_git()
        manifest = self.manifest()
        self.manifest_contract(manifest, "runtime-policy")["domains"] = ["platform", "agent-runtime"]
        self.write_fixture(manifest)
        domains = self.run_command("sync", expect=1)
        self.assertIn("runtime-policy domains must be exactly", domains.stderr)

        manifest = self.manifest()
        self.manifest_contract(manifest, "runtime-policy")["targets"][0]["path"] = "src/generated.py"  # type: ignore[index]
        self.write_fixture(manifest)
        targets = self.run_command("sync", expect=1)
        self.assertIn("runtime-policy targets and formats must match", targets.stderr)

    def test_upstream_source_contract_rejects_floating_or_credentialed_sources(self) -> None:
        self.initialize_git()
        self.write_fixture()
        path = self.root / "docs/contracts/upstream-sources.json"
        contract = json.loads(path.read_text(encoding="utf-8"))
        contract["sources"]["cognee"]["revision"] = "main"
        path.write_text(json.dumps(contract), encoding="utf-8")
        floating = self.run_command("sync", expect=1)
        self.assertIn("40-character commit SHA", floating.stderr)

        contract["sources"]["cognee"]["revision"] = "1" * 40
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

    def test_each_code_and_test_pattern_must_match_a_real_corresponding_file(self) -> None:
        self.initialize_git()
        manifest = self.manifest()
        platform = self.manifest_domain(manifest, "platform")
        platform["code"].append("src/missing.py")  # type: ignore[union-attr]
        platform["tests"].append("tests/test_missing.py")  # type: ignore[union-attr]
        self.write_fixture(manifest)
        self.run_command("sync", expect=0)

        result = self.run_command("check", expect=1)
        self.assertIn("code pattern matches no covered production files: src/missing.py", result.stderr)
        self.assertIn("test pattern matches no files: tests/test_missing.py", result.stderr)

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

    def test_first_manifest_commit_is_a_bootstrap(self) -> None:
        self.initialize_git()
        (self.root / "src").mkdir(parents=True)
        (self.root / "src/main.py").write_text("VALUE = 1\n", encoding="utf-8")
        base = self.commit("before docs")

        self.write_fixture()
        self.run_command("sync", expect=0)
        head = self.commit("bootstrap docs")
        result = self.run_command("check-change", "--base", base, "--head", head, expect=0)
        self.assertIn("bootstrap detected", result.stdout)


if __name__ == "__main__":
    unittest.main()
