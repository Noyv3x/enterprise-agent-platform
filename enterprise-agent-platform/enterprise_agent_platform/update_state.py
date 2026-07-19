from __future__ import annotations

import argparse
import fcntl
import json
import os
import stat
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


AUTO_UPDATE_STATE_FILENAME = "auto-update-state.json"
AUTO_UPDATE_STATE_LOCK_FILENAME = "auto-update-state.lock"
AUTO_UPDATE_STATE_SCHEMA_VERSION = 1
PUBLIC_UPDATE_STATES = frozenset({"idle", "waiting_for_tasks", "updating", "failed"})
BLOCKING_UPDATE_STATES = frozenset({"updating", "failed"})
STALE_UPDATE_HEARTBEAT_SECONDS = 60


def state_path(data_dir: Path | str) -> Path:
    return Path(data_dir).expanduser().resolve() / AUTO_UPDATE_STATE_FILENAME


def state_lock_path(data_dir: Path | str) -> Path:
    return Path(data_dir).expanduser().resolve() / AUTO_UPDATE_STATE_LOCK_FILENAME


@contextmanager
def update_state_lock(data_dir: Path | str) -> Iterator[None]:
    """Serialize marker read/check/write transactions.

    The lock is intentionally public so callers such as the gateway can make
    an admission decision and update their own counters against one stable
    marker snapshot. Code already holding this lock should call ``read_state``
    directly and must not call another marker mutation from inside it.
    """

    path = state_lock_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise RuntimeError("auto-update state lock is not a regular private file")
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def read_state(data_dir: Path | str) -> dict[str, Any] | None:
    path = state_path(data_dir)
    try:
        metadata = path.lstat()
        if path.is_symlink() or metadata.st_size > 64 * 1024:
            return _invalid_state()
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw)
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        # An unreadable update marker is not equivalent to an idle platform.
        # Callers that enforce availability treat this synthetic failed state
        # as blocking until an operator repairs or replaces the marker.
        return _invalid_state()
    if not isinstance(value, dict):
        return _invalid_state()
    state = str(value.get("state") or "")
    if (
        value.get("schema_version") != AUTO_UPDATE_STATE_SCHEMA_VERSION
        or state not in PUBLIC_UPDATE_STATES
    ):
        return _invalid_state(value)
    return dict(value)


def _invalid_state(value: dict[str, Any] | None = None) -> dict[str, Any]:
    value = value or {}
    try:
        updated_at = int(value.get("updated_at") or 0)
    except (TypeError, ValueError, OverflowError):
        updated_at = 0
    return {
        "schema_version": AUTO_UPDATE_STATE_SCHEMA_VERSION,
        "state": "failed",
        "phase": "invalid_state",
        "update_id": str(value.get("update_id") or "")[:160],
        "instance_id": str(value.get("instance_id") or "")[:160],
        "updated_at": updated_at,
    }


def read_public(
    data_dir: Path | str,
    *,
    instance_id: str = "",
    retry_after_ms: int = 2000,
) -> dict[str, Any]:
    stored = read_state(data_dir)
    state = str((stored or {}).get("state") or "idle")
    if state not in PUBLIC_UPDATE_STATES:
        state = "failed"
    if state == "updating" and _update_owner_is_abandoned(stored):
        state = "failed"
    return {
        "state": state,
        "instance_id": (
            str((stored or {}).get("instance_id") or "")
            if state in BLOCKING_UPDATE_STATES
            else str(instance_id or (stored or {}).get("instance_id") or "")
        ),
        "retry_after_ms": max(500, min(int(retry_after_ms), 30_000)),
    }


