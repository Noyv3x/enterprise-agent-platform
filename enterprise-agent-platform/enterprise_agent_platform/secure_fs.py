from __future__ import annotations

import ctypes
import errno
import hashlib
import os
import stat
from pathlib import Path
from typing import Final


_PRIVATE_FILE_MODE: Final = 0o600


class UnsafePrivatePathError(RuntimeError):
    """A private path could not be traversed without crossing a trust boundary."""


class PrivatePublicationCommittedError(UnsafePrivatePathError):
    """A publication effect is exact, but its durability/cleanup call failed.

    The first caller must still observe the error.  The pinned identity lets the
    owning state machine advance only its in-memory observation, so a later
    retry can reconcile the already-published object without reclassifying an
    unrelated pathname as its own effect.
    """

    def __init__(self, message: str, published_identity: tuple[int, int]):
        super().__init__(message)
        self.published_identity = published_identity


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


def _require_private_identity(
    info: os.stat_result,
    *,
    kind: str,
    mode: int | None,
    display: str,
    link_count: int | None = None,
) -> None:
    if kind == "directory":
        valid_kind = stat.S_ISDIR(info.st_mode)
    elif kind == "file":
        valid_kind = stat.S_ISREG(info.st_mode)
    else:  # pragma: no cover - internal programming error
        raise ValueError(f"unknown private path kind: {kind}")
    if not valid_kind:
        raise UnsafePrivatePathError(f"private {kind} has an unsafe type: {display}")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise UnsafePrivatePathError(f"private {kind} has an unsafe owner: {display}")
    if hasattr(os, "getgid") and info.st_gid != os.getgid():
        raise UnsafePrivatePathError(f"private {kind} has an unsafe group: {display}")
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise UnsafePrivatePathError(f"private {kind} has an unsafe mode: {display}")
    if link_count is not None and info.st_nlink != link_count:
        raise UnsafePrivatePathError(
            f"private {kind} has an unsafe link count: {display}"
        )


def open_private_directory_fd(path: Path, *, mode: int | None = 0o700) -> int:
    """Open and pin an absolute directory without following any component.

    The caller owns the returned descriptor.  Unlike ``ensure_private_directory``
    this function never creates, chmods, or otherwise repairs the path.
    """

    fd = _open_private_root(Path(path))
    try:
        _require_private_identity(
            os.fstat(fd),
            kind="directory",
            mode=mode,
            display=str(path),
        )
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_private_child_directory_fd(
    parent_fd: int,
    name: str,
    *,
    mode: int | None = 0o700,
) -> int:
    """Open one safe child directory relative to a pinned parent."""

    _require_leaf_name(name)
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    _require_private_identity(
        before, kind="directory", mode=mode, display=name
    )
    fd = _open_directory_at(parent_fd, name, require_owner=True, display=name)
    try:
        opened = verify_private_child_directory_fd(parent_fd, name, fd, mode=mode)
        if (opened.st_dev, opened.st_ino) != (
            before.st_dev,
            before.st_ino,
        ):
            raise UnsafePrivatePathError(
                f"private directory changed while opening: {name}"
            )
        return fd
    except BaseException:
        os.close(fd)
        raise


