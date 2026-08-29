from __future__ import annotations

import os
import re
import sqlite3
import stat
import sys
from pathlib import Path


COMPATIBILITY_MARKER = "2026080801-to-2026082901"
_DIRECTORY_MODE = 0o700
_LEGACY_MODE = 0o755
_MAX_WORKSPACES = 10_000
_USER_WORKSPACE = re.compile(r"user-[1-9][0-9]*\Z")
_CHANNEL_WORKSPACE = re.compile(
    r"channel-(?:default|[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)\Z"
)


class WorkspaceMountCompatibilityError(RuntimeError):
    pass


def _directory_flags() -> int:
    if not hasattr(os, "O_DIRECTORY") or not hasattr(os, "O_NOFOLLOW"):
        raise WorkspaceMountCompatibilityError(
            "secure workspace compatibility traversal is unavailable"
        )
    return (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_NOFOLLOW
        | getattr(os, "O_CLOEXEC", 0)
    )


def _identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        int(info.st_dev),
        int(info.st_ino),
        int(info.st_uid),
        int(info.st_gid),
        stat.S_IMODE(info.st_mode),
    )


def _open_child(parent_fd: int, name: str) -> int:
    if not name or name in {".", ".."} or "/" in name or "\x00" in name:
        raise WorkspaceMountCompatibilityError("unsafe workspace path segment")
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        child_fd = os.open(name, _directory_flags(), dir_fd=parent_fd)
    except OSError as exc:
        raise WorkspaceMountCompatibilityError(
            f"unsafe workspace compatibility directory: {name}"
        ) from exc
    opened = os.fstat(child_fd)
    if (
        not stat.S_ISDIR(before.st_mode)
        or not stat.S_ISDIR(opened.st_mode)
        or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
    ):
        os.close(child_fd)
        raise WorkspaceMountCompatibilityError(
            f"workspace compatibility directory changed: {name}"
        )
    return child_fd


def _open_absolute_directory(path: Path) -> int:
    absolute = Path(os.path.abspath(os.fspath(path)))
    current_fd = os.open("/", _directory_flags())
    try:
        for part in absolute.parts[1:]:
            next_fd = _open_child(current_fd, part)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except BaseException:
        os.close(current_fd)
        raise


def _require_identity(
    info: os.stat_result,
    *,
    uid: int,
    gid: int,
    modes: tuple[int, ...],
    device: int | None,
    display: str,
) -> None:
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != uid
        or info.st_gid != gid
        or stat.S_IMODE(info.st_mode) not in modes
        or (device is not None and info.st_dev != device)
    ):
        raise WorkspaceMountCompatibilityError(
            f"unsafe workspace compatibility identity: {display}"
        )


def _verify_entry(parent_fd: int, name: str, child_fd: int) -> os.stat_result:
    opened = os.fstat(child_fd)
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (
        not stat.S_ISDIR(current.st_mode)
        or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
    ):
        raise WorkspaceMountCompatibilityError(
            f"workspace compatibility entry changed: {name}"
        )
    return opened


def _entries(directory_fd: int) -> list[str]:
    try:
        with os.scandir(directory_fd) as entries:
            result = []
            for entry in entries:
                result.append(entry.name)
                if len(result) > _MAX_WORKSPACES:
                    raise WorkspaceMountCompatibilityError(
                        "workspace compatibility entry limit exceeded"
                    )
            return sorted(result)
    except OSError as exc:
        raise WorkspaceMountCompatibilityError(
            "cannot inspect workspace compatibility directory"
        ) from exc


def _workspace_parts(
    workspaces_fd: int,
    target_uid: int,
    target_gid: int,
    device: int,
) -> list[tuple[str, ...]]:
    result: list[tuple[str, ...]] = []
    names = _entries(workspaces_fd)
    for name in names:
        if _USER_WORKSPACE.fullmatch(name):
            result.append((name,))
        elif name == "channels":
            channels_fd = _open_child(workspaces_fd, name)
            try:
                _require_identity(
                    os.fstat(channels_fd),
                    uid=target_uid,
                    gid=target_gid,
                    modes=(_DIRECTORY_MODE,),
                    device=device,
                    display="channels",
                )
                for channel in _entries(channels_fd):
                    if _CHANNEL_WORKSPACE.fullmatch(channel):
                        result.append((name, channel))
            finally:
                os.close(channels_fd)
        if len(result) > _MAX_WORKSPACES:
            raise WorkspaceMountCompatibilityError(
                "workspace compatibility scope limit exceeded"
            )
    return result


