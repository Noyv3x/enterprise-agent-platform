from __future__ import annotations

import errno
import hashlib
import os
import stat
from pathlib import Path


class UnsafePrivatePathError(RuntimeError):
    """A private path could not be traversed without crossing a trust boundary."""


def _directory_open_flags() -> int:
    required = ("O_DIRECTORY", "O_NOFOLLOW")
    if any(not hasattr(os, name) for name in required):
        raise RuntimeError("secure directory traversal is unsupported on this platform")
    return (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )


def _private_file_open_flags() -> int:
    if not hasattr(os, "O_NOFOLLOW"):
        raise RuntimeError("secure file creation is unsupported on this platform")
    return (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )


def _validate_directory_fd(fd: int, *, require_owner: bool, display: str) -> os.stat_result:
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        raise UnsafePrivatePathError(f"private path component is not a directory: {display}")
    if require_owner and hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise UnsafePrivatePathError(
            f"private path component is not owned by the service user: {display}"
        )
    return info


def _open_directory_at(
    parent_fd: int,
    name: str,
    *,
    require_owner: bool,
    display: str,
) -> int:
    try:
        fd = os.open(name, _directory_open_flags(), dir_fd=parent_fd)
    except OSError as exc:
        if exc.errno in {errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM}:
            raise UnsafePrivatePathError(
                f"private path component is unsafe: {display}"
            ) from exc
        raise
    try:
        _validate_directory_fd(fd, require_owner=require_owner, display=display)
        return fd
    except BaseException:
        os.close(fd)
        raise


def _open_private_root(root: Path) -> int:
    """Open an absolute workspace root without following any path component."""

    root = root.expanduser()
    if not root.is_absolute() or root == Path(root.anchor) or ".." in root.parts:
        raise UnsafePrivatePathError("private root must be a scoped absolute directory")
    current_fd = os.open(root.anchor, _directory_open_flags())
    try:
        root_parts = root.parts[1:]
        traversed: list[str] = []
        for index, part in enumerate(root_parts):
            traversed.append(part)
            next_fd = _open_directory_at(
                current_fd,
                part,
                require_owner=index == len(root_parts) - 1,
                display=str(Path(root.anchor).joinpath(*traversed)),
            )
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except BaseException:
        os.close(current_fd)
        raise


def _open_private_child_directory(parent_fd: int, name: str, *, display: str) -> int:
    try:
        return _open_directory_at(
            parent_fd,
            name,
            require_owner=True,
            display=display,
        )
    except FileNotFoundError:
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            # A concurrent creator won. Re-open it without following links and
            # validate the inode before using it.
            pass
        fd = _open_directory_at(
            parent_fd,
            name,
            require_owner=True,
            display=display,
        )
        os.fchmod(fd, 0o700)
        return fd


def _open_private_file_at(parent_fd: int, name: str) -> int:
    """Open the final leaf relative to an already trusted directory fd."""

    return os.open(name, _private_file_open_flags(), 0o600, dir_fd=parent_fd)


def _unlink_matching_file_at(
    parent_fd: int,
    name: str,
    created: os.stat_result,
) -> None:
    """Remove only the directory entry that still names our created inode."""

    probe_flags = getattr(os, "O_PATH", os.O_RDONLY)
    probe_flags |= os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    if not hasattr(os, "O_PATH"):
        probe_flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        probe_fd = os.open(name, probe_flags, dir_fd=parent_fd)
    except OSError:
        return
    try:
        current = os.fstat(probe_fd)
    finally:
        os.close(probe_fd)
    if (current.st_dev, current.st_ino) != (created.st_dev, created.st_ino):
        return
    try:
        os.unlink(name, dir_fd=parent_fd)
    except OSError:
        return