def ensure_private_child_directory_fd(
    parent_fd: int,
    name: str,
    *,
    mode: int = 0o700,
    staging_fd: int | None = None,
    staging_name: str | None = None,
    expected_existing_identity: tuple[int, int] | None = None,
    require_empty: bool = False,
) -> int:
    """Open or create one private child below an already pinned parent.

    Existing entries are validation-only: an unsafe type, owner, group or mode
    is never repaired. Missing entries are published from a caller-bound,
    Agent-invisible staging directory with ``RENAME_NOREPLACE``; direct
    ``mkdirat`` followed by a pathname reopen cannot prove it opened the inode
    it created. The caller owns the returned descriptor.
    """

    _require_leaf_name(name)
    if (staging_fd is None) != (staging_name is None):
        raise UnsafePrivatePathError(
            "private directory staging identity is incomplete"
        )
    existing_fd: int | None = None
    try:
        existing_fd = open_private_child_directory_fd(parent_fd, name, mode=mode)
    except FileNotFoundError:
        if expected_existing_identity is not None:
            raise UnsafePrivatePathError(
                f"private directory disappeared before publication: {name}"
            )
    else:
        try:
            if staging_fd is None or staging_name is None:
                if expected_existing_identity is not None:
                    opened = os.fstat(existing_fd)
                    if (opened.st_dev, opened.st_ino) != expected_existing_identity:
                        raise UnsafePrivatePathError(
                            f"private directory changed before publication: {name}"
                        )
                return existing_fd

            _require_leaf_name(staging_name)
            opened = os.fstat(existing_fd)
            if (
                expected_existing_identity is None
                or (opened.st_dev, opened.st_ino) != expected_existing_identity
            ):
                _remove_empty_private_directory_staging(
                    staging_fd,
                    staging_name,
                    expected_device=opened.st_dev,
                )
                raise UnsafePrivatePathError(
                    f"private directory appeared before publication: {name}"
                )
            _remove_empty_private_directory_staging(
                staging_fd,
                staging_name,
                expected_device=opened.st_dev,
                sync_parent=False,
            )
            _sync_private_directory_publication(
                parent_fd,
                name,
                existing_fd,
                staging_fd,
                mode=mode,
                require_empty=require_empty,
            )
            return existing_fd
        except BaseException:
            os.close(existing_fd)
            raise

    if staging_fd is None or staging_name is None:
        raise UnsafePrivatePathError(
            "private directory creation requires transaction-bound staging"
        )
    _require_leaf_name(staging_name)
    if os.fstat(parent_fd).st_dev != os.fstat(staging_fd).st_dev:
        raise UnsafePrivatePathError(
            "private directory staging is on another filesystem"
        )
    try:
        os.mkdir(staging_name, mode=mode, dir_fd=staging_fd)
        os.fsync(staging_fd)
    except FileExistsError:
        # A deterministic residue can only be reused after its exact metadata
        # and empty contents are validated below.
        pass
    fd = open_private_child_directory_fd(
        staging_fd,
        staging_name,
        mode=mode,
    )
    try:
        if os.listdir(fd):
            raise UnsafePrivatePathError(
                f"private directory staging is not empty: {staging_name}"
            )
        os.fsync(fd)
        verify_private_child_directory_fd(
            staging_fd,
            staging_name,
            fd,
            mode=mode,
        )
        try:
            _rename_noreplace(staging_fd, staging_name, parent_fd, name)
        except FileExistsError as exc:
            _remove_empty_private_directory_staging(
                staging_fd,
                staging_name,
                child_fd=fd,
                expected_device=os.fstat(parent_fd).st_dev,
            )
            raise UnsafePrivatePathError(
                f"private directory appeared during publication: {name}"
            ) from exc
        verify_private_child_directory_fd(parent_fd, name, fd, mode=mode)
        if os.listdir(fd):
            raise UnsafePrivatePathError(
                f"private directory gained contents during publication: {name}"
            )
        _sync_private_directory_publication(
            parent_fd,
            name,
            fd,
            staging_fd,
            mode=mode,
            require_empty=True,
        )
        return fd
    except BaseException:
        os.close(fd)
        raise