def _open_workspace(
    workspaces_fd: int,
    parts: tuple[str, ...],
    target_uid: int,
    target_gid: int,
    device: int,
) -> tuple[int, list[tuple[int, str, int]]]:
    chain: list[tuple[int, str, int]] = []
    parent_fd = workspaces_fd
    try:
        for name in parts:
            child_fd = _open_child(parent_fd, name)
            _require_identity(
                os.fstat(child_fd),
                uid=target_uid,
                gid=target_gid,
                modes=(_DIRECTORY_MODE,),
                device=device,
                display="/".join(parts),
            )
            chain.append((parent_fd, name, child_fd))
            parent_fd = child_fd
        return parent_fd, chain
    except BaseException:
        for _parent, _name, child_fd in reversed(chain):
            os.close(child_fd)
        raise


def _inspect_internal(
    workspace_fd: int,
    display: str,
    target_uid: int,
    target_gid: int,
    device: int,
) -> tuple[tuple[int, int, int, int, int], tuple[int, int, int, int, int] | None] | None:
    try:
        internal_fd = _open_child(workspace_fd, ".agent-platform")
    except WorkspaceMountCompatibilityError as exc:
        try:
            os.stat(
                ".agent-platform",
                dir_fd=workspace_fd,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return None
        raise exc
    try:
        internal = os.fstat(internal_fd)
        mode = stat.S_IMODE(internal.st_mode)
        if internal.st_dev != device:
            raise WorkspaceMountCompatibilityError(
                f"legacy workspace mount crosses a filesystem: {display}"
            )
        if (internal.st_uid, internal.st_gid) == (target_uid, target_gid):
            if mode not in (_DIRECTORY_MODE, _LEGACY_MODE):
                raise WorkspaceMountCompatibilityError(
                    f"legacy workspace mount has an unsafe mode: {display}"
                )
            return _identity(internal), None
        if (internal.st_uid, internal.st_gid, mode) != (0, 0, _LEGACY_MODE):
            raise WorkspaceMountCompatibilityError(
                f"legacy workspace mount has an unsafe owner: {display}"
            )
        if _entries(internal_fd) != ["attachments"]:
            raise WorkspaceMountCompatibilityError(
                f"legacy workspace mount has unexpected entries: {display}"
            )
        attachments_fd = _open_child(internal_fd, "attachments")
        try:
            attachments = os.fstat(attachments_fd)
            owner = (attachments.st_uid, attachments.st_gid)
            attachment_mode = stat.S_IMODE(attachments.st_mode)
            if (
                attachments.st_dev != device
                or owner not in ((0, 0), (target_uid, target_gid))
                or (
                    owner == (0, 0)
                    and attachment_mode != _LEGACY_MODE
                )
                or (
                    owner == (target_uid, target_gid)
                    and attachment_mode not in (_LEGACY_MODE, _DIRECTORY_MODE)
                )
                or _entries(attachments_fd)
            ):
                raise WorkspaceMountCompatibilityError(
                    f"legacy attachment mount is unsafe or nonempty: {display}"
                )
            _verify_entry(internal_fd, "attachments", attachments_fd)
            return _identity(internal), _identity(attachments)
        finally:
            os.close(attachments_fd)
    finally:
        os.close(internal_fd)


def _plan(
    workspaces_fd: int,
    target_uid: int,
    target_gid: int,
    device: int,
) -> list[
    tuple[
        tuple[str, ...],
        tuple[int, int, int, int, int],
        tuple[int, int, int, int, int],
        tuple[int, int, int, int, int] | None,
    ]
]:
    plans = []
    for parts in _workspace_parts(
        workspaces_fd, target_uid, target_gid, device
    ):
        workspace_fd, chain = _open_workspace(
            workspaces_fd, parts, target_uid, target_gid, device
        )
        try:
            workspace_identity = _identity(os.fstat(workspace_fd))
            internal = _inspect_internal(
                workspace_fd,
                "/".join(parts) + "/.agent-platform",
                target_uid,
                target_gid,
                device,
            )
            if internal is not None:
                plans.append((parts, workspace_identity, *internal))
        finally:
            for _parent, _name, child_fd in reversed(chain):
                os.close(child_fd)
    return plans


def _apply_plan(
    workspaces_fd: int,
    plan: tuple[
        tuple[str, ...],
        tuple[int, int, int, int, int],
        tuple[int, int, int, int, int],
        tuple[int, int, int, int, int] | None,
    ],
    target_uid: int,
    target_gid: int,
    device: int,
) -> None:
    parts, workspace_expected, internal_expected, attachments_expected = plan
    workspace_fd, chain = _open_workspace(
        workspaces_fd, parts, target_uid, target_gid, device
    )
    internal_fd = -1
    attachments_fd = -1
    try:
        if _identity(os.fstat(workspace_fd)) != workspace_expected:
            raise WorkspaceMountCompatibilityError(
                "workspace changed after compatibility preflight"
            )
        internal_fd = _open_child(workspace_fd, ".agent-platform")
        if _identity(os.fstat(internal_fd)) != internal_expected:
            raise WorkspaceMountCompatibilityError(
                "legacy workspace mount changed after preflight"
            )
        if attachments_expected is not None:
            if _entries(internal_fd) != ["attachments"]:
                raise WorkspaceMountCompatibilityError(
                    "legacy workspace mount changed after preflight"
                )
            attachments_fd = _open_child(internal_fd, "attachments")
            if (
                _identity(os.fstat(attachments_fd)) != attachments_expected
                or _entries(attachments_fd)
            ):
                raise WorkspaceMountCompatibilityError(
                    "legacy attachment mount changed after preflight"
                )
            attachments = os.fstat(attachments_fd)
            if (attachments.st_uid, attachments.st_gid) == (0, 0):
                os.fchown(attachments_fd, target_uid, target_gid)
            if stat.S_IMODE(os.fstat(attachments_fd).st_mode) != _DIRECTORY_MODE:
                os.fchmod(attachments_fd, _DIRECTORY_MODE)
            _require_identity(
                _verify_entry(internal_fd, "attachments", attachments_fd),
                uid=target_uid,
                gid=target_gid,
                modes=(_DIRECTORY_MODE,),
                device=device,
                display="attachments",
            )
            if _entries(attachments_fd):
                raise WorkspaceMountCompatibilityError(
                    "legacy attachment mount changed during compatibility"
                )
            os.fsync(attachments_fd)
            os.fsync(internal_fd)

        internal = os.fstat(internal_fd)
        if (internal.st_uid, internal.st_gid) == (0, 0):
            os.fchown(internal_fd, target_uid, target_gid)
        if stat.S_IMODE(os.fstat(internal_fd).st_mode) != _DIRECTORY_MODE:
            os.fchmod(internal_fd, _DIRECTORY_MODE)
        _require_identity(
            _verify_entry(workspace_fd, ".agent-platform", internal_fd),
            uid=target_uid,
            gid=target_gid,
            modes=(_DIRECTORY_MODE,),
            device=device,
            display="/".join(parts) + "/.agent-platform",
        )
        os.fsync(internal_fd)
        os.fsync(workspace_fd)
    finally:
        if attachments_fd >= 0:
            os.close(attachments_fd)
        if internal_fd >= 0:
            os.close(internal_fd)
        for _parent, _name, child_fd in reversed(chain):
            os.close(child_fd)


def normalize_legacy_workspace_mounts(
    data_dir: Path,
    *,
    target_uid: int,
    target_gid: int,
) -> int:
    if os.geteuid() != 0:
        raise WorkspaceMountCompatibilityError(
            "workspace mount compatibility requires root"
        )
    if not (0 < target_uid <= 2_147_483_647) or not (
        0 < target_gid <= 2_147_483_647
    ):
        raise WorkspaceMountCompatibilityError(
            "workspace mount compatibility target identity is invalid"
        )
    data_fd = _open_absolute_directory(data_dir)
    workspaces_fd = -1
    try:
        data_info = os.fstat(data_fd)
        data_expected = _identity(data_info)
        _require_identity(
            data_info,
            uid=target_uid,
            gid=target_gid,
            modes=(_DIRECTORY_MODE,),
            device=None,
            display=str(data_dir),
        )
        workspaces_fd = _open_child(data_fd, "workspaces")
        workspaces_info = os.fstat(workspaces_fd)
        workspaces_expected = _identity(workspaces_info)
        _require_identity(
            workspaces_info,
            uid=target_uid,
            gid=target_gid,
            modes=(_DIRECTORY_MODE,),
            device=data_info.st_dev,
            display="workspaces",
        )
        plans = _plan(
            workspaces_fd,
            target_uid,
            target_gid,
            int(data_info.st_dev),
        )
        for plan in plans:
            _apply_plan(
                workspaces_fd,
                plan,
                target_uid,
                target_gid,
                int(data_info.st_dev),
            )
        current_workspaces = _verify_entry(
            data_fd,
            "workspaces",
            workspaces_fd,
        )
        if _identity(current_workspaces) != workspaces_expected:
            raise WorkspaceMountCompatibilityError(
                "workspaces root changed during workspace compatibility"
            )
        _require_identity(
            current_workspaces,
            uid=target_uid,
            gid=target_gid,
            modes=(_DIRECTORY_MODE,),
            device=data_info.st_dev,
            display="workspaces",
        )
        current_data_fd = _open_absolute_directory(data_dir)
        try:
            if _identity(os.fstat(current_data_fd)) != data_expected:
                raise WorkspaceMountCompatibilityError(
                    "data root changed during workspace compatibility"
                )
        finally:
            os.close(current_data_fd)
        return len(plans)
    finally:
        if workspaces_fd >= 0:
            os.close(workspaces_fd)
        os.close(data_fd)


def _source_database_requires_compatibility(data_dir: Path) -> bool:
    from .db import assert_existing_database_profile

    try:
        baseline = assert_existing_database_profile(
            data_dir / "platform.db",
            allow_source_migration=True,
        )
    except (OSError, RuntimeError, sqlite3.Error) as exc:
        raise WorkspaceMountCompatibilityError(
            "cannot verify workspace compatibility source database"
        ) from exc
    return baseline == 2026080801


def main() -> None:
    if os.environ.get("AGENT_PLATFORM_WORKSPACE_MOUNT_COMPAT") != COMPATIBILITY_MARKER:
        raise SystemExit("workspace mount compatibility marker is invalid")
    if os.environ.get("AGENT_PLATFORM_DATA") != "/var/lib/agent-platform":
        raise SystemExit("workspace mount compatibility data root is invalid")
    try:
        target_uid = int(os.environ["AGENT_PLATFORM_RUN_UID"])
        target_gid = int(os.environ["AGENT_PLATFORM_RUN_GID"])
    except (KeyError, ValueError) as exc:
        raise SystemExit("workspace mount compatibility identity is invalid") from exc
    data_dir = Path(os.environ["AGENT_PLATFORM_DATA"])
    if sys.argv[1:] == ["--check-source"]:
        if (
            (os.getuid(), os.geteuid()) != (target_uid, target_uid)
            or (os.getgid(), os.getegid()) != (target_gid, target_gid)
            or os.getgroups()
        ):
            raise SystemExit(
                "workspace mount compatibility source check identity is invalid"
            )
        try:
            required = _source_database_requires_compatibility(data_dir)
        except WorkspaceMountCompatibilityError as exc:
            raise SystemExit(str(exc)) from exc
        print("apply" if required else "skip")
        return
    if sys.argv[1:]:
        raise SystemExit("workspace mount compatibility command is invalid")
    try:
        normalize_legacy_workspace_mounts(
            data_dir,
            target_uid=target_uid,
            target_gid=target_gid,
        )
    except (OSError, WorkspaceMountCompatibilityError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
