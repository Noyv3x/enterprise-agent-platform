from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "verify_target_baseline_source.py"
SPEC = importlib.util.spec_from_file_location("verify_target_baseline_source", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
gate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gate
SPEC.loader.exec_module(gate)


class TargetBaselineSourceTreeGateTests(unittest.TestCase):
    def make_tree(self, stage: str = "cleanup") -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        contract = root / "docs/contracts/release-transition.json"
        contract.parent.mkdir(parents=True)
        contract.write_text(json.dumps({"stage": stage}) + "\n", encoding="utf-8")
        for configured in gate.SCAN_ROOTS:
            path = root / configured
            if Path(configured).suffix or Path(configured).name == "install.sh":
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("target_only = true\n", encoding="utf-8")
            else:
                path.mkdir(parents=True, exist_ok=True)
        return temporary, root

    def test_bridge_skips_without_requiring_target_roots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            contract = root / "contract.json"
            contract.write_text('{"stage":"bridge"}\n', encoding="utf-8")
            result = gate.verify_source_tree(root, gate.read_stage(contract))
            self.assertTrue(result.skipped)
            self.assertEqual(result.scanned_files, 0)

    def test_cleanup_and_target_baseline_accept_closed_target_tree(self) -> None:
        for stage in ("cleanup", "target_baseline"):
            temporary, root = self.make_tree(stage)
            with temporary:
                result = gate.verify_source_tree(root, gate.read_stage(root / "docs/contracts/release-transition.json"))
                self.assertFalse(result.skipped)
                self.assertGreater(result.scanned_files, 0)

    def test_forbidden_marker_in_production_has_no_migration_exemption(self) -> None:
        temporary, root = self.make_tree()
        with temporary:
            migration = root / "enterprise-agent-platform/enterprise_agent_platform/db.py"
            migration.write_text('historical = "ubitech-agent-v1"\n', encoding="utf-8")
            with self.assertRaisesRegex(gate.SourceTreeGateError, "ubitech-agent-v1"):
                gate.verify_source_tree(root, "cleanup")

    def test_each_source_capability_category_is_rejected(self) -> None:
        examples = (
            "UBITECH_MANAGER_SOCKET",
            "ubitech-manager-linux-amd64",
            "namespace_handoff",
            "release-transition",
            "P1_SOURCE_HANDOFF",
            "AgentRuntimeP1Inventory",
            '"source_profile"',
        )
        for marker in examples:
            with self.subTest(marker=marker):
                temporary, root = self.make_tree()
                with temporary:
                    path = root / "manager/internal/model/marker.go"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(f'package model\nconst retired = "{marker}"\n', encoding="utf-8")
                    with self.assertRaises(gate.SourceTreeGateError):
                        gate.verify_source_tree(root, "cleanup")

    def test_one_time_module_and_generated_contract_paths_are_rejected(self) -> None:
        for relative in (
            "manager/cmd/handoff-fs-helper/main.go",
            "manager/internal/handoffowner/coordinator_linux.go",
            "manager/internal/contract/release_transition_generated.go",
            "enterprise-agent-platform/enterprise_agent_platform/handoff_evidence.py",
        ):
            with self.subTest(relative=relative):
                temporary, root = self.make_tree()
                with temporary:
                    path = root / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("target only\n", encoding="utf-8")
                    with self.assertRaisesRegex(gate.SourceTreeGateError, "forbidden path"):
                        gate.verify_source_tree(root, "target_baseline")

    def test_historical_test_and_fixture_boundaries_are_not_product_inputs(self) -> None:
        temporary, root = self.make_tree()
        with temporary:
            test_file = root / "manager/internal/model/profile_test.go"
            test_file.parent.mkdir(parents=True, exist_ok=True)
            test_file.write_text('const old = "ubitech-agent-v1"\n', encoding="utf-8")
            testdata = root / "manager/internal/model/testdata/historical.json"
            testdata.parent.mkdir(parents=True, exist_ok=True)
            testdata.write_text('{"profile":"ubitech-agent-v1"}\n', encoding="utf-8")
            fixture = root / "scripts/tests/fixtures/historical-user-data.json"
            fixture.parent.mkdir(parents=True, exist_ok=True)
            fixture.write_text('{"workspace":".ubitech"}\n', encoding="utf-8")
            gate.verify_source_tree(root, "cleanup")

    def test_missing_root_symlink_unknown_type_and_non_utf8_fail_closed(self) -> None:
        temporary, root = self.make_tree()
        with temporary:
            (root / "manager/go.mod").unlink()
            with self.assertRaisesRegex(gate.SourceTreeGateError, "scan root"):
                gate.verify_source_tree(root, "cleanup")

        temporary, root = self.make_tree()
        with temporary:
            target = root / "outside.go"
            target.write_text("package outside\n", encoding="utf-8")
            os.symlink(target, root / "manager/internal/link.go")
            with self.assertRaisesRegex(gate.SourceTreeGateError, "symlink"):
                gate.verify_source_tree(root, "cleanup")

        temporary, root = self.make_tree()
        with temporary:
            (root / "manager/internal/opaque.bin").write_bytes(b"opaque")
            with self.assertRaisesRegex(gate.SourceTreeGateError, "unknown file type"):
                gate.verify_source_tree(root, "cleanup")

        temporary, root = self.make_tree()
        with temporary:
            (root / "manager/internal/invalid.go").write_bytes(b"\xff")
            with self.assertRaisesRegex(gate.SourceTreeGateError, "not UTF-8"):
                gate.verify_source_tree(root, "cleanup")

    def test_quality_and_release_workflows_call_the_same_gate(self) -> None:
        repository = SCRIPT.parents[1]
        quality = (repository / ".github/workflows/quality.yml").read_text(encoding="utf-8")
        release = (repository / ".github/workflows/container-release.yml").read_text(encoding="utf-8")
        invocation = "scripts/verify_target_baseline_source.py"
        self.assertEqual(quality.count(invocation), 1)
        self.assertEqual(release.count(invocation), 1)
        self.assertIn("--contract docs/contracts/release-transition.json", quality)
        self.assertIn("--contract docs/contracts/release-transition.json", release)


if __name__ == "__main__":
    unittest.main()
