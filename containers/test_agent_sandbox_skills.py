"""Tests for the sandbox skills safety net (containers/agent-sandbox-skills.py)."""
import contextlib
import datetime
import importlib.machinery
import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HELPER = Path(__file__).with_name("agent-sandbox-skills.py")
loader = importlib.machinery.SourceFileLoader("agent_sandbox_skills", str(HELPER))
spec = importlib.util.spec_from_loader(loader.name, loader)
skills = importlib.util.module_from_spec(spec)
loader.exec_module(skills)

NOW = datetime.datetime(2026, 10, 13, 8, 30, 0, tzinfo=datetime.timezone.utc)
STAMP = "20261013T083000Z"


def skill_md(name, body="Body."):
    return f'---\nname: "{name}"\ndescription: "Does {name}."\n---\n{body}\n'


class SkillsSafetyNetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.home, self.workspace = root / "home", root / "workspace"
        self.home.mkdir()
        self.workspace.mkdir()
        self.standard = self.workspace / ".agent-platform" / "skills"
        self.archive = self.workspace / ".agent-platform" / "skills-archive"
        self.chowns = []

    def record_chown(self, name, uid, gid, dir_fd=None, follow_symlinks=True):
        self.assertFalse(follow_symlinks, "ownership must never follow links")
        base = os.readlink(f"/proc/self/fd/{dir_fd}")
        self.chowns.append((os.path.join(base, name), uid, gid))

    def record_fchown(self, fd, uid, gid):
        self.chowns.append((os.readlink(f"/proc/self/fd/{fd}"), uid, gid))

    def write(self, path, text="x", mode=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        if mode is not None:
            path.chmod(mode)
        return path

    def skill(self, directory, name=None, **files):
        directory = Path(directory)
        self.write(directory / "SKILL.md", skill_md(name or directory.name))
        for relative, text in files.items():
            self.write(directory / relative, text)
        return directory

    def run_helper(self, profile="agent", uid=4242, gid=4343):
        arguments = ["--profile", profile, "--home", str(self.home), "--workspace", str(self.workspace),
                     "--uid", str(uid), "--gid", str(gid)]
        output = io.StringIO()
        with mock.patch.object(skills.os, "chown", side_effect=self.record_chown), \
                mock.patch.object(skills.os, "fchown", side_effect=self.record_fchown), \
                mock.patch.object(skills.datetime, "datetime", wraps=datetime.datetime) as clock, \
                contextlib.redirect_stdout(output):
            clock.now.return_value = NOW
            self.assertEqual(skills.main(arguments), 0)
        return output.getvalue()

    def tree(self, root):
        root = Path(root)
        return sorted(str(path.relative_to(root)) + ("@" if path.is_symlink() else "") for path in root.rglob("*"))

    # --- foreign directories -------------------------------------------------------------

    def test_free_destination_receives_the_foreign_skill_from_every_source(self):
        self.skill(self.home / ".claude" / "skills" / "one", **{"scripts/a.py": "a"})
        self.skill(self.home / ".codex" / "skills" / "two")
        self.skill(self.home / ".agents" / "skills" / "three")
        self.skill(self.workspace / ".claude" / "skills" / "four")
        self.skill(self.workspace / ".codex" / "skills" / "five")
        self.skill(self.workspace / ".agents" / "skills" / "six")
        self.run_helper()
        for name in ("one", "two", "three", "four", "five", "six"):
            self.assertTrue((self.standard / name / "SKILL.md").is_file(), name)
        self.assertEqual((self.standard / "one" / "scripts" / "a.py").read_text(), "a")

    def test_real_skill_replaces_pointer_stub_for_the_reb_layout(self):
        self.skill(self.home / ".claude" / "skills" / "ubitech-platform", **{"scripts/tool.py": "t", ".git/HEAD": "ref"})
        stub = self.standard / "ubitech-platform"
        self.write(stub / "SKILL.md", skill_md("ubitech-platform", "Install location: /home/agent/.claude/skills/ubitech-platform"))
        self.run_helper()
        self.assertEqual((self.standard / "ubitech-platform" / "scripts" / "tool.py").read_text(), "t")
        self.assertTrue((self.standard / "ubitech-platform" / ".git" / "HEAD").is_file())
        archived = list(self.archive.glob("ubitech-platform-*"))
        self.assertEqual([path.name for path in archived], [f"ubitech-platform-{STAMP}"])
        self.assertIn("Install location", (archived[0] / "SKILL.md").read_text())
        self.assertTrue((self.home / ".claude" / "skills").is_symlink())
        self.assertEqual(sorted(path.name for path in self.standard.iterdir()), ["ubitech-platform"])

    def test_tilde_form_of_the_source_path_identifies_a_stub(self):
        self.skill(self.home / ".codex" / "skills" / "x", **{"real.txt": "r"})
        self.write(self.standard / "x" / "SKILL.md", skill_md("x", "See ~/.codex/skills/x"))
        self.run_helper()
        self.assertTrue((self.standard / "x" / "real.txt").is_file())
        self.assertEqual(len(list(self.archive.glob("x-*"))), 1)

    def test_conflict_archives_the_incoming_skill(self):
        self.skill(self.standard / "plan", **{"mine.txt": "keep"})
        self.skill(self.home / ".claude" / "skills" / "plan", **{"theirs.txt": "incoming"})
        output = self.run_helper()
        self.assertEqual((self.standard / "plan" / "mine.txt").read_text(), "keep")
        self.assertFalse((self.standard / "plan" / "theirs.txt").exists())
        archived = self.archive / f"plan-home-claude-{STAMP}"
        self.assertEqual((archived / "theirs.txt").read_text(), "incoming")
        self.assertIn("conflict", output)

    def test_large_or_multi_file_stub_lookalike_is_a_conflict_not_a_stub(self):
        self.skill(self.home / ".claude" / "skills" / "x", **{"incoming.txt": "i"})
        self.write(self.standard / "x" / "SKILL.md", skill_md("x", f"{self.home}/.claude/skills/x"))
        self.write(self.standard / "x" / "extra.txt", "another file")
        self.run_helper()
        self.assertTrue((self.standard / "x" / "extra.txt").is_file())
        self.assertTrue((self.archive / f"x-home-claude-{STAMP}" / "incoming.txt").is_file())

    def test_stub_with_unrelated_text_is_a_conflict(self):
        self.skill(self.home / ".claude" / "skills" / "x")
        self.write(self.standard / "x" / "SKILL.md", skill_md("x", "A tiny but real skill."))
        self.run_helper()
        self.assertIn("tiny but real", (self.standard / "x" / "SKILL.md").read_text())
        self.assertTrue((self.archive / f"x-home-claude-{STAMP}").is_dir())

    def test_non_skill_leftovers_stay_and_block_the_link(self):
        self.skill(self.home / ".claude" / "skills" / "one")
        self.write(self.home / ".claude" / "skills" / "README.md", "notes")
        self.write(self.home / ".claude" / "skills" / "loose" / "data.txt", "no SKILL.md")
        self.run_helper()
        directory = self.home / ".claude" / "skills"
        self.assertFalse(directory.is_symlink())
        self.assertEqual(sorted(path.name for path in directory.iterdir()), ["README.md", "loose"])
        self.assertTrue((self.standard / "one" / "SKILL.md").is_file())

    def test_foreign_symlinks_are_never_followed(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        self.skill(outside / "secret-skill")
        (self.home / ".claude").mkdir()
        (self.home / ".claude" / "skills").symlink_to(outside)
        (self.workspace / ".codex").mkdir()
        (self.workspace / ".codex" / "skills").mkdir()
        (self.workspace / ".codex" / "skills" / "linked").symlink_to(outside / "secret-skill")
        self.run_helper()
        self.assertTrue((outside / "secret-skill" / "SKILL.md").is_file())
        self.assertFalse((self.standard / "secret-skill").exists())
        self.assertFalse((self.standard / "linked").exists())
        self.assertTrue((self.workspace / ".codex" / "skills" / "linked").is_symlink())

    # --- step 3 -------------------------------------------------------------

    def test_links_are_absolute_in_home_relative_in_workspace_and_resolve(self):
        self.skill(self.home / ".claude" / "skills" / "one")
        self.run_helper()
        for name in (".claude", ".codex", ".agents"):
            link = self.home / name / "skills"
            self.assertTrue(link.is_symlink(), link)
            self.assertEqual(os.readlink(link), str(self.standard))
            self.assertEqual(link.resolve(), self.standard.resolve())
            link = self.workspace / name / "skills"
            self.assertTrue(link.is_symlink(), link)
            self.assertEqual(os.readlink(link), "../.agent-platform/skills")
            self.assertEqual(link.resolve(), self.standard.resolve())
        self.assertTrue((self.home / ".claude" / "skills" / "one" / "SKILL.md").is_file())

    def test_empty_foreign_directory_becomes_a_link(self):
        (self.workspace / ".agents" / "skills").mkdir(parents=True)
        self.run_helper()
        self.assertEqual(os.readlink(self.workspace / ".agents" / "skills"), "../.agent-platform/skills")

    def test_install_through_the_link_lands_in_the_standard_directory(self):
        self.run_helper()
        self.skill(self.home / ".claude" / "skills" / "literal")
        self.assertTrue((self.standard / "literal" / "SKILL.md").is_file())

    def test_symlinked_foreign_ancestor_into_the_workspace_leaves_personal_skills_alone(self):
        self.skill(self.standard / "personal", **{"keep.txt": "k"})
        (self.home / ".claude").symlink_to(self.workspace / ".agent-platform")
        self.run_helper()
        self.assertEqual((self.standard / "personal" / "keep.txt").read_text(), "k")
        self.assertFalse(self.archive.exists())
        self.assertEqual(os.readlink(self.home / ".claude"), str(self.workspace / ".agent-platform"))
        self.assertEqual(sorted(path.name for path in self.standard.iterdir()), ["personal"])

    def test_symlinked_intermediate_directory_is_skipped_not_followed(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        self.skill(outside / "skills" / "escape")
        (self.workspace / ".codex").symlink_to(outside)
        self.run_helper()
        self.assertTrue((outside / "skills" / "escape" / "SKILL.md").is_file())
        self.assertFalse((self.standard / "escape").exists())
        self.assertEqual(sorted(path.name for path in outside.iterdir()), ["skills"])
        self.assertTrue((self.workspace / ".codex").is_symlink())

    def test_symlinked_agent_platform_directory_stops_everything(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        (self.workspace / ".agent-platform").symlink_to(outside)
        self.skill(self.home / ".claude" / "skills" / "one")
        output = self.run_helper()
        self.assertEqual(list(outside.iterdir()), [])
        self.assertTrue((self.home / ".claude" / "skills" / "one" / "SKILL.md").is_file())
        self.assertIn("errors=0", output)

    def test_cross_filesystem_move_copies_files_and_links_and_removes_the_source(self):
        self.skill(self.home / ".claude" / "skills" / "one", **{"scripts/a.sh": "#!/bin/sh\n"})
        (self.home / ".claude" / "skills" / "one" / "scripts" / "a.sh").chmod(0o755)
        (self.home / ".claude" / "skills" / "one" / "link").symlink_to("scripts/a.sh")
        real_rename = os.rename

        def rename(source, destination, *, src_dir_fd=None, dst_dir_fd=None):
            if src_dir_fd != dst_dir_fd:
                raise OSError(18, "cross-device")
            return real_rename(source, destination, src_dir_fd=src_dir_fd, dst_dir_fd=dst_dir_fd)

        with mock.patch.object(skills.os, "rename", side_effect=rename):
            self.run_helper()
        moved = self.standard / "one"
        self.assertEqual((moved / "scripts" / "a.sh").stat().st_mode & 0o777, 0o755)
        self.assertEqual(os.readlink(moved / "link"), "scripts/a.sh")
        self.assertEqual([path.name for path in self.standard.iterdir()], ["one"])
        self.assertTrue((self.home / ".claude" / "skills").is_symlink())

    # --- idempotency, ownership, profile --------------------------------------

    def test_second_run_changes_nothing(self):
        self.skill(self.home / ".claude" / "skills" / "one")
        self.skill(self.workspace / ".codex" / "skills" / "two")
        self.write(self.home / ".agents" / "skills" / "leftover.txt", "stay")
        self.run_helper()
        before = (self.tree(self.home), self.tree(self.workspace))
        output = self.run_helper()
        self.assertEqual((self.tree(self.home), self.tree(self.workspace)), before)
        self.assertIn("migrated=0", output)
        self.assertIn("links=0", output)

    def test_everything_the_helper_touches_is_chowned_to_the_agent(self):
        self.skill(self.home / ".claude" / "skills" / "one", **{"scripts/a.py": "a"})
        stub = self.standard / "one"
        self.write(stub / "SKILL.md", skill_md("one", "~/.claude/skills/one"))
        self.run_helper(uid=4242, gid=4343)
        self.assertTrue(self.chowns)
        self.assertEqual({(uid, gid) for _, uid, gid in self.chowns}, {(4242, 4343)})
        chowned = {os.path.realpath(path) for path, _, _ in self.chowns}
        expected = [self.standard / "one", self.standard / "one" / "SKILL.md",
                    self.standard / "one" / "scripts", self.standard / "one" / "scripts" / "a.py",
                    self.archive, next(self.archive.glob("one-*")), next(self.archive.glob("one-*")) / "SKILL.md",
                    self.home / ".codex" / "skills", self.home / ".codex", self.workspace / ".claude" / "skills",
                    self.workspace / ".claude"]
        for path in expected:
            self.assertIn(os.path.realpath(path), chowned, path)

    def test_chat_profile_is_untouched(self):
        self.skill(self.home / ".claude" / "skills" / "one")
        before = (self.tree(self.home), self.tree(self.workspace))
        output = self.run_helper(profile="chat")
        self.assertEqual((self.tree(self.home), self.tree(self.workspace)), before)
        self.assertEqual(output, "")
        self.assertEqual(self.chowns, [])
        self.assertFalse((self.workspace / ".agent-platform").exists())

    def test_missing_profile_is_untouched(self):
        self.run_helper(profile="")
        self.assertFalse((self.workspace / ".agent-platform").exists())

    def test_summary_line_is_printed(self):
        output = self.run_helper()
        self.assertRegex(output, r"agent-platform-skills: migrated=0 archived=0 conflicts=0 links=6 errors=0")


if __name__ == "__main__":
    unittest.main()