def _remove_empty_private_directory_staging(
    staging_fd: int,
    staging_name: str,
    *,
    child_fd: int | None = None,
    expected_device: int | None = None,
    sync_parent: bool = True,
) -> None:
    """Remove only one exact, owner-only and empty directory residue."""

    _require_leaf_name(staging_name)
    owns_child_fd = child_fd is None
    try:
        if child_fd is None:
            try:
                child_fd = open_private_child_directory_fd(
                    staging_fd,
                    staging_name,
                )
            except FileNotFoundError:
                return
        opened = verify_private_child_directory_fd(
            staging_fd,
            staging_name,
            child_fd,
        )
        if expected_device is not None and opened.st_dev != expected_device:
            raise UnsafePrivatePathError(
                f"private directory staging is on another filesystem: {staging_name}"
            )
        if os.listdir(child_fd):
            raise UnsafePrivatePathError(
                f"private directory staging is not empty: {staging_name}"
            )
        # Bind cleanup to the same directory entry that was proven empty.  The
        # staging root is Agent-invisible and single-writer, but this second
        # check still turns an unexpected replacement into a fail-closed
        # residue instead of unlinking by an unchecked pathname.
        current = verify_private_child_directory_fd(
            staging_fd,
            staging_name,
            child_fd,
        )
        if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise UnsafePrivatePathError(
                f"private directory staging changed before cleanup: {staging_name}"
            )
        os.rmdir(staging_name, dir_fd=staging_fd)
        if sync_parent:
            os.fsync(staging_fd)
    finally:
        if owns_child_fd and child_fd is not None:
            os.close(child_fd)


def _sync_private_directory_publication(
    parent_fd: int,
    name: str,
    child_fd: int,
    staging_fd: int,
    *,
    mode: int,
    require_empty: bool,
) -> os.stat_result:
    """Commit or replay one exact cross-directory publication durably.

    The staged child is empty when first renamed, so persisting source-name
    removal before destination-name creation is the recoverable ordering: a
    crash before the final parent sync can at worst require recreating an empty
    directory. Exact-final replay uses the same barrier even when the staging
    name is already absent.
    """

    published = verify_private_child_directory_fd(
        parent_fd,
        name,
        child_fd,
        mode=mode,
    )
    identity = (published.st_dev, published.st_ino)

    def reprove() -> os.stat_result:
        current = verify_private_child_directory_fd(
            parent_fd,
            name,
            child_fd,
            mode=mode,
        )
        if (current.st_dev, current.st_ino) != identity:
            raise UnsafePrivatePathError(
                f"private directory changed after publication: {name}"
            )
        if require_empty and os.listdir(child_fd):
            raise UnsafePrivatePathError(
                f"private directory gained contents during publication: {name}"
            )
        return current

    try:
        os.fsync(child_fd)
        os.fsync(staging_fd)
        os.fsync(parent_fd)
    except OSError as exc:
        # renameat2 has already moved the pinned inode into the final
        # namespace. Reprove that exact effect before exposing a recovery
        # identity; the first durability error remains visible to callers.
        try:
            reprove()
        except (OSError, UnsafePrivatePathError):
            raise
        raise PrivatePublicationCommittedError(
            f"private directory publication durability failed: {name}",
            identity,
        ) from exc
    return reprove()


def verify_private_child_directory_fd(
    parent_fd: int,
    name: str,
    child_fd: int,
    *,
    mode: int | None = 0o700,
) -> os.stat_result:
    """Reprove that a pinned child is still named by its pinned parent."""

    _require_leaf_name(name)
    opened = os.fstat(child_fd)
    entry = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    _require_private_identity(
        opened, kind="directory", mode=mode, display=name
    )
    _require_private_identity(
        entry, kind="directory", mode=mode, display=name
    )
    if (entry.st_dev, entry.st_ino) != (opened.st_dev, opened.st_ino):
        raise UnsafePrivatePathError(
            f"private directory entry changed identity: {name}"
        )
    return opened


def _require_leaf_name(name: str) -> None:
    if (
        not isinstance(name, str)
        or not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or "\x00" in name
    ):
        raise UnsafePrivatePathError("private leaf name is unsafe")