def mark_updating(
    data_dir: Path | str,
    *,
    update_id: str,
    instance_id: str,
    reason: str,
    target_revision: str,
    remote: str,
    branch: str,
    phase: str = "launching",
    started_at: int | None = None,
    owner_pid: int | None = None,
    takeover: bool = False,
) -> dict[str, Any]:
    clean_update_id = _required_id(update_id, "update_id")
    clean_instance_id = _required_id(instance_id, "instance_id")
    with update_state_lock(data_dir):
        now = int(time.time())
        existing = read_state(data_dir)
        existing_id = str((existing or {}).get("update_id") or "")
        existing_state = str((existing or {}).get("state") or "")
        if existing_id == clean_update_id and existing_state in {"idle", "failed"}:
            raise RuntimeError("a terminal auto-update state cannot be restarted")
        if (
            existing
            and existing_id != clean_update_id
            and is_blocking(existing)
            and not takeover
        ):
            raise RuntimeError("another platform update owns the maintenance state")
        existing_started = (
            int(existing.get("started_at") or 0)
            if existing and existing_id == clean_update_id
            else 0
        )
        state = {
            "schema_version": AUTO_UPDATE_STATE_SCHEMA_VERSION,
            "state": "updating",
            "phase": _clean_text(phase, 80) or "launching",
            "update_id": clean_update_id,
            "instance_id": clean_instance_id,
            "reason": _clean_text(reason, 120),
            "target_revision": _clean_text(target_revision, 160),
            "remote": _clean_text(remote, 120),
            "branch": _clean_text(branch, 120),
            "started_at": existing_started or int(started_at or now),
            "updated_at": now,
            "heartbeat_at": now,
            "owner_pid": max(
                0,
                int(
                    owner_pid
                    if owner_pid is not None
                    else (existing or {}).get("owner_pid")
                    or 0
                ),
            ),
        }
        _write_state(data_dir, state)
        return state


def heartbeat(
    data_dir: Path | str,
    *,
    update_id: str,
    phase: str | None = None,
) -> dict[str, Any]:
    with update_state_lock(data_dir):
        current = _matching_state(data_dir, update_id)
        if str(current.get("state") or "") != "updating":
            raise RuntimeError("auto-update state is no longer active")
        now = int(time.time())
        updated = dict(current)
        if phase is not None:
            updated["phase"] = _clean_text(phase, 80) or str(current.get("phase") or "updating")
        updated["updated_at"] = now
        updated["heartbeat_at"] = now
        _write_state(data_dir, updated)
        return updated


def mark_success(
    data_dir: Path | str,
    *,
    update_id: str,
    instance_id: str = "",
    outcome: str = "success",
) -> dict[str, Any]:
    with update_state_lock(data_dir):
        current = _matching_state(data_dir, update_id)
        if str(current.get("state") or "") == "idle":
            return current
        now = int(time.time())
        updated = {
            **current,
            "schema_version": AUTO_UPDATE_STATE_SCHEMA_VERSION,
            "state": "idle",
            "phase": _clean_text(outcome, 80) or "success",
            "instance_id": _clean_text(instance_id, 160)
            or str(current.get("instance_id") or ""),
            "updated_at": now,
            "completed_at": now,
        }
        updated.pop("error", None)
        _write_state(data_dir, updated)
        return updated


def mark_failure(
    data_dir: Path | str,
    *,
    update_id: str,
    error: str = "",
    rollback_succeeded: bool = False,
    instance_id: str = "",
) -> dict[str, Any]:
    with update_state_lock(data_dir):
        current = _matching_state(data_dir, update_id)
        current_state = str(current.get("state") or "")
        if current_state == "idle":
            return current
        if current_state == "failed" and not rollback_succeeded:
            return current
        now = int(time.time())
        updated = {
            **current,
            "schema_version": AUTO_UPDATE_STATE_SCHEMA_VERSION,
            "state": "idle" if rollback_succeeded else "failed",
            "phase": "rollback_succeeded" if rollback_succeeded else "failed",
            "instance_id": _clean_text(instance_id, 160)
            or str(current.get("instance_id") or ""),
            "updated_at": now,
            "completed_at": now,
        }
        if error:
            updated["error"] = _clean_text(error, 2000)
        else:
            updated.pop("error", None)
        _write_state(data_dir, updated)
        return updated


