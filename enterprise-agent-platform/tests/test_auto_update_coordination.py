from __future__ import annotations

import http.client
import json
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.agent_runtime_client import AgentResult
from enterprise_agent_platform.agent_scopes import AgentScopeManager
from enterprise_agent_platform.camofox_state import ensure_camofox_runtime_sidecar
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.learning import LEARNING_REVIEW_JOB_KIND
from enterprise_agent_platform.manager_client import ManagerClientError
from enterprise_agent_platform.release_transition_contract_generated import (
    SOURCE_OWNER_COMPAT_GENERATION,
)
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import (
    EnterpriseService,
    ServiceError,
    _manager_handoff_receipt_digest,
    _validate_manager_handoff_receipt,
)
from test_platform import RecordingAgent


class _BlockingAgent(RecordingAgent):
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def generate(self, **kwargs):
        self.started.set()
        self.release.wait(timeout=5)
        return AgentResult(
            content="complete",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class _ManagerStub:
    def __init__(self, status: dict[str, object] | None = None):
        self.operations: list[dict[str, object]] = []
        self.checks: list[str] = []
        self.config_updates: list[dict[str, object]] = []
        self.status_payload = status or {
            "generation": 17,
            "public_state": "idle",
            "phase": "idle",
            "maintenance": False,
            "active_operation_id": "",
            "finalize_pending_operation_id": "",
            "operation_id": "",
            "workspace_schema_commit": None,
            "gate_settlement": None,
            "current": {
                "id": "release-current",
                "source_commit": "a" * 40,
                "images": {"platform": "registry/platform@sha256:abc"},
            },
            "previous": {"id": "release-previous"},
            "target": {"id": "release-target", "source_commit": "b" * 40},
            "services": {"platform": {"status": "healthy"}},
            "checked_at": "2026-07-24T12:34:56Z",
        }
        self.config_payload: dict[str, object] = {
            "update_enabled": True,
            "update_interval": 300,
            "release_manifest_url": "https://releases.example/main.json",
            "lan_enabled": False,
            "lan_listen": "127.0.0.1:8081",
            "direct_access_cidrs": ["192.168.0.0/16"],
            "trusted_ingress_cidrs": ["127.0.0.0/8"],
            "lan_active": False,
        }

    def config(self):
        return dict(self.config_payload)

    def update_config(self, updates):
        self.config_updates.append(dict(updates))
        self.config_payload.update(updates)
        return dict(self.config_payload)

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
    config = PlatformConfig(
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
        camofox_url="http://127.0.0.1:19377",
        firecrawl_api_url="http://127.0.0.1:13002",
        runtime_startup_wait_seconds=0,
        agent_runtime_url="http://127.0.0.1:8766",
        agent_runtime_token="runtime-token",
        agent_runtime_model="gpt-5.5",
        agent_runtime_provider="openai-codex",
        agent_runtime_idle_timeout_seconds=2,
        allow_insecure_bootstrap_password=True,
    )
    config.workspace_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    return config


def _container_config(data_dir: Path) -> PlatformConfig:
    return replace(
        _config(data_dir),
        manager_socket=data_dir / "manager.sock",
        manager_token_file=data_dir / "manager-token",
    )


class ManagerUpdateControlTests(unittest.TestCase):
    def test_status_keeps_release_identity_and_concurrency_generation_separate(self):
        with tempfile.TemporaryDirectory() as td:
            manager = _ManagerStub()
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=_BlockingAgent(),
                manager_client=manager,
            )
            try:
                _, actor = service.authenticate("admin", "admin")
                payload = service.auto_update_config(actor)
                self.assertEqual(payload["status"]["manager_generation"], 17)
                self.assertEqual(payload["status"]["current_generation"], "release-current")
                self.assertEqual(payload["status"]["previous_generation"], "release-previous")
                self.assertEqual(payload["status"]["target_generation"], "release-target")
                self.assertTrue(payload["status"]["update_available"])

                updated = service.update_auto_update_config(
                    actor,
                    {
                        "enabled": False,
                        "interval_seconds": 600,
                        "release_manifest_url": "https://releases.example/stable.json",
                    },
                )
                self.assertEqual(
                    manager.config_updates,
                    [{
                        "update_enabled": False,
                        "update_interval": 600,
                        "release_manifest_url": "https://releases.example/stable.json",
                    }],
                )
                self.assertFalse(updated["config"]["enabled"])

                checked = service.trigger_auto_update_check(actor)
                self.assertTrue(checked["accepted"])
                self.assertEqual(len(manager.checks), 1)

                operation = service.trigger_manager_operation(
                    actor,
                    "update",
                    {"expected_generation": 17, "idempotency_key": "test-update"},
                )
                self.assertEqual(operation["operation"], "update")
                self.assertEqual(operation["expected_generation"], 17)
            finally:
                service.close()

    def test_startup_fails_closed_with_unreadable_manager_state(self):
        class UnavailableManager:
            @staticmethod
            def status():
                raise ManagerClientError("manager socket unavailable")

        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            with self.assertRaisesRegex(
                RuntimeError, "could not restore Manager maintenance state"
            ):
                EnterpriseService(
                    _container_config(data_dir),
                    agent_client=_BlockingAgent(),
                    manager_client=UnavailableManager(),
                )

            # Failure happens before the instance lock, so a corrected launch
            # can immediately take ownership of the data directory.
            corrected = EnterpriseService(
                _container_config(data_dir),
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(),
            )
            corrected.close()

    def test_lan_config_is_manager_owned_and_strictly_forwarded(self):
        with tempfile.TemporaryDirectory() as td:
            manager = _ManagerStub()
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=_BlockingAgent(),
                manager_client=manager,
            )
            try:
                _, actor = service.authenticate("admin", "admin")
                current = service.auto_update_config(actor)["config"]
                self.assertFalse(current["lan_enabled"])
                self.assertEqual(current["lan_listen"], "127.0.0.1:8081")
                self.assertEqual(current["direct_access_cidrs"], ["192.168.0.0/16"])

                updated = service.update_auto_update_config(
                    actor,
                    {
                        "lan_enabled": True,
                        "lan_listen": "192.168.10.5:8091",
                        "direct_access_cidrs": ["10.20.0.0/16"],
                        "trusted_ingress_cidrs": ["127.0.0.0/8", "10.20.0.2/32"],
                    },
                )
                self.assertEqual(
                    manager.config_updates,
                    [{
                        "lan_enabled": True,
                        "lan_listen": "192.168.10.5:8091",
                        "direct_access_cidrs": ["10.20.0.0/16"],
                        "trusted_ingress_cidrs": ["127.0.0.0/8", "10.20.0.2/32"],
                    }],
                )
                self.assertTrue(updated["config"]["lan_enabled"])

                with self.assertRaisesRegex(ServiceError, "entries must be strings"):
                    service.update_auto_update_config(
                        actor,
                        {"direct_access_cidrs": ["10.0.0.0/8", 7]},
                    )
            finally:
                service.close()

    def test_manager_maintenance_identity_is_strictly_validated(self):
        operation_id = "operation-active-1"
        self.assertEqual(
            EnterpriseService._manager_startup_reservation_id(
                {
                    "maintenance": True,
                    "active_operation_id": operation_id,
                    "finalize_pending_operation_id": "",
                    "operation_id": operation_id,
                    "workspace_schema_commit": None,
                    "gate_settlement": None,
                }
            ),
            operation_id,
        )
        with self.assertRaisesRegex(ManagerClientError, "missing maintenance"):
            EnterpriseService._manager_startup_reservation_id(
                {"active_operation_id": operation_id, "operation_id": operation_id}
            )

    def test_gate_settlement_absence_is_only_accepted_for_exact_p1_boundary(self):
        idle = dict(_ManagerStub().status_payload)
        idle.pop("gate_settlement")
        with self.assertRaisesRegex(ManagerClientError, "missing the Gate settlement"):
            EnterpriseService._manager_startup_gate_settlement(idle)

        explicit_null = dict(idle)
        explicit_null["gate_settlement"] = None
        self.assertIsNone(
            EnterpriseService._manager_startup_gate_settlement(explicit_null)
        )
        self.assertEqual(
            EnterpriseService._manager_startup_reservation_id(explicit_null), ""
        )

        operation_id = "op_" + "9" * 32
        legacy = ServiceUpdateReservationTests._p1_status(operation_id)
        self.assertNotIn("gate_settlement", legacy)
        self.assertIsNone(
            EnterpriseService._manager_startup_gate_settlement(legacy)
        )
        self.assertEqual(
            EnterpriseService._manager_startup_reservation_id(legacy), operation_id
        )

        legacy["current"] = {"id": "b" * 40, "source_commit": "b" * 40}
        with self.assertRaisesRegex(ManagerClientError, "missing the Gate settlement"):
            EnterpriseService._manager_startup_gate_settlement(legacy)

    def test_handoff_commit_http_contract_is_authenticated_and_closed_world(self):
        operation_id = "handoff_" + "6" * 32
        target_generation = "7" * 40
        binding_sha256 = "8" * 64
        status = {
            "maintenance": True,
            "public_state": "updating",
            "active_operation_id": operation_id,
            "finalize_pending_operation_id": "",
            "operation_id": operation_id,
            "workspace_schema_commit": None,
            "gate_settlement": None,
        }
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            token_file = data_dir / "manager-token"
            token_file.write_text("manager-token\n", encoding="utf-8")
            token_file.chmod(0o600)
            config = replace(_config(data_dir), manager_token_file=token_file)
            service = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(status=status),
            )
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            headers = {
                "Authorization": "Bearer manager-token",
                "Content-Type": "application/json",
            }
            try:
                oversized_conn = http.client.HTTPConnection(host, port, timeout=5)
                oversized_conn.request(
                    "POST",
                    "/internal/manager/handoff/commit-release",
                    body=" " * (16 * 1024 + 1),
                    headers=headers,
                )
                oversized_response = oversized_conn.getresponse()
                oversized_response.read()
                self.assertEqual(oversized_response.status, 413)
                oversized_conn.close()

                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/internal/manager/handoff/reservation")
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.status, 401)

                duplicate = (
                    '{"operation_id":"%s","operation_id":"%s",'
                    '"target_generation":"%s","binding_sha256":"%s"}'
                    % (
                        operation_id,
                        operation_id,
                        target_generation,
                        binding_sha256,
                    )
                )
                conn.request(
                    "POST",
                    "/internal/manager/handoff/commit-release",
                    body=duplicate,
                    headers=headers,
                )
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.status, 400)
                self.assertTrue(service.platform_update_is_blocking())

                unknown = {
                    "operation_id": operation_id,
                    "target_generation": target_generation,
                    "binding_sha256": binding_sha256,
                    "unexpected": True,
                }
                conn.request(
                    "POST",
                    "/internal/manager/handoff/commit-release",
                    body=json.dumps(unknown),
                    headers=headers,
                )
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.status, 400)

                request = {
                    "operation_id": operation_id,
                    "target_generation": target_generation,
                    "binding_sha256": binding_sha256,
                }
                conn.request(
                    "POST",
                    "/internal/manager/handoff/commit-release",
                    body=json.dumps(request),
                    headers=headers,
                )
                response = conn.getresponse()
                committed = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(set(committed), {"released", "receipt"})
                self.assertEqual(committed["receipt"]["operation_id"], operation_id)

                conn.request(
                    "GET",
                    "/internal/manager/handoff/reservation",
                    headers={"Authorization": "Bearer manager-token"},
                )
                response = conn.getresponse()
                observed = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(
                    set(observed),
                    {
                        "schema_version",
                        "reserved",
                        "reservation_id",
                        "reservation_owner",
                        "receipt",
                    },
                )
                self.assertFalse(observed["reserved"])
                self.assertEqual(observed["receipt"], committed["receipt"])
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