def stat_private_entry_at(parent_fd: int, name: str) -> os.stat_result:
    """Return no-follow metadata for one entry in a pinned directory."""

    _require_leaf_name(name)
    return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def read_private_file_at(
    parent_fd: int,
    name: str,
    *,
    maximum_bytes: int,
    mode: int | None = _PRIVATE_FILE_MODE,
    link_count: int = 1,
) -> tuple[bytes, os.stat_result]:
    """Read one private leaf and reprove its directory entry after the read."""

    _require_leaf_name(name)
    if maximum_bytes < 0:
        raise ValueError("maximum_bytes must not be negative")
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    _require_private_identity(
        before,
        kind="file",
        mode=mode,
        link_count=link_count,
        display=name,
    )
    if before.st_size > maximum_bytes:
        raise UnsafePrivatePathError(f"private file exceeds its size limit: {name}")
    flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(name, flags, dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise UnsafePrivatePathError(
                f"private file changed while opening: {name}"
            )
        _require_private_identity(
            opened,
            kind="file",
            mode=mode,
            link_count=link_count,
            display=name,
        )
        chunks: list[bytes] = []
        remaining = maximum_bytes + 1
        while remaining:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after_fd = os.fstat(fd)
    finally:
        os.close(fd)
    if len(raw) > maximum_bytes:
        raise UnsafePrivatePathError(f"private file exceeds its size limit: {name}")
    after_path = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (
        (after_fd.st_dev, after_fd.st_ino) != (opened.st_dev, opened.st_ino)
        or (after_path.st_dev, after_path.st_ino) != (opened.st_dev, opened.st_ino)
        or after_fd.st_size != len(raw)
        or after_path.st_size != len(raw)
    ):
        raise UnsafePrivatePathError(f"private file changed while reading: {name}")
    _require_private_identity(
        after_path,
        kind="file",
        mode=mode,
        link_count=link_count,
        display=name,
    )
    return raw, after_path


def _write_all(fd: int, data: bytes) -> None:
    remaining = memoryview(data)
    while remaining:
        written = os.write(fd, remaining)
        if written <= 0:
            raise OSError("private file write made no progress")
        remaining = remaining[written:]


def _open_anonymous_private_file(parent_fd: int) -> int:
    if not hasattr(os, "O_TMPFILE"):
        raise UnsafePrivatePathError("anonymous private publication is unsupported")
    try:
        return os.open(
            ".",
            os.O_TMPFILE | os.O_RDWR | getattr(os, "O_CLOEXEC", 0),
            _PRIVATE_FILE_MODE,
            dir_fd=parent_fd,
        )
    except OSError as exc:
        raise UnsafePrivatePathError(
            "anonymous private publication is unavailable on this filesystem"
        ) from exc


def _link_anonymous_file_at(file_fd: int, parent_fd: int, name: str) -> None:
    _require_leaf_name(name)
    libc = ctypes.CDLL(None, use_errno=True)
    function = libc.linkat
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
    ]
    function.restype = ctypes.c_int
    if function(file_fd, b"", parent_fd, os.fsencode(name), 0x1000) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise FileExistsError(error, os.strerror(error), name)
        raise OSError(error, os.strerror(error), name)


def _rename_exchange(
    left_fd: int,
    left_name: str,
    right_fd: int,
    right_name: str,
) -> None:
    _require_leaf_name(left_name)
    _require_leaf_name(right_name)
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        function = libc.renameat2
    except AttributeError as exc:
        raise OSError(errno.ENOSYS, "renameat2 is unavailable") from exc
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    function.restype = ctypes.c_int
    if function(
        left_fd,
        os.fsencode(left_name),
        right_fd,
        os.fsencode(right_name),
        2,
    ) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def _rename_noreplace(
    left_fd: int,
    left_name: str,
    right_fd: int,
    right_name: str,
) -> None:
    _require_leaf_name(left_name)
    _require_leaf_name(right_name)
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        function = libc.renameat2
    except AttributeError as exc:
        raise OSError(errno.ENOSYS, "renameat2 is unavailable") from exc
    function.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    function.restype = ctypes.c_int
    if function(
        left_fd,
        os.fsencode(left_name),
        right_fd,
        os.fsencode(right_name),
        1,
    ) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise FileExistsError(error, os.strerror(error), right_name)
        raise OSError(error, os.strerror(error))