def clear_state(data_dir: Path | str, *, update_id: str = "") -> None:
    with update_state_lock(data_dir):
        path = state_path(data_dir)
        if update_id:
            current = read_state(data_dir)
            if current is not None and str(current.get("update_id") or "") != str(update_id):
                raise RuntimeError("auto-update state belongs to a different update")
        try:
            path.unlink()
        except FileNotFoundError:
            return


def is_blocking(state: dict[str, Any] | None) -> bool:
    return str((state or {}).get("state") or "") in BLOCKING_UPDATE_STATES


def _matching_state(data_dir: Path | str, update_id: str) -> dict[str, Any]:
    current = read_state(data_dir)
    if current is None or str(current.get("update_id") or "") != str(update_id):
        raise RuntimeError("auto-update state belongs to a different update")
    return current


def _inherited_update_lock_is_held() -> bool:
    """Confirm the deployment child inherited the repository update lock."""

    raw_fd = os.getenv("ENTERPRISE_AUTO_UPDATE_LOCK_FD", "").strip()
    raw_path = os.getenv("ENTERPRISE_AUTO_UPDATE_LOCK_PATH", "").strip()
    if not raw_fd or not raw_path:
        return False
    try:
        fd = int(raw_fd)
        if fd < 3:
            return False
        inherited = os.fstat(fd)
        expected = os.stat(Path(raw_path).expanduser().resolve(), follow_symlinks=False)
        if (
            inherited.st_dev != expected.st_dev
            or inherited.st_ino != expected.st_ino
            or not stat.S_ISREG(inherited.st_mode)
        ):
            return False
        # flock is tied to the inherited open file description. This is a
        # no-op when the shell already holds it and establishes the lock on
        # that same description if the caller only opened the descriptor.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, TypeError, ValueError):
        return False
    return True


def _close_inherited_update_lock() -> None:
    """Keep the heartbeat worker from extending repository-lock ownership.

    The deployment shell is the update-lock owner. Its heartbeat child only
    updates the durable marker and must not keep the Git lock alive if that
    shell is killed before its EXIT trap can run.
    """

    raw_fd = os.getenv("ENTERPRISE_AUTO_UPDATE_LOCK_FD", "").strip()
    if raw_fd:
        try:
            fd = int(raw_fd)
            if fd >= 3:
                os.close(fd)
        except (OSError, TypeError, ValueError):
            pass
    os.environ.pop("ENTERPRISE_AUTO_UPDATE_LOCK_FD", None)
    os.environ.pop("ENTERPRISE_AUTO_UPDATE_LOCK_PATH", None)


def _required_id(value: str, label: str) -> str:
    clean = _clean_text(value, 160)
    if not clean:
        raise ValueError(f"{label} is required")
    return clean


