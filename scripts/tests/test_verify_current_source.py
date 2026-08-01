from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "verify_current_source.py"
SPEC = importlib.util.spec_from_file_location("verify_current_source", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
gate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gate
SPEC.loader.exec_module(gate)


class CurrentSourceTreeGateTests(unittest.TestCase):
    def make_tree(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        for configured in gate.SOURCE_ROOTS:
            path = root / configured
            if Path(configured).suffix or Path(configured).name == "install.sh":
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("current = true\n", encoding="utf-8")
            else:
                path.mkdir(parents=True, exist_ok=True)
        return temporary, root

    def test_accepts_current_source_tree(self) -> None:
        temporary, root = self.make_tree()
        with temporary:
            self.assertGreater(gate.verify_source_tree(root), 0)

    def test_rejects_retired_marker_and_executable_path(self) -> None:
        temporary, root = self.make_tree()
        with temporary:
            marker = root / "manager/internal/model/identity.go"
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text('package model\nconst old = "ubitech-agent-v1"\n', encoding="utf-8")
            with self.assertRaisesRegex(gate.SourceTreeGateError, "retired technical identity"):
                gate.verify_source_tree(root)

        temporary, root = self.make_tree()
        with temporary:
            retired = root / "manager/cmd/ubitech-manager/main.go"
            retired.parent.mkdir(parents=True, exist_ok=True)
            retired.write_text("package main\n", encoding="utf-8")
            with self.assertRaisesRegex(gate.SourceTreeGateError, "retired executable path"):
                gate.verify_source_tree(root)

    def test_allows_historical_test_data(self) -> None:
        temporary, root = self.make_tree()
        with temporary:
            fixture = root / "manager/internal/model/testdata/history.json"
            fixture.parent.mkdir(parents=True, exist_ok=True)
            fixture.write_text('{"profile":"ubitech-agent-v1"}\n', encoding="utf-8")
            gate.verify_source_tree(root)

    def test_missing_root_and_symlink_fail_closed(self) -> None:
        temporary, root = self.make_tree()
        with temporary:
            (root / "manager/go.mod").unlink()
            with self.assertRaisesRegex(gate.SourceTreeGateError, "source root"):
                gate.verify_source_tree(root)

        temporary, root = self.make_tree()
        with temporary:
            target = root / "outside.go"
            target.write_text("package outside\n", encoding="utf-8")
            os.symlink(target, root / "manager/internal/link.go")
            with self.assertRaisesRegex(gate.SourceTreeGateError, "symlink"):
                gate.verify_source_tree(root)


if __name__ == "__main__":
    unittest.main()
