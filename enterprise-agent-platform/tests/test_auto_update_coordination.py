from __future__ import annotations

import http.client
import json
import subprocess
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from enterprise_agent_platform.agent_runtime_client import AgentResult
from enterprise_agent_platform.auto_update import AutoUpdateManager
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.manager_client import ManagerClientError
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError
from enterprise_agent_platform.update_state import (
    clear_state,
    heartbeat,
    mark_failure,
    mark_success,
    mark_updating,
    read_public,
    read_state,
    state_path,
)


class _UpdateService:
    def __init__(self, data_dir: Path):
        self.config = SimpleNamespace(data_dir=data_dir, host="127.0.0.1", port=8765)
        self.blocked = True
        self.enabled = True
        self.released: list[str] = []

    def auto_update_enabled(self):
        return self.enabled

    def auto_update_interval_seconds(self):
        return 30

    def auto_update_remote(self):
        return "origin"

    def auto_update_branch(self):
        return "main"

    def try_reserve_auto_update(self, update_id, *, prepare=None):
        if self.blocked:
            return {
                "reserved": False,
                "active_agent_tasks": 1,
                "queued_agent_jobs": 2,
                "running_agent_jobs": 1,
                "admissions_in_progress": 0,
                "protected_processes": 0,
            }
        if prepare:
            prepare()
        return {"reserved": True}

    def release_auto_update_reservation(self, update_id, *, cleanup=None):
        if cleanup:
            cleanup()
        self.released.append(update_id)
        return True


class _BlockingAgent:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.blocker_summary: dict[str, int] | Exception = {
            "running_background_terminal_count": 0,
            "update_blocking_terminal_count": 0,
            "terminable_background_terminal_count": 0,
        }

    def generate(self, **kwargs):
        self.started.set()
        self.release.wait(timeout=5)
        return AgentResult(
            content="complete",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )

    def update_blocker_summary(self):
        if isinstance(self.blocker_summary, Exception):
            raise self.blocker_summary
        return dict(self.blocker_summary)


class _ManagerStub:
    def __init__(self, status: dict[str, object] | None = None):
        self.operations: list[dict[str, object]] = []
        self.checks: list[str] = []
        self.status_payload = status or {
            "generation": 17,
            "public_state": "idle",
            "phase": "committing",
            "maintenance": False,
            "active_operation_id": "",
            "finalize_pending_operation_id": "",
            "operation_id": "",
            "current": {
                "id": "release-current",
                "source_commit": "a" * 40,
                "images": {"platform": "registry/platform@sha256:abc"},
            },
            "previous": {"id": "release-previous"},
            "target": {"id": "release-target", "source_commit": "b" * 40},
            "services": {
                "manager": {"status": "healthy"},
                "platform": {"status": "unavailable"},
            },
            "checked_at": "2026-07-24T12:34:56Z",
        }

    def config(self):
        return {
            "update_enabled": True,
            "update_interval": 300,
            "release_manifest_url": "https://releases.example/main.json",
        }

    def status(self):
        return dict(self.status_payload)

    def operation(self, operation, *, idempotency_key, expected_generation=None):
        value = {
            "operation": operation,
            "idempotency_key": idempotency_key,
            "expected_generation": expected_generation,
        }
        self.operations.append(value)
        return value

    def check(self, *, idempotency_key):
        self.checks.append(idempotency_key)
        return {"manifest": {"source_commit": "c" * 40}, "reused": False}


def _config(data_dir: Path) -> PlatformConfig:
    return PlatformConfig(
        data_dir=data_dir,
        host="127.0.0.1",
        port=0,
        public_base_url="http://127.0.0.1:0",
        token_secret="test-secret",
        token_ttl_seconds=3600,
        agent_tool_token="agent-token",
        knowledge_backend="local",
        cognee_dataset="test",
        cognee_ingest_background=True,
        cognee_repo=data_dir / "cognee",
        firecrawl_repo=data_dir / "firecrawl",
        camofox_url="http://127.0.0.1:19377",
        firecrawl_api_url="http://127.0.0.1:13002",
        runtime_startup_wait_seconds=0,
        manage_agent_runtime=False,
        agent_runtime_url="http://127.0.0.1:8766",
        agent_runtime_token="runtime-token",
        agent_runtime_home=data_dir / "runtimes" / "agent",
        agent_runtime_model="gpt-5.5",
        agent_runtime_provider="openai-codex",
        agent_runtime_idle_timeout_seconds=2,
        allow_insecure_bootstrap_password=True,
    )