def validate_anonymous_publication_support(parent_fd: int) -> None:
    """Prove O_TMPFILE support without publishing a directory entry."""

    temporary_fd = _open_anonymous_private_file(parent_fd)
    os.close(temporary_fd)


def validate_atomic_replace_support(parent_fd: int, staging_fd: int) -> None:
    """Validate non-mutating prerequisites for an atomic replacement.

    The transaction-bound staging/final exchange is the only safe way to
    prove filesystem support for ``RENAME_EXCHANGE``.  A synthetic named
    probe could collide with an existing entry or leave crash residue, so this
    check deliberately touches no directory entry.
    """

    if os.fstat(parent_fd).st_dev != os.fstat(staging_fd).st_dev:
        raise UnsafePrivatePathError(
            "private replacement staging is on another filesystem"
        )
    validate_anonymous_publication_support(staging_fd)
    try:
        getattr(ctypes.CDLL(None, use_errno=True), "renameat2")
    except AttributeError as exc:
        raise UnsafePrivatePathError(
            "atomic private replacement is unsupported"
        ) from exc


def _reprove_committed_private_file(
    parent_fd: int,
    name: str,
    data: bytes,
    published_identity: tuple[int, int],
    *,
    staging_fd: int | None = None,
    staging_name: str | None = None,
    previous_data: bytes | None = None,
    previous_identity: tuple[int, int] | None = None,
) -> None:
    """Prove one exact final effect and its absent-or-exact old residue."""

    final_raw, final_info = read_private_file_at(
        parent_fd,
        name,
        maximum_bytes=max(len(data), 1),
    )
    if final_raw != data or (
        final_info.st_dev,
        final_info.st_ino,
    ) != published_identity:
        raise UnsafePrivatePathError(
            f"private destination changed after publication: {name}"
        )
    if staging_fd is None or staging_name is None:
        return
    if previous_data is None or previous_identity is None:
        raise UnsafePrivatePathError(
            f"private replacement recovery identity is incomplete: {name}"
        )
    try:
        staged_raw, staged_info = read_private_file_at(
            staging_fd,
            staging_name,
            maximum_bytes=max(len(previous_data), 1),
        )
    except FileNotFoundError:
        return
    if staged_raw != previous_data or (
        staged_info.st_dev,
        staged_info.st_ino,
    ) != previous_identity:
        raise UnsafePrivatePathError(
            f"private replacement residue conflicts: {staging_name}"
        )


