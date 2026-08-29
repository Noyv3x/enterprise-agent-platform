from __future__ import annotations

import ctypes
import errno
import hashlib
import json
import os
import re
import secrets
import sqlite3
import stat
import threading
import time
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator

from .container_contract_generated import DATABASE_SCHEMA_VERSION
from .secure_fs import (
    UnsafePrivatePathError,
    open_private_child_directory_fd,
    open_private_directory_fd,
    open_private_file_fd_at,
    tighten_sqlite_files_at,
    verify_private_child_directory_fd,
    verify_private_directory_path_fd,
    verify_private_file_fd_at,
    ensure_private_directory,
)
from .technical_profile import (
    TARGET_DATABASE_BASELINE,
    TARGET_TECHNICAL_PROFILE,
    TechnicalProfile,
    technical_profile,
)


_SOURCE_DATABASE_BASELINE_VERSION = 2026080801
_DATABASE_BASELINE_VERSION = 2026082901
_DATABASE_BASELINE_NAME = TARGET_DATABASE_BASELINE
if _DATABASE_BASELINE_VERSION != DATABASE_SCHEMA_VERSION:
    raise RuntimeError("Database baseline does not match the container contract")


_AGENT_MEMORY_FTS_TABLE_SQL = (
    "CREATE VIRTUAL TABLE agent_memory_fts "
    "USING fts5(content, tags_json, content='agent_memories', content_rowid='id')"
)
_AGENT_MEMORY_FTS_TRIGGER_SQL = {
    "agent_memory_ai": """
        CREATE TRIGGER agent_memory_ai AFTER INSERT ON agent_memories BEGIN
            INSERT INTO agent_memory_fts(rowid, content, tags_json)
            VALUES (new.id, new.content, new.tags_json);
        END
    """.strip(),
    "agent_memory_ad": """
        CREATE TRIGGER agent_memory_ad AFTER DELETE ON agent_memories BEGIN
            INSERT INTO agent_memory_fts(
                agent_memory_fts, rowid, content, tags_json
            ) VALUES ('delete', old.id, old.content, old.tags_json);
        END
    """.strip(),
    "agent_memory_au": """
        CREATE TRIGGER agent_memory_au AFTER UPDATE ON agent_memories BEGIN
            INSERT INTO agent_memory_fts(
                agent_memory_fts, rowid, content, tags_json
            ) VALUES ('delete', old.id, old.content, old.tags_json);
            INSERT INTO agent_memory_fts(rowid, content, tags_json)
            VALUES (new.id, new.content, new.tags_json);
        END
    """.strip(),
}


_RETIRED_SCHEMA_SQL = """
DROP TABLE knowledge_chunk_embeddings;
DROP TABLE knowledge_chunks;
DROP TABLE knowledge_document_index;
DROP TABLE knowledge_index_generations;
DROP TABLE knowledge_document_files;
DROP TABLE knowledge_documents;
DROP TABLE sylver_platform_credentials;
DROP TABLE sylver_platform_connections;
"""

_RETIRED_KNOWLEDGE_SETTINGS = (
    "knowledge_embedding_base_url",
    "knowledge_embedding_model",
    "knowledge_embedding_dimensions",
    "knowledge_embedding_batch_size",
    "KNOWLEDGE_EMBEDDING_API_KEY",
)

_SKILL_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
_SKILL_SUPPORT_DIRECTORIES = frozenset(
    {"references", "templates", "scripts", "assets"}
)
_PRIVATE_DIRECTORY_MODE = 0o700
_PRIVATE_FILE_MODE = 0o600
_MAX_SKILL_MIGRATION_FILE_BYTES = 6 * 1024 * 1024
_MAX_SKILL_MIGRATION_ENTRIES = 14_000
_MAX_SKILL_MIGRATION_DEPTH = 66


def now_ts() -> int:
    return int(time.time())


def _read_migration_tree_fd(
    root_fd: int,
    display: str,
) -> dict[tuple[str, ...], tuple[str, bytes]]:
    manifest: dict[tuple[str, ...], tuple[str, bytes]] = {}
    remaining = _MAX_SKILL_MIGRATION_ENTRIES

    def visit(directory_fd: int, relative: tuple[str, ...]) -> None:
        nonlocal remaining
        before = os.fstat(directory_fd)
        try:
            entries = os.scandir(directory_fd)
        except OSError as exc:
            raise sqlite3.DatabaseError(
                f"cannot list Skill migration directory: {display}/{'/'.join(relative)}"
            ) from exc
        with entries:
            for entry in entries:
                remaining -= 1
                path = relative + (entry.name,)
                if remaining < 0 or len(path) > _MAX_SKILL_MIGRATION_DEPTH:
                    raise sqlite3.DatabaseError(
                        "Skill migration tree exceeds its entry limits"
                    )
                try:
                    info = os.stat(
                        entry.name,
                        dir_fd=directory_fd,
                        follow_symlinks=False,
                    )
                except OSError as exc:
                    raise sqlite3.DatabaseError(
                        f"cannot inspect Skill migration entry: {display}/{'/'.join(path)}"
                    ) from exc
                if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                    child_fd = open_private_child_directory_fd(
                        directory_fd, entry.name
                    )
                    try:
                        manifest[path] = ("directory", b"")
                        visit(child_fd, path)
                        verify_private_child_directory_fd(
                            directory_fd, entry.name, child_fd
                        )
                    finally:
                        os.close(child_fd)
                elif stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                    file_fd = open_private_file_fd_at(
                        directory_fd,
                        entry.name,
                        writable=False,
                    )
                    try:
                        chunks: list[bytes] = []
                        size = 0
                        while True:
                            chunk = os.read(file_fd, 1024 * 1024)
                            if not chunk:
                                break
                            chunks.append(chunk)
                            size += len(chunk)
                            if size > _MAX_SKILL_MIGRATION_FILE_BYTES:
                                raise sqlite3.DatabaseError(
                                    "Skill migration file is too large: "
                                    + display
                                    + "/"
                                    + "/".join(path)
                                )
                        verify_private_file_fd_at(
                            directory_fd,
                            entry.name,
                            file_fd,
                        )
                        manifest[path] = ("file", b"".join(chunks))
                    finally:
                        os.close(file_fd)
                else:
                    raise sqlite3.DatabaseError(
                        f"unsafe Skill migration entry: {display}/{'/'.join(path)}"
                    )
        after = os.fstat(directory_fd)
        if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
            raise sqlite3.DatabaseError(
                f"Skill migration directory changed: {display}/{'/'.join(relative)}"
            )

    try:
        visit(root_fd, ())
    except (OSError, UnsafePrivatePathError) as exc:
        raise sqlite3.DatabaseError(f"unsafe Skill migration tree: {display}") from exc
    return manifest


def _read_migration_tree(root: Path) -> dict[tuple[str, ...], tuple[str, bytes]]:
    """Return one closed, private tree as immutable bytes."""

    try:
        root_fd = open_private_directory_fd(root)
    except (OSError, UnsafePrivatePathError) as exc:
        raise sqlite3.DatabaseError(f"unsafe Skill migration tree: {root}") from exc
    try:
        try:
            manifest = _read_migration_tree_fd(root_fd, str(root))
            verify_private_directory_path_fd(root, root_fd)
        except (OSError, UnsafePrivatePathError) as exc:
            raise sqlite3.DatabaseError(f"unsafe Skill migration tree: {root}") from exc
        return manifest
    finally:
        os.close(root_fd)


def _assert_migration_tree(
    target: Path,
    expected: dict[tuple[str, ...], tuple[str, bytes]],
) -> None:
    actual = _read_migration_tree(target)
    if actual != expected:
        raise sqlite3.DatabaseError(f"Skill migration target differs: {target}")


def _migration_manifest_fingerprint(
    manifest: dict[tuple[str, ...], tuple[str, bytes]],
) -> str:
    digest = hashlib.sha256()
    for relative, (kind, payload) in sorted(manifest.items()):
        for value in (kind.encode("ascii"), "/".join(relative).encode("utf-8"), payload):
            digest.update(len(value).to_bytes(8, "big"))
            digest.update(value)
    return digest.hexdigest()


def _migration_path_exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def _assert_migration_tree_fd(
    root_fd: int,
    manifest: dict[tuple[str, ...], tuple[str, bytes]],
    display: str,
) -> None:
    if _read_migration_tree_fd(root_fd, display) != manifest:
        raise sqlite3.DatabaseError(f"Skill migration target differs: {display}")


def _fsync_migration_tree_fd(root_fd: int) -> None:
    remaining = [_MAX_SKILL_MIGRATION_ENTRIES]

    def fsync_tree(directory_fd: int, depth: int) -> None:
        with os.scandir(directory_fd) as entries:
            names: list[str] = []
            for entry in entries:
                remaining[0] -= 1
                if remaining[0] < 0 or depth > _MAX_SKILL_MIGRATION_DEPTH:
                    raise sqlite3.DatabaseError(
                        "Skill migration durability tree exceeds its limits"
                    )
                names.append(entry.name)
        for name in names:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                child_fd = open_private_child_directory_fd(directory_fd, name)
                try:
                    fsync_tree(child_fd, depth + 1)
                    verify_private_child_directory_fd(directory_fd, name, child_fd)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                file_fd = open_private_file_fd_at(directory_fd, name, writable=False)
                try:
                    os.fsync(file_fd)
                    verify_private_file_fd_at(directory_fd, name, file_fd)
                finally:
                    os.close(file_fd)
            else:
                raise sqlite3.DatabaseError("unsafe Skill migration durability entry")
        os.fsync(directory_fd)

    fsync_tree(root_fd, 1)


def _open_migration_child_directory_at(
    parent_fd: int,
    name: str,
    *,
    create: bool,
) -> tuple[int, bool]:
    try:
        return open_private_child_directory_fd(parent_fd, name), False
    except FileNotFoundError:
        if not create:
            raise
    try:
        os.mkdir(name, _PRIVATE_DIRECTORY_MODE, dir_fd=parent_fd)
        created = True
    except FileExistsError:
        created = False
    child_fd = open_private_child_directory_fd(parent_fd, name)
    if created:
        os.fsync(parent_fd)
    return child_fd, created


def _open_migration_directory_chain_at(
    root_fd: int,
    parts: tuple[str, ...],
) -> list[tuple[int, str, int]]:
    chain: list[tuple[int, str, int]] = []
    parent_fd = root_fd
    try:
        for name in parts:
            child_fd, _created = _open_migration_child_directory_at(
                parent_fd, name, create=False
            )
            chain.append((parent_fd, name, child_fd))
            parent_fd = child_fd
        return chain
    except BaseException:
        for _parent, _name, child_fd in reversed(chain):
            os.close(child_fd)
        raise


def _verify_migration_directory_chain(
    chain: list[tuple[int, str, int]],
) -> None:
    for parent_fd, name, child_fd in chain:
        verify_private_child_directory_fd(parent_fd, name, child_fd)


def _rename_migration_noreplace_at(
    parent_fd: int,
    source_name: str,
    target_name: str,
) -> None:
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
        parent_fd,
        os.fsencode(source_name),
        parent_fd,
        os.fsencode(target_name),
        1,
    ) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise FileExistsError(error, os.strerror(error), target_name)
        raise OSError(error, os.strerror(error), target_name)


