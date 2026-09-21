from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/release_eligibility.py"


class ReleaseEligibilityTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="release-eligibility-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.root),
            "LANG": "C.UTF-8",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "core.hooksPath",
            "GIT_CONFIG_VALUE_0": "/dev/null",
            "GIT_AUTHOR_NAME": "Release Fixture",
            "GIT_AUTHOR_EMAIL": "release@example.invalid",
            "GIT_COMMITTER_NAME": "Release Fixture",
            "GIT_COMMITTER_EMAIL": "release@example.invalid",
        }
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("config", "core.filemode", "true")
        self.put("README.md", "Published prose\n")
        self.put("app.py", "print('published product')\n")
        self.published = self.commit()

    def git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(self.repo), *args], env=self.env,
            capture_output=True, text=True, timeout=10, check=True,
        )
        return result.stdout.strip()

    def put(self, path: str, text: str = "New content\n") -> Path:
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return target

    def commit(self) -> str:
        self.git("add", "--all")
        self.git("commit", "--quiet", "--allow-empty", "-m", "fixture change")
        return self.git("rev-parse", "HEAD")

    def decision(
        self, source: str, published: str | None = None, *,
        manual: bool = False, repo: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [sys.executable, str(SCRIPT), "--repo", str(repo or self.repo), "--source", source]
        if published is not None:
            command.extend(["--published", published])
        if manual:
            command.append("--manual")
        return subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=10)

    def assert_decision(self, expected: bool, source: str, published: str | None = None, **kwargs) -> None:
        result = self.decision(source, published, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "true\n" if expected else "false\n")

    def assert_rejected(self, source: str, published: str | None = None, **kwargs) -> None:
        result = self.decision(source, published, **kwargs)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "", "invalid evidence must not emit an eligibility decision")

    def test_unpublished_product_survives_a_later_prose_commit(self) -> None:
        self.put("app.py", "print('unpublished product')\n")
        product = self.commit()
        self.put("README.md", "New prose after the product change\n")
        prose = self.commit()
        self.assert_decision(True, prose, self.published)
        self.assert_decision(False, prose, product)
        self.assert_decision(False, prose, prose)

    def test_initial_and_manual_releases_are_required_even_for_unchanged_trees(self) -> None:
        unchanged = self.commit()
        self.assert_decision(True, unchanged)
        self.assert_decision(False, unchanged, self.published)
        self.assert_decision(True, unchanged, self.published, manual=True)
        self.put("README.md", "Prose-only manual recovery\n")
        self.assert_decision(True, self.commit(), self.published, manual=True)

    def test_all_allowlisted_locations_can_be_added_modified_and_deleted(self) -> None:
        for path in (
            "README.md", "AGENTS.md", "docs/README.md", "docs/design/model.md",
            "docs/reference/api.md", "docs/operations/deploy.md",
            "docs/development/local setup.md", "docs/decisions/0001-decision.md",
        ):
            self.put(path)
        additions = self.commit()
        self.assert_decision(False, additions, self.published)
        for path in ("README.md", "AGENTS.md", "docs/reference/api.md"):
            (self.repo / path).unlink()
        self.assert_decision(False, self.commit(), additions)

    def test_unknown_packaged_and_machine_contract_paths_require_release(self) -> None:
        previous = self.published
        for path in (
            "NOTES.md", "docs/extra.md", "docs/design/nested/README.md",
            "docs/contracts/runtime.json", "docs/domains.json",
            "enterprise-agent-platform/README.md",
            "enterprise-agent-platform/bundled_skills/example/SKILL.md",
            "scripts/tests/test_changed.py", ".github/workflows/quality.yml",
        ):
            with self.subTest(path=path):
                self.put(path)
                source = self.commit()
                self.assert_decision(True, source, previous)
                previous = source

    def test_moves_consider_both_sides_not_just_the_prose_destination(self) -> None:
        self.git("config", "diff.renames", "true")
        destination = self.repo / "docs/design/product.md"
        destination.parent.mkdir(parents=True)
        (self.repo / "app.py").rename(destination)
        prose_destination = self.commit()
        self.assert_decision(True, prose_destination, self.published)
        destination.rename(self.repo / "new-product.py")
        self.assert_decision(True, self.commit(), prose_destination)

    def test_moves_between_allowlisted_prose_remain_skippable(self) -> None:
        destination = self.repo / "docs/design/introduction.md"
        destination.parent.mkdir(parents=True)
        (self.repo / "README.md").rename(destination)
        self.assert_decision(False, self.commit(), self.published)

    def test_executable_mode_changes_in_either_direction_require_release(self) -> None:
        readme = self.repo / "README.md"
        readme.chmod(0o755)
        executable = self.commit()
        self.assert_decision(True, executable, self.published)
        readme.chmod(0o644)
        self.assert_decision(True, self.commit(), executable)

    def test_added_or_deleted_executable_prose_requires_release(self) -> None:
        path = self.put("docs/design/executable.md")
        path.chmod(0o755)
        executable = self.commit()
        self.assert_decision(True, executable, self.published)
        path.unlink()
        self.assert_decision(True, self.commit(), executable)

    def test_symlink_addition_change_and_deletion_cannot_be_prose(self) -> None:
        path = self.repo / "AGENTS.md"
        path.symlink_to("README.md")
        added = self.commit()
        self.assert_decision(True, added, self.published)
        path.unlink()
        path.symlink_to("app.py")
        changed = self.commit()
        self.assert_decision(True, changed, added)
        path.unlink()
        self.assert_decision(True, self.commit(), changed)

    def test_regular_prose_and_symlink_type_changes_require_release(self) -> None:
        path = self.repo / "README.md"
        path.unlink()
        path.symlink_to("app.py")
        symlink = self.commit()
        self.assert_decision(True, symlink, self.published)
        path.unlink()
        self.put("README.md", "Regular prose again\n")
        self.assert_decision(True, self.commit(), symlink)

    def test_control_and_undecodable_names_are_not_allowlisted_prose(self) -> None:
        previous = self.published
        for name in ("line\nbreak.md", "tab\tname.md", "delete\x7f.md", "bidi\u202e.md", "invalid\udcff.md"):
            with self.subTest(name=name):
                self.put("docs/design/" + name)
                source = self.commit()
                self.assert_decision(True, source, previous)
                previous = source

    def test_gitlinks_are_not_hidden_by_local_diff_configuration(self) -> None:
        self.git("update-index", "--add", "--cacheinfo", f"160000,{self.published},docs/design/module.md")
        self.git("commit", "--quiet", "-m", "gitlink addition")
        added = self.git("rev-parse", "HEAD")
        self.git("update-index", "--cacheinfo", f"160000,{added},docs/design/module.md")
        self.git("commit", "--quiet", "-m", "gitlink update")
        self.git("config", "diff.ignoreSubmodules", "all")
        self.assert_decision(True, added, self.published)
        self.assert_decision(True, self.git("rev-parse", "HEAD"), added)

    def test_replacement_objects_cannot_hide_product_changes(self) -> None:
        self.put("app.py", "print('actual product change')\n")
        source = self.commit()
        replacement = self.git(
            "commit-tree", self.git("rev-parse", f"{self.published}^{{tree}}"),
            "-p", self.published, "-m", "replacement with unchanged tree",
        )
        self.git("replace", source, replacement)
        self.assert_decision(True, source, self.published)

    def test_invalid_and_non_commit_identities_are_rejected_even_when_manual(self) -> None:
        self.git("tag", "-a", "annotated", "-m", "not a commit identity", self.published)
        for identity in (
            "HEAD", self.published[:12], "A" * 40, "0" * 40,
            self.git("rev-parse", "HEAD:README.md"),
            self.git("rev-parse", "HEAD^{tree}"),
            self.git("rev-parse", "refs/tags/annotated"),
        ):
            with self.subTest(identity=identity):
                self.assert_rejected(identity, self.published, manual=True)
                self.assert_rejected(self.published, identity, manual=True)

    def test_non_ancestor_and_unrelated_generations_are_rejected(self) -> None:
        self.put("README.md", "Later generation\n")
        descendant = self.commit()
        self.assert_rejected(self.published, descendant)
        self.assert_rejected(self.published, descendant, manual=True)
        unrelated = self.git("commit-tree", self.git("rev-parse", "HEAD^{tree}"), "-m", "unrelated root")
        self.assert_rejected(descendant, unrelated)

    def test_missing_history_is_not_a_prose_only_release(self) -> None:
        self.put("README.md", "Shallow clone candidate\n")
        source = self.commit()
        shallow = self.root / "shallow"
        self.git("clone", "--quiet", "--depth=1", self.repo.as_uri(), str(shallow))
        self.assert_rejected(source, self.published, repo=shallow)

    def test_failed_tree_read_never_emits_false(self) -> None:
        self.put("README.md", "Candidate with missing tree\n")
        source = self.commit()
        tree = self.git("rev-parse", "HEAD^{tree}")
        (self.repo / ".git/objects" / tree[:2] / tree[2:]).unlink()
        self.assert_rejected(source, self.published)


if __name__ == "__main__":
    unittest.main()
