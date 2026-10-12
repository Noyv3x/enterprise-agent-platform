#!/usr/bin/env python3
"""Skills safety net run by the sandbox entrypoint (agent profile only).

Users paste install instructions written for other products, so skills end up
in ~/.claude/skills, ~/.codex/skills, .agents/skills and similar places the
platform never discovers. At container start, as root and before the agent
command runs, this helper

1. moves skills found in foreign skill directories into
   ``/workspace/.agent-platform/skills`` (replacing a pointer stub, archiving
   the loser of any conflict under ``skills-archive``);
2. turns now-absent or empty foreign skill directories into symlinks to the
   standard directory, so literal installs land in the right place.

It is idempotent and never deletes user content: anything displaced is moved to
``skills-archive`` (never discovered) and non-skill leftovers stay where they
are.

HOME and the workspace are agent-controlled and this runs as root, so no path
is ever resolved by name through a link. Every walk starts at a trusted root
opened with O_NOFOLLOW and descends one component at a time with
O_NOFOLLOW|O_DIRECTORY; a source whose path crosses any symlink is skipped
whole. Every mutation (mkdir, rename, symlink, chown, rmdir, copy) is relative
to those directory file descriptors, never following links, so a component
replaced concurrently cannot redirect root outside the intended tree.
"""
from __future__ import annotations

import argparse
import datetime
import errno
import os
import re
import shutil
import stat
import sys
from collections.abc import Sequence

STANDARD = ".agent-platform/skills"
ARCHIVE = ".agent-platform/skills-archive"
FOREIGN = (".claude/skills", ".codex/skills", ".agents/skills")
STUB_MAX_BYTES = 4096
HOME_ALIAS = "/home/agent"
WORKSPACE_ALIAS = "/workspace"
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC


def normalize(name: str) -> str:
    """The Agent Skills name form: [a-z0-9]+(-[a-z0-9]+)*, at most 64 chars."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:64].strip("-")


def frontmatter_name(text: str) -> str | None:
    """The top-level ``name`` of SKILL.md frontmatter, without a YAML parser."""
    lines = text.lstrip("\ufeff").splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            return None
        match = re.match(r"name\s*:\s*(.*?)\s*$", line)
        if match:
            value = match.group(1)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            return value or None
    return None


def lstat_at(dir_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except OSError:
        return None


def open_dir_at(dir_fd: int, name: str) -> int | None:
    """Open a real child directory; None for absent, links and non-directories."""
    try:
        return os.open(name, DIR_FLAGS, dir_fd=dir_fd)
    except OSError:
        return None


def read_file_at(dir_fd: int, name: str, limit: int) -> bytes | None:
    try:
        descriptor = os.open(name, FILE_FLAGS, dir_fd=dir_fd)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            return None
        return os.read(descriptor, limit)
    finally:
        os.close(descriptor)


def is_skill_dir(dir_fd: int, name: str) -> bool:
    """A real directory holding a real SKILL.md file."""
    child = open_dir_at(dir_fd, name)
    if child is None:
        return False
    try:
        info = lstat_at(child, "SKILL.md")
        return info is not None and stat.S_ISREG(info.st_mode)
    finally:
        os.close(child)


class Run:
    def __init__(self, home: str, workspace: str, uid: int, gid: int, now: datetime.datetime):
        self.home = home.rstrip("/") or "/"
        self.workspace = workspace.rstrip("/") or "/"
        self.uid, self.gid = uid, gid
        self.stamp = now.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self.standard_path = os.path.join(self.workspace, STANDARD)
        self.counts = {"migrated": 0, "archived": 0, "conflicts": 0, "links": 0, "errors": 0}
        self.standard_fd = -1
        self.archive_parent_fd = -1

    def log(self, message: str) -> None:
        print(f"agent-platform-skills: {message}", flush=True)

    # --- ownership and directory-fd primitives -----------------------------

    def chown_at(self, dir_fd: int, name: str) -> None:
        try:
            os.chown(name, self.uid, self.gid, dir_fd=dir_fd, follow_symlinks=False)
        except OSError as error:
            self.log(f"cannot chown {name}: {error}")

    def chown_fd(self, fd: int) -> None:
        try:
            os.fchown(fd, self.uid, self.gid)
        except OSError as error:
            self.log(f"cannot chown directory: {error}")

    def chown_tree(self, dir_fd: int, name: str) -> None:
        self.chown_at(dir_fd, name)
        child = open_dir_at(dir_fd, name)
        if child is None:
            return
        try:
            self._chown_contents(child)
        finally:
            os.close(child)

    def _chown_contents(self, fd: int) -> None:
        for entry in list(os.scandir(fd)):
            self.chown_at(fd, entry.name)
            if entry.is_dir(follow_symlinks=False):
                child = open_dir_at(fd, entry.name)
                if child is not None:
                    try:
                        self._chown_contents(child)
                    finally:
                        os.close(child)

    def open_chain(self, root_fd: int, parts: Sequence[str], create: bool) -> int | None:
        """Descend from root_fd one real directory at a time; None when any
        component is absent (and not created), a link or not a directory."""
        current = os.dup(root_fd)
        for part in parts:
            child = open_dir_at(current, part)
            if child is None and create and lstat_at(current, part) is None:
                try:
                    os.mkdir(part, 0o755, dir_fd=current)
                except FileExistsError:
                    pass
                except OSError as error:
                    self.log(f"cannot create {part}: {error}")
                    os.close(current)
                    return None
                else:
                    child = open_dir_at(current, part)
                    if child is not None:
                        self.chown_fd(child)
                if child is None:
                    child = open_dir_at(current, part)
            os.close(current)
            if child is None:
                return None
            current = child
        return current

    def free_name(self, dir_fd: int, base: str) -> str:
        candidate, index = base, 1
        while lstat_at(dir_fd, candidate) is not None:
            index += 1
            candidate = f"{base}-{index}"
        return candidate

    def move(self, src_fd: int, src_name: str, dst_fd: int, dst_name: str) -> None:
        """Move a directory tree to a destination that does not exist.

        Rename when possible; across filesystems (HOME and the workspace are
        separate mounts) copy symlinks as links into a temporary sibling,
        rename it into place, then remove the source.
        """
        try:
            os.rename(src_name, dst_name, src_dir_fd=src_fd, dst_dir_fd=dst_fd)
            return
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
        temporary = self.free_name(dst_fd, f".skills-move-{os.getpid()}")
        try:
            self._copy_tree(src_fd, src_name, dst_fd, temporary)
            os.rename(temporary, dst_name, src_dir_fd=dst_fd, dst_dir_fd=dst_fd)
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True, dir_fd=dst_fd)
            raise
        shutil.rmtree(src_name, dir_fd=src_fd)

    def _copy_tree(self, src_fd: int, src_name: str, dst_fd: int, dst_name: str) -> None:
        source = open_dir_at(src_fd, src_name)
        if source is None:
            raise OSError(errno.ENOTDIR, f"{src_name} is not a real directory")
        try:
            os.mkdir(dst_name, stat.S_IMODE(os.fstat(source).st_mode), dir_fd=dst_fd)
            destination = open_dir_at(dst_fd, dst_name)
            if destination is None:
                raise OSError(errno.ENOTDIR, f"{dst_name} was replaced")
            try:
                for entry in list(os.scandir(source)):
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        os.symlink(os.readlink(entry.name, dir_fd=source), entry.name, dir_fd=destination)
                    elif stat.S_ISDIR(info.st_mode):
                        self._copy_tree(source, entry.name, destination, entry.name)
                    elif stat.S_ISREG(info.st_mode):
                        self._copy_file(source, entry.name, destination, info)
                    else:
                        raise OSError(errno.EINVAL, f"unsupported file type: {entry.name}")
            finally:
                os.close(destination)
        finally:
            os.close(source)

    def _copy_file(self, src_fd: int, name: str, dst_fd: int, info: os.stat_result) -> None:
        reader = os.open(name, FILE_FLAGS, dir_fd=src_fd)
        try:
            writer = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             stat.S_IMODE(info.st_mode), dir_fd=dst_fd)
            try:
                while chunk := os.read(reader, 1 << 20):
                    view = memoryview(chunk)
                    while view:
                        view = view[os.write(writer, view):]
                os.fchmod(writer, stat.S_IMODE(info.st_mode))
            finally:
                os.close(writer)
        finally:
            os.close(reader)

    def archive_move(self, src_fd: int, name: str, label: str) -> str | None:
        archive = self.open_chain(self.archive_parent_fd, ["skills-archive"], create=True)
        if archive is None:
            self.log("cannot open skills-archive; leaving the skill in place")
            return None
        try:
            destination = self.free_name(archive, f"{label}-{self.stamp}")
            self.move(src_fd, name, archive, destination)
            self.chown_tree(archive, destination)
        finally:
            os.close(archive)
        self.counts["archived"] += 1
        return f"{self.workspace}/{ARCHIVE}/{destination}"

    # --- step 1: foreign skill directories ---------------------------------

    def sources(self, home_fd: int | None, workspace_fd: int | None):
        for fd, base, alias in ((home_fd, self.home, HOME_ALIAS), (workspace_fd, self.workspace, WORKSPACE_ALIAS)):
            if fd is None:
                continue
            for relative in FOREIGN:
                yield fd, base, relative, alias

    def is_pointer_stub(self, dir_fd: int, name: str, references: tuple[str, ...]) -> bool:
        """A SKILL.md under 4 KB, alone in its directory, naming the real source."""
        directory = open_dir_at(dir_fd, name)
        if directory is None:
            return False
        try:
            if os.listdir(directory) != ["SKILL.md"]:
                return False
            info = lstat_at(directory, "SKILL.md")
            if info is None or not stat.S_ISREG(info.st_mode) or info.st_size >= STUB_MAX_BYTES:
                return False
            data = read_file_at(directory, "SKILL.md", STUB_MAX_BYTES)
        finally:
            os.close(directory)
        if data is None:
            return False
        text = data.decode("utf-8", "replace")
        return any(reference in text for reference in references)

    def migrate_foreign_directories(self, home_fd: int | None, workspace_fd: int | None) -> None:
        for base_fd, _, relative, alias in self.sources(home_fd, workspace_fd):
            parts = tuple(relative.split("/"))
            directory = self.open_chain(base_fd, parts, create=False)
            if directory is None:  # absent, or a link somewhere on the path
                continue
            label = ("home-" if base_fd == home_fd else "workspace-") + parts[0].lstrip(".")
            try:
                for entry in sorted(os.listdir(directory)):
                    if not is_skill_dir(directory, entry):
                        continue
                    try:
                        self.migrate_one(label, directory, entry, relative, alias)
                    except Exception as error:  # one broken skill must not stop the rest
                        self.counts["errors"] += 1
                        self.log(f"cannot migrate {alias}/{relative}/{entry}: {error}")
                if not os.listdir(directory):
                    parent = self.open_chain(base_fd, parts[:-1], create=False)
                    if parent is not None:
                        try:
                            os.rmdir(parts[-1], dir_fd=parent)
                        except OSError as error:
                            self.log(f"cannot remove {alias}/{relative}: {error}")
                        finally:
                            os.close(parent)
            finally:
                os.close(directory)

    def migrate_one(self, label: str, directory: int, entry: str, relative: str, alias: str) -> None:
        skill = open_dir_at(directory, entry)
        if skill is None:
            return
        try:
            declared = read_file_at(skill, "SKILL.md", 65536)
        finally:
            os.close(skill)
        name = normalize(entry) or normalize(frontmatter_name((declared or b"").decode("utf-8", "replace")) or "")
        if not name:
            self.log(f"skipping {alias}/{relative}/{entry}: no usable skill name")
            return
        shown = f"{alias}/{relative}/{entry}"
        references = tuple(reference for reference in (shown, f"~/{relative}/{entry}" if alias == HOME_ALIAS else "") if reference)
        destination = f"{self.workspace}/{STANDARD}/{name}"
        if lstat_at(self.standard_fd, name) is None:
            self.move(directory, entry, self.standard_fd, name)
            self.chown_tree(self.standard_fd, name)
            self.counts["migrated"] += 1
            self.log(f"migrated {shown} to {destination}")
            return
        if self.is_pointer_stub(self.standard_fd, name, references):
            stub = self.archive_move(self.standard_fd, name, name)
            if stub is None:
                return
            try:
                self.move(directory, entry, self.standard_fd, name)
            except BaseException:
                archive = self.open_chain(self.archive_parent_fd, ["skills-archive"], create=False)
                if archive is not None:
                    try:
                        os.rename(os.path.basename(stub), name, src_dir_fd=archive, dst_dir_fd=self.standard_fd)
                        self.counts["archived"] -= 1
                    finally:
                        os.close(archive)
                raise
            self.chown_tree(self.standard_fd, name)
            self.counts["migrated"] += 1
            self.log(f"migrated {shown} to {destination}; pointer stub archived at {stub}")
            return
        archived = self.archive_move(directory, entry, f"{name}-{label}")
        if archived is not None:
            self.counts["conflicts"] += 1
            self.log(f"conflict: {destination} exists; incoming {shown} archived at {archived}")

    # --- step 2: links -------------------------------------------------------

    def link_foreign_directories(self, home_fd: int | None, workspace_fd: int | None) -> None:
        for base_fd, _, relative, alias in self.sources(home_fd, workspace_fd):
            parts = tuple(relative.split("/"))
            parent = self.open_chain(base_fd, parts[:-1], create=True)
            if parent is None:  # a link (or file) on the path: never touch it
                continue
            try:
                name = parts[-1]
                info = lstat_at(parent, name)
                if info is not None:
                    if not stat.S_ISDIR(info.st_mode):
                        continue  # an existing link or file is the user's
                    child = open_dir_at(parent, name)
                    if child is None:
                        continue
                    try:
                        if os.listdir(child):
                            continue
                    finally:
                        os.close(child)
                    os.rmdir(name, dir_fd=parent)
                if alias == HOME_ALIAS:
                    target = self.standard_path
                else:
                    target = "../" * (len(parts) - 1) + STANDARD
                os.symlink(target, name, dir_fd=parent)
                self.chown_at(parent, name)
                self.counts["links"] += 1
            except OSError as error:
                self.counts["errors"] += 1
                self.log(f"cannot link {alias}/{relative}: {error}")
            finally:
                os.close(parent)

    def run(self) -> None:
        home_fd = self.open_root(self.home)
        workspace_fd = self.open_root(self.workspace)
        try:
            if workspace_fd is not None:
                self.archive_parent_fd = self.open_chain(workspace_fd, [".agent-platform"], create=True) or -1
                if self.archive_parent_fd >= 0:
                    self.standard_fd = self.open_chain(self.archive_parent_fd, ["skills"], create=True) or -1
                if self.standard_fd < 0:
                    self.log(f"{self.workspace}/.agent-platform/skills is unavailable; nothing to do")
            if self.standard_fd >= 0:
                for step in (self.migrate_foreign_directories, self.link_foreign_directories):
                    try:
                        step(home_fd, workspace_fd)
                    except Exception as error:
                        self.counts["errors"] += 1
                        self.log(f"{step.__name__} failed: {error}")
        finally:
            for fd in (home_fd, workspace_fd, self.standard_fd, self.archive_parent_fd):
                if fd is not None and fd >= 0:
                    os.close(fd)
        self.log(" ".join(f"{key}={value}" for key, value in self.counts.items()))

    def open_root(self, path: str) -> int | None:
        try:
            return os.open(path, DIR_FLAGS)
        except OSError as error:
            self.log(f"cannot open {path}: {error}")
            return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", default="")
    parser.add_argument("--home", default=HOME_ALIAS)
    parser.add_argument("--workspace", default=WORKSPACE_ALIAS)
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--gid", type=int, required=True)
    args = parser.parse_args(argv)
    if args.profile != "agent":
        # Chat sandboxes have no skills directory; leave them untouched.
        return 0
    Run(args.home, args.workspace, args.uid, args.gid, datetime.datetime.now(datetime.timezone.utc)).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