def _update_owner_is_abandoned(state: dict[str, Any] | None) -> bool:
    if not state:
        return False
    try:
        heartbeat_at = int(state.get("heartbeat_at") or state.get("updated_at") or 0)
    except (TypeError, ValueError, OverflowError):
        return True
    if heartbeat_at <= 0 or time.time() - heartbeat_at > STALE_UPDATE_HEARTBEAT_SECONDS:
        return True
    try:
        owner_pid = int(state.get("owner_pid") or 0)
    except (TypeError, ValueError, OverflowError):
        return True
    if owner_pid <= 0:
        return False
    try:
        os.kill(owner_pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    except OSError:
        return True
    return False


def _clean_text(value: Any, limit: int) -> str:
    return str(value or "").replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()[:limit]


def _write_state(data_dir: Path | str, value: dict[str, Any]) -> None:
    path = state_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=True) as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _deployment_env() -> tuple[Path, str]:
    raw_data = os.getenv("ENTERPRISE_PLATFORM_DATA", "").strip()
    if not raw_data:
        raise RuntimeError("ENTERPRISE_PLATFORM_DATA is required")
    update_id = os.getenv("ENTERPRISE_AUTO_UPDATE_ID", "").strip()
    if not update_id:
        update_id = f"manual-{uuid.uuid4().hex}"
        os.environ["ENTERPRISE_AUTO_UPDATE_ID"] = update_id
    return Path(raw_data).expanduser().resolve(), update_id


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Manage the durable platform update state")
    subparsers = parser.add_subparsers(dest="command", required=True)
    begin = subparsers.add_parser("begin")
    begin.add_argument("--phase", default="launching")
    begin.add_argument(
        "--takeover",
        action="store_true",
        help="replace an older blocking marker while holding the repository update lock",
    )
    beat = subparsers.add_parser("heartbeat")
    beat.add_argument("--phase", default="updating")
    beat_loop = subparsers.add_parser("heartbeat-loop")
    beat_loop.add_argument("--phase", default="updating")
    beat_loop.add_argument("--interval", type=float, default=5.0)
    success = subparsers.add_parser("success")
    success.add_argument("--outcome", default="success")
    failure = subparsers.add_parser("failure")
    failure.add_argument("--rollback-succeeded", action="store_true")
    failure.add_argument("--error", default="")
    args = parser.parse_args(argv)

    data_dir, update_id = _deployment_env()
    if args.command == "begin":
        if args.takeover and not _inherited_update_lock_is_held():
            raise RuntimeError("auto-update marker takeover requires the repository update lock")
        current = read_state(data_dir)
        mark_updating(
            data_dir,
            update_id=update_id,
            instance_id=os.getenv("ENTERPRISE_AUTO_UPDATE_INSTANCE_ID", "").strip()
            or str((current or {}).get("instance_id") or "").strip()
            or f"deployment-{os.getpid()}",
            reason=os.getenv("ENTERPRISE_AUTO_UPDATE_REASON", "").strip()
            or str((current or {}).get("reason") or "").strip()
            or "manual",
            target_revision=os.getenv("ENTERPRISE_AUTO_UPDATE_TARGET_REVISION", "").strip()
            or str((current or {}).get("target_revision") or "").strip(),
            remote=os.getenv("ENTERPRISE_AUTO_UPDATE_REMOTE", "").strip()
            or str((current or {}).get("remote") or "").strip(),
            branch=os.getenv("ENTERPRISE_AUTO_UPDATE_BRANCH", "").strip()
            or str((current or {}).get("branch") or "").strip(),
            phase=args.phase,
            owner_pid=int(os.getenv("ENTERPRISE_AUTO_UPDATE_OWNER_PID", "0") or 0),
            takeover=bool(args.takeover),
        )
    elif args.command == "heartbeat":
        heartbeat(data_dir, update_id=update_id, phase=args.phase)
    elif args.command == "heartbeat-loop":
        interval = max(1.0, min(float(args.interval), 60.0))
        try:
            owner_pid = int(os.getenv("ENTERPRISE_AUTO_UPDATE_OWNER_PID", "0") or 0)
        except (TypeError, ValueError, OverflowError):
            owner_pid = 0
        _close_inherited_update_lock()
        while True:
            time.sleep(interval)
            # The worker is launched directly by deploy.sh. If it has been
            # reparented, the deployment shell exited without completing its
            # normal heartbeat cleanup, so stop refreshing the marker.
            if owner_pid > 1 and os.getppid() != owner_pid:
                return
            try:
                heartbeat(data_dir, update_id=update_id, phase=args.phase)
            except RuntimeError:
                return
    elif args.command == "success":
        mark_success(data_dir, update_id=update_id, outcome=args.outcome)
    elif args.command == "failure":
        mark_failure(
            data_dir,
            update_id=update_id,
            error=args.error,
            rollback_succeeded=bool(args.rollback_succeeded),
        )


if __name__ == "__main__":
    main()
