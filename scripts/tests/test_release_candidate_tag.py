from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPOSITORY_ROOT / "scripts/ensure-release-candidate-tag.sh"
CANDIDATE = "2" * 40


class ReleaseCandidateTagTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "gh").write_text(
            """#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]]
state="$(cat "$TAG_STATE")"
if [[ "${2:-}" == --method ]]; then
  [[ "${3:-}" == POST ]]
  if [[ "$state" == race ]]; then
    exit 1
  fi
  [[ "$state" == absent ]]
  printf '%s' exact > "$TAG_STATE"
  exit 0
fi
case "$state" in
  absent|race) exit 1 ;;
  exact) printf '{"object":{"type":"commit","sha":"%s"}}\\n' "$EXPECTED_CANDIDATE" ;;
  wrong) printf '{"object":{"type":"commit","sha":"%040d"}}\\n' 9 ;;
  annotated) printf '{"object":{"type":"tag","sha":"%s"}}\\n' "$EXPECTED_CANDIDATE" ;;
  *) exit 90 ;;
esac
""",
            encoding="utf-8",
        )
        (self.bin / "gh").chmod(0o755)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_case(self, state: str) -> subprocess.CompletedProcess[str]:
        state_path = self.root / "state"
        state_path.write_text(state, encoding="utf-8")
        environment = os.environ.copy()
        environment["PATH"] = f"{self.bin}:{environment['PATH']}"
        environment["TAG_STATE"] = str(state_path)
        environment["EXPECTED_CANDIDATE"] = CANDIDATE
        return subprocess.run(
            [str(SCRIPT), "example/agent-platform", CANDIDATE],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )

    def test_missing_tag_is_created_without_replacing_an_existing_ref(self) -> None:
        self.assertEqual(self.run_case("absent").returncode, 0)
        self.assertEqual(self.run_case("exact").returncode, 0)

    def test_wrong_annotated_or_racing_tag_fails_before_visibility(self) -> None:
        for state in ("wrong", "annotated", "race"):
            with self.subTest(state=state):
                self.assertNotEqual(self.run_case(state).returncode, 0)

    def test_untrusted_repository_or_candidate_is_rejected(self) -> None:
        environment = os.environ.copy()
        environment["PATH"] = f"{self.bin}:{environment['PATH']}"
        for repository, candidate in (
            ("../escape", CANDIDATE),
            ("example/agent-platform", "main"),
        ):
            with self.subTest(repository=repository, candidate=candidate):
                result = subprocess.run(
                    [str(SCRIPT), repository, candidate],
                    check=False,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=environment,
                )
                self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