class ServiceUpdateReservationTests(unittest.TestCase):
    @staticmethod
    def _handoff_status(operation_id: str) -> dict[str, object]:
        return {
            "maintenance": True,
            "public_state": "updating",
            "active_operation_id": operation_id,
            "finalize_pending_operation_id": "",
            "operation_id": operation_id,
            "workspace_schema_commit": None,
            "gate_settlement": None,
        }

    @staticmethod
    def _p1_status(operation_id: str) -> dict[str, object]:
        status = ServiceUpdateReservationTests._handoff_status(operation_id)
        status.pop("gate_settlement")
        status.pop("workspace_schema_commit")
        status["current"] = {
            "id": SOURCE_OWNER_COMPAT_GENERATION,
            "source_commit": SOURCE_OWNER_COMPAT_GENERATION,
        }
        status["target"] = {
            "id": "a" * 40,
            "source_commit": "a" * 40,
        }
        return status

    @staticmethod
    def _post_switch_p1_status(operation_id: str) -> dict[str, object]:
        target_generation = "a" * 40
        return {
            "maintenance": True,
            "active_operation_id": "",
            "finalize_pending_operation_id": operation_id,
            "operation_id": operation_id,
            "public_state": "updating",
            "current": {
                "id": target_generation,
                "source_commit": target_generation,
            },
            "previous": {
                "id": SOURCE_OWNER_COMPAT_GENERATION,
                "source_commit": SOURCE_OWNER_COMPAT_GENERATION,
            },
            "target": None,
            "workspace_schema_commit": {
                "schema_version": 1,
                "operation_id": operation_id,
                "predecessor_generation": SOURCE_OWNER_COMPAT_GENERATION,
                "target_generation": target_generation,
            },
            "gate_settlement": None,
        }

    @staticmethod
    def _settled_status(operation_id: str, action: str) -> dict[str, object]:
        generation = "c" * 40
        return {
            "maintenance": True,
            "public_state": "updating",
            "active_operation_id": "",
            "finalize_pending_operation_id": operation_id,
            "operation_id": operation_id,
            "current": {"id": generation, "source_commit": generation},
            "previous": None,
            "target": None,
            "workspace_schema_commit": None,
            "gate_settlement": {
                "schema_version": 1,
                "operation_id": operation_id,
                "action": action,
            },
        }

    def test_settled_commit_restart_is_unreserved_and_second_gate_is_idempotent(self):
        operation_id = "op_" + "a" * 32
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            baseline = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(),
            )
            baseline.close()

            service = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(
                    status=self._settled_status(operation_id, "commit")
                ),
            )
            try:
                self.assertFalse(service.platform_update_is_blocking())
                self.assertEqual(service._auto_update_last_committed_id, operation_id)
                with mock.patch.object(
                    service.agent_scopes,
                    "commit_schema_upgrade",
                    side_effect=AssertionError("settled schema commit repeated"),
                ), mock.patch(
                    "enterprise_agent_platform.service.ensure_camofox_runtime_sidecar",
                    side_effect=AssertionError("settled Camoufox commit repeated"),
                ):
                    self.assertEqual(
                        service.manager_update_commit_release(operation_id),
                        {"released": True},
                    )
            finally:
                service.close()

    def test_settled_abort_restart_reopens_only_current_in_memory_gate(self):
        operation_id = "op_" + "b" * 32
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            baseline = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(),
            )
            baseline.close()

            calls: list[bool] = []

            def observe_sidecar(data_dir, *, commit_schema_upgrade=False):
                calls.append(bool(commit_schema_upgrade))
                return ensure_camofox_runtime_sidecar(
                    data_dir, commit_schema_upgrade=commit_schema_upgrade
                )

            with mock.patch(
                "enterprise_agent_platform.service.ensure_camofox_runtime_sidecar",
                side_effect=observe_sidecar,
            ):
                service = EnterpriseService(
                    config,
                    agent_client=_BlockingAgent(),
                    manager_client=_ManagerStub(
                        status=self._settled_status(operation_id, "abort")
                    ),
                )
            try:
                self.assertEqual(calls, [False])
                self.assertFalse(service.platform_update_is_blocking())
                self.assertTrue(service.agent_scopes._schema_writes_enabled)
                self.assertEqual(service._auto_update_last_released_id, operation_id)
                self.assertEqual(
                    service.manager_update_abort_release(operation_id),
                    {"released": True},
                )
            finally:
                service.close()

    def test_gate_settlement_rejects_closed_world_and_slot_drift(self):
        operation_id = "op_" + "c" * 32
        mutations = {
            "boolean schema": lambda status: status["gate_settlement"].__setitem__(
                "schema_version", True
            ),
            "extra field": lambda status: status["gate_settlement"].__setitem__(
                "extra", "unexpected"
            ),
            "wrong operation": lambda status: status["gate_settlement"].__setitem__(
                "operation_id", "op_" + "d" * 32
            ),
            "wrong action": lambda status: status["gate_settlement"].__setitem__(
                "action", "release"
            ),
            "active overlap": lambda status: status.__setitem__(
                "active_operation_id", operation_id
            ),
            "candidate appeared": lambda status: status.__setitem__(
                "target", {"id": "d" * 40, "source_commit": "d" * 40}
            ),
            "current drift": lambda status: status["current"].__setitem__(
                "source_commit", "d" * 40
            ),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                status = self._settled_status(operation_id, "commit")
                mutate(status)
                with self.assertRaisesRegex(ManagerClientError, "settlement"):
                    EnterpriseService._manager_startup_gate_settlement(status)

    def test_exact_p1_reservation_materializes_workspace_only_at_commit(self):
        operation_id = "op_" + "1" * 32
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                workspace = Path(scope.workspace_path)
                channel_root = workspace.parent
                shutil.rmtree(channel_root)
                db.execute(
                    "DELETE FROM agent_runtime_scope_sessions WHERE scope_key = ?",
                    (scope.scope_key,),
                )
            finally:
                db.close()

            service = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(status=self._p1_status(operation_id)),
            )
            try:
                self.assertFalse(channel_root.exists())
                self.assertIsNone(
                    service.db.query_one(
                        "SELECT 1 FROM agent_runtime_scope_sessions WHERE scope_key = ?",
                        (scope.scope_key,),
                    )
                )

                self.assertEqual(
                    service.manager_update_commit_release(operation_id),
                    {"released": True},
                )
                self.assertEqual(channel_root.stat().st_mode & 0o777, 0o700)
                self.assertEqual(workspace.stat().st_mode & 0o777, 0o700)
                marker = workspace / ".ubitech-agent-scope.json"
                self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
                self.assertEqual(
                    json.loads(marker.read_text(encoding="utf-8"))["scope_key"],
                    scope.scope_key,
                )
                self.assertIsNotNone(
                    service.db.query_one(
                        "SELECT 1 FROM agent_runtime_scope_sessions WHERE scope_key = ?",
                        (scope.scope_key,),
                    )
                )
            finally:
                service.close()

    def test_exact_p1_abort_keeps_unmaterialized_workspace_absent(self):
        operation_id = "op_" + "3" * 32
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                channel_root = Path(scope.workspace_path).parent
                shutil.rmtree(channel_root)
            finally:
                db.close()

            service = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(status=self._p1_status(operation_id)),
            )
            try:
                with mock.patch.object(
                    service,
                    "_resume_deferred_background_workers",
                    side_effect=AssertionError("P1 abort resumed background workers"),
                ), mock.patch.object(
                    service,
                    "_start_deferred_agent_workers_locked",
                    side_effect=AssertionError("P1 abort resumed Agent workers"),
                ):
                    self.assertEqual(
                        service.manager_update_abort_release(operation_id),
                        {"released": True},
                    )
                    self.assertEqual(
                        service.manager_update_abort_release(operation_id),
                        {"released": True},
                    )
                self.assertFalse(channel_root.exists())
                self.assertTrue(service.platform_update_is_blocking())
                self.assertEqual(
                    service._auto_update_reservation_id,
                    operation_id,
                )
                self.assertFalse(service.agent_scopes._schema_writes_enabled)
            finally:
                service.close()

    def test_exact_p1_abort_quiescence_is_rederived_after_platform_restart(self):
        operation_id = "op_" + "e" * 32
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                channel_root = Path(scope.workspace_path).parent
                shutil.rmtree(channel_root)
            finally:
                db.close()

            status = self._p1_status(operation_id)
            first = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(status=status),
            )
            try:
                self.assertEqual(
                    first.manager_update_abort_release(operation_id),
                    {"released": True},
                )
                self.assertTrue(first.platform_update_is_blocking())
            finally:
                first.close()

            restarted = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(status=status),
            )
            try:
                self.assertTrue(restarted.platform_update_is_blocking())
                self.assertTrue(
                    restarted.agent_scopes.abort_requires_process_quiescence()
                )
                self.assertEqual(
                    restarted.manager_update_abort_release(operation_id),
                    {"released": True},
                )
                self.assertTrue(restarted.platform_update_is_blocking())
                self.assertFalse(channel_root.exists())
            finally:
                restarted.close()

    def test_p1_workspace_commit_resumes_across_platform_restart(self):
        operation_id = "op_" + "4" * 32
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            db = Database(config.db_path)
            try:
                manager = AgentScopeManager(config, db)
                scopes = [
                    manager.ensure_channel_scope(1),
                    manager.ensure_channel_scope(2),
                ]
                channel_root = Path(scopes[0].workspace_path).parent
                shutil.rmtree(channel_root)
                for scope in scopes:
                    db.execute(
                        "DELETE FROM agent_runtime_scope_sessions WHERE scope_key = ?",
                        (scope.scope_key,),
                    )
            finally:
                db.close()

            first = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(status=self._p1_status(operation_id)),
            )
            real_write = first.agent_scopes._write_scope_marker
            marker_writes = 0

            def fail_after_first_marker(scope, **kwargs):
                nonlocal marker_writes
                real_write(scope, **kwargs)
                marker_writes += 1
                if marker_writes == 1:
                    raise RuntimeError("simulated process loss after first marker")

            try:
                with mock.patch.object(
                    first.agent_scopes,
                    "_write_scope_marker",
                    side_effect=fail_after_first_marker,
                ):
                    with self.assertRaisesRegex(RuntimeError, "process loss"):
                        first.manager_update_commit_release(operation_id)
            finally:
                first.close()

            self.assertTrue(
                (
                    Path(scopes[0].workspace_path)
                    / ".ubitech-agent-scope.json"
                ).is_file()
            )
            self.assertFalse(Path(scopes[1].workspace_path).exists())

            recovered = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(
                    status=self._post_switch_p1_status(operation_id)
                ),
            )
            try:
                self.assertEqual(
                    recovered.manager_update_commit_release(operation_id),
                    {"released": True},
                )
                for scope in scopes:
                    marker = (
                        Path(scope.workspace_path)
                        / ".ubitech-agent-scope.json"
                    )
                    self.assertEqual(
                        json.loads(marker.read_text(encoding="utf-8"))["scope_key"],
                        scope.scope_key,
                    )
                    self.assertIsNotNone(
                        recovered.db.query_one(
                            "SELECT 1 FROM agent_runtime_scope_sessions WHERE scope_key = ?",
                            (scope.scope_key,),
                        )
                    )
            finally:
                recovered.close()

    def test_non_p1_reservation_does_not_gain_workspace_compatibility(self):
        operation_id = "op_" + "2" * 32
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_channel_scope(1)
                channel_root = Path(scope.workspace_path).parent
                shutil.rmtree(channel_root)
            finally:
                db.close()
            status = self._handoff_status(operation_id)
            status["current"] = {"id": "a" * 40, "source_commit": "a" * 40}

            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "workspace directory is missing",
            ):
                EnterpriseService(
                    config,
                    agent_client=_BlockingAgent(),
                    manager_client=_ManagerStub(status=status),
                )
            self.assertFalse(channel_root.exists())

    def test_explicit_null_reservation_does_not_repair_marker_or_alias(self):
        operation_id = "op_" + "8" * 32
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            db = Database(config.db_path)
            try:
                scope = AgentScopeManager(config, db).ensure_private_scope(1)
                marker = Path(scope.workspace_path) / ".ubitech-agent-scope.json"
                marker.unlink()
                db.execute(
                    "DELETE FROM agent_runtime_scope_sessions WHERE scope_key = ?",
                    (scope.scope_key,),
                )
            finally:
                db.close()

            status = self._p1_status(operation_id)
            status["workspace_schema_commit"] = None
            with self.assertRaisesRegex(
                sqlite3.DatabaseError,
                "current alias is missing",
            ):
                EnterpriseService(
                    config,
                    agent_client=_BlockingAgent(),
                    manager_client=_ManagerStub(status=status),
                )

            self.assertFalse(marker.exists())
            verification = Database(config.db_path)
            try:
                self.assertIsNone(
                    verification.query_one(
                        "SELECT 1 FROM agent_runtime_scope_sessions WHERE scope_key = ?",
                        (scope.scope_key,),
                    )
                )
            finally:
                verification.close()

    def test_workspace_commit_capability_rejects_slot_and_field_drift(self):
        operation_id = "op_" + "5" * 32
        mutations = {
            "boolean schema": lambda status: status["workspace_schema_commit"].__setitem__(
                "schema_version", True
            ),
            "extra field": lambda status: status["workspace_schema_commit"].__setitem__(
                "extra", "unexpected"
            ),
            "operation mismatch": lambda status: status[
                "workspace_schema_commit"
            ].__setitem__("operation_id", "op_" + "6" * 32),
            "predecessor mismatch": lambda status: status[
                "workspace_schema_commit"
            ].__setitem__("predecessor_generation", "b" * 40),
            "current source mismatch": lambda status: status["current"].__setitem__(
                "source_commit", "b" * 40
            ),
            "previous id mismatch": lambda status: status["previous"].__setitem__(
                "id", "b" * 40
            ),
            "candidate reappeared": lambda status: status.__setitem__(
                "target", {"id": "a" * 40, "source_commit": "a" * 40}
            ),
            "active overlap": lambda status: status.__setitem__(
                "active_operation_id", operation_id
            ),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                status = self._post_switch_p1_status(operation_id)
                mutate(status)
                self.assertFalse(
                    EnterpriseService._manager_allows_source_owner_workspace_commit(
                        status,
                        operation_id,
                    )
                )

    def test_legacy_p1_workspace_capability_requires_exact_target_and_slots(self):
        operation_id = "op_" + "7" * 32
        valid = self._p1_status(operation_id)
        self.assertTrue(
            EnterpriseService._manager_allows_source_owner_workspace_commit(
                valid,
                operation_id,
            )
        )
        explicit_null = self._p1_status(operation_id)
        explicit_null["workspace_schema_commit"] = None
        self.assertFalse(
            EnterpriseService._manager_allows_source_owner_workspace_commit(
                explicit_null,
                operation_id,
            )
        )
        for field, value in (
            ("target", None),
            (
                "target",
                {"id": "a" * 40, "source_commit": "b" * 40},
            ),
            ("finalize_pending_operation_id", operation_id),
        ):
            with self.subTest(field=field, value=value):
                status = self._p1_status(operation_id)
                status[field] = value
                self.assertFalse(
                    EnterpriseService._manager_allows_source_owner_workspace_commit(
                        status,
                        operation_id,
                    )
                )

    def test_handoff_receipt_digest_uses_cross_runtime_canonical_form(self):
        receipt = {
            "schema_version": 1,
            "operation_id": "handoff_" + "a" * 32,
            "target_generation": "b" * 40,
            "binding_sha256": "c" * 64,
            "database_schema_version": 2026072901,
            "committed_at": "2026-07-31T12:34:56.123456Z",
        }
        self.assertEqual(
            _manager_handoff_receipt_digest(receipt),
            "d88b7e48f47f0d3337d3a11a66a9fb3a863145127f5dd49b28ab7e280f35037b",
        )

    def test_handoff_receipt_requires_json_integer_schema_version(self):
        receipt = {
            "schema_version": True,
            "operation_id": "handoff_" + "a" * 32,
            "target_generation": "b" * 40,
            "binding_sha256": "c" * 64,
            "database_schema_version": 2026072901,
            "committed_at": "2026-07-31T12:34:56.123456Z",
        }
        receipt["receipt_sha256"] = _manager_handoff_receipt_digest(receipt)
        with self.assertRaisesRegex(ValueError, "schema is unsupported"):
            _validate_manager_handoff_receipt(receipt)

    def test_handoff_commit_receipt_survives_restart_and_lost_response(self):
        operation_id = "handoff_" + "a" * 32
        target_generation = "b" * 40
        binding_sha256 = "c" * 64
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            config = _config(data_dir)
            manager = _ManagerStub(status=self._handoff_status(operation_id))
            service = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=manager,
            )
            try:
                first = service.manager_handoff_commit_release(
                    operation_id, target_generation, binding_sha256
                )
                self.assertEqual(set(first), {"released", "receipt"})
                self.assertTrue(first["released"])
                self.assertEqual(first["receipt"]["operation_id"], operation_id)
                self.assertEqual(
                    service.manager_handoff_reservation(),
                    {
                        "schema_version": 1,
                        "reserved": False,
                        "reservation_id": "",
                        "reservation_owner": "",
                        "receipt": first["receipt"],
                    },
                )
                # Treat the successful return as a response lost after the
                # server completed every effect. The next process must return
                # the same durable receipt without repeating schemas.
            finally:
                service.close()

            restarted = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(
                    status=self._handoff_status(operation_id)
                ),
            )
            try:
                with mock.patch.object(
                    restarted.agent_scopes,
                    "commit_schema_upgrade",
                    side_effect=AssertionError("workspace schema repeated"),
                ), mock.patch(
                    "enterprise_agent_platform.service.ensure_camofox_runtime_sidecar",
                    side_effect=AssertionError("Camoufox schema repeated"),
                ):
                    replay = restarted.manager_handoff_commit_release(
                        operation_id, target_generation, binding_sha256
                    )
                self.assertEqual(replay, first)
                self.assertFalse(restarted.platform_update_is_blocking())
            finally:
                restarted.close()

    def test_handoff_receipt_before_release_is_reconciled_after_restart(self):
        operation_id = "handoff_" + "d" * 32
        target_generation = "e" * 40
        binding_sha256 = "f" * 64
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            config = _config(data_dir)
            service = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(
                    status=self._handoff_status(operation_id)
                ),
            )
            try:
                with mock.patch.object(
                    service,
                    "release_auto_update_reservation",
                    return_value=False,
                ):
                    with self.assertRaisesRegex(
                        ServiceError, "reservation does not match"
                    ):
                        service.manager_handoff_commit_release(
                            operation_id, target_generation, binding_sha256
                        )
                uncertain = service.manager_handoff_reservation()
                self.assertTrue(uncertain["reserved"])
                self.assertIsNotNone(uncertain["receipt"])
            finally:
                service.close()

            restarted = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(
                    status=self._handoff_status(operation_id)
                ),
            )
            try:
                with mock.patch.object(
                    restarted.agent_scopes,
                    "commit_schema_upgrade",
                    side_effect=AssertionError("workspace schema repeated"),
                ), mock.patch(
                    "enterprise_agent_platform.service.ensure_camofox_runtime_sidecar",
                    side_effect=AssertionError("Camoufox schema repeated"),
                ):
                    result = restarted.manager_handoff_commit_release(
                        operation_id, target_generation, binding_sha256
                    )
                self.assertEqual(result["receipt"], uncertain["receipt"])
                self.assertFalse(restarted.platform_update_is_blocking())
            finally:
                restarted.close()

    def test_handoff_commit_rejects_conflicting_or_malformed_identity(self):
        operation_id = "handoff_" + "1" * 32
        target_generation = "2" * 40
        binding_sha256 = "3" * 64
        with tempfile.TemporaryDirectory() as td:
            config = _config(Path(td))
            service = EnterpriseService(
                config,
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(
                    status=self._handoff_status(operation_id)
                ),
            )
            try:
                service.manager_handoff_commit_release(
                    operation_id, target_generation, binding_sha256
                )
                for arguments in (
                    (operation_id, "4" * 40, binding_sha256),
                    (operation_id, target_generation, "5" * 64),
                ):
                    with self.assertRaisesRegex(ServiceError, "another identity"):
                        service.manager_handoff_commit_release(*arguments)
                with self.assertRaisesRegex(ServiceError, "operation_id is invalid"):
                    service.manager_handoff_commit_release(
                        "op_not-a-handoff", target_generation, binding_sha256
                    )
                with self.assertRaisesRegex(ServiceError, "must be strings"):
                    service.manager_handoff_commit_release(
                        operation_id, 7, binding_sha256  # type: ignore[arg-type]
                    )
            finally:
                service.close()

    def test_only_commit_release_advances_machine_schemas(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=_BlockingAgent(),
                manager_client=_ManagerStub(),
            )
            schema_events: list[str] = []

            def commit_workspace_schema() -> None:
                self.assertTrue(service.platform_update_is_blocking())
                schema_events.append("workspace")

            def commit_camofox_schema(_data_dir, *, commit_schema_upgrade=False):
                self.assertTrue(service.platform_update_is_blocking())
                self.assertTrue(commit_schema_upgrade)
                schema_events.append("camofox")
                return {"schema_version": 2}

            try:
                self.assertTrue(service.try_reserve_auto_update("abort-1")["reserved"])
                with mock.patch.object(
                    service.agent_scopes,
                    "commit_schema_upgrade",
                    side_effect=commit_workspace_schema,
                ), mock.patch(
                    "enterprise_agent_platform.service.ensure_camofox_runtime_sidecar",
                    side_effect=commit_camofox_schema,
                ):
                    self.assertEqual(
                        service.manager_update_abort_release("abort-1"),
                        {"released": True},
                    )
                self.assertEqual(schema_events, [])

                self.assertTrue(service.try_reserve_auto_update("commit-1")["reserved"])
                with mock.patch.object(
                    service.agent_scopes,
                    "commit_schema_upgrade",
                    side_effect=commit_workspace_schema,
                ), mock.patch(
                    "enterprise_agent_platform.service.ensure_camofox_runtime_sidecar",
                    side_effect=commit_camofox_schema,
                ):
                    self.assertEqual(
                        service.manager_update_commit_release("commit-1"),
                        {"released": True},
                    )
                    self.assertEqual(
                        service.manager_update_commit_release("commit-1"),
                        {"released": True},
                    )
                self.assertEqual(schema_events, ["workspace", "camofox"])
                self.assertFalse(service.platform_update_is_blocking())

                self.assertTrue(service.try_reserve_auto_update("commit-fails")["reserved"])
                with mock.patch.object(
                    service.agent_scopes,
                    "commit_schema_upgrade",
                    side_effect=RuntimeError("schema write failed"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "schema write failed"):
                        service.manager_update_commit_release("commit-fails")
                self.assertTrue(service.platform_update_is_blocking())
                self.assertEqual(
                    service.manager_update_abort_release("commit-fails"),
                    {"released": True},
                )
            finally:
                service.close()

    def test_message_persist_to_job_enqueue_gap_is_counted_as_admitted_work(self):
        with tempfile.TemporaryDirectory() as td:
            agent = _BlockingAgent()
            agent.release.set()
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=agent,
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
                    result["value"] = service.send_private_message(
                        actor, "atomic admission"
                    )
                except BaseException as exc:
                    result["error"] = exc

            try:
                with mock.patch.object(
                    service.jobs, "enqueue", side_effect=delayed_enqueue
                ):
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

    def test_queued_learning_review_crosses_update_but_claimed_review_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=_BlockingAgent(),
            )
            review_id: int | None = None
            try:
                review, created = service.jobs.enqueue(
                    kind=LEARNING_REVIEW_JOB_KIND,
                    dedupe_key="update-quiescence-review",
                    payload={},
                    scope_type="private",
                    scope_id="1",
                    available_at=int(time.time()) + 3600,
                )
                self.assertTrue(created)
                review_id = review.id

                queued = service.try_reserve_auto_update("queued-review-update")
                self.assertTrue(queued["reserved"])
                self.assertTrue(
                    service.release_auto_update_reservation(
                        "queued-review-update"
                    )
                )

                with service._conversation_lock:
                    service._learning_active_jobs[review.id] = "review-run"
                active = service.try_reserve_auto_update("active-review-update")
                self.assertFalse(active["reserved"])
                self.assertEqual(active["active_learning_reviews"], 1)

                with service._conversation_lock:
                    service._learning_active_jobs.pop(review.id, None)
                idle = service.try_reserve_auto_update("settled-review-update")
                self.assertTrue(idle["reserved"])
                self.assertTrue(
                    service.release_auto_update_reservation(
                        "settled-review-update"
                    )
                )
            finally:
                if review_id is not None:
                    with service._conversation_lock:
                        service._learning_active_jobs.pop(review_id, None)
                service.close()

    def test_finalize_reservation_defers_agent_and_background_workers(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            seed_agent = _BlockingAgent()
            seed_agent.release.set()
            seed = EnterpriseService(
                _config(data_dir),
                agent_client=seed_agent,
            )
            _, actor = seed.authenticate("admin", "admin")
            message = seed._append_message(
                scope_type="private",
                scope_id=str(actor["id"]),
                author_type="user",
                user_id=int(actor["id"]),
                username=str(actor["display_name"]),
                content="resume only after Manager release",
                metadata={"generation": seed.account_generation_config(actor)},
            )
            agent_job, created = seed.jobs.enqueue(
                kind="agent",
                dedupe_key=f"message:{int(message['id'])}",
                payload={
                    "scope_type": "private",
                    "scope_id": str(actor["id"]),
                    "actor": actor,
                    "content": "resume only after Manager release",
                    "attachments": [],
                    "generation": seed.account_generation_config(actor),
                    "user_message": message,
                },
                scope_type="private",
                scope_id=str(actor["id"]),
            )
            self.assertTrue(created)
            ingest_job, created = seed.jobs.enqueue(
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
            seed.close()

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
                    "workspace_schema_commit": None,
                    "gate_settlement": None,
                }
            )
            recovered_agent = _BlockingAgent()
            ingest_started = threading.Event()

            def ingest_document(**_kwargs):
                ingest_started.set()
                return {"attempted": True, "available": True}

            recovered = EnterpriseService(
                _container_config(data_dir),
                agent_client=recovered_agent,
                manager_client=manager,
            )
            recovered.cognee.ingest_document = ingest_document
            try:
                time.sleep(0.1)
                self.assertTrue(recovered.platform_update_is_blocking())
                self.assertEqual(recovered.jobs.get(agent_job.id).status, "queued")
                self.assertEqual(recovered.jobs.get(ingest_job.id).status, "queued")
                self.assertFalse(recovered_agent.started.is_set())
                self.assertFalse(ingest_started.is_set())
                self.assertEqual(recovered._agent_workers, {})
                self.assertIsNone(recovered._ingest_thread)
                self.assertIsNone(recovered._schedule_thread)

                with self.assertRaisesRegex(
                    ServiceError, "does not match the Manager operation"
                ):
                    recovered.manager_update_abort_release("wrong-operation")

                self.assertEqual(
                    recovered.manager_update_abort_release(operation_id),
                    {"released": True},
                )
                self.assertTrue(recovered_agent.started.wait(timeout=2))
                self.assertTrue(ingest_started.wait(timeout=2))
                self.assertIsNotNone(recovered._schedule_thread)
            finally:
                recovered_agent.release.set()
                recovered.close()

    def test_existing_telegram_delivery_worker_pauses_for_live_reservation(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                _config(Path(td)),
                agent_client=_BlockingAgent(),
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
                time.sleep(0.2)
                self.assertFalse(delivered.is_set())
                self.assertEqual(service.jobs.get(job.id).status, "queued")

                self.assertEqual(
                    service.manager_update_abort_release("live-operation"),
                    {"released": True},
                )
                self.assertTrue(delivered.wait(timeout=2))
                allow_delivery.set()
                completed = service.wait_for_telegram_delivery(job.id, timeout=2)
                self.assertIsNotNone(completed)
                self.assertEqual(completed.status, "succeeded")
            finally:
                allow_delivery.set()
                service.close()

    def test_public_status_is_unauthenticated_and_maintenance_blocks_use(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            for directory in (
                data_dir / "runtimes",
                data_dir / "runtimes" / "agent",
            ):
                directory.mkdir(mode=0o700, exist_ok=True)
                directory.chmod(0o700)
            token_file = data_dir / "manager-token"
            token_file.write_text("manager-token\n", encoding="utf-8")
            token_file.chmod(0o600)
            manager = _ManagerStub()
            service = EnterpriseService(
                replace(_config(data_dir), manager_token_file=token_file),
                agent_client=_BlockingAgent(),
                manager_client=manager,
            )
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

                conn.request("GET", "/internal/manager/handoff/evidence")
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.status, 401)
                conn.request(
                    "GET",
                    "/internal/manager/handoff/evidence",
                    headers={"Authorization": "Bearer manager-token"},
                )
                response = conn.getresponse()
                evidence = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(evidence["schema_version"], 1)
                self.assertEqual(evidence["technical_profile"], "ubitech-agent-v1")
                self.assertEqual(evidence["database_integrity"], "ok")
                self.assertEqual(evidence["database_foreign_keys"], "ok")
                self.assertTrue(evidence["platform_reservation_idle"])
                self.assertRegex(evidence["runtime_identity_sha256"], r"^[0-9a-f]{64}$")
                self.assertRegex(evidence["workspace_identity_sha256"], r"^[0-9a-f]{64}$")

                update_id = "update-http"
                self.assertTrue(service.try_reserve_auto_update(update_id)["reserved"])
                manager.status_payload.update(
                    {
                        "public_state": "updating",
                        "phase": "starting",
                        "maintenance": True,
                        "active_operation_id": update_id,
                        "operation_id": update_id,
                    }
                )
                conn.request("GET", "/")
                response = conn.getresponse()
                blocked = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 503)
                self.assertEqual(blocked["code"], "platform_updating")

                conn.request("GET", "/api/platform/update-status")
                response = conn.getresponse()
                updating = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(updating["state"], "updating")

                conn.request(
                    "GET",
                    "/internal/manager/health",
                    headers={"Authorization": "Bearer manager-token"},
                )
                response = conn.getresponse()
                health = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(health["status"], "ok")

                for endpoint, body in (
                    (
                        "/internal/manager/update/commit-release",
                        '{"operation_id":"update-http","operation_id":"update-http"}',
                    ),
                    (
                        "/internal/manager/update/abort-release",
                        json.dumps({"operation_id": update_id, "unexpected": True}),
                    ),
                    (
                        "/internal/manager/update/abort-release",
                        json.dumps({"operation_id": update_id}) + " true",
                    ),
                ):
                    conn.request(
                        "POST",
                        endpoint,
                        body=body,
                        headers={
                            "Authorization": "Bearer manager-token",
                            "Content-Type": "application/json",
                        },
                    )
                    response = conn.getresponse()
                    response.read()
                    self.assertEqual(response.status, 400)
                    self.assertTrue(service.platform_update_is_blocking())

                oversized = http.client.HTTPConnection(host, port, timeout=5)
                oversized.request(
                    "POST",
                    "/internal/manager/update/abort-release",
                    body=" " * (16 * 1024 + 1),
                    headers={
                        "Authorization": "Bearer manager-token",
                        "Content-Type": "application/json",
                    },
                )
                response = oversized.getresponse()
                response.read()
                self.assertEqual(response.status, 413)
                oversized.close()
                self.assertTrue(service.platform_update_is_blocking())

                conn.request(
                    "POST",
                    "/internal/manager/update/abort-release",
                    body=json.dumps({"operation_id": update_id}),
                    headers={
                        "Authorization": "Bearer manager-token",
                        "Content-Type": "application/json",
                    },
                )
                response = conn.getresponse()
                released = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertEqual(released, {"released": True})
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)