class UpdateStateTests(unittest.TestCase):
    def test_container_webhook_checks_manager_without_starting_source_updater(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=_BlockingAgent(),
                autostart_runtime=False,
            )
            manager = _ManagerStub()
            source_updater = mock.Mock()
            service.manager_client = manager
            service._auto_updater = source_updater
            try:
                result = service.auto_update_webhook({"ref": "refs/heads/main"})
                self.assertTrue(result["accepted"])
                self.assertEqual(len(manager.checks), 1)
                self.assertRegex(manager.checks[0], r"^webhook-[0-9]+-[0-9a-f]{8}$")
                source_updater.trigger.assert_not_called()
            finally:
                service.close()

    def test_manager_status_keeps_release_identity_and_numeric_concurrency_generation_separate(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=_BlockingAgent(),
                autostart_runtime=False,
            )
            manager = _ManagerStub()
            service.manager_client = manager
            try:
                _, actor = service.authenticate("admin", "admin")
                payload = service.auto_update_config(actor)
                status = payload["status"]
                self.assertEqual(status["manager_generation"], 17)
                self.assertEqual(status["current_generation"], "release-current")
                self.assertEqual(status["last_check_at"], "2026-07-24T12:34:56Z")
                self.assertTrue(status["services"]["manager"]["available"])
                self.assertFalse(status["services"]["platform"]["available"])
                self.assertEqual(status["services"]["platform"]["state"], "unavailable")

                service.trigger_manager_operation(
                    actor,
                    "restart",
                    {"expected_generation": status["manager_generation"]},
                )
                self.assertEqual(manager.operations[-1]["expected_generation"], 17)
                with self.assertRaisesRegex(ServiceError, "expected_generation"):
                    service.trigger_manager_operation(
                        actor,
                        "restart",
                        {"expected_generation": "release-current"},
                    )
            finally:
                service.close()

    def test_state_transitions_are_atomic_private_and_publicly_redacted(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            updating = mark_updating(
                data_dir,
                update_id="update-1",
                instance_id="instance-old",
                reason="webhook",
                target_revision="abc123",
                remote="origin",
                branch="main",
            )
            self.assertEqual(updating["state"], "updating")
            self.assertEqual(state_path(data_dir).stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                read_public(data_dir),
                {
                    "state": "updating",
                    "instance_id": "instance-old",
                    "retry_after_ms": 2000,
                },
            )
            heartbeat(data_dir, update_id="update-1", phase="deploying")
            self.assertEqual(read_state(data_dir)["phase"], "deploying")
            succeeded = mark_success(
                data_dir,
                update_id="update-1",
                instance_id="instance-new",
            )
            self.assertEqual(succeeded["state"], "idle")
            self.assertEqual(read_public(data_dir, instance_id="live")["instance_id"], "live")

            mark_updating(
                data_dir,
                update_id="update-2",
                instance_id="instance-new",
                reason="poll",
                target_revision="def456",
                remote="origin",
                branch="main",
            )
            failed = mark_failure(data_dir, update_id="update-2", error="private path /secret")
            self.assertEqual(failed["state"], "failed")
            self.assertNotIn("error", read_public(data_dir))

    def test_stale_or_dead_update_owner_fails_closed_publicly(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            state = mark_updating(
                data_dir,
                update_id="update-stale",
                instance_id="instance-old",
                reason="poll",
                target_revision="def456",
                remote="origin",
                branch="main",
                owner_pid=999_999_999,
            )
            self.assertEqual(state["state"], "updating")
            self.assertEqual(read_public(data_dir)["state"], "failed")

            state["owner_pid"] = 0
            state["heartbeat_at"] = int(time.time()) - 3600
            state_path(data_dir).write_text(json.dumps(state), encoding="utf-8")
            self.assertEqual(read_public(data_dir)["state"], "failed")

    def test_invalid_update_state_never_raises_or_exposes_contents(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            path = state_path(data_dir)
            path.write_text(
                json.dumps(
                    {
                        "schema_version": 99,
                        "state": "updating",
                        "updated_at": "not-an-integer",
                        "error": "/private/secret",
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(read_state(data_dir)["state"], "failed")
            self.assertEqual(read_public(data_dir)["state"], "failed")
            self.assertNotIn("error", read_public(data_dir))


class AutoUpdateQueueTests(unittest.TestCase):
    def test_deployment_handoff_preserves_disabled_searxng_configuration(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            service = _UpdateService(root / "state")
            service.config.manage_searxng = False
            service.config.searxng_api_url = "http://127.0.0.1:14567"
            service.config.searxng_timeout_seconds = 7.5
            manager = AutoUpdateManager(service, repo_root=root)

            with mock.patch.dict(
                "os.environ",
                {"ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS": "420"},
                clear=False,
            ):
                handoff = manager._deployment_handoff()

            self.assertEqual(handoff["ENTERPRISE_MANAGE_SEARXNG"], "0")
            self.assertEqual(
                handoff["ENTERPRISE_SEARXNG_API_URL"],
                "http://127.0.0.1:14567",
            )
            self.assertEqual(handoff["ENTERPRISE_SEARXNG_TIMEOUT_SECONDS"], "7.5")
            self.assertEqual(
                handoff["ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS"],
                "420",
            )

    def test_systemd_update_worker_receives_custom_searxng_environment(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            (root / "deploy.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            service = _UpdateService(root / "state")
            service.config.manage_searxng = True
            service.config.searxng_api_url = "http://127.0.0.1:15432"
            service.config.searxng_timeout_seconds = 11.25
            runner = mock.Mock(
                return_value=subprocess.CompletedProcess(
                    args=[],
                    returncode=0,
                    stdout="",
                    stderr="",
                )
            )
            manager = AutoUpdateManager(service, repo_root=root, runner=runner)

            with (
                mock.patch.dict(
                    "os.environ",
                    {"ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS": "510"},
                    clear=False,
                ),
                mock.patch(
                    "enterprise_agent_platform.auto_update.shutil.which",
                    return_value="/usr/bin/tool",
                ),
                mock.patch(
                    "enterprise_agent_platform.auto_update._running_under_systemd",
                    return_value=True,
                ),
                mock.patch(
                    "enterprise_agent_platform.auto_update._user_systemd_available",
                    return_value=True,
                ),
            ):
                command = manager._launch_update_command("test")

            self.assertIn("--setenv=ENTERPRISE_MANAGE_SEARXNG=1", command)
            self.assertIn(
                "--setenv=ENTERPRISE_SEARXNG_API_URL=http://127.0.0.1:15432",
                command,
            )
            self.assertIn(
                "--setenv=ENTERPRISE_SEARXNG_TIMEOUT_SECONDS=11.25",
                command,
            )
            self.assertIn(
                "--setenv=ENTERPRISE_SEARXNG_STARTUP_WAIT_SECONDS=510",
                command,
            )
            runner.assert_called_once_with(
                command,
                cwd=root.resolve(),
                timeout=30,
                check=False,
            )

    def test_stop_cancels_an_inflight_check_before_handoff(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            service = _UpdateService(root / "state")
            service.blocked = False
            launched: list[str] = []
            manager = AutoUpdateManager(
                service,
                repo_root=root,
                launcher=lambda reason: launched.append(reason) or ["deploy.sh", "update"],
            )
            inspection_started = threading.Event()
            inspection = {
                "current_revision": "old",
                "remote_revision": "new",
                "remote": "origin",
                "branch": "main",
                "dirty": False,
                "dirty_summary": "",
                "update_available": True,
            }

            def delayed_inspection():
                inspection_started.set()
                manager._stop.wait(timeout=5)
                return inspection

            with mock.patch.object(manager, "_inspect_upstream", side_effect=delayed_inspection):
                manager.trigger("webhook")
                self.assertTrue(inspection_started.wait(timeout=2))
                manager.stop()
            self.assertEqual(launched, [])
            self.assertIsNone(read_state(service.config.data_dir))

    def test_detected_update_waits_and_launches_once_after_idle(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            (root / "deploy.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            data_dir = root / "state"
            service = _UpdateService(data_dir)
            launched: list[str] = []
            manager = AutoUpdateManager(
                service,
                repo_root=root,
                launcher=lambda reason: launched.append(reason) or ["deploy.sh", "update"],
            )
            inspection = {
                "current_revision": "old",
                "remote_revision": "new",
                "remote": "origin",
                "branch": "main",
                "dirty": False,
                "dirty_summary": "",
                "update_available": True,
            }
            with mock.patch.object(manager, "_inspect_upstream", return_value=inspection):
                waiting = manager.check_once("webhook")
                self.assertEqual(waiting["state"], "waiting_for_tasks")
                self.assertEqual(waiting["active_tasks"], 1)
                self.assertEqual(waiting["queued_tasks"], 2)
                self.assertEqual(launched, [])
                self.assertIsNone(read_state(data_dir))

                service.blocked = False
                updating = manager.check_once("poll")
            self.assertEqual(updating["state"], "updating")
            self.assertEqual(launched, ["webhook"])
            self.assertEqual(read_state(data_dir)["state"], "updating")
            mark_success(data_dir, update_id=updating["update_id"])
            self.assertEqual(manager.status()["state"], "idle")

    def test_launcher_failure_releases_reservation_and_marker(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            data_dir = root / "state"
            service = _UpdateService(data_dir)
            service.blocked = False
            manager = AutoUpdateManager(
                service,
                repo_root=root,
                launcher=mock.Mock(side_effect=RuntimeError("handoff failed")),
            )
            inspection = {
                "current_revision": "old",
                "remote_revision": "new",
                "remote": "origin",
                "branch": "main",
                "dirty": False,
                "dirty_summary": "",
                "update_available": True,
            }
            with mock.patch.object(manager, "_inspect_upstream", return_value=inspection):
                status = manager.check_once("manual")
            self.assertEqual(status["state"], "idle")
            self.assertIn("handoff failed", status["last_error"])
            self.assertEqual(len(service.released), 1)
            self.assertIsNone(read_state(data_dir))

    def test_post_handoff_bookkeeping_failure_keeps_maintenance_reserved(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            data_dir = root / "state"
            service = _UpdateService(data_dir)
            service.blocked = False
            launcher = mock.Mock(return_value=["deploy.sh", "update"])
            manager = AutoUpdateManager(
                service,
                repo_root=root,
                launcher=launcher,
            )
            inspection = {
                "current_revision": "old",
                "remote_revision": "new",
                "remote": "origin",
                "branch": "main",
                "dirty": False,
                "dirty_summary": "",
                "update_available": True,
            }
            with (
                mock.patch.object(manager, "_inspect_upstream", return_value=inspection),
                mock.patch(
                    "enterprise_agent_platform.auto_update.heartbeat",
                    side_effect=RuntimeError("local status write failed"),
                ),
            ):
                status = manager.check_once("manual")

            launcher.assert_called_once_with("manual")
            self.assertEqual(service.released, [])
            self.assertEqual(read_state(data_dir)["state"], "updating")
            self.assertEqual(read_state(data_dir)["phase"], "launching")
            self.assertEqual(status["state"], "updating")
            self.assertTrue(status["update_started"])
            self.assertIn("local status write failed", status["last_error"])

    def test_disable_after_reserved_reinspection_cancels_before_handoff(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            data_dir = root / "state"
            service = _UpdateService(data_dir)
            service.blocked = False
            launcher = mock.Mock(return_value=["deploy.sh", "update"])
            manager = AutoUpdateManager(
                service,
                repo_root=root,
                launcher=launcher,
            )
            inspection = {
                "current_revision": "old",
                "remote_revision": "new",
                "remote": "origin",
                "branch": "main",
                "dirty": False,
                "dirty_summary": "",
                "update_available": True,
            }
            second_inspection_started = threading.Event()
            allow_second_inspection = threading.Event()
            inspection_count = 0

            def delayed_second_inspection():
                nonlocal inspection_count
                inspection_count += 1
                if inspection_count == 2:
                    second_inspection_started.set()
                    allow_second_inspection.wait(timeout=5)
                return dict(inspection)

            result: dict[str, object] = {}

            def check() -> None:
                result["status"] = manager.check_once("manual")

            with mock.patch.object(
                manager,
                "_inspect_upstream",
                side_effect=delayed_second_inspection,
            ):
                worker = threading.Thread(target=check)
                worker.start()
                self.assertTrue(second_inspection_started.wait(timeout=2))
                service.enabled = False
                allow_second_inspection.set()
                worker.join(timeout=5)

            self.assertFalse(worker.is_alive())
            launcher.assert_not_called()
            self.assertEqual(len(service.released), 1)
            self.assertIsNone(read_state(data_dir))
            status = result["status"]
            self.assertEqual(status["state"], "idle")
            self.assertIn("disabled or stopped", status["last_error"])

    def test_stop_after_reserved_reinspection_cancels_before_handoff(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".git").mkdir()
            data_dir = root / "state"
            service = _UpdateService(data_dir)
            service.blocked = False
            launcher = mock.Mock(return_value=["deploy.sh", "update"])
            manager = AutoUpdateManager(
                service,
                repo_root=root,
                launcher=launcher,
            )
            inspection = {
                "current_revision": "old",
                "remote_revision": "new",
                "remote": "origin",
                "branch": "main",
                "dirty": False,
                "dirty_summary": "",
                "update_available": True,
            }
            second_inspection_started = threading.Event()
            allow_second_inspection = threading.Event()
            inspection_count = 0

            def delayed_second_inspection():
                nonlocal inspection_count
                inspection_count += 1
                if inspection_count == 2:
                    second_inspection_started.set()
                    allow_second_inspection.wait(timeout=5)
                return dict(inspection)

            result: dict[str, object] = {}

            def check() -> None:
                result["status"] = manager.check_once(
                    "manual",
                    _generation=0,
                )

            with mock.patch.object(
                manager,
                "_inspect_upstream",
                side_effect=delayed_second_inspection,
            ):
                worker = threading.Thread(target=check)
                worker.start()
                self.assertTrue(second_inspection_started.wait(timeout=2))
                manager.stop()
                allow_second_inspection.set()
                worker.join(timeout=5)

            self.assertFalse(worker.is_alive())
            launcher.assert_not_called()
            self.assertEqual(len(service.released), 1)
            self.assertIsNone(read_state(data_dir))
            self.assertEqual(result["status"]["state"], "idle")


class ServiceUpdateReservationTests(unittest.TestCase):
    def test_message_persist_to_job_enqueue_gap_is_counted_as_admitted_work(self):
        with tempfile.TemporaryDirectory() as td:
            agent = _BlockingAgent()
            agent.release.set()
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=agent,
                autostart_runtime=False,
            )
            _, actor = service.authenticate("admin", "admin")
            enqueue_entered = threading.Event()
            allow_enqueue = threading.Event()
            original_enqueue = service.jobs.enqueue

            def delayed_enqueue(*args, **kwargs):
                enqueue_entered.set()
                allow_enqueue.wait(timeout=5)
                return original_enqueue(*args, **kwargs)

            result: dict[str, object] = {}

            def send() -> None:
                try:
                    result["value"] = service.send_private_message(actor, "atomic admission")
                except BaseException as exc:
                    result["error"] = exc

            try:
                with mock.patch.object(service.jobs, "enqueue", side_effect=delayed_enqueue):
                    sender = threading.Thread(target=send)
                    sender.start()
                    self.assertTrue(enqueue_entered.wait(timeout=2))
                    blocked = service.try_reserve_auto_update("update-gap")
                    self.assertFalse(blocked["reserved"])
                    self.assertGreaterEqual(blocked["admissions_in_progress"], 1)
                    allow_enqueue.set()
                    sender.join(timeout=5)
                self.assertFalse(sender.is_alive())
                self.assertNotIn("error", result)
                service.wait_for_agent_idle("private", str(actor["id"]), timeout=5)
            finally:
                allow_enqueue.set()
                agent.release.set()
                service.close()

    def test_active_agent_blocks_then_idle_reservation_rejects_new_message(self):
        with tempfile.TemporaryDirectory() as td:
            agent = _BlockingAgent()
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=agent,
                autostart_runtime=False,
            )
            _, actor = service.authenticate("admin", "admin")
            try:
                service.send_private_message(actor, "long task")
                self.assertTrue(agent.started.wait(timeout=2))
                blocked = service.try_reserve_auto_update("update-1")
                self.assertFalse(blocked["reserved"])
                self.assertGreaterEqual(blocked["active_agent_tasks"], 1)
                self.assertGreaterEqual(blocked["running_agent_jobs"], 1)

                agent.release.set()
                service.wait_for_agent_idle("private", str(actor["id"]), timeout=5)
                reserved = service.try_reserve_auto_update("update-1")
                self.assertTrue(reserved["reserved"])
                with self.assertRaises(ServiceError) as raised:
                    service.send_private_message(actor, "too late")
                self.assertEqual(raised.exception.status, 503)
                self.assertTrue(service.release_auto_update_reservation("update-1"))
            finally:
                agent.release.set()
                service.close()

    def test_protected_terminal_and_query_error_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            agent = _BlockingAgent()
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=agent,
                autostart_runtime=False,
            )
            try:
                agent.blocker_summary = {
                    "running_background_terminal_count": 1,
                    "update_blocking_terminal_count": 1,
                    "terminable_background_terminal_count": 0,
                }
                protected = service.try_reserve_auto_update("update-1")
                self.assertFalse(protected["reserved"])
                self.assertEqual(protected["protected_processes"], 1)

                agent.blocker_summary = RuntimeError("runtime unavailable")
                unavailable = service.try_reserve_auto_update("update-1")
                self.assertFalse(unavailable["reserved"])
                self.assertIn("runtime unavailable", unavailable["blocker_error"])

                agent.update_blocker_summary = None
                unsupported = service.try_reserve_auto_update("update-1")
                self.assertFalse(unsupported["reserved"])
                self.assertIn("does not expose", unsupported["blocker_error"])
            finally:
                service.close()

    def test_runtime_inventory_probe_keeps_new_agent_admissions_usable(self):
        with tempfile.TemporaryDirectory() as td:
            agent = _BlockingAgent()
            query_started = threading.Event()
            allow_query = threading.Event()

            def delayed_summary():
                query_started.set()
                allow_query.wait(timeout=5)
                return {
                    "running_background_terminal_count": 0,
                    "update_blocking_terminal_count": 0,
                    "terminable_background_terminal_count": 0,
                }

            agent.update_blocker_summary = delayed_summary
            agent.release.set()
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=agent,
                autostart_runtime=False,
            )
            _, actor = service.authenticate("admin", "admin")
            reservation: dict[str, object] = {}
            send_result: dict[str, object] = {}

            def reserve() -> None:
                reservation["value"] = service.try_reserve_auto_update("update-probe")

            def send() -> None:
                try:
                    send_result["value"] = service.send_private_message(
                        actor,
                        "arrived during idle probe",
                    )
                except BaseException as exc:
                    send_result["error"] = exc

            try:
                reserve_worker = threading.Thread(target=reserve)
                reserve_worker.start()
                self.assertTrue(query_started.wait(timeout=2))

                # The slow runtime HTTP equivalent runs outside the global
                # conversation lock.
                self.assertTrue(service._conversation_lock.acquire(timeout=0.25))
                service._conversation_lock.release()

                send_worker = threading.Thread(target=send)
                send_worker.start()
                send_worker.join(timeout=2)
                self.assertFalse(send_worker.is_alive())
                self.assertNotIn("error", send_result)

                allow_query.set()
                reserve_worker.join(timeout=5)
                self.assertFalse(reserve_worker.is_alive())
                self.assertFalse(reservation["value"]["reserved"])
                self.assertIn(
                    "admission changed",
                    reservation["value"]["blocker_error"],
                )
                service.wait_for_agent_idle(
                    "private",
                    str(actor["id"]),
                    timeout=5,
                )
            finally:
                allow_query.set()
                service.close()

    def test_recovered_agent_job_waits_for_durable_maintenance_to_end(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            first_agent = _BlockingAgent()
            first_agent.release.set()
            first = EnterpriseService(
                _config(data_dir),
                agent_client=first_agent,
                autostart_runtime=False,
            )
            _, actor = first.authenticate("admin", "admin")
            message = first._append_message(
                scope_type="private",
                scope_id=str(actor["id"]),
                author_type="user",
                user_id=int(actor["id"]),
                username=str(actor["display_name"]),
                content="recover after maintenance",
                metadata={"generation": first.account_generation_config(actor)},
            )
            task = {
                "scope_type": "private",
                "scope_id": str(actor["id"]),
                "actor": actor,
                "content": "recover after maintenance",
                "attachments": [],
                "generation": first.account_generation_config(actor),
                "user_message": message,
            }
            job, created = first.jobs.enqueue(
                kind="agent",
                dedupe_key=f"message:{int(message['id'])}",
                payload=task,
                scope_type="private",
                scope_id=str(actor["id"]),
            )
            self.assertTrue(created)
            first.close()

            update_id = "update-recovery"
            mark_updating(
                data_dir,
                update_id=update_id,
                instance_id="old-instance",
                reason="test",
                target_revision="abc",
                remote="origin",
                branch="main",
            )
            recovered_agent = _BlockingAgent()
            recovered = EnterpriseService(
                _config(data_dir),
                agent_client=recovered_agent,
                autostart_runtime=False,
            )
            try:
                time.sleep(0.1)
                self.assertFalse(recovered_agent.started.is_set())
                self.assertEqual(recovered.jobs.get(job.id).status, "queued")

                self.assertTrue(
                    recovered.release_auto_update_reservation(
                        update_id,
                        cleanup=lambda: clear_state(
                            data_dir,
                            update_id=update_id,
                        ),
                    )
                )
                self.assertTrue(recovered_agent.started.wait(timeout=2))
                recovered_agent.release.set()
                recovered.wait_for_agent_idle(
                    "private",
                    str(actor["id"]),
                    timeout=5,
                )
                self.assertEqual(recovered.jobs.get(job.id).status, "succeeded")
            finally:
                recovered_agent.release.set()
                clear_state(data_dir, update_id=update_id)
                recovered.close()

    def test_container_restores_finalize_reservation_before_starting_workers(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            first_agent = _BlockingAgent()
            first_agent.release.set()
            first = EnterpriseService(
                _config(data_dir),
                agent_client=first_agent,
                autostart_runtime=False,
            )
            _, actor = first.authenticate("admin", "admin")
            message = first._append_message(
                scope_type="private",
                scope_id=str(actor["id"]),
                author_type="user",
                user_id=int(actor["id"]),
                username=str(actor["display_name"]),
                content="resume only after Manager release",
                metadata={"generation": first.account_generation_config(actor)},
            )
            agent_job, created = first.jobs.enqueue(
                kind="agent",
                dedupe_key=f"message:{int(message['id'])}",
                payload={
                    "scope_type": "private",
                    "scope_id": str(actor["id"]),
                    "actor": actor,
                    "content": "resume only after Manager release",
                    "attachments": [],
                    "generation": first.account_generation_config(actor),
                    "user_message": message,
                },
                scope_type="private",
                scope_id=str(actor["id"]),
            )
            self.assertTrue(created)
            ingest_job, created = first.jobs.enqueue(
                kind="cognee",
                dedupe_key="document:991",
                payload={
                    "document_id": 991,
                    "title": "deferred ingest",
                    "content": "candidate must not ingest this before release",
                    "source": "test",
                },
                scope_type="knowledge",
                scope_id="991",
            )
            self.assertTrue(created)
            first.set_setting("telegram_enabled", "1")
            first.set_setting(
                "ENTERPRISE_TELEGRAM_BOT_TOKEN", "test-bot-token", secret=True
            )
            first.close()

            operation_id = "operation-finalize-1"
            manager = _ManagerStub(
                {
                    "generation": 18,
                    "public_state": "updating",
                    "phase": "committing",
                    "maintenance": True,
                    "active_operation_id": "",
                    "finalize_pending_operation_id": operation_id,
                    "operation_id": operation_id,
                }
            )
            container_config = replace(
                _config(data_dir),
                deployment_mode="container",
                manager_socket=data_dir / "manager.sock",
                manager_token_file=data_dir / "manager-token",
            )
            recovered_agent = _BlockingAgent()
            ingest_started = threading.Event()

            def ingest_document(**_kwargs):
                ingest_started.set()
                return {"attempted": True, "available": True}

            with mock.patch(
                "enterprise_agent_platform.telegram_gateway.TelegramGateway"
            ) as telegram_gateway:
                recovered = EnterpriseService(
                    container_config,
                    agent_client=recovered_agent,
                    autostart_runtime=False,
                    manager_client=manager,
                )
                recovered.cognee.ingest_document = ingest_document
                try:
                    time.sleep(0.1)
                    self.assertTrue(recovered.platform_update_is_blocking())
                    self.assertEqual(
                        recovered._auto_update_reservation_id, operation_id
                    )
                    self.assertEqual(recovered.jobs.get(agent_job.id).status, "queued")
                    self.assertEqual(recovered.jobs.get(ingest_job.id).status, "queued")
                    self.assertFalse(recovered_agent.started.is_set())
                    self.assertFalse(ingest_started.is_set())
                    self.assertEqual(recovered._agent_workers, {})
                    self.assertIsNone(recovered._ingest_thread)
                    self.assertIsNone(recovered._schedule_thread)
                    self.assertIsNone(recovered._telegram_gateway)
                    telegram_gateway.assert_not_called()

                    with self.assertRaisesRegex(
                        ServiceError, "does not match the Manager operation"
                    ) as mismatch:
                        recovered.manager_update_release("wrong-operation")
                    self.assertEqual(mismatch.exception.status, 409)
                    self.assertFalse(recovered_agent.started.is_set())
                    self.assertFalse(ingest_started.is_set())
                    self.assertIsNone(recovered._schedule_thread)
                    telegram_gateway.assert_not_called()

                    self.assertEqual(
                        recovered.manager_update_release(operation_id),
                        {"released": True},
                    )
                    self.assertTrue(recovered_agent.started.wait(timeout=2))
                    self.assertTrue(ingest_started.wait(timeout=2))
                    self.assertIsNotNone(recovered._schedule_thread)
                    self.assertTrue(recovered._schedule_thread.is_alive())
                    telegram_gateway.assert_called_once()
                    telegram_gateway.return_value.start.assert_called_once()
                    self.assertEqual(
                        recovered.manager_update_release(operation_id),
                        {"released": True},
                    )
                    telegram_gateway.assert_called_once()
                finally:
                    recovered_agent.release.set()
                    recovered.close()

    def test_container_startup_fails_closed_without_readable_manager_state(self):
        class UnavailableManager:
            @staticmethod
            def status():
                raise OSError("manager socket unavailable")

        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            with self.assertRaisesRegex(RuntimeError, "Manager control socket"):
                EnterpriseService(
                    replace(_config(data_dir), deployment_mode="container"),
                    agent_client=_BlockingAgent(),
                    autostart_runtime=False,
                )
            config = replace(
                _config(data_dir),
                deployment_mode="container",
                manager_socket=data_dir / "manager.sock",
                manager_token_file=data_dir / "manager-token",
            )
            with self.assertRaisesRegex(
                RuntimeError, "could not restore Manager maintenance state"
            ):
                EnterpriseService(
                    config,
                    agent_client=_BlockingAgent(),
                    autostart_runtime=False,
                    manager_client=UnavailableManager(),
                )

            # The failed status read happens before the data-directory instance
            # lock, so a corrected launch can proceed without stale ownership.
            service = EnterpriseService(
                _config(data_dir),
                agent_client=_BlockingAgent(),
                autostart_runtime=False,
            )
            service.close()

    def test_manager_active_maintenance_operation_is_a_startup_reservation(self):
        operation_id = "operation-active-1"
        self.assertEqual(
            EnterpriseService._manager_startup_reservation_id(
                {
                    "maintenance": True,
                    "active_operation_id": operation_id,
                    "finalize_pending_operation_id": "",
                    "operation_id": operation_id,
                }
            ),
            operation_id,
        )
        with self.assertRaisesRegex(ManagerClientError, "missing maintenance"):
            EnterpriseService._manager_startup_reservation_id(
                {"active_operation_id": operation_id, "operation_id": operation_id}
            )

    def test_existing_telegram_delivery_worker_pauses_for_live_reservation(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=_BlockingAgent(),
                autostart_runtime=False,
            )
            delivered = threading.Event()
            allow_delivery = threading.Event()

            def deliver(_actor, _payload, _message):
                delivered.set()
                allow_delivery.wait(timeout=2)

            service.set_setting("telegram_enabled", "1")
            service.manager_client = _ManagerStub()
            service.register_telegram_delivery_handler(deliver)
            try:
                self.assertIsNotNone(service._telegram_delivery_thread)
                self.assertTrue(service._telegram_delivery_thread.is_alive())
                reservation = service.try_reserve_auto_update("live-operation")
                self.assertTrue(reservation["reserved"])

                job = service.enqueue_telegram_text_delivery(
                    update_id=441,
                    chat_id=9441,
                    reply_to_message_id=None,
                    message_thread_id=None,
                    text="hold until release",
                    result={"ok": True},
                )
                time.sleep(0.3)
                self.assertFalse(delivered.is_set())
                self.assertEqual(service.jobs.get(job.id).status, "queued")

                self.assertEqual(
                    service.manager_update_release("live-operation"),
                    {"released": True},
                )
                self.assertTrue(delivered.wait(timeout=2))
                blocked = service.try_reserve_auto_update("next-operation")
                self.assertFalse(blocked["reserved"])
                self.assertEqual(blocked["admissions_in_progress"], 1)
                allow_delivery.set()
                completed = service.wait_for_telegram_delivery(job.id, timeout=2)
                self.assertIsNotNone(completed)
                self.assertEqual(completed.status, "succeeded")
            finally:
                allow_delivery.set()
                service.close()

    def test_running_cognee_ingest_holds_update_admission_until_safe(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(_config(Path(td)), knowledge_backend="hybrid")
            service = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                autostart_runtime=False,
            )
            service.manager_client = _ManagerStub()
            started = threading.Event()
            allow_ingest = threading.Event()

            def ingest_document(**_kwargs):
                started.set()
                allow_ingest.wait(timeout=2)
                return {"attempted": True, "available": True}

            service.cognee.ingest_document = ingest_document
            try:
                queued = service._queue_cognee_ingest(
                    {
                        "id": 771,
                        "title": "active ingest",
                        "content": "must finish before update",
                        "source": "test",
                    }
                )
                self.assertTrue(started.wait(timeout=2))
                blocked = service.try_reserve_auto_update("ingest-update")
                self.assertFalse(blocked["reserved"])
                self.assertEqual(blocked["admissions_in_progress"], 1)

                allow_ingest.set()
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    job = service.jobs.get(int(queued["job_id"]))
                    if job is not None and job.status == "succeeded":
                        break
                    time.sleep(0.02)
                else:
                    self.fail("Cognee ingest did not finish")
                reserved = service.try_reserve_auto_update("ingest-update")
                self.assertTrue(reserved["reserved"])
                self.assertTrue(service.release_auto_update_reservation("ingest-update"))
            finally:
                allow_ingest.set()
                service.close()

    def test_public_status_is_unauthenticated_and_maintenance_blocks_use(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            agent = _BlockingAgent()
            service = EnterpriseService(
                _config(data_dir),
                agent_client=agent,
                autostart_runtime=False,
            )
            service.validate_manager_internal_token = lambda token: token == "manager-token"
            service.manager_internal_health = lambda: {"status": "ok"}
            server, thread = serve_in_thread(service.config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/api/platform/update-status")
                response = conn.getresponse()
                idle = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(idle["state"], "idle")

                update_id = "update-http"
                reserved = service.try_reserve_auto_update(
                    update_id,
                    prepare=lambda: mark_updating(
                        data_dir,
                        update_id=update_id,
                        instance_id="old-instance",
                        reason="test",
                        target_revision="abc",
                        remote="origin",
                        branch="main",
                    ),
                )
                self.assertTrue(reserved["reserved"])
                conn.request("GET", "/")
                response = conn.getresponse()
                blocked = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 503)
                self.assertEqual(blocked["code"], "platform_updating")
                self.assertEqual(response.getheader("Retry-After"), "2")

                conn.request(
                    "GET",
                    "/internal/manager/health",
                    headers={"Authorization": "Bearer manager-token"},
                )
                response = conn.getresponse()
                manager_health = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(manager_health["status"], "ok")

                conn.request("GET", "/api/platform/update-status")
                response = conn.getresponse()
                updating = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(updating["state"], "updating")
                service.release_auto_update_reservation(
                    update_id,
                    cleanup=lambda: clear_state(data_dir, update_id=update_id),
                )
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)
