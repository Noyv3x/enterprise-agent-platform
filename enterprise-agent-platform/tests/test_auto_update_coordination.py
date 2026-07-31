from __future__ import annotations

import http.client
import json
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.agent_runtime_client import AgentResult
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.learning import LEARNING_REVIEW_JOB_KIND
from enterprise_agent_platform.manager_client import ManagerClientError
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError
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
                }
            ),
            operation_id,
        )
        with self.assertRaisesRegex(ManagerClientError, "missing maintenance"):
            EnterpriseService._manager_startup_reservation_id(
                {"active_operation_id": operation_id, "operation_id": operation_id}
            )


class ServiceUpdateReservationTests(unittest.TestCase):
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
                    recovered.manager_update_release("wrong-operation")

                self.assertEqual(
                    recovered.manager_update_release(operation_id),
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
                    service.manager_update_release("live-operation"),
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

                self.assertEqual(
                    service.manager_update_release(update_id),
                    {"released": True},
                )
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)