def publish_private_file_at(
    parent_fd: int,
    name: str,
    data: bytes,
    *,
    replace_identity: tuple[int, int] | None,
    replace_data: bytes | None = None,
    staging_fd: int | None = None,
    staging_name: str | None = None,
) -> None:
    """Publish a private leaf without exposing an incomplete named file.

    Initial publication links an ``O_TMPFILE`` inode directly to the final name.
    Replacement requires an Agent-invisible staging directory on the same
    filesystem, then uses ``renameat2(RENAME_EXCHANGE)`` as an inode CAS.  The
    exchanged old leaf and the newly published leaf are both verified before
    the protected copy is removed. A mismatch is never exchanged back: an
    unconditional second exchange would introduce another pathname TOCTOU.
    Instead both directory entries are retained and the operation fails closed
    for explicit recovery.
    """

    _require_leaf_name(name)
    try:
        final_raw, final_info = read_private_file_at(
            parent_fd, name, maximum_bytes=max(len(data), len(replace_data or b""), 1)
        )
    except FileNotFoundError:
        final_raw = None
        final_info = None
    if final_raw == data:
        if staging_fd is not None and staging_name is not None:
            try:
                staged_raw, _ = read_private_file_at(
                    staging_fd,
                    staging_name,
                    maximum_bytes=max(len(replace_data or b""), 1),
                )
            except FileNotFoundError:
                pass
            else:
                if replace_data is None or staged_raw != replace_data:
                    raise UnsafePrivatePathError(
                        f"private replacement residue conflicts: {staging_name}"
                    )
                os.unlink(staging_name, dir_fd=staging_fd)
                os.fsync(staging_fd)
        return
    if replace_identity is None:
        if final_info is not None:
            raise UnsafePrivatePathError(f"private destination already exists: {name}")
        temporary_fd = _open_anonymous_private_file(parent_fd)
        try:
            os.fchmod(temporary_fd, _PRIVATE_FILE_MODE)
            _write_all(temporary_fd, data)
            os.fsync(temporary_fd)
            published_info = os.fstat(temporary_fd)
            _link_anonymous_file_at(temporary_fd, parent_fd, name)
            try:
                os.fsync(parent_fd)
            except OSError as exc:
                try:
                    _reprove_committed_private_file(
                        parent_fd,
                        name,
                        data,
                        (published_info.st_dev, published_info.st_ino),
                    )
                except (OSError, UnsafePrivatePathError) as proof_exc:
                    raise UnsafePrivatePathError(
                        f"private destination could not be reconciled after publication: {name}"
                    ) from proof_exc
                raise PrivatePublicationCommittedError(
                    f"private file publication durability failed: {name}",
                    (published_info.st_dev, published_info.st_ino),
                ) from exc
        finally:
            os.close(temporary_fd)
    else:
        if (
            final_info is None
            or (final_info.st_dev, final_info.st_ino) != replace_identity
            or replace_data is None
            or final_raw != replace_data
            or staging_fd is None
            or staging_name is None
        ):
            raise UnsafePrivatePathError(
                f"private destination identity changed: {name}"
            )
        validate_atomic_replace_support(parent_fd, staging_fd)
        _require_leaf_name(staging_name)
        try:
            staged_raw, staged_info = read_private_file_at(
                staging_fd,
                staging_name,
                maximum_bytes=max(len(data), len(replace_data), 1),
            )
        except FileNotFoundError:
            temporary_fd = _open_anonymous_private_file(staging_fd)
            try:
                os.fchmod(temporary_fd, _PRIVATE_FILE_MODE)
                _write_all(temporary_fd, data)
                os.fsync(temporary_fd)
                _link_anonymous_file_at(temporary_fd, staging_fd, staging_name)
                os.fsync(staging_fd)
            finally:
                os.close(temporary_fd)
            staged_raw, staged_info = read_private_file_at(
                staging_fd,
                staging_name,
                maximum_bytes=max(len(data), len(replace_data), 1),
            )
        else:
            if staged_raw == replace_data and final_raw == data:
                os.unlink(staging_name, dir_fd=staging_fd)
                os.fsync(staging_fd)
                return
            if staged_raw != data:
                raise UnsafePrivatePathError(
                    f"private replacement staging conflicts: {staging_name}"
                )

        try:
            _rename_exchange(staging_fd, staging_name, parent_fd, name)
        except OSError as exc:
            os.fsync(staging_fd)
            os.fsync(parent_fd)
            raise UnsafePrivatePathError(
                f"atomic private replacement is unsupported: {name}"
            ) from exc
        exchanged = os.stat(staging_name, dir_fd=staging_fd, follow_symlinks=False)
        if (exchanged.st_dev, exchanged.st_ino) != replace_identity:
            os.fsync(staging_fd)
            os.fsync(parent_fd)
            raise UnsafePrivatePathError(
                f"private destination raced with replacement: {name}"
            )
        exchanged_raw, _ = read_private_file_at(
            staging_fd,
            staging_name,
            maximum_bytes=max(len(replace_data), 1),
        )
        if exchanged_raw != replace_data:
            os.fsync(staging_fd)
            os.fsync(parent_fd)
            raise UnsafePrivatePathError(
                f"private destination content raced with replacement: {name}"
            )
        try:
            published_raw, published_info = read_private_file_at(
                parent_fd,
                name,
                maximum_bytes=max(len(data), 1),
            )
        except (FileNotFoundError, UnsafePrivatePathError) as exc:
            os.fsync(staging_fd)
            os.fsync(parent_fd)
            raise UnsafePrivatePathError(
                f"private destination raced after replacement: {name}"
            ) from exc
        if (
            (published_info.st_dev, published_info.st_ino)
            != (staged_info.st_dev, staged_info.st_ino)
            or published_raw != data
        ):
            os.fsync(staging_fd)
            os.fsync(parent_fd)
            raise UnsafePrivatePathError(
                f"private destination raced after replacement: {name}"
            )
        published_identity = (published_info.st_dev, published_info.st_ino)
        try:
            os.fsync(parent_fd)
            # The staging directory is not mounted into an Agent and this writer
            # is its sole owner. Removing the exchanged, already-verified old
            # inode cannot be raced by a workspace process.
            os.unlink(staging_name, dir_fd=staging_fd)
            os.fsync(staging_fd)
        except OSError as exc:
            try:
                _reprove_committed_private_file(
                    parent_fd,
                    name,
                    data,
                    published_identity,
                    staging_fd=staging_fd,
                    staging_name=staging_name,
                    previous_data=replace_data,
                    previous_identity=replace_identity,
                )
            except (OSError, UnsafePrivatePathError) as proof_exc:
                raise UnsafePrivatePathError(
                    f"private replacement could not be reconciled after publication: {name}"
                ) from proof_exc
            raise PrivatePublicationCommittedError(
                f"private file publication cleanup or durability failed: {name}",
                published_identity,
            ) from exc

    final_raw, _ = read_private_file_at(
        parent_fd, name, maximum_bytes=max(len(data), 1)
    )
    if final_raw != data:
        raise UnsafePrivatePathError(f"private publication verification failed: {name}")


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

        file_fd = _open_anonymous_private_file(parent_fd)
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
        _link_anonymous_file_at(file_fd, parent_fd, parts[-1])
        os.fsync(parent_fd)
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
    """Atomically publish a new owner-only file without a named partial."""

    parent_fd = open_private_directory_fd(path.parent)
    try:
        try:
            publish_private_file_at(
                parent_fd,
                path.name,
                data,
                replace_identity=None,
            )
        except UnsafePrivatePathError as exc:
            if str(exc) == f"private destination already exists: {path.name}":
                raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST), path) from exc
            raise
    finally:
        os.close(parent_fd)