def _remove_migration_staging_at(
    parent_fd: int,
    name: str,
    staging_fd: int,
) -> None:
    verify_private_child_directory_fd(parent_fd, name, staging_fd)
    remaining = [_MAX_SKILL_MIGRATION_ENTRIES]

    def remove_children(directory_fd: int, depth: int) -> None:
        names: list[str] = []
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                remaining[0] -= 1
                if remaining[0] < 0 or depth > _MAX_SKILL_MIGRATION_DEPTH:
                    raise sqlite3.DatabaseError(
                        "Skill migration staging cleanup exceeds its limits"
                    )
                names.append(entry.name)
        for child_name in names:
            info = os.stat(child_name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                child_fd = open_private_child_directory_fd(directory_fd, child_name)
                try:
                    remove_children(child_fd, depth + 1)
                    verify_private_child_directory_fd(
                        directory_fd, child_name, child_fd
                    )
                    os.rmdir(child_name, dir_fd=directory_fd)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                file_fd = open_private_file_fd_at(
                    directory_fd, child_name, writable=False
                )
                try:
                    verify_private_file_fd_at(
                        directory_fd, child_name, file_fd
                    )
                    os.unlink(child_name, dir_fd=directory_fd)
                finally:
                    os.close(file_fd)
            else:
                raise sqlite3.DatabaseError(
                    "unsafe Skill migration staging cleanup entry"
                )
        os.fsync(directory_fd)

    remove_children(staging_fd, 1)
    verify_private_child_directory_fd(parent_fd, name, staging_fd)
    os.rmdir(name, dir_fd=parent_fd)
    os.fsync(parent_fd)


def _publish_migration_tree_at(
    parent_fd: int,
    target_name: str,
    manifest: dict[tuple[str, ...], tuple[str, bytes]],
) -> int:
    try:
        target_fd = open_private_child_directory_fd(parent_fd, target_name)
    except FileNotFoundError:
        pass
    else:
        try:
            _assert_migration_tree_fd(target_fd, manifest, target_name)
            _fsync_migration_tree_fd(target_fd)
            verify_private_child_directory_fd(
                parent_fd, target_name, target_fd
            )
            os.fsync(parent_fd)
            return target_fd
        except BaseException:
            os.close(target_fd)
            raise

    for _attempt in range(32):
        staging_name = f".{target_name}.migration-{secrets.token_hex(8)}"
        try:
            os.mkdir(staging_name, _PRIVATE_DIRECTORY_MODE, dir_fd=parent_fd)
            break
        except FileExistsError:
            continue
    else:  # pragma: no cover - random collision guard
        raise sqlite3.DatabaseError("cannot allocate Skill migration staging")
    staging_fd = open_private_child_directory_fd(parent_fd, staging_name)
    published = False
    keep_staging_fd = False
    child_fds: dict[tuple[str, ...], int] = {(): staging_fd}
    try:
        for relative, (kind, payload) in sorted(
            manifest.items(), key=lambda item: (len(item[0]), item[0])
        ):
            parent = child_fds[relative[:-1]]
            name = relative[-1]
            if kind == "directory":
                os.mkdir(name, _PRIVATE_DIRECTORY_MODE, dir_fd=parent)
                child_fds[relative] = open_private_child_directory_fd(parent, name)
                continue
            descriptor = os.open(
                name,
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | os.O_NOFOLLOW
                | getattr(os, "O_CLOEXEC", 0),
                _PRIVATE_FILE_MODE,
                dir_fd=parent,
            )
            try:
                view = memoryview(payload)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        raise OSError("short Skill migration write")
                    view = view[written:]
                os.fsync(descriptor)
                verify_private_file_fd_at(parent, name, descriptor)
            finally:
                os.close(descriptor)
        for relative, directory_fd in sorted(
            child_fds.items(), key=lambda item: len(item[0]), reverse=True
        ):
            os.fsync(directory_fd)
            if relative:
                verify_private_child_directory_fd(
                    child_fds[relative[:-1]], relative[-1], directory_fd
                )
        os.fsync(parent_fd)
        verify_private_child_directory_fd(parent_fd, staging_name, staging_fd)
        try:
            _rename_migration_noreplace_at(
                parent_fd, staging_name, target_name
            )
        except FileExistsError:
            target_fd = open_private_child_directory_fd(parent_fd, target_name)
            try:
                _assert_migration_tree_fd(target_fd, manifest, target_name)
                _fsync_migration_tree_fd(target_fd)
                verify_private_child_directory_fd(
                    parent_fd, target_name, target_fd
                )
            except BaseException:
                os.close(target_fd)
                raise
            _remove_migration_staging_at(parent_fd, staging_name, staging_fd)
            os.fsync(parent_fd)
            return target_fd
        published = True
        verify_private_child_directory_fd(parent_fd, target_name, staging_fd)
        _assert_migration_tree_fd(staging_fd, manifest, target_name)
        os.fsync(staging_fd)
        os.fsync(parent_fd)
        keep_staging_fd = True
        return staging_fd
    finally:
        for relative, descriptor in list(child_fds.items()):
            if relative and descriptor >= 0:
                os.close(descriptor)
        if not published:
            try:
                try:
                    os.stat(staging_name, dir_fd=parent_fd, follow_symlinks=False)
                except FileNotFoundError:
                    pass
                else:
                    _remove_migration_staging_at(
                        parent_fd, staging_name, staging_fd
                    )
            finally:
                os.close(staging_fd)
        elif not keep_staging_fd:
            os.close(staging_fd)


def _normalized_schema_sql(value: object) -> str:
    return "".join(str(value or "").casefold().split())


def _execute_transactional_schema(
    connection: sqlite3.Connection,
    schema: str,
) -> None:
    """Execute the owned DDL without ``executescript``'s implicit COMMIT."""

    for statement in schema.split(";"):
        sql = statement.strip()
        if sql:
            connection.execute(sql)


def _close_database_descriptors(database_fd: int, directory_fd: int) -> None:
    for fd in (database_fd, directory_fd):
        try:
            os.close(fd)
        except OSError:
            pass


def _sqlite_fd_uri(database_fd: int, *, mode: str) -> str:
    if mode not in {"ro", "rw"}:  # pragma: no cover - internal programming error
        raise ValueError("SQLite fd mode is invalid")
    proc_path = Path(f"/proc/self/fd/{database_fd}")
    if not proc_path.exists():
        raise RuntimeError("pinned SQLite file descriptors are unavailable")
    return f"file:{proc_path}?mode={mode}"


def _validate_existing_sqlite_sidecars(parent_fd: int, database_name: str) -> None:
    for name in (f"{database_name}-wal", f"{database_name}-shm"):
        try:
            sidecar_fd = open_private_file_fd_at(
                parent_fd,
                name,
                writable=False,
                mode=None,
            )
        except FileNotFoundError:
            continue
        os.close(sidecar_fd)


def _assert_pinned_database_profile(
    parent_fd: int,
    database_name: str,
    database_fd: int,
    selected: TechnicalProfile,
    *,
    allow_source_migration: bool = False,
) -> int | None:
    """Read the baseline through one pinned, re-proven database inode."""

    info = verify_private_file_fd_at(
        parent_fd,
        database_name,
        database_fd,
        mode=None,
    )
    if info.st_size == 0:
        return None
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(
            _sqlite_fd_uri(database_fd, mode="ro"),
            uri=True,
        )
        verify_private_file_fd_at(
            parent_fd,
            database_name,
            database_fd,
            mode=None,
        )
        row = connection.execute(
            "SELECT version, name FROM schema_migrations ORDER BY version"
        ).fetchall()
        verify_private_file_fd_at(
            parent_fd,
            database_name,
            database_fd,
            mode=None,
        )
    except sqlite3.Error as exc:
        raise sqlite3.DatabaseError(
            "database does not match the current baseline marker"
        ) from exc
    finally:
        if connection is not None:
            connection.close()
    markers = [(int(version), str(name)) for version, name in row]
    allowed_markers = {
        (_DATABASE_BASELINE_VERSION, selected.database_baseline_name),
    }
    if allow_source_migration:
        allowed_markers.add(
            (_SOURCE_DATABASE_BASELINE_VERSION, selected.database_baseline_name)
        )
    if len(markers) != 1 or markers[0] not in allowed_markers:
        raise sqlite3.DatabaseError(
            "database does not match the current baseline marker"
        )
    return markers[0][0]


def assert_existing_database_profile(
    path: Path,
    technical_profile_value: TechnicalProfile | str = TARGET_TECHNICAL_PROFILE,
    *,
    allow_source_migration: bool = False,
) -> int | None:
    """Reject a cross-profile database without opening a writable handle."""

    selected = technical_profile(technical_profile_value)
    path = Path(path).expanduser()
    directory_fd = -1
    database_fd = -1
    try:
        try:
            directory_fd = open_private_directory_fd(path.parent, mode=None)
        except FileNotFoundError:
            return None
        verify_private_directory_path_fd(path.parent, directory_fd, mode=None)
        try:
            database_fd = open_private_file_fd_at(
                directory_fd,
                path.name,
                writable=False,
                mode=None,
            )
        except FileNotFoundError:
            return None
        _validate_existing_sqlite_sidecars(directory_fd, path.name)
        baseline = _assert_pinned_database_profile(
            directory_fd,
            path.name,
            database_fd,
            selected,
            allow_source_migration=allow_source_migration,
        )
        verify_private_directory_path_fd(path.parent, directory_fd, mode=None)
        return baseline
    finally:
        if database_fd >= 0:
            os.close(database_fd)
        if directory_fd >= 0:
            os.close(directory_fd)


class _ConnectionHolder:
    """Owns one sqlite3 connection and closes it when garbage collected.

    Stored in thread-local storage so a connection is closed automatically when
    its owning thread dies (sqlite3.Connection is not weakref-able, but a plain
    holder object is, which lets the Database track live connections in a
    WeakSet without preventing that cleanup).
    """

    __slots__ = ("conn", "__weakref__")

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def close(self) -> None:
        conn, self.conn = self.conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def __del__(self) -> None:
        self.close()


class Database:
    """SQLite access with one connection per thread.

    WAL mode plus a per-connection busy timeout lets reads run concurrently and
    serializes writes at the SQLite level, so no global Python lock is needed on
    the hot path (the previous single-connection + RLock design serialized every
    request and agent-worker thread platform-wide).
    """

    def __init__(
        self,
        path: Path,
        technical_profile_value: TechnicalProfile | str = TARGET_TECHNICAL_PROFILE,
        *,
        allow_source_migration: bool = False,
        migration_data_dir: Path | None = None,
    ):
        self.path = Path(path).expanduser()
        self.technical_profile = technical_profile(technical_profile_value)
        self._database_baseline_name = self.technical_profile.database_baseline_name
        self._allow_source_migration = bool(allow_source_migration)
        self._migration_data_dir = (
            Path(migration_data_dir).expanduser()
            if migration_data_dir is not None
            else None
        )
        self._directory_fd = -1
        self._database_fd = -1
        self._pin_finalizer: weakref.finalize | None = None
        ensure_private_directory(self.path.parent)
        try:
            self._directory_fd = open_private_directory_fd(self.path.parent)
            verify_private_directory_path_fd(
                self.path.parent,
                self._directory_fd,
            )
            self._database_fd = open_private_file_fd_at(
                self._directory_fd,
                self.path.name,
                writable=True,
                create=True,
                mode=0o600,
                tighten_mode=True,
            )
            self._pin_finalizer = weakref.finalize(
                self,
                _close_database_descriptors,
                self._database_fd,
                self._directory_fd,
            )
            # Existing WAL/SHM leaves are verified before even a read-only
            # profile query can make SQLite discover them.
            tighten_sqlite_files_at(
                self._directory_fd,
                self.path.name,
                database_fd=self._database_fd,
            )
            _assert_pinned_database_profile(
                self._directory_fd,
                self.path.name,
                self._database_fd,
                self.technical_profile,
                allow_source_migration=self._allow_source_migration,
            )
            verify_private_directory_path_fd(
                self.path.parent,
                self._directory_fd,
            )
            self._local = threading.local()
            self._init_lock = threading.RLock()
            self._holders: "weakref.WeakSet[_ConnectionHolder]" = weakref.WeakSet()
            self._holders_lock = threading.Lock()
            self.fts_available = False
            self.message_fts_available = False
            self.message_fts_trigram_available = False
            self._closed = False
            self.init_schema()
        except BaseException:
            holder = getattr(self, "_local", None)
            if holder is not None:
                connection_holder = getattr(holder, "holder", None)
                if connection_holder is not None:
                    connection_holder.close()
            self._close_pinned_files()
            raise

    def _verify_database_identity(self) -> None:
        verify_private_directory_path_fd(self.path.parent, self._directory_fd)
        verify_private_file_fd_at(
            self._directory_fd,
            self.path.name,
            self._database_fd,
            mode=0o600,
        )

    def _close_pinned_files(self) -> None:
        finalizer = self._pin_finalizer
        self._pin_finalizer = None
        database_fd, self._database_fd = self._database_fd, -1
        directory_fd, self._directory_fd = self._directory_fd, -1
        if finalizer is not None and finalizer.alive:
            finalizer.detach()
        _close_database_descriptors(database_fd, directory_fd)

    def _new_connection(self) -> sqlite3.Connection:
        self._verify_database_identity()
        tighten_sqlite_files_at(
            self._directory_fd,
            self.path.name,
            database_fd=self._database_fd,
        )
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(
                _sqlite_fd_uri(self._database_fd, mode="rw"),
                uri=True,
                check_same_thread=False,
                timeout=30,
            )
            # sqlite3_open has acquired its own handle to the pinned inode, but
            # no WAL pragma or schema statement has run yet. Reprove the named
            # leaf now so a connect-window replacement fails without a writer.
            self._verify_database_identity()
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=30000")
            self._verify_database_identity()
            tighten_sqlite_files_at(
                self._directory_fd,
                self.path.name,
                database_fd=self._database_fd,
            )
            return conn
        except BaseException:
            if conn is not None:
                conn.close()
            raise

    @property
    def _conn(self) -> sqlite3.Connection:
        if self._closed:
            raise sqlite3.ProgrammingError("Cannot operate on a closed database.")
        holder = getattr(self._local, "holder", None)
        # holder.conn can be None if another thread's close() ran; recreate it.
        if holder is None or holder.conn is None:
            holder = _ConnectionHolder(self._new_connection())
            self._local.holder = holder
            with self._holders_lock:
                self._holders.add(holder)
        return holder.conn

    def close(self) -> None:
        """Mark the database closed and reclaim this thread's connection.

        Callers must join every DB-touching thread (request handlers, agent
        workers, the ingest loop) BEFORE calling close(); otherwise an in-flight
        statement on another thread's connection can race a shutdown that closes
        it. To avoid that cross-thread race we only close the connection owned by
        the calling thread here. Connections owned by other threads are left to
        their _ConnectionHolder.__del__ (invoked when that thread's thread-local
        storage is torn down on thread exit), so a slow worker that has not yet
        finished keeps a valid handle until it does.
        """
        self._closed = True
        own = getattr(self._local, "holder", None)
        with self._holders_lock:
            # Drop tracking references so the holders become eligible for GC; do
            # not force-close other threads' connections out from under them.
            self._holders.clear()
        if own is not None:
            own.close()
        try:
            self._local.holder = None
        except Exception:
            pass
        try:
            self._verify_database_identity()
            tighten_sqlite_files_at(
                self._directory_fd,
                self.path.name,
                database_fd=self._database_fd,
            )
        finally:
            self._close_pinned_files()

    def init_schema(self) -> None:
        with self._init_lock:
            existing_tables = {
                str(row["name"])
                for row in self._conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                ).fetchall()
            }
            fresh_database = not existing_tables
            if not fresh_database:
                marker = self._database_marker(existing_tables)
                source_marker = (
                    _SOURCE_DATABASE_BASELINE_VERSION,
                    self._database_baseline_name,
                )
                if marker == source_marker and self._allow_source_migration:
                    self._assert_database_structure(
                        existing_tables,
                        source_database_baseline=True,
                    )
                    self._migrate_source_database_baseline()
                else:
                    self._assert_current_database_baseline(existing_tables)
            if fresh_database:
                try:
                    schema = """
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;
                BEGIN IMMEDIATE;

                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    applied_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'member',
                    position TEXT NOT NULL DEFAULT '',
                    permission_group TEXT NOT NULL DEFAULT 'member',
                    model_name TEXT NOT NULL DEFAULT '',
                    thinking_depth TEXT NOT NULL DEFAULT 'medium',
                    timezone TEXT NOT NULL DEFAULT '',
                    active INTEGER NOT NULL DEFAULT 1,
                    token_version INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    last_login_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS channels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT NOT NULL DEFAULT '',
                    created_by INTEGER REFERENCES users(id),
                    created_at INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
                    scope_id TEXT NOT NULL,
                    author_type TEXT NOT NULL CHECK(author_type IN ('user', 'agent', 'system')),
                    user_id INTEGER REFERENCES users(id),
                    username TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    hidden_at INTEGER,
                    hidden_by_user_id INTEGER REFERENCES users(id),
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(scope_type, scope_id, id);
                CREATE INDEX IF NOT EXISTS idx_messages_visible_scope
                    ON messages(scope_type, scope_id, hidden_at, id);

                CREATE TABLE IF NOT EXISTS conversation_revisions (
                    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
                    scope_id TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0,
                    reset_revision INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_type, scope_id)
                );

                CREATE TABLE IF NOT EXISTS attachments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
                    scope_id TEXT NOT NULL,
                    uploader_user_id INTEGER REFERENCES users(id),
                    source TEXT NOT NULL DEFAULT 'upload'
                        CHECK(source IN ('upload', 'agent_generated')),
                    filename TEXT NOT NULL,
                    storage_path TEXT NOT NULL UNIQUE,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id, id);
                CREATE INDEX IF NOT EXISTS idx_attachments_scope ON attachments(scope_type, scope_id, id);

                CREATE TABLE IF NOT EXISTS token_usage_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    username TEXT NOT NULL DEFAULT '',
                    display_name TEXT NOT NULL DEFAULT '',
                    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
                    scope_id TEXT NOT NULL,
                    scope_name TEXT NOT NULL DEFAULT '',
                    request_message_id INTEGER,
                    response_message_id INTEGER,
                    provider TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    total_tokens INTEGER NOT NULL DEFAULT 0,
                    raw_usage_json TEXT NOT NULL DEFAULT '{}',
                    degraded INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_token_usage_user_time ON token_usage_events(user_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_token_usage_scope_time ON token_usage_events(scope_type, scope_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_token_usage_model_time ON token_usage_events(provider, model, created_at);
                CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage_events(created_at);

                CREATE TABLE IF NOT EXISTS agent_scopes (
                    scope_key TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL CHECK(scope_type IN ('channel', 'private')),
                    scope_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL DEFAULT '',
                    workspace_path TEXT NOT NULL,
                    sandbox_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(scope_type, scope_id)
                );
                CREATE INDEX IF NOT EXISTS idx_agent_scopes_type_id
                    ON agent_scopes(scope_type, scope_id);

                -- Runtime session state is separate from logical scope metadata:
                -- workspaces remain stable while a conversation lifecycle can be
                -- rotated independently.
                CREATE TABLE IF NOT EXISTS agent_runtime_scopes (
                    scope_key TEXT PRIMARY KEY REFERENCES agent_scopes(scope_key) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    lifecycle_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS agent_runtime_scope_sessions (
                    scope_key TEXT NOT NULL REFERENCES agent_runtime_scopes(scope_key) ON DELETE CASCADE,
                    lifecycle_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(scope_key, lifecycle_id, session_id)
                );
                CREATE INDEX IF NOT EXISTS idx_agent_runtime_scope_sessions_lookup
                    ON agent_runtime_scope_sessions(scope_key, lifecycle_id, session_id);

                CREATE TABLE IF NOT EXISTS agent_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scope_key TEXT NOT NULL,
                    target TEXT NOT NULL DEFAULT 'memory' CHECK(target IN ('memory', 'user')),
                    owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    content TEXT NOT NULL,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    source_type TEXT NOT NULL DEFAULT 'manual'
                        CHECK(source_type IN ('manual', 'automatic')),
                    source_run_id TEXT NOT NULL DEFAULT '',
                    source_message_id TEXT NOT NULL DEFAULT '',
                    content_hash TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_agent_memories_scope
                    ON agent_memories(scope_key, target, owner_user_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_memories_content_hash
                    ON agent_memories(scope_key, target, owner_user_id, content_hash);
                CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_memories_dedupe
                    ON agent_memories(
                        scope_key, target, COALESCE(owner_user_id, 0), content_hash
                    )
                    WHERE content_hash != '';

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    secret INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS external_identities (
                    provider TEXT NOT NULL,
                    external_id TEXT NOT NULL,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    username TEXT NOT NULL DEFAULT '',
                    display_name TEXT NOT NULL DEFAULT '',
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(provider, external_id)
                );
                CREATE INDEX IF NOT EXISTS idx_external_identities_user ON external_identities(user_id);

                CREATE TABLE IF NOT EXISTS telegram_link_challenges (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    code_hash TEXT NOT NULL UNIQUE,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_telegram_link_challenges_expiry
                    ON telegram_link_challenges(expires_at);

                CREATE TABLE IF NOT EXISTS telegram_updates (
                    update_id INTEGER PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'queued'
                        CHECK(status IN ('queued', 'processing', 'succeeded', 'failed', 'ignored')),
                    received_at INTEGER NOT NULL,
                    processed_at INTEGER,
                    last_error TEXT NOT NULL DEFAULT '',
                    result_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_telegram_updates_status
                    ON telegram_updates(status, update_id);

                CREATE TABLE IF NOT EXISTS mail_accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    label TEXT NOT NULL,
                    email_address TEXT NOT NULL,
                    username TEXT NOT NULL,
                    imap_host TEXT NOT NULL,
                    imap_port INTEGER NOT NULL CHECK(imap_port BETWEEN 1 AND 65535),
                    imap_security TEXT NOT NULL CHECK(imap_security IN ('tls', 'starttls')),
                    smtp_host TEXT NOT NULL,
                    smtp_port INTEGER NOT NULL CHECK(smtp_port BETWEEN 1 AND 65535),
                    smtp_security TEXT NOT NULL CHECK(smtp_security IN ('tls', 'starttls')),
                    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
                    wake_enabled INTEGER NOT NULL DEFAULT 0 CHECK(wake_enabled IN (0, 1)),
                    wake_folder TEXT NOT NULL DEFAULT 'INBOX',
                    poll_interval_seconds INTEGER NOT NULL DEFAULT 300
                        CHECK(poll_interval_seconds BETWEEN 60 AND 3600),
                    checkpoint_initialized INTEGER NOT NULL DEFAULT 0
                        CHECK(checkpoint_initialized IN (0, 1)),
                    uid_validity INTEGER,
                    last_uid INTEGER NOT NULL DEFAULT 0,
                    revision INTEGER NOT NULL DEFAULT 1,
                    last_checked_at INTEGER,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(owner_user_id, email_address)
                );
                CREATE INDEX IF NOT EXISTS idx_mail_accounts_poll
                    ON mail_accounts(enabled, wake_enabled, last_checked_at, id);
                CREATE INDEX IF NOT EXISTS idx_mail_accounts_owner
                    ON mail_accounts(owner_user_id, id);

                CREATE TABLE IF NOT EXISTS mail_account_credentials (
                    account_id INTEGER PRIMARY KEY
                        REFERENCES mail_accounts(id) ON DELETE CASCADE,
                    password TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS durable_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    scope_type TEXT NOT NULL DEFAULT '',
                    scope_id TEXT NOT NULL DEFAULT '',
                    dedupe_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'queued'
                        CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'needs_review')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    available_at INTEGER NOT NULL DEFAULT 0,
                    lease_until INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(kind, dedupe_key)
                );
                CREATE INDEX IF NOT EXISTS idx_durable_jobs_ready
                    ON durable_jobs(kind, status, available_at, id);
                CREATE INDEX IF NOT EXISTS idx_durable_jobs_scope
                    ON durable_jobs(scope_type, scope_id, id);

                CREATE TABLE IF NOT EXISTS agent_run_inputs (
                    message_id INTEGER PRIMARY KEY,
                    job_id INTEGER NOT NULL UNIQUE,
                    parent_job_id INTEGER NOT NULL,
                    input_group_id TEXT NOT NULL,
                    runtime_run_id TEXT NOT NULL DEFAULT '',
                    state TEXT NOT NULL
                        CHECK(state IN (
                            'running', 'reserved', 'submitting', 'accepted',
                            'injected', 'unconsumed', 'succeeded', 'failed',
                            'needs_review'
                        )),
                    turn_id TEXT NOT NULL DEFAULT '',
                    turn_index INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_group
                    ON agent_run_inputs(input_group_id, message_id);
                CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_parent
                    ON agent_run_inputs(parent_job_id, message_id);
                CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_runtime
                    ON agent_run_inputs(runtime_run_id, message_id);

                CREATE TABLE IF NOT EXISTS agent_schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    schedule_json TEXT NOT NULL,
                    timezone TEXT NOT NULL DEFAULT 'UTC',
                    delivery TEXT NOT NULL DEFAULT 'chat'
                        CHECK(delivery IN ('chat', 'chat_and_telegram')),
                    state TEXT NOT NULL DEFAULT 'active'
                        CHECK(state IN ('active', 'paused', 'completed')),
                    enabled INTEGER NOT NULL DEFAULT 1,
                    next_run_at INTEGER,
                    last_run_id INTEGER,
                    revision INTEGER NOT NULL DEFAULT 1,
                    retry_after INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    deleted_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
                    ON agent_schedules(enabled, next_run_at, id);
                CREATE INDEX IF NOT EXISTS idx_agent_schedules_owner
                    ON agent_schedules(owner_user_id, deleted_at, id);

                CREATE TABLE IF NOT EXISTS agent_schedule_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    schedule_id INTEGER NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
                    schedule_revision INTEGER NOT NULL DEFAULT 1,
                    occurrence_key TEXT,
                    scheduled_for INTEGER NOT NULL,
                    trigger TEXT NOT NULL DEFAULT 'scheduled'
                        CHECK(trigger IN ('scheduled', 'manual')),
                    status TEXT NOT NULL DEFAULT 'queued'
                        CHECK(status IN ('queued', 'running', 'succeeded', 'failed',
                                         'needs_review', 'blocked', 'skipped', 'cancelled')),
                    durable_job_id INTEGER REFERENCES durable_jobs(id),
                    source_message_id INTEGER REFERENCES messages(id),
                    response_message_id INTEGER REFERENCES messages(id),
                    started_at INTEGER,
                    finished_at INTEGER,
                    error TEXT NOT NULL DEFAULT '',
                    delivery_warning TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(schedule_id, schedule_revision, occurrence_key)
                );
                CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_schedule
                    ON agent_schedule_runs(schedule_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_job
                    ON agent_schedule_runs(durable_job_id);

                INSERT INTO schema_migrations(version, name, applied_at)
                    VALUES (
                        __CURRENT_DATABASE_BASELINE_VERSION__,
                        '__CURRENT_DATABASE_BASELINE__',
                        CAST(strftime('%s', 'now') AS INTEGER)
                    );
                INSERT INTO settings(key, value, secret, updated_at)
                    VALUES (
                        'durable_agent_jobs_start_message_id',
                        '0',
                        0,
                        CAST(strftime('%s', 'now') AS INTEGER)
                    );

                CREATE TRIGGER conversation_revision_ai
                AFTER INSERT ON messages BEGIN
                    INSERT INTO conversation_revisions(
                        scope_type, scope_id, revision, reset_revision, updated_at
                    ) VALUES (
                        new.scope_type, new.scope_id, 1, 0,
                        CAST(strftime('%s', 'now') AS INTEGER)
                    )
                    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
                        revision = conversation_revisions.revision + 1,
                        updated_at = CAST(strftime('%s', 'now') AS INTEGER);
                END;

                CREATE TRIGGER conversation_revision_hidden_au
                AFTER UPDATE OF hidden_at ON messages
                WHEN old.hidden_at IS NOT new.hidden_at BEGIN
                    INSERT INTO conversation_revisions(
                        scope_type, scope_id, revision, reset_revision, updated_at
                    ) VALUES (
                        new.scope_type, new.scope_id, 1, 1,
                        CAST(strftime('%s', 'now') AS INTEGER)
                    )
                    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
                        revision = conversation_revisions.revision + 1,
                        reset_revision = conversation_revisions.revision + 1,
                        updated_at = CAST(strftime('%s', 'now') AS INTEGER);
                END;

                CREATE TRIGGER conversation_revision_metadata_au
                AFTER UPDATE OF metadata_json ON messages
                WHEN old.metadata_json IS NOT new.metadata_json BEGIN
                    INSERT INTO conversation_revisions(
                        scope_type, scope_id, revision, reset_revision, updated_at
                    ) VALUES (
                        new.scope_type, new.scope_id, 1, 1,
                        CAST(strftime('%s', 'now') AS INTEGER)
                    )
                    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
                        revision = conversation_revisions.revision + 1,
                        reset_revision = conversation_revisions.revision + 1,
                        updated_at = CAST(strftime('%s', 'now') AS INTEGER);
                END;

                CREATE TRIGGER conversation_revision_ad
                AFTER DELETE ON messages BEGIN
                    INSERT INTO conversation_revisions(
                        scope_type, scope_id, revision, reset_revision, updated_at
                    ) VALUES (
                        old.scope_type, old.scope_id, 1, 1,
                        CAST(strftime('%s', 'now') AS INTEGER)
                    )
                    ON CONFLICT(scope_type, scope_id) DO UPDATE SET
                        revision = conversation_revisions.revision + 1,
                        reset_revision = conversation_revisions.revision + 1,
                        updated_at = CAST(strftime('%s', 'now') AS INTEGER);
                END;
                COMMIT;
                """
                    if schema.count("__CURRENT_DATABASE_BASELINE__") != 1:
                        raise RuntimeError("database baseline placeholder is invalid")
                    if schema.count("__CURRENT_DATABASE_BASELINE_VERSION__") != 1:
                        raise RuntimeError("database baseline version placeholder is invalid")
                    self._conn.executescript(
                        schema.replace(
                            "__CURRENT_DATABASE_BASELINE__",
                            self._database_baseline_name,
                        ).replace(
                            "__CURRENT_DATABASE_BASELINE_VERSION__",
                            str(_DATABASE_BASELINE_VERSION),
                        )
                    )
                except BaseException:
                    self._conn.rollback()
                    raise
            self._ensure_fts()
            self._ensure_message_fts()
            self._assert_current_database_baseline()
            self._conn.commit()

    def _database_marker(self, tables: set[str] | None = None) -> tuple[int, str] | None:
        known_tables = tables or self._database_tables()
        if "schema_migrations" not in known_tables:
            return None
        rows = self._conn.execute(
            "SELECT version, name FROM schema_migrations ORDER BY version"
        ).fetchall()
        if len(rows) != 1:
            return None
        return int(rows[0]["version"]), str(rows[0]["name"])

    def _migrate_source_database_baseline(self) -> None:
        """Copy old Skills durably before retiring the source database baseline."""

        copies = self._legacy_skill_copy_plan()
        try:
            self._publish_legacy_skill_copies(copies)
            self._conn.execute("BEGIN IMMEDIATE")
            placeholders = ", ".join("?" for _ in _RETIRED_KNOWLEDGE_SETTINGS)
            self._conn.execute(
                f"DELETE FROM settings WHERE key IN ({placeholders})",
                _RETIRED_KNOWLEDGE_SETTINGS,
            )
            self._conn.execute(
                "DELETE FROM durable_jobs WHERE kind = 'knowledge_index'"
            )
            _execute_transactional_schema(self._conn, _RETIRED_SCHEMA_SQL)
            self._conn.execute(
                "UPDATE schema_migrations SET version = ?, applied_at = ? "
                "WHERE version = ? AND name = ?",
                (
                    _DATABASE_BASELINE_VERSION,
                    now_ts(),
                    _SOURCE_DATABASE_BASELINE_VERSION,
                    self._database_baseline_name,
                ),
            )
            if self._conn.execute("SELECT changes()").fetchone()[0] != 1:
                raise sqlite3.DatabaseError(
                    "database source baseline marker changed during migration"
                )
            violations = self._conn.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise sqlite3.IntegrityError(
                    f"database migration produced {len(violations)} "
                    "foreign-key violations"
                )
            self._assert_current_database_baseline()
            self._commit_or_rollback(self._conn)
        except BaseException:
            try:
                self._conn.rollback()
            except Exception:
                pass
            raise

    def _legacy_skill_copy_plan(self) -> list[dict[str, Any]]:
        data_dir = self._migration_data_dir
        if data_dir is None:
            raise sqlite3.DatabaseError("database migration requires the data directory")
        data_root = Path(os.path.abspath(os.fspath(data_dir)))
        rows = self._conn.execute(
            "SELECT scope_key, scope_type, scope_id, workspace_path "
            "FROM agent_scopes ORDER BY scope_key"
        ).fetchall()
        expected: dict[str, sqlite3.Row] = {}
        workspaces: dict[str, Path] = {}
        destinations: set[str] = set()
        workspace_root = data_root / "workspaces"
        workspace_root_fd = open_private_directory_fd(workspace_root)
        os.close(workspace_root_fd)
        for row in rows:
            scope_key = str(row["scope_key"])
            canonical = self._canonical_migration_workspace(row)
            if str(row["workspace_path"]) != canonical:
                raise sqlite3.DatabaseError("Agent workspace path is noncanonical")
            if canonical in destinations:
                raise sqlite3.DatabaseError("Agent workspace destination is duplicated")
            destinations.add(canonical)
            digest = hashlib.sha256(scope_key.encode("utf-8")).hexdigest()
            if digest in expected:  # pragma: no cover - SHA-256 collision guard
                raise sqlite3.DatabaseError("Agent Skill scope digest is duplicated")
            expected[digest] = row
            workspace = workspace_root.joinpath(*Path(canonical).parts)
            try:
                workspace_fd = open_private_directory_fd(workspace)
            except (OSError, RuntimeError) as exc:
                raise sqlite3.DatabaseError(
                    "Agent workspace path is unavailable or unsafe"
                ) from exc
            os.close(workspace_fd)
            workspaces[digest] = workspace

        legacy_root = data_root / "agent-skills"
        try:
            legacy_info = legacy_root.lstat()
        except FileNotFoundError:
            return []
        if stat.S_ISLNK(legacy_info.st_mode) or not stat.S_ISDIR(legacy_info.st_mode):
            raise sqlite3.DatabaseError("legacy Skill storage is unsafe")
        legacy_fd = open_private_directory_fd(legacy_root)
        try:
            with os.scandir(legacy_fd) as entries:
                unknown = next(
                    (entry.name for entry in entries if entry.name not in expected),
                    None,
                )
        finally:
            os.close(legacy_fd)
        if unknown is not None:
            raise sqlite3.DatabaseError(
                "legacy Skill storage contains an unknown scope: " + unknown
            )

        state_root = data_root / "agent-skill-state"
        try:
            state_root.lstat()
        except FileNotFoundError:
            pass
        else:
            state_root_fd = open_private_directory_fd(state_root)
            os.close(state_root_fd)

        copies: list[dict[str, Any]] = []
        for digest, row in expected.items():
            source = legacy_root / digest
            try:
                source.lstat()
            except FileNotFoundError:
                continue
            portable, sidecars, usage, source_fingerprint = (
                self._legacy_scope_skill_manifests(source)
            )
            workspace = workspaces[digest]
            internal = workspace / ".agent-platform"
            try:
                internal.lstat()
            except FileNotFoundError:
                pass
            else:
                internal_fd = open_private_directory_fd(internal)
                os.close(internal_fd)
            destination = internal / "skills"
            state_destination = state_root / digest
            destination_exists = _migration_path_exists(destination)
            state_exists = _migration_path_exists(state_destination)
            if destination_exists:
                _assert_migration_tree(destination, portable)
                destination_fd = open_private_directory_fd(destination)
                try:
                    planned_state = self._legacy_skill_state_manifest_fd(
                        destination_fd, sidecars, usage
                    )
                finally:
                    os.close(destination_fd)
                if state_exists:
                    _assert_migration_tree(state_destination, planned_state)
            elif state_exists:
                raise sqlite3.DatabaseError(
                    "Skill migration state exists without its workspace package"
                )
            copies.append(
                {
                    "digest": digest,
                    "source": source,
                    "source_fingerprint": source_fingerprint,
                    "workspace_parts": tuple(Path(str(row["workspace_path"])).parts),
                }
            )
            del portable, sidecars, usage
        return copies

    @staticmethod
    def _canonical_migration_workspace(row: sqlite3.Row) -> str:
        scope_key = str(row["scope_key"])
        scope_type = str(row["scope_type"])
        scope_id = str(row["scope_id"])
        if scope_type == "private":
            try:
                user_id = int(scope_id)
            except ValueError as exc:
                raise sqlite3.DatabaseError("private Agent scope id is invalid") from exc
            if user_id <= 0 or scope_id != str(user_id) or scope_key != f"private:{user_id}":
                raise sqlite3.DatabaseError("private Agent scope is noncanonical")
            return f"user-{user_id}"
        if scope_type == "channel":
            safe_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", scope_id).strip(".-") or "default"
            if not scope_id or scope_key != f"channel:{scope_id}:main-agent":
                raise sqlite3.DatabaseError("channel Agent scope is noncanonical")
            return f"channels/channel-{safe_id}"
        raise sqlite3.DatabaseError("Agent Skill scope type is unknown")

    @staticmethod
    def _legacy_scope_skill_manifests(
        source: Path,
    ) -> tuple[
        dict[tuple[str, ...], tuple[str, bytes]],
        dict[str, dict[str, Any]],
        dict[str, Any] | None,
        str,
    ]:
        from .skills import (
            MAX_SKILLS_PER_SCOPE,
            MAX_SUPPORT_DIRECTORIES,
            MAX_SUPPORT_FILES,
            MAX_SUPPORT_FILE_BYTES,
            MAX_SUPPORT_TOTAL_BYTES,
            _MAX_SIDECAR_BYTES,
            _MAX_SKILL_DOCUMENT_BYTES,
            _MAX_USAGE_STATE_BYTES,
            _parse_skill_document,
            _parse_usage_state,
            _validate_support_path,
            _validated_document,
        )

        tree = _read_migration_tree(source)
        root_directories = {
            relative[0]
            for relative, (kind, _payload) in tree.items()
            if len(relative) == 1 and kind == "directory"
        }
        root_files = {
            relative[0]
            for relative, (kind, _payload) in tree.items()
            if len(relative) == 1 and kind == "file"
        }
        legacy_lock = tree.get((".lock",))
        if (
            root_files - {".lock", ".skill-usage.json"}
            or legacy_lock not in (None, ("file", b""))
            or any(not _SKILL_ID_RE.fullmatch(name) for name in root_directories)
        ):
            raise sqlite3.DatabaseError("legacy Skill scope has unknown root entries")
        if len(root_directories) > MAX_SKILLS_PER_SCOPE:
            raise sqlite3.DatabaseError("legacy Skill scope exceeds its package limit")

        portable: dict[tuple[str, ...], tuple[str, bytes]] = {}
        sidecars: dict[str, dict[str, Any]] = {}
        for skill_id in sorted(root_directories):
            document_key = (skill_id, "SKILL.md")
            sidecar_key = (skill_id, ".skill.json")
            if tree.get(document_key, (None,))[0] != "file" or tree.get(
                sidecar_key, (None,)
            )[0] != "file":
                raise sqlite3.DatabaseError(
                    f"legacy Skill package is incomplete: {skill_id}"
                )
            support_file_count = 0
            support_directory_count = 0
            support_bytes = 0
            for relative, (kind, payload) in tree.items():
                if not relative or relative[0] != skill_id or len(relative) == 1:
                    continue
                child = relative[1]
                if len(relative) == 2 and child in {"SKILL.md", ".skill.json"}:
                    if kind != "file":
                        raise sqlite3.DatabaseError(
                            f"legacy Skill package has an unsafe root: {skill_id}"
                        )
                    continue
                if child not in _SKILL_SUPPORT_DIRECTORIES:
                    raise sqlite3.DatabaseError(
                        f"legacy Skill package has an unknown entry: {skill_id}/{child}"
                    )
                if len(relative) == 2 and kind != "directory":
                    raise sqlite3.DatabaseError(
                        f"legacy Skill support root is invalid: {skill_id}/{child}"
                    )
                if kind == "directory":
                    support_directory_count += 1
                    if support_directory_count > MAX_SUPPORT_DIRECTORIES:
                        raise sqlite3.DatabaseError(
                            f"legacy Skill support directory limit is exceeded: {skill_id}"
                        )
                if kind == "file":
                    try:
                        _validate_support_path("/".join(relative[1:]))
                    except Exception as exc:
                        raise sqlite3.DatabaseError(
                            f"legacy Skill support path is invalid: {'/'.join(relative)}"
                        ) from exc
                    support_file_count += 1
                    support_bytes += len(payload)
                    if (
                        len(payload) > MAX_SUPPORT_FILE_BYTES
                        or support_file_count > MAX_SUPPORT_FILES
                        or support_bytes > MAX_SUPPORT_TOTAL_BYTES
                    ):
                        raise sqlite3.DatabaseError(
                            f"legacy Skill support limits are exceeded: {skill_id}"
                        )
                portable[relative] = (kind, payload)
            portable[(skill_id,)] = ("directory", b"")
            portable[document_key] = tree[document_key]
            try:
                if (
                    len(tree[document_key][1]) > _MAX_SKILL_DOCUMENT_BYTES
                    or len(tree[sidecar_key][1]) > _MAX_SIDECAR_BYTES
                ):
                    raise ValueError("Skill metadata exceeds its size limit")
                document = tree[document_key][1].decode("utf-8")
                _validated_document(
                    **_parse_skill_document(document),
                    check_instruction_threats=False,
                    check_sensitive_material=False,
                )
                sidecar = json.loads(tree[sidecar_key][1].decode("utf-8"))
            except Exception as exc:
                raise sqlite3.DatabaseError(
                    f"legacy Skill package metadata is invalid: {skill_id}"
                ) from exc
            required = {
                "schema_version",
                "id",
                "enabled",
                "created_at",
                "updated_at",
            }
            if (
                not isinstance(sidecar, dict)
                or set(sidecar) != required
                or sidecar.get("schema_version") != 1
                or sidecar.get("id") != skill_id
                or not isinstance(sidecar.get("enabled"), bool)
                or any(
                    not isinstance(sidecar.get(field), str) or not sidecar[field]
                    for field in ("created_at", "updated_at")
                )
            ):
                raise sqlite3.DatabaseError(
                    f"legacy Skill sidecar is invalid: {skill_id}"
                )
            sidecars[skill_id] = sidecar

        usage: dict[str, Any] | None = None
        usage_entry = tree.get((".skill-usage.json",))
        if usage_entry is not None:
            try:
                if len(usage_entry[1]) > _MAX_USAGE_STATE_BYTES:
                    raise ValueError("Skill usage state exceeds its size limit")
                usage = _parse_usage_state(usage_entry[1])
            except Exception as exc:
                raise sqlite3.DatabaseError("legacy Skill usage state is invalid") from exc
            if set(usage["skills"]) != set(root_directories):
                raise sqlite3.DatabaseError(
                    "legacy Skill usage state does not match its packages"
                )
        elif root_directories:
            raise sqlite3.DatabaseError("legacy Skill usage state is missing")
        return portable, sidecars, usage, _migration_manifest_fingerprint(tree)

    def _publish_legacy_skill_copies(self, copies: list[dict[str, Any]]) -> None:
        if not copies:
            return
        if self._migration_data_dir is None:  # pragma: no cover - plan contract
            raise sqlite3.DatabaseError("database migration requires the data directory")
        data_root = Path(os.path.abspath(os.fspath(self._migration_data_dir)))
        data_root_fd = open_private_directory_fd(data_root)
        workspace_root_fd = -1
        state_root_fd = -1
        try:
            workspace_root_fd = open_private_child_directory_fd(
                data_root_fd, "workspaces"
            )
            state_root_fd, _created = _open_migration_child_directory_at(
                data_root_fd, "agent-skill-state", create=True
            )
            for copy in copies:
                portable, sidecars, usage, source_fingerprint = (
                    self._legacy_scope_skill_manifests(copy["source"])
                )
                if source_fingerprint != copy["source_fingerprint"]:
                    raise sqlite3.DatabaseError(
                        "legacy Skill source changed after migration preflight"
                    )
                chain = _open_migration_directory_chain_at(
                    workspace_root_fd, copy["workspace_parts"]
                )
                workspace_fd = chain[-1][2]
                internal_fd = -1
                skills_fd = -1
                state_fd = -1
                try:
                    internal_fd, _created = _open_migration_child_directory_at(
                        workspace_fd, ".agent-platform", create=True
                    )
                    skills_fd = _publish_migration_tree_at(
                        internal_fd, "skills", portable
                    )
                    state = self._legacy_skill_state_manifest_fd(
                        skills_fd, sidecars, usage
                    )
                    state_fd = _publish_migration_tree_at(
                        state_root_fd, copy["digest"], state
                    )
                    verify_private_child_directory_fd(
                        workspace_fd, ".agent-platform", internal_fd
                    )
                    _verify_migration_directory_chain(chain)
                finally:
                    if state_fd >= 0:
                        os.close(state_fd)
                    if skills_fd >= 0:
                        os.close(skills_fd)
                    if internal_fd >= 0:
                        os.close(internal_fd)
                    for _parent, _name, child_fd in reversed(chain):
                        os.close(child_fd)
                del portable, sidecars, usage, state

            for copy in copies:
                portable, sidecars, usage, source_fingerprint = (
                    self._legacy_scope_skill_manifests(copy["source"])
                )
                if source_fingerprint != copy["source_fingerprint"]:
                    raise sqlite3.DatabaseError(
                        "legacy Skill source changed after migration publication"
                    )
                chain = _open_migration_directory_chain_at(
                    workspace_root_fd, copy["workspace_parts"]
                )
                internal_fd = -1
                skills_fd = -1
                state_fd = -1
                try:
                    internal_fd = open_private_child_directory_fd(
                        chain[-1][2], ".agent-platform"
                    )
                    skills_fd = open_private_child_directory_fd(
                        internal_fd, "skills"
                    )
                    state_fd = open_private_child_directory_fd(
                        state_root_fd, copy["digest"]
                    )
                    state = self._legacy_skill_state_manifest_fd(
                        skills_fd, sidecars, usage
                    )
                    _assert_migration_tree_fd(skills_fd, portable, "skills")
                    _fsync_migration_tree_fd(skills_fd)
                    _assert_migration_tree_fd(state_fd, state, copy["digest"])
                    _fsync_migration_tree_fd(state_fd)
                    _assert_migration_tree_fd(skills_fd, portable, "skills")
                    _assert_migration_tree_fd(state_fd, state, copy["digest"])
                    verify_private_child_directory_fd(
                        state_root_fd, copy["digest"], state_fd
                    )
                    verify_private_child_directory_fd(
                        chain[-1][2], ".agent-platform", internal_fd
                    )
                    verify_private_child_directory_fd(
                        internal_fd, "skills", skills_fd
                    )
                    _verify_migration_directory_chain(chain)
                finally:
                    if state_fd >= 0:
                        os.close(state_fd)
                    if skills_fd >= 0:
                        os.close(skills_fd)
                    if internal_fd >= 0:
                        os.close(internal_fd)
                    for _parent, _name, child_fd in reversed(chain):
                        os.close(child_fd)
                del portable, sidecars, usage, state
                final_source_fingerprint = self._legacy_scope_skill_manifests(
                    copy["source"]
                )[3]
                if final_source_fingerprint != copy["source_fingerprint"]:
                    raise sqlite3.DatabaseError(
                        "legacy Skill source changed during final migration verification"
                    )
            verify_private_child_directory_fd(
                data_root_fd, "agent-skill-state", state_root_fd
            )
            verify_private_child_directory_fd(
                data_root_fd, "workspaces", workspace_root_fd
            )
            verify_private_directory_path_fd(data_root, data_root_fd)
        finally:
            if state_root_fd >= 0:
                os.close(state_root_fd)
            if workspace_root_fd >= 0:
                os.close(workspace_root_fd)
            os.close(data_root_fd)

    @staticmethod
    def _legacy_skill_state_manifest_fd(
        destination_fd: int,
        sidecars: dict[str, dict[str, Any]],
        usage: dict[str, Any] | None,
    ) -> dict[tuple[str, ...], tuple[str, bytes]]:
        from .skills import _render_sidecar, _render_usage_state

        manifest: dict[tuple[str, ...], tuple[str, bytes]] = {}
        for skill_id, old_sidecar in sorted(sidecars.items()):
            package_fd = open_private_child_directory_fd(
                destination_fd, skill_id
            )
            try:
                info = os.fstat(package_fd)
                verify_private_child_directory_fd(
                    destination_fd, skill_id, package_fd
                )
            finally:
                os.close(package_fd)
            sidecar = dict(old_sidecar)
            sidecar["package_dev"] = int(info.st_dev)
            sidecar["package_ino"] = int(info.st_ino)
            sidecar["package_ctime_ns"] = int(info.st_ctime_ns)
            manifest[(skill_id,)] = ("directory", b"")
            manifest[(skill_id, ".skill.json")] = (
                "file",
                _render_sidecar(sidecar),
            )
        if usage is not None:
            manifest[(".skill-usage.json",)] = (
                "file",
                _render_usage_state(usage),
            )
        return manifest

    def _assert_current_database_baseline(
        self,
        existing_tables: set[str] | None = None,
    ) -> None:
        """Reject every non-empty database outside the current product baseline."""

        tables = existing_tables or self._database_tables()
        markers = [
            (int(row["version"]), str(row["name"]))
            for row in self._conn.execute(
                "SELECT version, name FROM schema_migrations ORDER BY version"
            ).fetchall()
        ] if "schema_migrations" in tables else []
        if markers != [
            (_DATABASE_BASELINE_VERSION, self._database_baseline_name)
        ]:
            raise sqlite3.DatabaseError(
                "database does not match the current baseline marker"
            )
        self._assert_database_structure(tables)

    def _database_tables(self) -> set[str]:
        return {
            str(row["name"])
            for row in self._conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }

    def _assert_database_structure(
        self,
        tables: set[str],
        *,
        source_database_baseline: bool = False,
    ) -> None:
        agent_scope_columns = {
            "scope_key", "scope_type", "scope_id", "session_id",
            "lifecycle_id", "workspace_path", "sandbox_id", "created_at",
            "updated_at",
        }
        required_columns = {
            "schema_migrations": {"version", "name", "applied_at"},
            "users": {
                "id", "username", "display_name", "password_hash", "role",
                "position", "permission_group", "model_name", "thinking_depth",
                "timezone", "active", "token_version", "created_at", "last_login_at",
            },
            "channels": {
                "id", "name", "description", "created_by", "created_at", "archived",
            },
            "messages": {
                "id", "scope_type", "scope_id", "author_type", "user_id",
                "username", "content", "metadata_json", "hidden_at",
                "hidden_by_user_id", "created_at",
            },
            "conversation_revisions": {
                "scope_type", "scope_id", "revision", "reset_revision", "updated_at",
            },
            "attachments": {
                "id", "message_id", "scope_type", "scope_id", "uploader_user_id",
                "source", "filename", "storage_path", "mime_type", "size_bytes",
                "sha256", "created_at",
            },
            "token_usage_events": {
                "id", "user_id", "username", "display_name", "scope_type",
                "scope_id", "scope_name", "request_message_id",
                "response_message_id", "provider", "model", "input_tokens",
                "output_tokens", "total_tokens", "raw_usage_json", "degraded",
                "created_at",
            },
            "agent_scopes": agent_scope_columns,
            "agent_runtime_scopes": {
                "scope_key", "session_id", "lifecycle_id", "created_at", "updated_at",
            },
            "agent_runtime_scope_sessions": {
                "scope_key", "lifecycle_id", "session_id", "created_at",
            },
            "agent_memories": {
                "id", "scope_key", "target", "owner_user_id", "content",
                "tags_json", "source_type", "source_run_id", "source_message_id",
                "content_hash", "created_at", "updated_at",
            },
            "settings": {"key", "value", "secret", "updated_at"},
            "external_identities": {
                "provider", "external_id", "user_id", "username",
                "display_name", "metadata_json", "created_at", "updated_at",
            },
            "telegram_link_challenges": {
                "user_id", "code_hash", "expires_at", "created_at", "updated_at",
            },
            "telegram_updates": {
                "update_id", "status", "received_at", "processed_at",
                "last_error", "result_json",
            },
            "durable_jobs": {
                "id", "kind", "scope_type", "scope_id", "dedupe_key",
                "payload_json", "status", "attempts", "available_at",
                "lease_until", "last_error", "created_at", "updated_at",
            },
            "agent_run_inputs": {
                "message_id", "job_id", "parent_job_id", "input_group_id",
                "runtime_run_id", "state", "turn_id", "turn_index",
                "last_error", "created_at", "updated_at",
            },
            "agent_schedules": {
                "id", "owner_user_id", "name", "prompt", "schedule_json",
                "timezone", "delivery", "state", "enabled", "next_run_at",
                "last_run_id", "revision", "retry_after", "last_error",
                "created_at", "updated_at", "deleted_at",
            },
            "agent_schedule_runs": {
                "id", "schedule_id", "schedule_revision", "occurrence_key",
                "scheduled_for", "trigger", "status", "durable_job_id",
                "source_message_id", "response_message_id", "started_at",
                "finished_at", "error", "delivery_warning", "created_at",
                "updated_at",
            },
        }
        required_columns["mail_accounts"] = {
            "id", "owner_user_id", "label", "email_address", "username",
            "imap_host", "imap_port", "imap_security", "smtp_host",
            "smtp_port", "smtp_security", "enabled", "wake_enabled",
            "wake_folder", "poll_interval_seconds", "checkpoint_initialized",
            "uid_validity", "last_uid", "revision", "last_checked_at",
            "last_error", "created_at", "updated_at",
        }
        required_columns["mail_account_credentials"] = {
            "account_id", "password", "updated_at",
        }
        if source_database_baseline:
            required_columns["knowledge_documents"] = {
                "id", "title", "summary", "content", "source", "created_by",
                "created_at", "updated_at", "content_hash",
            }
            required_columns["sylver_platform_connections"] = {
                "owner_user_id", "base_url", "remote_user_id", "username",
                "full_name", "title", "email", "role", "verified_at",
                "created_at", "updated_at",
            }
            required_columns["sylver_platform_credentials"] = {
                "owner_user_id", "token", "updated_at",
            }
            required_columns.update({
                "knowledge_index_generations": {
                "id", "config_hash", "embedding_base_url",
                "embedding_model", "embedding_dimensions",
                "chunker_version", "status", "document_count",
                "ready_document_count", "last_error", "created_at",
                "updated_at", "activated_at",
            },
                "knowledge_document_index": {
                "generation_id", "document_id", "expected_hash",
                "status", "chunk_count", "last_error", "created_at",
                "updated_at",
            },
                "knowledge_chunks": {
                "generation_id", "chunk_id", "document_id",
                "chunk_index", "title_path", "content", "char_start",
                "char_end", "chunk_hash", "created_at",
            },
                "knowledge_chunk_embeddings": {
                "generation_id", "chunk_id", "dimensions", "vector",
                "norm", "created_at",
            },
            })
            required_columns["knowledge_document_files"] = {
                "document_id", "filename", "media_type", "size_bytes",
                "sha256", "content", "created_at",
            }
        fts_prefixes = [
            "agent_memory_fts",
            "message_fts",
            "message_fts_trigram",
        ]
        fts_tables = {
            f"{prefix}{suffix}"
            for prefix in fts_prefixes
            for suffix in ("", "_data", "_idx", "_docsize", "_config")
        }
        unexpected_tables = sorted(
            tables - set(required_columns) - fts_tables
        )
        if unexpected_tables:
            raise sqlite3.DatabaseError(
                "database contains tables outside the current baseline: "
                + ", ".join(unexpected_tables)
            )
        for table_name, expected in required_columns.items():
            if table_name not in tables:
                raise sqlite3.DatabaseError(
                    f"database is missing current baseline table {table_name}"
                )
            actual = {
                str(row["name"])
                for row in self._conn.execute(
                    f'PRAGMA table_info("{table_name}")'
                ).fetchall()
            }
            if actual != expected:
                missing = sorted(expected - actual)
                extra = sorted(actual - expected)
                differences = []
                if missing:
                    differences.append("missing " + ", ".join(missing))
                if extra:
                    differences.append("unexpected " + ", ".join(extra))
                raise sqlite3.DatabaseError(
                    f"database table {table_name} has non-current columns: "
                    + "; ".join(differences)
                )

        self._assert_table_sql(
            "attachments", "check(sourcein('upload','agent_generated'))"
        )
        self._assert_table_sql(
            "durable_jobs",
            "check(statusin('queued','running','succeeded','failed','needs_review'))",
        )
        self._assert_table_sql(
            "mail_accounts", "check(imap_securityin('tls','starttls'))"
        )
        self._assert_table_sql(
            "mail_accounts", "check(smtp_securityin('tls','starttls'))"
        )
        self._assert_table_sql(
            "mail_accounts", "check(poll_interval_secondsbetween60and3600)"
        )
        if source_database_baseline:
            self._assert_table_sql(
                "sylver_platform_connections", "check(length(base_url)>0)"
            )
            self._assert_table_sql(
                "sylver_platform_connections", "check(remote_user_id>0)"
            )
            self._assert_table_sql(
                "sylver_platform_connections", "check(length(username)>0)"
            )
            self._assert_table_sql(
                "sylver_platform_credentials", "check(length(token)>0)"
            )
        self._assert_table_sql(
            "agent_run_inputs",
            "check(statein('running','reserved','submitting','accepted','injected','unconsumed','succeeded','failed','needs_review'))",
        )
        self._assert_table_sql(
            "agent_schedules",
            "check(deliveryin('chat','chat_and_telegram'))",
        )
        self._assert_table_sql(
            "agent_schedules",
            "check(statein('active','paused','completed'))",
        )
        self._assert_table_sql(
            "agent_schedule_runs",
            "check(triggerin('scheduled','manual'))",
        )
        self._assert_table_sql(
            "agent_schedule_runs",
            "check(statusin('queued','running','succeeded','failed','needs_review','blocked','skipped','cancelled'))",
        )
        self._assert_table_sql(
            "agent_memories",
            "check(source_typein('manual','automatic'))",
        )
        if source_database_baseline:
            self._assert_table_sql(
                "knowledge_index_generations",
                "check(statusin('building','active','failed','superseded'))",
            )
            self._assert_table_sql(
                "knowledge_document_index",
                "check(statusin('pending','ready','failed'))",
            )
            self._assert_table_sql(
                "knowledge_chunks", "check(char_end>char_start)"
            )
            self._assert_table_sql(
                "knowledge_document_files", "check(length(content)=size_bytes)"
            )
        memory_sources = ("manual", "automatic")
        placeholders = ", ".join("?" for _ in memory_sources)
        invalid_sources = int(self._conn.execute(
            "SELECT count(*) FROM agent_memories "
            f"WHERE source_type NOT IN ({placeholders})",
            memory_sources,
        ).fetchone()[0])
        if invalid_sources:
            raise sqlite3.DatabaseError(
                "database contains invalid current memory sources"
            )

        required_indexes = {
            "idx_messages_visible_scope",
            "uq_agent_memories_dedupe",
            "idx_durable_jobs_ready",
            "idx_durable_jobs_scope",
            "idx_agent_run_inputs_group",
            "idx_agent_run_inputs_parent",
            "idx_agent_run_inputs_runtime",
            "idx_agent_schedules_due",
            "idx_agent_schedules_owner",
            "idx_agent_schedule_runs_schedule",
            "idx_agent_schedule_runs_job",
        }
        if source_database_baseline:
            required_indexes.update({
                "idx_knowledge_documents_content_hash",
                "idx_knowledge_index_generations_status",
                "uq_knowledge_index_generations_active",
                "idx_knowledge_document_index_status",
                "idx_knowledge_chunks_document",
            })
        required_indexes.update({
            "idx_mail_accounts_poll",
            "idx_mail_accounts_owner",
        })
        indexes = {
            str(row["name"])
            for row in self._conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
        missing_indexes = sorted(required_indexes - indexes)
        if missing_indexes:
            raise sqlite3.DatabaseError(
                "database is missing current baseline indexes: "
                + ", ".join(missing_indexes)
            )
        named_indexes = [
            ("idx_durable_jobs_ready", "durable_jobs", ("kind", "status", "available_at", "id")),
            ("idx_durable_jobs_scope", "durable_jobs", ("scope_type", "scope_id", "id")),
            ("idx_agent_run_inputs_group", "agent_run_inputs", ("input_group_id", "message_id")),
            ("idx_agent_run_inputs_parent", "agent_run_inputs", ("parent_job_id", "message_id")),
            ("idx_agent_run_inputs_runtime", "agent_run_inputs", ("runtime_run_id", "message_id")),
            ("idx_agent_schedules_due", "agent_schedules", ("enabled", "next_run_at", "id")),
            ("idx_agent_schedules_owner", "agent_schedules", ("owner_user_id", "deleted_at", "id")),
            ("idx_agent_schedule_runs_schedule", "agent_schedule_runs", ("schedule_id", "id")),
            ("idx_agent_schedule_runs_job", "agent_schedule_runs", ("durable_job_id",)),
        ]
        if source_database_baseline:
            named_indexes.extend([
                (
                    "idx_knowledge_index_generations_status",
                    "knowledge_index_generations",
                    ("status", "id"),
                ),
                (
                    "uq_knowledge_index_generations_active",
                    "knowledge_index_generations",
                    ("status",),
                ),
                (
                    "idx_knowledge_document_index_status",
                    "knowledge_document_index",
                    ("generation_id", "status", "document_id"),
                ),
                (
                    "idx_knowledge_chunks_document",
                    "knowledge_chunks",
                    ("generation_id", "document_id", "chunk_index"),
                ),
            ])
        named_indexes.extend([
            ("idx_mail_accounts_poll", "mail_accounts", ("enabled", "wake_enabled", "last_checked_at", "id")),
            ("idx_mail_accounts_owner", "mail_accounts", ("owner_user_id", "id")),
        ])
        for index_name, table_name, columns in named_indexes:
            self._assert_named_index(index_name, table_name, columns)
        self._assert_unique_columns("durable_jobs", ("kind", "dedupe_key"))
        self._assert_unique_columns("mail_accounts", ("owner_user_id", "email_address"))
        if source_database_baseline:
            self._assert_primary_key_columns(
                "sylver_platform_connections", ("owner_user_id",)
            )
            self._assert_primary_key_columns(
                "sylver_platform_credentials", ("owner_user_id",)
            )
            self._assert_unique_columns(
                "sylver_platform_connections", ("base_url", "remote_user_id")
            )
        self._assert_unique_columns("agent_run_inputs", ("job_id",))
        self._assert_unique_columns(
            "agent_schedule_runs",
            ("schedule_id", "schedule_revision", "occurrence_key"),
        )
        if source_database_baseline:
            self._assert_unique_columns(
                "knowledge_index_generations", ("status",)
            )
            self._assert_unique_columns(
                "knowledge_document_index", ("generation_id", "document_id")
            )
            self._assert_unique_columns(
                "knowledge_chunks", ("generation_id", "chunk_id")
            )
            self._assert_unique_columns(
                "knowledge_chunks",
                ("generation_id", "document_id", "chunk_index"),
            )
            self._assert_unique_columns(
                "knowledge_chunk_embeddings", ("generation_id", "chunk_id")
            )

        self._assert_foreign_keys("durable_jobs", set())
        self._assert_foreign_keys(
            "mail_accounts",
            {("owner_user_id", "users", "id", "CASCADE")},
        )
        self._assert_foreign_keys(
            "mail_account_credentials",
            {("account_id", "mail_accounts", "id", "CASCADE")},
        )
        if source_database_baseline:
            self._assert_foreign_keys(
                "sylver_platform_connections",
                {("owner_user_id", "users", "id", "CASCADE")},
            )
            self._assert_foreign_keys(
                "sylver_platform_credentials",
                {
                    (
                        "owner_user_id", "sylver_platform_connections",
                        "owner_user_id", "CASCADE",
                    )
                },
            )
        self._assert_foreign_keys("agent_run_inputs", set())
        self._assert_foreign_keys(
            "agent_schedules",
            {("owner_user_id", "users", "id", "CASCADE")},
        )
        self._assert_foreign_keys(
            "agent_schedule_runs",
            {
                ("schedule_id", "agent_schedules", "id", "CASCADE"),
                ("durable_job_id", "durable_jobs", "id", "NO ACTION"),
                ("source_message_id", "messages", "id", "NO ACTION"),
                ("response_message_id", "messages", "id", "NO ACTION"),
            },
        )
        if source_database_baseline:
            self._assert_foreign_keys("knowledge_index_generations", set())
            self._assert_foreign_keys(
                "knowledge_document_index",
                {
                    (
                        "generation_id", "knowledge_index_generations", "id",
                        "CASCADE",
                    ),
                    ("document_id", "knowledge_documents", "id", "CASCADE"),
                },
            )
            self._assert_foreign_keys(
                "knowledge_chunks",
                {
                    (
                        "generation_id", "knowledge_index_generations", "id",
                        "CASCADE",
                    ),
                    ("document_id", "knowledge_documents", "id", "CASCADE"),
                },
            )
            self._assert_foreign_keys(
                "knowledge_chunk_embeddings",
                {
                    (
                        "generation_id", "knowledge_chunks", "generation_id",
                        "CASCADE",
                    ),
                    ("chunk_id", "knowledge_chunks", "chunk_id", "CASCADE"),
                },
            )
            self._assert_foreign_keys(
                "knowledge_document_files",
                {("document_id", "knowledge_documents", "id", "CASCADE")},
            )

        required_triggers = {
            "conversation_revision_ai",
            "conversation_revision_hidden_au",
            "conversation_revision_metadata_au",
            "conversation_revision_ad",
        }
        optional_fts_triggers: dict[str, set[str]] = {
            "agent_memory_fts": {
                "agent_memory_ai", "agent_memory_ad", "agent_memory_au",
            },
            "message_fts": {
                "message_fts_ai", "message_fts_ad", "message_fts_au",
            },
            "message_fts_trigram": {
                "message_fts_trigram_ai", "message_fts_trigram_ad",
                "message_fts_trigram_au",
            },
        }
        allowed_triggers = set(required_triggers)
        for table_name, names in optional_fts_triggers.items():
            if table_name in tables:
                required_triggers.update(names)
                allowed_triggers.update(names)
        triggers = {
            str(row["name"])
            for row in self._conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
            ).fetchall()
        }
        missing_triggers = sorted(required_triggers - triggers)
        if missing_triggers:
            raise sqlite3.DatabaseError(
                "database is missing current baseline triggers: "
                + ", ".join(missing_triggers)
            )
        unexpected_triggers = sorted(triggers - allowed_triggers)
        if unexpected_triggers:
            raise sqlite3.DatabaseError(
                "database contains triggers outside the current baseline: "
                + ", ".join(unexpected_triggers)
            )

        durable_start = self._conn.execute(
            "SELECT value FROM settings "
            "WHERE key = 'durable_agent_jobs_start_message_id'"
        ).fetchone()
        try:
            durable_start_id = int(durable_start["value"]) if durable_start else -1
        except (TypeError, ValueError):
            durable_start_id = -1
        if durable_start_id < 0:
            raise sqlite3.DatabaseError(
                "database durable Agent message high-water mark is invalid"
            )

        missing_parents = self._missing_foreign_key_parents()
        if missing_parents:
            raise sqlite3.DatabaseError(
                "database has missing foreign-key parents: "
                + ", ".join(missing_parents)
            )
        violations = self._conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise sqlite3.IntegrityError(
                f"database has {len(violations)} foreign-key violations"
            )

    def _assert_table_sql(self, table_name: str, required_fragment: str) -> None:
        row = self._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        normalized = "".join(str(row["sql"] or "").casefold().split()) if row else ""
        if required_fragment not in normalized:
            raise sqlite3.DatabaseError(
                f"database table {table_name} is outside the current baseline"
            )

    def _assert_primary_key_columns(
        self,
        table_name: str,
        columns: tuple[str, ...],
    ) -> None:
        actual = tuple(
            str(row["name"])
            for row in sorted(
                (
                    row
                    for row in self._conn.execute(
                        f'PRAGMA table_info("{table_name}")'
                    ).fetchall()
                    if int(row["pk"] or 0) > 0
                ),
                key=lambda row: int(row["pk"]),
            )
        )
        if actual != columns:
            raise sqlite3.DatabaseError(
                f"database table {table_name} has a non-current primary key"
            )

    def _assert_named_index(
        self,
        index_name: str,
        table_name: str,
        columns: tuple[str, ...],
    ) -> None:
        row = self._conn.execute(
            "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?",
            (index_name,),
        ).fetchone()
        actual_columns = tuple(
            str(item["name"])
            for item in self._conn.execute(
                f'PRAGMA index_info("{index_name}")'
            ).fetchall()
        )
        if row is None or str(row["tbl_name"]) != table_name or actual_columns != columns:
            raise sqlite3.DatabaseError(
                f"database index {index_name} is outside the current baseline"
            )

    def _assert_unique_columns(
        self,
        table_name: str,
        columns: tuple[str, ...],
    ) -> None:
        for index in self._conn.execute(
            f'PRAGMA index_list("{table_name}")'
        ).fetchall():
            if not int(index["unique"]):
                continue
            index_name = str(index["name"])
            actual_columns = tuple(
                str(item["name"])
                for item in self._conn.execute(
                    f'PRAGMA index_info("{index_name}")'
                ).fetchall()
            )
            if actual_columns == columns:
                return
        raise sqlite3.DatabaseError(
            f"database table {table_name} is missing current unique constraint"
        )

    def _assert_foreign_keys(
        self,
        table_name: str,
        expected: set[tuple[str, str, str, str]],
    ) -> None:
        actual = {
            (
                str(row["from"]),
                str(row["table"]),
                str(row["to"]),
                str(row["on_delete"]),
            )
            for row in self._conn.execute(
                f'PRAGMA foreign_key_list("{table_name}")'
            ).fetchall()
        }
        if actual != expected:
            raise sqlite3.DatabaseError(
                f"database table {table_name} has non-current foreign keys"
            )

    def _missing_foreign_key_parents(self) -> list[str]:
        """Return child-to-parent edges whose declared parent table is absent."""

        rows = self._conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
        tables = {str(row["name"]).casefold() for row in rows}
        missing: set[str] = set()
        for row in rows:
            child_name = str(row["name"])
            quoted_name = '"' + child_name.replace('"', '""') + '"'
            foreign_keys = self._conn.execute(
                f"PRAGMA foreign_key_list({quoted_name})"
            ).fetchall()
            for foreign_key in foreign_keys:
                parent_name = str(foreign_key["table"])
                if parent_name.casefold() not in tables:
                    missing.add(f"{child_name}->{parent_name}")
        return sorted(missing)

    def _ensure_fts(self) -> None:
        try:
            memory_fts_rebuilt = self._ensure_agent_memory_fts_contract()
            memory_count = self._conn.execute(
                "SELECT count(*) FROM agent_memories"
            ).fetchone()[0]
            if memory_count > 0 and not memory_fts_rebuilt:
                indexed = self._conn.execute(
                    "SELECT count(*) FROM agent_memory_fts_docsize"
                ).fetchone()[0]
                if indexed != memory_count:
                    self._conn.execute(
                        "INSERT INTO agent_memory_fts(agent_memory_fts) "
                        "VALUES('rebuild')"
                    )
            self.fts_available = True
        except sqlite3.OperationalError:
            self.fts_available = False

    def _ensure_agent_memory_fts_contract(self) -> bool:
        """Repair the derived memory index when its projection has drifted.

        The authoritative table stores ``tags_json``. An earlier FTS definition
        exposed that source value through a non-existent external-content column
        named ``tags``, so FTS5 tried to read ``agent_memories.tags`` during a
        rebuild or query. Validate the complete owned schema rather than trusting
        ``CREATE ... IF NOT EXISTS`` and replace only these derived objects when
        they differ.

        Returns True when the index was recreated and already rebuilt.
        """

        table = self._conn.execute(
            "SELECT sql FROM sqlite_master "
            "WHERE type = 'table' AND name = 'agent_memory_fts'"
        ).fetchone()
        columns = tuple(
            str(row["name"])
            for row in self._conn.execute(
                'PRAGMA table_info("agent_memory_fts")'
            ).fetchall()
        )
        matches = (
            table is not None
            and columns == ("content", "tags_json")
            and _normalized_schema_sql(table["sql"])
            == _normalized_schema_sql(_AGENT_MEMORY_FTS_TABLE_SQL)
        )
        if matches:
            for trigger_name, expected_sql in _AGENT_MEMORY_FTS_TRIGGER_SQL.items():
                trigger = self._conn.execute(
                    "SELECT tbl_name, sql FROM sqlite_master "
                    "WHERE type = 'trigger' AND name = ?",
                    (trigger_name,),
                ).fetchone()
                if (
                    trigger is None
                    or str(trigger["tbl_name"]) != "agent_memories"
                    or _normalized_schema_sql(trigger["sql"])
                    != _normalized_schema_sql(expected_sql)
                ):
                    matches = False
                    break
        if matches:
            return False

        savepoint = "agent_memory_fts_contract"
        self._conn.execute(f"SAVEPOINT {savepoint}")
        try:
            for trigger_name in _AGENT_MEMORY_FTS_TRIGGER_SQL:
                self._conn.execute(f'DROP TRIGGER IF EXISTS "{trigger_name}"')
            self._conn.execute('DROP TABLE IF EXISTS "agent_memory_fts"')
            self._conn.execute(_AGENT_MEMORY_FTS_TABLE_SQL)
            for trigger_sql in _AGENT_MEMORY_FTS_TRIGGER_SQL.values():
                self._conn.execute(trigger_sql)
            self._conn.execute(
                "INSERT INTO agent_memory_fts(agent_memory_fts) VALUES('rebuild')"
            )
        except sqlite3.OperationalError as exc:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            # A partially present memory FTS schema is a broken derived
            # contract, not an optional-capability fallback.
            raise sqlite3.DatabaseError(
                "agent memory FTS contract repair failed"
            ) from exc
        except BaseException:
            self._conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        self._conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        return True

    def _ensure_message_fts(self) -> None:
        """Maintain a message index for internal cross-session search.

        Trigram tokenization materially improves CJK substring search, but it
        is optional in some SQLite builds. Keep the normal unicode index
        available even when creation of the trigram variant fails.
        """

        try:
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS message_fts "
                "USING fts5(content, content='messages', content_rowid='id')"
            )
            self._conn.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS message_fts_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO message_fts(rowid, content) VALUES (new.id, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS message_fts_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO message_fts(message_fts, rowid, content)
                    VALUES ('delete', old.id, old.content);
                END;
                CREATE TRIGGER IF NOT EXISTS message_fts_au AFTER UPDATE OF content ON messages BEGIN
                    INSERT INTO message_fts(message_fts, rowid, content)
                    VALUES ('delete', old.id, old.content);
                    INSERT INTO message_fts(rowid, content) VALUES (new.id, new.content);
                END;
                """
            )
            message_count = self._conn.execute(
                "SELECT count(*) FROM messages"
            ).fetchone()[0]
            if message_count > 0:
                indexed = self._conn.execute(
                    "SELECT count(*) FROM message_fts_docsize"
                ).fetchone()[0]
                if indexed != message_count:
                    self._conn.execute(
                        "INSERT INTO message_fts(message_fts) VALUES('rebuild')"
                    )
            self.message_fts_available = True
        except sqlite3.OperationalError:
            self.message_fts_available = False

        if not self.message_fts_available:
            self.message_fts_trigram_available = False
            return
        try:
            self._conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_trigram "
                "USING fts5(content, content='messages', content_rowid='id', tokenize='trigram')"
            )
            self._conn.executescript(
                """
                CREATE TRIGGER IF NOT EXISTS message_fts_trigram_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO message_fts_trigram(rowid, content) VALUES (new.id, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS message_fts_trigram_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO message_fts_trigram(message_fts_trigram, rowid, content)
                    VALUES ('delete', old.id, old.content);
                END;
                CREATE TRIGGER IF NOT EXISTS message_fts_trigram_au
                AFTER UPDATE OF content ON messages BEGIN
                    INSERT INTO message_fts_trigram(message_fts_trigram, rowid, content)
                    VALUES ('delete', old.id, old.content);
                    INSERT INTO message_fts_trigram(rowid, content)
                    VALUES (new.id, new.content);
                END;
                """
            )
            message_count = self._conn.execute(
                "SELECT count(*) FROM messages"
            ).fetchone()[0]
            if message_count > 0:
                indexed = self._conn.execute(
                    "SELECT count(*) FROM message_fts_trigram_docsize"
                ).fetchone()[0]
                if indexed != message_count:
                    self._conn.execute(
                        "INSERT INTO message_fts_trigram(message_fts_trigram) VALUES('rebuild')"
                    )
            self.message_fts_trigram_available = True
        except sqlite3.OperationalError:
            self.message_fts_trigram_available = False

    @contextmanager
    def transaction(
        self, *, immediate: bool = False
    ) -> Iterator[sqlite3.Connection]:
        """Run several writes on this thread's connection as one transaction.

        Yields the thread-local connection. Statements issued through the
        yielded connection (conn.execute/executemany) are committed together on
        clean exit and rolled back on any exception, so a multi-row write such
        as a message plus its attachment rows lands atomically instead of being
        committed one statement at a time. The per-statement helpers below keep
        their immediate commits for single writes; callers that need atomicity
        should issue their statements through this connection directly and avoid
        the auto-committing helpers inside the block.
        """
        conn = self._conn
        try:
            if immediate:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        else:
            self._commit_or_rollback(conn)

    @staticmethod
    def _commit_or_rollback(conn: sqlite3.Connection) -> None:
        """Commit one write, restoring a reusable connection on failure."""

        try:
            conn.commit()
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        conn = self._conn
        try:
            cur = conn.execute(sql, tuple(params))
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        self._commit_or_rollback(conn)
        return cur

    def executemany(self, sql: str, seq: Iterable[Iterable[Any]]) -> None:
        conn = self._conn
        try:
            conn.executemany(sql, seq)
        except BaseException:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        self._commit_or_rollback(conn)

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        rows = self._conn.execute(sql, tuple(params)).fetchall()
        return [dict(row) for row in rows]

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        row = self._conn.execute(sql, tuple(params)).fetchone()
        return dict(row) if row else None

    def scalar(self, sql: str, params: Iterable[Any] = ()) -> Any:
        row = self._conn.execute(sql, tuple(params)).fetchone()
        return row[0] if row else None

    def insert(self, sql: str, params: Iterable[Any] = ()) -> int:
        conn = self._conn
        cur = conn.execute(sql, tuple(params))
        conn.commit()
        return int(cur.lastrowid)


def migrate_database(
    path: Path,
    technical_profile_value: TechnicalProfile | str = TARGET_TECHNICAL_PROFILE,
    *,
    data_dir: Path,
) -> int:
    """Apply the sole supported direct baseline migration and verify its result.

    Normal ``Database`` construction never accepts a previous marker. The
    deployment-only migrate command must opt into this function after Manager
    has stopped the current writer and created its rollback snapshot.
    """

    database = Database(
        path,
        technical_profile_value,
        allow_source_migration=True,
        migration_data_dir=data_dir,
    )
    try:
        return int(
            database.scalar(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
            )
            or 0
        )
    finally:
        database.close()


def encode_json(value: dict[str, Any] | list[Any] | None) -> str:
    return json.dumps({} if value is None else value, ensure_ascii=False, separators=(",", ":"))


def decode_json(value: str | None) -> Any:
    if not value:
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}
