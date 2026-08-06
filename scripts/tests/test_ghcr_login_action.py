from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LOGIN_ACTION = ROOT / ".github" / "actions" / "ghcr-login" / "action.yml"
RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "container-release.yml"
PINNED_LOGIN_ACTION = (
    "docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772"
)


class GHCRLoginActionTests(unittest.TestCase):
    def test_login_action_has_three_bounded_attempts(self) -> None:
        source = LOGIN_ACTION.read_text(encoding="utf-8")
        self.assertEqual(source.count(PINNED_LOGIN_ACTION), 3)
        self.assertEqual(source.count("continue-on-error: true"), 2)
        self.assertIn("run: sleep 5", source)
        self.assertIn("run: sleep 15", source)
        self.assertNotIn("packages: write", source)

    def test_release_workflow_uses_the_shared_login_boundary(self) -> None:
        source = RELEASE_WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(source.count("uses: ./.github/actions/ghcr-login"), 2)
        self.assertNotIn(PINNED_LOGIN_ACTION, source)
        self.assertEqual(source.count("token: ${{ secrets.GITHUB_TOKEN }}"), 2)


if __name__ == "__main__":
    unittest.main()
