from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import stat
import subprocess
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
MIGRATION_RESULT_PHASES = frozenset(
    {"container_migration_queued", "container_migration_failed"}
)
SOURCE_BRIDGE_READY_PHASE = "source_bridge_ready"
SOURCE_BRIDGE_BOOTSTRAP_PHASE = "source_bridge_bootstrapping"
SOURCE_MIGRATION_HANDOFF_PHASES = frozenset(
    {SOURCE_BRIDGE_READY_PHASE, *MIGRATION_RESULT_PHASES}
)
SOURCE_MIGRATION_RESUME_PHASES = frozenset(
    {"migration_reserving", "migration_launching", "migration_resuming"}
)


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
        existing_phase = str((existing or {}).get("phase") or "")
        clean_phase = _clean_text(phase, 80) or "launching"
        if existing_phase == SOURCE_BRIDGE_BOOTSTRAP_PHASE:
            raise RuntimeError("source bridge bootstrap owns this checkout")
        if existing_phase in MIGRATION_RESULT_PHASES:
            raise RuntimeError(
                "container migration owns this checkout; Git update is frozen"
            )
        if existing_phase == SOURCE_BRIDGE_READY_PHASE and not (
            existing_id == clean_update_id
            and clean_phase in SOURCE_MIGRATION_RESUME_PHASES
        ):
            raise RuntimeError(
                "source bridge handoff can only enter explicit migration recovery"
            )
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
            "phase": clean_phase,
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
        current_state = str(current.get("state") or "")
        if current_state == "idle":
            return current
        if current_state == "failed" and outcome == "operator_recovered":
            pass
        if current_state != "updating":
            if not (current_state == "failed" and outcome == "operator_recovered"):
                raise RuntimeError("auto-update success requires an active source update")
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


def mark_source_bridge_ready(
    data_dir: Path | str,
    *,
    update_id: str,
    instance_id: str = "",
    source_revision: str = "",
) -> dict[str, Any]:
    """Commit the healthy source transaction without claiming Docker success.

    ``waiting_for_tasks`` is deliberately non-blocking for the legacy gateway.
    The Manager must be able to query and reserve that source Platform after
    the installer starts, while the old marker still makes the handoff visible.
    """

    with update_state_lock(data_dir):
        current = _matching_state(data_dir, update_id)
        current_state = str(current.get("state") or "")
        if current_state == "waiting_for_tasks" and str(
            current.get("phase") or ""
        ) == SOURCE_BRIDGE_READY_PHASE:
            if source_revision:
                existing_revision = _clean_source_revision(
                    str(current.get("source_revision") or current.get("target_revision") or "")
                )
                if existing_revision != _clean_source_revision(source_revision):
                    raise RuntimeError("source bridge revision does not match its marker")
            return current
        if current_state != "updating":
            raise RuntimeError("source bridge handoff requires an active source update")
        clean_revision = _clean_source_revision(
            source_revision or str(current.get("target_revision") or "")
        )
        now = int(time.time())
        updated = {
            **current,
            "schema_version": AUTO_UPDATE_STATE_SCHEMA_VERSION,
            "state": "waiting_for_tasks",
            "phase": SOURCE_BRIDGE_READY_PHASE,
            "instance_id": _clean_text(instance_id, 160)
            or str(current.get("instance_id") or ""),
            "updated_at": now,
            "source_completed_at": now,
            "source_revision": clean_revision,
        }
        updated.pop("error", None)
        try:
            _write_state(data_dir, updated)
        except OSError:
            # os.replace is the commit point. chmod or the parent-directory
            # fsync can still report an error after the new marker is already
            # visible; treating that ambiguous result as "not committed"
            # would let an older deploy shell reset a healthy bridge checkout.
            committed = read_state(data_dir)
            if not _source_bridge_ready_matches(
                committed,
                update_id=update_id,
                source_revision=clean_revision,
            ):
                raise
        return updated