def copy_private_file_exclusive(
    source: Path,
    destination: Path,
    *,
    expected_size: int | None = None,
    expected_sha256: str | None = None,
    chunk_bytes: int = 64 * 1024,
) -> tuple[int, str]:
    """Stream one owner-only regular file into a new owner-only file.

    Both paths are opened without following symlinks. The destination remains
    anonymous until every size/hash check and fsync succeeds, so failure never
    creates a pathname that cleanup could race.
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

        parent_fd = open_private_directory_fd(destination.parent)
        destination_fd = _open_anonymous_private_file(parent_fd)
        try:
            digest = hashlib.sha256()
            total = 0
            with os.fdopen(source_fd, "rb") as source_handle:
                source_fd = -1
                while True:
                    chunk = source_handle.read(max(1, int(chunk_bytes)))
                    if not chunk:
                        break
                    _write_all(destination_fd, chunk)
                    digest.update(chunk)
                    total += len(chunk)
                if expected_size is not None and total != int(expected_size):
                    raise RuntimeError(f"private source file size changed while reading: {source}")
                actual_sha256 = digest.hexdigest()
                if expected_sha256 and actual_sha256 != str(expected_sha256).lower():
                    raise RuntimeError(f"private source file content changed: {source}")
                os.fsync(destination_fd)
            _link_anonymous_file_at(destination_fd, parent_fd, destination.name)
            os.fsync(parent_fd)
            return total, actual_sha256
        finally:
            if destination_fd >= 0:
                os.close(destination_fd)
            os.close(parent_fd)
    finally:
        if source_fd >= 0:
            os.close(source_fd)


def tighten_sqlite_files(path: Path) -> None:
    """Tighten SQLite's database and sidecar files when they exist."""

    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        ensure_private_file(candidate)
