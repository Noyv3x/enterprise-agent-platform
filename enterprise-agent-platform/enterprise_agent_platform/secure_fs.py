from __future__ import annotations

import os
import stat
from pathlib import Path


def ensure_private_directory(path: Path) -> Path:
    """Create/validate an owner-only runtime directory.

    Runtime roots must not be symlinks: following one here could redirect
    databases, OAuth state or attachments outside the configured platform data
    tree. Existing permissions are tightened on every start.
    """

    target = path.expanduser()
    try:
        info = target.lstat()
    except FileNotFoundError:
        target.mkdir(parents=True, mode=0o700, exist_ok=False)
        info = target.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise RuntimeError(f"private runtime directory must not be a symlink: {target}")
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"private runtime path is not a directory: {target}")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise RuntimeError(f"private runtime directory is not owned by the service user: {target}")
    target.chmod(0o700)
    return target


def ensure_private_file(path: Path) -> None:
    """Validate an existing owner file and tighten it to mode 0600."""

    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise RuntimeError(f"private runtime file must be a regular non-symlink file: {path}")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise RuntimeError(f"private runtime file is not owned by the service user: {path}")
    path.chmod(0o600)


def write_private_file_exclusive(path: Path, data: bytes) -> None:
    """Create a new owner-only file without following or replacing paths."""

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(str(path), flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise


def tighten_sqlite_files(path: Path) -> None:
    """Tighten SQLite's database and sidecar files when they exist."""

    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        ensure_private_file(candidate)