def mark_container_migration_result(
    data_dir: Path | str,
    *,
    update_id: str,
    outcome: str,
    error: str = "",
    instance_id: str = "",
) -> dict[str, Any]:
    """Annotate the legacy marker after the Manager installer returns.

    A queued or failed handoff leaves the healthy source Platform available,
    so both outcomes are terminal ``idle`` states. A successful Manager
    operation is intentionally not written here because it may already have
    archived this checkout; the Manager journal is authoritative from then on.
    """

    clean_outcome = _clean_text(outcome, 80)
    if clean_outcome not in MIGRATION_RESULT_PHASES:
        raise ValueError("invalid container migration result")
    with update_state_lock(data_dir):
        current = _matching_state(data_dir, update_id)
        current_state = str(current.get("state") or "")
        current_phase = str(current.get("phase") or "")
        if current_state == "idle" and current_phase == clean_outcome:
            return current
        source_bridge_ready = current_state == "waiting_for_tasks" and str(
            current.get("phase") or ""
        ) == SOURCE_BRIDGE_READY_PHASE
        # The first bridge-capable release marked the source transaction as a
        # generic success before invoking install.sh. Accept that exact legacy
        # boundary so the updated installer can repair status for machines
        # whose currently running deploy.sh still has the old ordering.
        legacy_bridge_success = current_state == "idle" and current_phase == "success"
        queued_to_failed = (
            current_state == "idle"
            and current_phase == "container_migration_queued"
            and clean_outcome == "container_migration_failed"
        )
        if current_phase == "container_migration_failed":
            raise RuntimeError("a failed container migration requires explicit repair")
        if not source_bridge_ready and not legacy_bridge_success and not queued_to_failed:
            raise RuntimeError("container migration result requires a source bridge handoff")
        now = int(time.time())
        updated = {
            **current,
            "schema_version": AUTO_UPDATE_STATE_SCHEMA_VERSION,
            "state": "idle",
            "phase": clean_outcome,
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


def recover_source_bridge_handoff(
    data_dir: Path | str,
    *,
    update_id: str,
    instance_id: str = "",
    source_revision: str,
    repair_failed: bool = False,
) -> dict[str, Any] | None:
    """Recover a bridge worker that died after the healthy source restart.

    This transition is intentionally separate from generic ``mark_updating``:
    only a source process already carrying the persisted bridge environment
    calls it, and it never changes the checkout or update id.
    """

    if not _inherited_update_lock_is_held():
        raise RuntimeError("source bridge recovery requires the repository update lock")
    clean_update_id = _required_id(update_id, "update_id")
    clean_revision = _clean_source_revision(source_revision)
    with update_state_lock(data_dir):
        current = _matching_state(data_dir, clean_update_id)
        current_state = str(current.get("state") or "")
        current_phase = str(current.get("phase") or "")
        if (
            current_state == "waiting_for_tasks"
            and current_phase == SOURCE_BRIDGE_READY_PHASE
        ):
            existing_revision = _clean_source_revision(
                str(current.get("source_revision") or current.get("target_revision") or "")
            )
            if existing_revision != clean_revision:
                raise RuntimeError("source bridge recovery revision does not match its marker")
            return current
        recoverable_active = current_state == "updating"
        legacy_success = current_state == "idle" and current_phase == "success"
        explicit_failed_repair = (
            repair_failed
            and current_state == "idle"
            and current_phase == "container_migration_failed"
        )
        if not recoverable_active and not legacy_success and not explicit_failed_repair:
            raise RuntimeError("source bridge marker is not recoverable")
        existing_revision = _clean_source_revision(
            str(current.get("source_revision") or current.get("target_revision") or "")
        )
        if existing_revision != clean_revision:
            raise RuntimeError("source bridge recovery revision does not match its marker")
        now = int(time.time())
        updated = {
            **current,
            "schema_version": AUTO_UPDATE_STATE_SCHEMA_VERSION,
            "state": "waiting_for_tasks",
            "phase": SOURCE_BRIDGE_READY_PHASE,
            "instance_id": _clean_text(instance_id, 160)
            or str(current.get("instance_id") or ""),
            "updated_at": now,
            "source_completed_at": int(current.get("source_completed_at") or now),
            "source_revision": clean_revision,
        }
        updated.pop("error", None)
        updated.pop("completed_at", None)
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
        current_phase = str(current.get("phase") or "")
        if current_phase in SOURCE_MIGRATION_HANDOFF_PHASES:
            raise RuntimeError("source migration handoff cannot become a source failure")
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


def _source_bridge_ready_matches(
    state: dict[str, Any] | None,
    *,
    update_id: str,
    source_revision: str,
) -> bool:
    return bool(
        state
        and str(state.get("update_id") or "") == str(update_id)
        and str(state.get("state") or "") == "waiting_for_tasks"
        and str(state.get("phase") or "") == SOURCE_BRIDGE_READY_PHASE
        and str(state.get("source_revision") or "") == source_revision
    )


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


def _clean_source_revision(value: str) -> str:
    clean = _clean_text(value, 40).lower()
    if not re.fullmatch(r"[0-9a-f]{40}", clean):
        raise ValueError("source_revision must be a full Git commit")
    return clean


def _current_checkout_revision() -> str:
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError("could not resolve the bridge checkout revision")
    return _clean_source_revision(result.stdout.strip())


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
    bridge_ready = subparsers.add_parser("source-bridge-ready")
    bridge_ready.add_argument("--source-revision", required=True)
    bridge_recover = subparsers.add_parser("recover-source-bridge")
    bridge_recover.add_argument("--source-revision", required=True)
    bridge_recover.add_argument("--repair-failed", action="store_true")
    migration_result = subparsers.add_parser("container-migration-result")
    migration_result.add_argument(
        "--outcome", required=True, choices=sorted(MIGRATION_RESULT_PHASES)
    )
    migration_result.add_argument("--error", default="")
    failure = subparsers.add_parser("failure")
    failure.add_argument("--rollback-succeeded", action="store_true")
    failure.add_argument("--error", default="")
    args = parser.parse_args(argv)

    data_dir, update_id = _deployment_env()
    if args.command == "begin":
        if args.takeover and not _inherited_update_lock_is_held():
            raise RuntimeError("auto-update marker takeover requires the repository update lock")
        current = read_state(data_dir)
        inherited = (
            current
            if str((current or {}).get("update_id") or "") == update_id
            else None
        )
        mark_updating(
            data_dir,
            update_id=update_id,
            instance_id=os.getenv("ENTERPRISE_AUTO_UPDATE_INSTANCE_ID", "").strip()
            or str((inherited or {}).get("instance_id") or "").strip()
            or f"deployment-{os.getpid()}",
            reason=os.getenv("ENTERPRISE_AUTO_UPDATE_REASON", "").strip()
            or str((inherited or {}).get("reason") or "").strip()
            or "manual",
            target_revision=os.getenv("ENTERPRISE_AUTO_UPDATE_TARGET_REVISION", "").strip()
            or str((inherited or {}).get("target_revision") or "").strip(),
            remote=os.getenv("ENTERPRISE_AUTO_UPDATE_REMOTE", "").strip()
            or str((inherited or {}).get("remote") or "").strip(),
            branch=os.getenv("ENTERPRISE_AUTO_UPDATE_BRANCH", "").strip()
            or str((inherited or {}).get("branch") or "").strip(),
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
        # Compatibility for the first bridge-capable target: its already
        # running deploy.sh calls the generic success command after restarting
        # a source service with the bridge environment. The target helper must
        # repair that old shell ordering without claiming Docker completion.
        if (
            args.outcome == "success"
            and os.getenv("UBITECH_SOURCE_MIGRATION_BRIDGE", "0") == "1"
        ):
            mark_source_bridge_ready(
                data_dir,
                update_id=update_id,
                # The already-running legacy shell can re-fetch after the
                # controller detected its target. Bind the marker to the
                # checkout actually bootstrapped, which is also what the
                # installer uses for its immutable release.
                source_revision=_current_checkout_revision(),
            )
        else:
            mark_success(data_dir, update_id=update_id, outcome=args.outcome)
    elif args.command == "source-bridge-ready":
        mark_source_bridge_ready(
            data_dir,
            update_id=update_id,
            source_revision=args.source_revision,
        )
    elif args.command == "recover-source-bridge":
        recover_source_bridge_handoff(
            data_dir,
            update_id=update_id,
            instance_id=os.getenv("ENTERPRISE_AUTO_UPDATE_INSTANCE_ID", ""),
            source_revision=args.source_revision,
            repair_failed=bool(args.repair_failed),
        )
    elif args.command == "container-migration-result":
        mark_container_migration_result(
            data_dir,
            update_id=update_id,
            outcome=args.outcome,
            error=args.error,
        )
    elif args.command == "failure":
        mark_failure(
            data_dir,
            update_id=update_id,
            error=args.error,
            rollback_succeeded=bool(args.rollback_succeeded),
        )


if __name__ == "__main__":
    main()
