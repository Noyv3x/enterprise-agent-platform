from __future__ import annotations

import fcntl
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Protocol

from .update_state import (
    MIGRATION_RESULT_PHASES,
    SOURCE_BRIDGE_BOOTSTRAP_PHASE,
    SOURCE_BRIDGE_READY_PHASE,
    SOURCE_MIGRATION_HANDOFF_PHASES,
    clear_state,
    heartbeat,
    is_blocking,
    mark_updating,
    read_public,
    read_state,
    state_path,
)


DEFAULT_SERVICE_NAME = "enterprise-agent-platform.service"


class AutoUpdateService(Protocol):
    def auto_update_enabled(self) -> bool:
        ...

    def auto_update_interval_seconds(self) -> int:
        ...

    def auto_update_remote(self) -> str:
        ...

    def auto_update_branch(self) -> str:
        ...


class AutoUpdateManager:
    """Watch the upstream git branch and hand updates to deploy.sh.

    The manager deliberately does not implement deployment itself. It only
    verifies that a fast-forward update is available and then launches the
    existing `deploy.sh update` path, preserving its rollback behavior.
    """

    def __init__(
        self,
        service: AutoUpdateService,
        *,
        repo_root: Path | None = None,
        runner=None,
        launcher=None,
    ):
        self.service = service
        self.repo_root = (repo_root or discover_repo_root()).expanduser().resolve()
        self.deploy_script = self.repo_root / "deploy.sh"
        self._runner = runner or self._run_command
        self._launcher = launcher or self._launch_update_command
        self._stop = threading.Event()
        self._wake = threading.Event()
        # Git/fetch/launcher work must never hold the status lock: status is
        # polled by both the admin UI and the public maintenance gate.
        self._check_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._lifecycle_generation = 0
        self._pending_reason = "startup"
        self._pending_update: dict[str, Any] | None = None
        self._migration_resume_launched_at = 0.0
        self._instance_id = uuid.uuid4().hex
        configured_data_dir = getattr(getattr(self.service, "config", None), "data_dir", None)
        fallback_data_dir = Path(
            os.getenv("ENTERPRISE_PLATFORM_DATA")
            or (self.repo_root.parent / f".{self.repo_root.name}-runtime")
        )
        self._data_dir = Path(
            configured_data_dir or fallback_data_dir
        ).expanduser().resolve()
        restored = read_state(self._data_dir)
        restored_blocking = is_blocking(restored)
        restored_bridge_phase = (
            str((restored or {}).get("phase") or "")
            in SOURCE_MIGRATION_HANDOFF_PHASES
        )
        self._status: dict[str, Any] = {
            "running": False,
            "in_progress": False,
            "phase": (
                str((restored or {}).get("phase") or (restored or {}).get("state") or "idle")
                if restored_blocking or restored_bridge_phase
                else "idle"
            ),
            "last_check_at": None,
            "last_update_requested_at": None,
            "last_trigger": "",
            "last_error": "",
            "current_revision": "",
            "remote_revision": "",
            "remote": "",
            "branch": "",
            "dirty": False,
            "dirty_summary": "",
            "update_available": False,
            "update_started": restored_blocking,
            "update_command": "",
            "waiting_since": None,
            "pending_revision": "",
            "update_id": str((restored or {}).get("update_id") or ""),
            "active_agent_tasks": 0,
            "queued_agent_jobs": 0,
            "running_agent_jobs": 0,
            "admissions_in_progress": 0,
            "protected_processes": 0,
            "terminable_processes": 0,
            "blocker_error": "",
            "instance_id": self._instance_id,
            "state_file": str(state_path(self._data_dir)),
            "container_migration_required": False,
            "update_action": "",
            "repo_root": str(self.repo_root),
            "deploy_script": str(self.deploy_script),
        }

    def start(self) -> None:
        with self._state_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._lifecycle_generation += 1
            generation = self._lifecycle_generation
            self._stop.clear()
            thread = threading.Thread(
                target=self._loop,
                args=(generation,),
                name="auto-update-listener",
                daemon=True,
            )
            self._thread = thread
        thread.start()

    def stop(self) -> None:
        with self._state_lock:
            self._lifecycle_generation += 1
            thread = self._thread
            self._stop.set()
        self._wake.set()
        if thread is not None:
            thread.join(timeout=2)
        with self._state_lock:
            if self._thread is thread and (
                thread is None or not thread.is_alive()
            ):
                self._thread = None
            if self._status.get("phase") == "waiting_for_tasks":
                self._pending_update = None
                self._status.update(
                    {
                        "phase": "idle",
                        "waiting_since": None,
                        "pending_revision": "",
                        "update_available": False,
                    }
                )
            self._status["running"] = False
            self._status["in_progress"] = False

    def worker_thread(self) -> threading.Thread | None:
        with self._state_lock:
            return self._thread

    def trigger(self, reason: str = "manual") -> dict[str, Any]:
        self.start()
        with self._state_lock:
            normalized_reason = reason or "manual"
            self._pending_reason = normalized_reason
            if normalized_reason == "config" and self._pending_update is not None:
                # A changed remote/branch invalidates the queued target. The
                # next pass must inspect the new configuration rather than
                # launching the revision detected under the old one.
                self._pending_update = None
                self._status.update(
                    {
                        "phase": "idle",
                        "waiting_since": None,
                        "pending_revision": "",
                        "update_available": False,
                    }
                )
        self._wake.set()
        return self.status()

    def notify_work_state_changed(self) -> None:
        """Wake a queued update when Agent/process blockers may have changed."""

        with self._state_lock:
            waiting = self._pending_update is not None
        if waiting:
            self._wake.set()

    def status(self) -> dict[str, Any]:
        with self._state_lock:
            status = dict(self._status)
            has_pending_update = self._pending_update is not None
        marker = read_state(self._data_dir)
        marker_state = str((marker or {}).get("state") or "")
        source_bridge_waiting = (
            marker_state == "waiting_for_tasks"
            and str((marker or {}).get("phase") or "") == "source_bridge_ready"
        )
        if is_blocking(marker) or source_bridge_waiting:
            status.update(
                {
                    "phase": str(marker.get("phase") or marker.get("state") or "updating"),
                    "update_id": str(marker.get("update_id") or ""),
                    "update_started": is_blocking(marker),
                }
            )
        elif (
            marker
            and str(marker.get("state") or "") == "idle"
            and str(marker.get("update_id") or "")
            and str(marker.get("update_id") or "") == str(status.get("update_id") or "")
            and (
                str(status.get("phase") or "") in {"launching", "updating"}
                or str(marker.get("phase") or "")
                in SOURCE_MIGRATION_HANDOFF_PHASES
            )
        ):
            # The detached deploy worker may finish before restarting this
            # process (for example, a final dirty-tree refusal). Reconcile its
            # durable terminal outcome so the admin status does not remain
            # stuck on "updating" after product access has safely resumed.
            status.update(
                {
                    "phase": str(marker.get("phase") or "idle"),
                    "update_started": False,
                    "update_available": False,
                    "last_error": str(marker.get("error") or status.get("last_error") or ""),
                }
            )
            with self._state_lock:
                self._status.update(
                    {
                        "phase": status["phase"],
                        "update_started": status["update_started"],
                        "update_available": status["update_available"],
                        "last_error": status["last_error"],
                    }
                )
        phase = str(status.get("phase") or "idle")
        if is_blocking(marker):
            status_state = str(marker.get("state") or "updating")
        elif source_bridge_waiting:
            status_state = "waiting_for_tasks"
        elif has_pending_update or phase == "waiting_for_tasks":
            status_state = "waiting_for_tasks"
        elif phase in {"checking", "launching", "updating"}:
            status_state = phase
        else:
            status_state = "idle"
        status.update(
            {
                "state": status_state,
                "active_tasks": max(
                    int(status.get("active_agent_tasks") or 0),
                    int(status.get("running_agent_jobs") or 0),
                ),
                "queued_tasks": int(status.get("queued_agent_jobs") or 0),
                "protected_processes": int(status.get("protected_processes") or 0),
            }
        )
        status.update(
            {
                "enabled": bool(self.service.auto_update_enabled()),
                "interval_seconds": int(self.service.auto_update_interval_seconds()),
                "configured_remote": self.service.auto_update_remote(),
                "configured_branch": self.service.auto_update_branch(),
                "thread_alive": bool(self._thread and self._thread.is_alive()),
            }
        )
        return status

    def public_status(self) -> dict[str, Any]:
        marker = read_state(self._data_dir)
        if is_blocking(marker) or str((marker or {}).get("state") or "") == "waiting_for_tasks":
            return read_public(self._data_dir, instance_id=self._instance_id)
        with self._state_lock:
            waiting = self._pending_update is not None
        return {
            "state": "waiting_for_tasks" if waiting else "idle",
            "instance_id": self._instance_id,
            "retry_after_ms": 1000 if waiting else 3000,
        }

    def blocks_platform_use(self) -> bool:
        return is_blocking(read_state(self._data_dir))

    def source_migration_recovery_required(self) -> bool:
        """Return whether a durable handoff requires a live coordinator.

        Startup must not depend on the repository lock being available. The
        old updater still owns that lock while it restarts this process; the
        coordinator waits and rechecks the lock immediately before launch.
        """

        return self._source_migration_recoverable()

    def source_migration_bootstrap_required(self) -> bool:
        """Return whether a synchronized legacy source still needs first handoff."""

        try:
            return self._container_migration_required()
        except RuntimeError:
            # Keep the lightweight controller alive so its normal check path
            # can expose the incomplete release instead of killing startup.
            return True

    def blocking_update_id(self) -> str:
        marker = read_state(self._data_dir)
        if not is_blocking(marker):
            return ""
        return str(marker.get("update_id") or "")

    def check_once(
        self,
        reason: str = "manual",
        *,
        _generation: int | None = None,
    ) -> dict[str, Any]:
        if not self._check_lock.acquire(blocking=False):
            return self.status()
        try:
            if not self._generation_is_current(_generation):
                return self.status()
            if self.blocks_platform_use() and not self._source_migration_resume_candidate():
                return self.status()
            with self._state_lock:
                self._status.update(
                    {
                        "running": bool(self._thread and self._thread.is_alive()),
                        "in_progress": True,
                        "phase": (
                            "waiting_for_tasks"
                            if self._pending_update is not None
                            else "checking"
                        ),
                        "last_check_at": int(time.time()),
                        "last_trigger": reason,
                        "last_error": "",
                        "update_started": False,
                        "update_command": "",
                    }
                )
                pending = dict(self._pending_update) if self._pending_update is not None else None
            if pending is None:
                result = self._inspect_upstream()
                if not self._generation_is_current(_generation):
                    return self.status()
                with self._state_lock:
                    self._status.update(result)
            else:
                result = pending
            if result["dirty"]:
                with self._state_lock:
                    self._pending_update = None
                    self._status.update(
                        {
                            "phase": "idle",
                            "last_error": "working tree has local changes; auto update skipped",
                            "waiting_since": None,
                            "pending_revision": "",
                        }
                    )
                return self.status()
            if result["update_available"]:
                if str(result.get("update_action") or "") == "migrate-container":
                    return self._attempt_source_migration_resume(
                        result,
                        reason=reason,
                        generation=_generation,
                    )
                with self._state_lock:
                    if self._pending_update is None:
                        pending = {
                            **result,
                            "reason": reason,
                            "update_id": str(result.get("update_id") or uuid.uuid4().hex),
                            "detected_at": int(time.time()),
                        }
                        self._pending_update = pending
                    else:
                        pending = dict(self._pending_update)
                    self._status.update(
                        {
                            "phase": "waiting_for_tasks",
                            "waiting_since": int(
                                self._status.get("waiting_since")
                                or pending.get("detected_at")
                                or time.time()
                            ),
                            "pending_revision": str(pending.get("remote_revision") or ""),
                            "update_id": str(pending.get("update_id") or ""),
                        }
                    )
                if not self._generation_is_current(_generation):
                    return self.status()
                return self._attempt_pending_update(
                    pending,
                    generation=_generation,
                )
            with self._state_lock:
                self._pending_update = None
                self._status.update(
                    {
                        "phase": "idle",
                        "waiting_since": None,
                        "pending_revision": "",
                    }
                )
            return self.status()
        except Exception as exc:
            marker = read_state(self._data_dir)
            with self._state_lock:
                self._status.update(
                    {
                        "phase": (
                            str(
                                (marker or {}).get("phase")
                                or (marker or {}).get("state")
                                or "updating"
                            )
                            if is_blocking(marker)
                            else "idle"
                        ),
                        "update_started": is_blocking(marker),
                        "last_error": str(exc),
                    }
                )
            return self.status()
        finally:
            with self._state_lock:
                if _generation is None or _generation == self._lifecycle_generation:
                    self._status["in_progress"] = False
            self._check_lock.release()

    def _attempt_source_migration_resume(
        self,
        migration: dict[str, Any],
        *,
        reason: str,
        generation: int | None,
    ) -> dict[str, Any]:
        """Launch the exact installer without taking a source reservation.

        The source remains usable while artifacts download. The Manager owns
        the later idle/readiness reservation, so this path must not reuse the
        Git updater's blocking ``try_reserve_auto_update`` transaction.
        """

        if not self._generation_is_current(generation) or self._stop.is_set():
            return self.status()
        now = time.monotonic()
        with self._state_lock:
            if now - self._migration_resume_launched_at < 30:
                return self.status()
            self._migration_resume_launched_at = now
            self._status.update(
                {
                    **migration,
                    "phase": SOURCE_BRIDGE_READY_PHASE,
                    "update_action": "migrate-container",
                    "update_id": str(migration.get("update_id") or ""),
                    "last_trigger": reason,
                }
            )
        try:
            command = self._launcher(reason)
        except Exception:
            with self._state_lock:
                self._migration_resume_launched_at = 0.0
            raise
        with self._state_lock:
            self._status.update(
                {
                    "phase": SOURCE_BRIDGE_READY_PHASE,
                    "last_update_requested_at": int(time.time()),
                    "update_started": True,
                    "update_command": " ".join(command),
                }
            )
        return self.status()

    def _generation_is_current(self, generation: int | None) -> bool:
        if generation is None:
            return True
        with self._state_lock:
            return generation == self._lifecycle_generation

    def _attempt_pending_update(
        self,
        pending: dict[str, Any],
        *,
        generation: int | None,
    ) -> dict[str, Any]:
        update_id = str(pending["update_id"])

        def prepare_marker() -> None:
            mark_updating(
                self._data_dir,
                update_id=update_id,
                instance_id=self._instance_id,
                reason=str(pending.get("reason") or "poll"),
                target_revision=str(pending.get("remote_revision") or ""),
                remote=str(pending.get("remote") or ""),
                branch=str(pending.get("branch") or ""),
                phase="reserving",
            )

        reservation = self._reserve_service(update_id, prepare_marker)
        blockers = {
            "active_agent_tasks": int(reservation.get("active_agent_tasks") or 0),
            "queued_agent_jobs": int(reservation.get("queued_agent_jobs") or 0),
            "running_agent_jobs": int(reservation.get("running_agent_jobs") or 0),
            "admissions_in_progress": int(reservation.get("admissions_in_progress") or 0),
            "protected_processes": int(reservation.get("protected_processes") or 0),
            "terminable_processes": int(reservation.get("terminable_processes") or 0),
            "blocker_error": str(reservation.get("blocker_error") or ""),
        }
        with self._state_lock:
            self._status.update(blockers)
        if not reservation.get("reserved"):
            with self._state_lock:
                self._status["phase"] = "waiting_for_tasks"
            return self.status()

        handoff_complete = False
        command: list[str] = []
        try:
            # Revalidate the repository only after the update owns the idle
            # boundary. This preserves the clean-tree and fast-forward safety
            # checks across an arbitrarily long wait.
            latest = self._inspect_upstream()
            with self._state_lock:
                self._status.update(latest)
            if latest["dirty"]:
                raise RuntimeError("working tree has local changes; auto update skipped")
            if not latest["update_available"]:
                self._release_service(update_id, lambda: clear_state(self._data_dir, update_id=update_id))
                with self._state_lock:
                    self._pending_update = None
                    self._status.update(
                        {
                            "phase": "idle",
                            "waiting_since": None,
                            "pending_revision": "",
                            "update_id": "",
                        }
                    )
                return self.status()
            with self._state_lock:
                # Transition to the launch phase under the same lifecycle lock
                # used by stop(). A disable/stop that wins this boundary
                # cancels cleanly; once this block wins, the detached deploy
                # handoff is intentionally allowed to complete.
                if (
                    (generation is not None and generation != self._lifecycle_generation)
                    or self._stop.is_set()
                    or not self._controller_enabled()
                ):
                    raise RuntimeError(
                        "auto update was disabled or stopped before deployment handoff"
                    )
                mark_updating(
                    self._data_dir,
                    update_id=update_id,
                    instance_id=self._instance_id,
                    reason=str(pending.get("reason") or "poll"),
                    target_revision=str(latest.get("remote_revision") or ""),
                    remote=str(latest.get("remote") or ""),
                    branch=str(latest.get("branch") or ""),
                    phase="launching",
                )
                self._status["phase"] = "launching"
                self._status["update_action"] = "update"
            command = self._launcher(str(pending.get("reason") or "poll"))
            # Returning from the launcher is the ownership handoff boundary.
            # From this point onward the detached deploy worker may already be
            # changing source or restarting services, so local bookkeeping
            # failures must never clear maintenance or release admissions.
            handoff_complete = True
            heartbeat(self._data_dir, update_id=update_id, phase="updating")
            with self._state_lock:
                self._pending_update = None
                self._status.update(
                    {
                        "phase": "updating",
                        "last_update_requested_at": int(time.time()),
                        "update_started": True,
                        "update_command": " ".join(command),
                        "waiting_since": None,
                        "pending_revision": str(latest.get("remote_revision") or ""),
                    }
                )
            return self.status()
        except Exception as exc:
            if handoff_complete:
                marker = read_state(self._data_dir)
                with self._state_lock:
                    self._pending_update = None
                    self._status.update(
                        {
                            "phase": (
                                str(
                                    (marker or {}).get("phase")
                                    or (marker or {}).get("state")
                                    or "updating"
                                )
                                if is_blocking(marker)
                                else "updating"
                            ),
                            "last_update_requested_at": int(time.time()),
                            "update_started": True,
                            "update_command": " ".join(command),
                            "waiting_since": None,
                            "pending_revision": str(
                                latest.get("remote_revision") or ""
                            ),
                            "last_error": str(exc),
                        }
                    )
                return self.status()
            self._release_service(
                update_id,
                lambda: clear_state(self._data_dir, update_id=update_id),
            )
            with self._state_lock:
                self._pending_update = None
                self._status.update(
                    {
                        "phase": "idle",
                        "waiting_since": None,
                        "pending_revision": "",
                        "update_id": "",
                    }
                )
            raise

    def _reserve_service(
        self,
        update_id: str,
        prepare: Callable[[], None],
    ) -> dict[str, Any]:
        reserve = getattr(self.service, "try_reserve_auto_update", None)
        if not callable(reserve):
            prepare()
            return {"reserved": True}
        result = reserve(update_id, prepare=prepare)
        if isinstance(result, dict):
            return result
        return {"reserved": bool(result)}

    def _release_service(self, update_id: str, cleanup: Callable[[], None]) -> None:
        release = getattr(self.service, "release_auto_update_reservation", None)
        if callable(release):
            release(update_id, cleanup=cleanup)
            return
        cleanup()

    def _loop(self, generation: int) -> None:
        with self._state_lock:
            if generation != self._lifecycle_generation:
                return
            self._status["running"] = True
        while self._generation_is_current(generation) and not self._stop.is_set():
            sync = getattr(self.service, "sync_auto_update_reservation", None)
            if callable(sync):
                sync()
            # Manager status is an external Unix-socket read. stop() may win
            # while it is in flight; never touch settings/SQLite after that
            # lifecycle boundary because Service.close may already be closing
            # those resources.
            if self._stop.is_set() or not self._generation_is_current(generation):
                break
            with self._state_lock:
                if generation != self._lifecycle_generation or self._stop.is_set():
                    break
                # Serialize settings reads with stop(): once stop advances the
                # generation it can safely let Service.close proceed.
                enabled = self._controller_enabled()
                interval = int(self.service.auto_update_interval_seconds())
                waiting = self._pending_update is not None
            bridge_coordinator = self._source_migration_handoff_active()
            wait_seconds = (
                1
                if waiting
                else (2 if bridge_coordinator else max(5, interval if enabled else 60))
            )
            woke = self._wake.wait(wait_seconds)
            self._wake.clear()
            if self._stop.is_set() or not self._generation_is_current(generation):
                break
            if not enabled and not woke:
                continue
            with self._state_lock:
                if generation != self._lifecycle_generation or self._stop.is_set():
                    break
                if not self._controller_enabled():
                    continue
            with self._state_lock:
                reason = self._pending_reason if woke else "poll"
                self._pending_reason = "poll"
            self.check_once(reason=reason, _generation=generation)
        with self._state_lock:
            if generation == self._lifecycle_generation:
                self._status["running"] = False
                self._status["in_progress"] = False

    def _inspect_upstream(self) -> dict[str, Any]:
        if not (self.repo_root / ".git").exists():
            raise RuntimeError(f"git repository not found: {self.repo_root}")
        remote = _safe_git_name(self.service.auto_update_remote() or "origin", "remote")
        branch = self.service.auto_update_branch().strip() or self._git_stdout(["git", "branch", "--show-current"])
        branch = _safe_git_name(branch or "main", "branch")
        dirty_summary = self._git_stdout(["git", "status", "--porcelain"])
        current = self._git_stdout(["git", "rev-parse", "HEAD"])
        marker = read_state(self._data_dir)
        marker_phase = str((marker or {}).get("phase") or "")
        handoff_active = self._source_migration_handoff_active()
        if handoff_active:
            self._validate_container_bridge_assets()
            expected = str(
                (marker or {}).get("source_revision")
                or (marker or {}).get("target_revision")
                or ""
            )
            if expected and expected != current:
                raise RuntimeError(
                    "source bridge checkout no longer matches its exact target revision"
                )
            resume_required = self._source_migration_resume_candidate(marker)
            return {
                "current_revision": current,
                "remote_revision": expected or current,
                "remote": str((marker or {}).get("remote") or remote),
                "branch": str((marker or {}).get("branch") or branch),
                "dirty": bool(dirty_summary.strip()),
                "dirty_summary": dirty_summary.strip(),
                "update_available": resume_required,
                "update_action": "migrate-container" if resume_required else "",
                "update_id": str((marker or {}).get("update_id") or ""),
                "container_migration_required": resume_required,
                "source_migration_handoff_active": True,
            }
        self._git(["git", "fetch", "--quiet", remote, branch], timeout=120)
        remote_ref = f"{remote}/{branch}"
        remote_revision = self._git_stdout(["git", "rev-parse", remote_ref])
        container_migration_required = self._container_migration_required()
        if current == remote_revision:
            # A pre-bridge deploy.sh can fast-forward and start the new source
            # without ever executing the bridge calls introduced by that
            # commit. The restarted source must therefore schedule one pass of
            # the current deploy.sh even when Git is already synchronized.
            update_available = container_migration_required
        else:
            ancestor = self._git(["git", "merge-base", "--is-ancestor", current, remote_revision], check=False)
            if ancestor.returncode != 0:
                raise RuntimeError(f"local HEAD is not a fast-forward ancestor of {remote_ref}")
            update_available = True
        return {
            "current_revision": current,
            "remote_revision": remote_revision,
            "remote": remote,
            "branch": branch,
            "dirty": bool(dirty_summary.strip()),
            "dirty_summary": dirty_summary.strip(),
            "update_available": update_available,
            "update_action": "update" if update_available else "",
            "container_migration_required": container_migration_required,
            "source_migration_handoff_active": False,
        }

    def _container_migration_required(self) -> bool:
        if os.getenv("UBITECH_SKIP_CONTAINER_MIGRATION", "0") == "1":
            return False
        if self._source_migration_handoff_active():
            return False
        config = getattr(self.service, "config", None)
        if str(getattr(config, "deployment_mode", "source") or "source").lower() == "container":
            return False
        self._validate_container_bridge_assets(optional=True)
        installer = self.repo_root / "install.sh"
        contract = self.repo_root / "docs" / "contracts" / "container-platform.json"
        return installer.exists() and contract.exists()

    def _validate_container_bridge_assets(self, *, optional: bool = False) -> None:
        installer = self.repo_root / "install.sh"
        contract = self.repo_root / "docs" / "contracts" / "container-platform.json"
        installer_present = installer.exists()
        contract_present = contract.exists()
        if not installer_present and not contract_present:
            if optional:
                return
            raise RuntimeError("container bridge assets are missing")
        if (
            not installer.is_file()
            or not os.access(installer, os.X_OK)
            or not contract.is_file()
        ):
            raise RuntimeError(
                "container bridge assets are incomplete or the installer is not executable"
            )

    def _source_bridge_environment_active(self) -> bool:
        config = getattr(self.service, "config", None)
        return (
            str(getattr(config, "deployment_mode", "source") or "source").lower()
            == "source"
            and os.getenv("UBITECH_SOURCE_MIGRATION_BRIDGE", "0") == "1"
        )

    def _source_migration_handoff_active(self) -> bool:
        if self._source_bridge_environment_active():
            return True
        marker = read_state(self._data_dir)
        return str((marker or {}).get("phase") or "") in (
            SOURCE_MIGRATION_HANDOFF_PHASES | {SOURCE_BRIDGE_BOOTSTRAP_PHASE}
        )

    def _controller_enabled(self) -> bool:
        return (
            bool(self.service.auto_update_enabled())
            or self._source_migration_handoff_active()
            or self.source_migration_bootstrap_required()
        )

    def _source_migration_resume_candidate(
        self,
        marker: dict[str, Any] | None = None,
    ) -> bool:
        return self._source_migration_recoverable(
            marker
        ) and self._repository_update_lock_available()

    def _source_migration_recoverable(
        self,
        marker: dict[str, Any] | None = None,
    ) -> bool:
        marker = marker if marker is not None else read_state(self._data_dir)
        if marker is None:
            return False
        if os.getenv("UBITECH_SKIP_CONTAINER_MIGRATION", "0") == "1":
            return False
        phase = str(marker.get("phase") or "")
        state = str(marker.get("state") or "")
        if phase in MIGRATION_RESULT_PHASES:
            return False
        revision = str(
            marker.get("source_revision") or marker.get("target_revision") or ""
        )
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            return False
        recoverable = state == "waiting_for_tasks" and phase == SOURCE_BRIDGE_READY_PHASE
        if self._source_bridge_environment_active():
            recoverable = recoverable or (state == "idle" and phase == "success") or (
                state == "updating"
                and str(read_public(self._data_dir).get("state") or "") == "failed"
            )
        return recoverable

    def _repository_update_lock_available(self) -> bool:
        git_entry = self.repo_root / ".git"
        if git_entry.is_dir():
            lock_path = git_entry / "ubitech-agent-update.lock"
        else:
            try:
                declaration = git_entry.read_text(encoding="utf-8").strip()
            except OSError:
                return False
            if not declaration.startswith("gitdir:"):
                return False
            git_dir = Path(declaration.removeprefix("gitdir:").strip())
            if not git_dir.is_absolute():
                git_dir = (self.repo_root / git_dir).resolve()
            lock_path = git_dir / "ubitech-agent-update.lock"
        try:
            fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
        return True

    def _launch_update_command(self, reason: str) -> list[str]:
        if not self.deploy_script.exists():
            raise RuntimeError(f"deploy script not found: {self.deploy_script}")
        with self._state_lock:
            update_action = str(self._status.get("update_action") or "update")
        command_name = (
            "migrate-container" if update_action == "migrate-container" else "update"
        )
        handoff = self._deployment_handoff()
        systemd_managed = _running_under_systemd()
        systemd_tools = bool(shutil.which("systemd-run") and shutil.which("systemctl"))
        user_systemd = systemd_tools and _user_systemd_available(self._runner)
        if user_systemd:
            systemd_managed = systemd_managed or _user_service_active(
                self._runner,
                handoff["ENTERPRISE_SERVICE_NAME"],
            )
        handoff["ENTERPRISE_AUTO_UPDATE_SOURCE_PID"] = str(os.getpid())
        handoff["ENTERPRISE_AUTO_UPDATE_SOURCE_MODE"] = (
            "service" if systemd_managed else "foreground"
        )
        if user_systemd and systemd_managed:
            unit = f"enterprise-agent-platform-auto-update-{time.time_ns()}-{os.getpid()}"
            command = [
                "systemd-run",
                "--user",
                "--collect",
                "--service-type=exec",
                f"--unit={unit}",
                f"--working-directory={self.repo_root}",
                *[f"--setenv={key}={value}" for key, value in handoff.items()],
                str(self.deploy_script),
                command_name,
                "--data",
                handoff["ENTERPRISE_PLATFORM_DATA"],
                "--service-name",
                handoff["ENTERPRISE_SERVICE_NAME"],
                "--host",
                handoff["ENTERPRISE_PLATFORM_HOST"],
                "--port",
                handoff["ENTERPRISE_PLATFORM_PORT"],
            ]
            result = self._runner(command, cwd=self.repo_root, timeout=30, check=False)
            if result.returncode == 0:
                return command
            if systemd_managed:
                detail = str(getattr(result, "stderr", "") or getattr(result, "stdout", "") or "").strip()
                raise RuntimeError(
                    "could not launch auto update in an independent systemd unit"
                    + (f": {detail}" if detail else "")
                )
        elif systemd_managed:
            raise RuntimeError(
                "auto update is running under systemd, but an independent user transient unit is unavailable"
            )

        # A detached child is safe only for a standalone/foreground process.
        # A child launched from a systemd service remains in the service cgroup
        # and can be killed by the restart that completes its own update.
        log_path = Path(handoff["ENTERPRISE_PLATFORM_DATA"]) / "logs" / "auto-update.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        command = [
            str(self.deploy_script),
            command_name,
            "--data",
            handoff["ENTERPRISE_PLATFORM_DATA"],
            "--service-name",
            handoff["ENTERPRISE_SERVICE_NAME"],
            "--host",
            handoff["ENTERPRISE_PLATFORM_HOST"],
            "--port",
            handoff["ENTERPRISE_PLATFORM_PORT"],
        ]
        with log_path.open("ab") as log:
            log.write(f"\n[{int(time.time())}] auto update triggered by {reason}\n".encode("utf-8"))
            environment = os.environ.copy()
            environment.update(handoff)
            subprocess.Popen(
                command,
                cwd=str(self.repo_root),
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        return command

    def _deployment_handoff(self) -> dict[str, str]:
        config = getattr(self.service, "config", None)
        data_dir = Path(
            getattr(config, "data_dir", self.repo_root / "enterprise-agent-platform" / "data")
        ).expanduser().resolve()
        service_name = str(os.getenv("ENTERPRISE_SERVICE_NAME", DEFAULT_SERVICE_NAME)).strip()
        host = str(getattr(config, "host", os.getenv("ENTERPRISE_PLATFORM_HOST", "127.0.0.1"))).strip()
        try:
            port = int(getattr(config, "port", os.getenv("ENTERPRISE_PLATFORM_PORT", "8765")))
        except (TypeError, ValueError) as exc:
            raise RuntimeError("invalid platform port for auto-update handoff") from exc
        if (
            len(service_name) > 255
            or not re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", service_name)
            or service_name.startswith((".", "-"))
        ):
            raise RuntimeError(f"invalid systemd service name for auto-update handoff: {service_name!r}")
        if not host or any(char in host for char in "\x00\r\n"):
            raise RuntimeError("invalid platform host for auto-update handoff")
        if not 1 <= port <= 65535:
            raise RuntimeError("invalid platform port for auto-update handoff")
        manage_searxng = getattr(
            config,
            "manage_searxng",
            os.getenv("ENTERPRISE_MANAGE_SEARXNG", "1"),
        )
        if isinstance(manage_searxng, str):
            manage_searxng_enabled = manage_searxng.strip().lower() in {
                "1",
                "true",
                "yes",
                "on",
            }
        else:
            manage_searxng_enabled = bool(manage_searxng)
        values = {
            "ENTERPRISE_PLATFORM_DATA": str(data_dir),
            "ENTERPRISE_SERVICE_NAME": service_name,
            "ENTERPRISE_PLATFORM_HOST": host,
            "ENTERPRISE_PLATFORM_PORT": str(port),
            "ENTERPRISE_AUTO_UPDATE_STATE_FILE": str(state_path(data_dir)),
            "ENTERPRISE_MANAGE_SEARXNG": "1" if manage_searxng_enabled else "0",
            "ENTERPRISE_SEARXNG_API_URL": (
                str(
                    getattr(
                        config,
                        "searxng_api_url",
                        os.getenv("ENTERPRISE_SEARXNG_API_URL", ""),
                    )
                ).strip()
                or "http://127.0.0.1:13003"
            ),
            "ENTERPRISE_SEARXNG_TIMEOUT_SECONDS": (
                str(
                    getattr(
                        config,
                        "searxng_timeout_seconds",
                        os.getenv("ENTERPRISE_SEARXNG_TIMEOUT_SECONDS", ""),
                    )
                ).strip()
                or "20"
            ),
            "ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS": (
                os.getenv("ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS", "").strip()
                or "300"
            ),
        }
        # Only explicitly supported source-migration overrides cross the
        # service -> transient systemd boundary. Arbitrary process environment
        # is intentionally not forwarded.
        for key in (
            "UBITECH_DATA_ROOT",
            "UBITECH_RELEASE_REPOSITORY",
            "UBITECH_RELEASE_MANIFEST_URL",
            "UBITECH_RELEASE_CHANNEL_MANIFEST_URL",
            "UBITECH_MANAGER_URL",
            "UBITECH_MANAGER_CHECKSUM_URL",
            "UBITECH_SKIP_CONTAINER_MIGRATION",
        ):
            value = os.getenv(key, "").strip()
            if value:
                values[key] = value
        with self._state_lock:
            if self._status.get("update_id"):
                values["ENTERPRISE_AUTO_UPDATE_ID"] = str(self._status["update_id"])
            if self._status.get("remote_revision"):
                values["ENTERPRISE_AUTO_UPDATE_TARGET_REVISION"] = str(
                    self._status["remote_revision"]
                )
            if self._status.get("remote"):
                values["ENTERPRISE_AUTO_UPDATE_REMOTE"] = str(self._status["remote"])
            if self._status.get("branch"):
                values["ENTERPRISE_AUTO_UPDATE_BRANCH"] = str(self._status["branch"])
        if any(any(char in value for char in "\x00\r\n") for value in values.values()):
            raise RuntimeError("invalid value in auto-update deployment handoff")
        return values

    def _git(self, cmd: list[str], *, timeout: float = 30, check: bool = True) -> subprocess.CompletedProcess:
        return self._runner(cmd, cwd=self.repo_root, timeout=timeout, check=check)

    def _git_stdout(self, cmd: list[str], *, timeout: float = 30) -> str:
        return str(self._git(cmd, timeout=timeout).stdout or "").strip()

    @staticmethod
    def _run_command(
        cmd: list[str],
        *,
        cwd: Path | None = None,
        timeout: float | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            timeout=timeout,
            text=True,
            capture_output=True,
            check=False,
        )
        if check and result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(f"command failed ({result.returncode}): {' '.join(cmd)}{': ' + detail if detail else ''}")
        return result


def discover_repo_root() -> Path:
    here = Path(__file__).resolve()
    candidates = [here.parents[2], Path.cwd(), Path.cwd().parent]
    for candidate in candidates:
        if (candidate / "deploy.sh").exists() and (candidate / ".git").exists():
            return candidate
    return here.parents[2]


def _safe_git_name(value: str, label: str) -> str:
    clean = value.strip()
    if not clean or not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", clean) or clean.startswith("-") or ".." in clean:
        raise RuntimeError(f"invalid git {label}: {value!r}")
    return clean


def _user_systemd_available(runner) -> bool:
    result = runner(["systemctl", "--user", "show-environment"], cwd=None, timeout=20, check=False)
    return result.returncode == 0


def _user_service_active(runner, service_name: str) -> bool:
    result = runner(
        ["systemctl", "--user", "is-active", "--quiet", service_name],
        cwd=None,
        timeout=20,
        check=False,
    )
    return result.returncode == 0


def _running_under_systemd() -> bool:
    return any(os.getenv(name) for name in ("INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID"))