def write_private_file_below_exclusive(root: Path, relative: Path, data: bytes) -> None:
    """Create a private file below ``root`` using only pinned directory fds.

    The workspace root and every untrusted path segment are opened with
    ``O_NOFOLLOW``. Missing directories are created relative to their already
    trusted parent, and the final file is created relative to the pinned leaf
    directory so a concurrent path replacement cannot redirect the write.
    """

    relative = Path(relative)
    parts = relative.parts
    if (
        relative.is_absolute()
        or not parts
        or any(
            part in {"", ".", ".."}
            or "/" in part
            or "\\" in part
            or "\x00" in part
            for part in parts
        )
    ):
        raise UnsafePrivatePathError("private destination must be a safe relative path")

    root_fd = _open_private_root(Path(root))
    parent_fd = root_fd
    file_fd = -1
    created_info: os.stat_result | None = None
    try:
        for index, part in enumerate(parts[:-1]):
            next_fd = _open_private_child_directory(
                parent_fd,
                part,
                display="/".join(parts[: index + 1]),
            )
            if parent_fd != root_fd:
                os.close(parent_fd)
            parent_fd = next_fd

        file_fd = _open_private_file_at(parent_fd, parts[-1])
        created_info = os.fstat(file_fd)
        if not stat.S_ISREG(created_info.st_mode):
            raise UnsafePrivatePathError("private destination is not a regular file")
        if hasattr(os, "getuid") and created_info.st_uid != os.getuid():
            raise UnsafePrivatePathError(
                "private destination is not owned by the service user"
            )
        os.fchmod(file_fd, 0o600)
        remaining = memoryview(data)
        while remaining:
            written = os.write(file_fd, remaining)
            if written <= 0:
                raise OSError("private file write made no progress")
            remaining = remaining[written:]
        os.fsync(file_fd)
        os.fsync(parent_fd)
    except BaseException:
        if created_info is not None:
            _unlink_matching_file_at(parent_fd, parts[-1], created_info)
        raise
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        if parent_fd != root_fd:
            os.close(parent_fd)
        os.close(root_fd)


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


def copy_private_file_exclusive(
    source: Path,
    destination: Path,
    *,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
    chunk_bytes: int = 64 * 1024,
) -> tuple[int, str]:
    """Stream one owner-only regular file into a new owner-only file.

    Both paths are opened without following symlinks. The destination is
    removed on every failed or incomplete copy so callers never observe a
    partially committed attachment blob.
    """

    read_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        read_flags |= os.O_NOFOLLOW
    source_fd = os.open(str(source), read_flags)
    try:
        source_info = os.fstat(source_fd)
        if not stat.S_ISREG(source_info.st_mode):
            raise RuntimeError(f"private source file must be regular: {source}")
        if hasattr(os, "getuid") and source_info.st_uid != os.getuid():
            raise RuntimeError(f"private source file is not owned by the service user: {source}")
        if expected_size is not None and source_info.st_size != int(expected_size):
            raise RuntimeError(f"private source file size changed: {source}")

        write_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            write_flags |= os.O_NOFOLLOW
        destination_fd = os.open(str(destination), write_flags, 0o600)
        try:
            digest = hashlib.sha256()
            total = 0
            with os.fdopen(source_fd, "rb") as source_handle:
                source_fd = -1
                with os.fdopen(destination_fd, "wb") as destination_handle:
                    destination_fd = -1
                    while True:
                        chunk = source_handle.read(max(1, int(chunk_bytes)))
                        if not chunk:
                            break
                        destination_handle.write(chunk)
                        digest.update(chunk)
                        total += len(chunk)
                    if expected_size is not None and total != int(expected_size):
                        raise RuntimeError(f"private source file size changed while reading: {source}")
                    actual_sha256 = digest.hexdigest()
                    if expected_sha256 and actual_sha256 != str(expected_sha256).lower():
                        raise RuntimeError(f"private source file content changed: {source}")
                    destination_handle.flush()
                    os.fsync(destination_handle.fileno())
            return total, actual_sha256
        except BaseException:
            if destination_fd >= 0:
                os.close(destination_fd)
            try:
                destination.unlink()
            except OSError:
                pass
            raise
    finally:
        if source_fd >= 0:
            os.close(source_fd)


def tighten_sqlite_files(path: Path) -> None:
    """Tighten SQLite's database and sidecar files when they exist."""

    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        ensure_private_file(candidate)
