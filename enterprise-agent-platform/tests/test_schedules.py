from __future__ import annotations

import json
import http.client
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.agent_runtime_client import AgentResult
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.schedules import next_occurrence, normalize_schedule
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError


def make_config(tmp: Path) -> PlatformConfig:
    return PlatformConfig(
        data_dir=tmp,
        host="127.0.0.1",
        port=0,
        public_base_url="http://127.0.0.1:0",
        token_secret="test-secret",
        token_ttl_seconds=3600,
        agent_tool_token="agent-token",
        knowledge_backend="local",
        cognee_dataset="test",
        cognee_ingest_background=True,
        cognee_repo=tmp / "cognee",
        firecrawl_repo=tmp / "firecrawl",
        camofox_url="http://127.0.0.1:19377",
        firecrawl_api_url="http://127.0.0.1:13002",
        runtime_startup_wait_seconds=0,
        manage_agent_runtime=False,
        agent_runtime_url="http://127.0.0.1:8766",
        agent_runtime_token="runtime-token",
        agent_runtime_home=tmp / "runtimes" / "agent",
        agent_runtime_model="gpt-5.5",
        agent_runtime_provider="openai-codex",
        agent_runtime_timeout_seconds=2,
        allow_insecure_bootstrap_password=True,
    )


class RecordingAgent:
    def __init__(self):
        self.calls: list[dict] = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return AgentResult(
            content="scheduled report",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class BlockingAgent(RecordingAgent):
    def __init__(self):
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("run_started_callback"):
            kwargs["run_started_callback"]("fake-run")
        self.started.set()
        self.release.wait(timeout=5)
        return AgentResult(
            content="scheduled report",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class BlockedToolAgent(RecordingAgent):
    def generate(self, **kwargs):
        self.calls.append(kwargs)
        kwargs["progress_callback"](
            {
                "event": "tool.failed",
                "tool": "terminal",
                "unattended_authorization_required": True,
                "reason": "unattended authorization required: terminal command needs approval",
            }
        )
        return AgentResult(
            content="I could not run the sensitive command unattended.",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class BlockThenFailAgent(RecordingAgent):
    def generate(self, **kwargs):
        self.calls.append(kwargs)
        kwargs["progress_callback"](
            {
                "event": "tool.failed",
                "unattended_authorization_required": True,
                "reason": "unattended authorization required: host command",
            }
        )
        raise RuntimeError("generation failed after blocked tool")


class ScheduleTimeTests(unittest.TestCase):
    def test_interval_keeps_an_explicit_anchor(self):
        definition, first = normalize_schedule(
            {"type": "interval", "every_seconds": 300},
            timezone_name="UTC",
            now=1_000,
        )
        self.assertEqual(first, 1_300)
        self.assertEqual(definition["starts_at"], "1970-01-01T00:21:40Z")
        self.assertEqual(
            next_occurrence(definition, timezone_name="UTC", after=1_601),
            1_900,
        )

    def test_cron_rejects_sub_five_minute_patterns_without_false_cross_day_gap(self):
        with self.assertRaisesRegex(ValueError, "at least 300 seconds"):
            normalize_schedule(
                {"type": "cron", "expression": "* * * * *"},
                timezone_name="UTC",
                now=1_700_000_000,
            )
        definition, _ = normalize_schedule(
            {"type": "cron", "expression": "0,58 0,23 * * 1"},
            timezone_name="UTC",
            now=1_700_000_000,
        )
        self.assertEqual(definition["expression"], "0,58 0,23 * * 1")

        stepped, _ = normalize_schedule(
            {"type": "cron", "expression": "0/5 * * * *"},
            timezone_name="UTC",
            now=1_700_000_000,
        )
        self.assertEqual(stepped["expression"], "0/5 * * * *")

    def test_cron_minimum_gap_validation_still_covers_dst_transition_days(self):
        with self.assertRaisesRegex(ValueError, "at least 300 seconds"):
            normalize_schedule(
                {"type": "cron", "expression": "2,58 1,3 * * *"},
                timezone_name="America/New_York",
                now=1_760_000_000,
            )

    def test_cron_skips_dst_gap_and_uses_only_first_fold(self):
        spring_after = int(datetime(2026, 3, 7, 8, tzinfo=timezone.utc).timestamp())
        spring = next_occurrence(
            {"type": "cron", "expression": "30 2 * * *"},
            timezone_name="America/New_York",
            after=spring_after,
        )
        self.assertEqual(
            spring,
            int(datetime(2026, 3, 9, 6, 30, tzinfo=timezone.utc).timestamp()),
        )

        before_fold = int(datetime(2026, 10, 31, 8, tzinfo=timezone.utc).timestamp())
        first = next_occurrence(
            {"type": "cron", "expression": "30 1 * * *"},
            timezone_name="America/New_York",
            after=before_fold,
        )
        self.assertEqual(
            first,
            int(datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc).timestamp()),
        )
        following = next_occurrence(
            {"type": "cron", "expression": "30 1 * * *"},
            timezone_name="America/New_York",
            after=first,
        )
        self.assertEqual(
            following,
            int(datetime(2026, 11, 2, 6, 30, tzinfo=timezone.utc).timestamp()),
        )

    def test_cron_effective_wildcard_does_not_enable_dom_dow_or(self):
        after = int(datetime(2026, 7, 11, 12, tzinfo=timezone.utc).timestamp())
        following = next_occurrence(
            {"type": "cron", "expression": "0 0 */1 * 1"},
            timezone_name="UTC",
            after=after,
        )
        self.assertEqual(
            following,
            int(datetime(2026, 7, 13, 0, tzinfo=timezone.utc).timestamp()),
        )


class ScheduleServiceTests(unittest.TestCase):
    @staticmethod
    def _create(service: EnterpriseService, actor: dict, **overrides) -> dict:
        scope = service.agent_scopes.ensure_private_scope(int(actor["id"]))
        arguments = {
            "name": "Morning report",
            "prompt": "Prepare the report",
            "schedule": {"type": "interval", "every_seconds": 300},
            "delivery": "chat",
            **overrides,
        }
        return service.invoke_agent_runtime_tool(
            {
                "tool": "schedule",
                "action": "create",
                "arguments": arguments,
                "context": {"scope_key": scope.scope_key},
            }
        )["data"]["schedule"]

    def test_run_now_reuses_private_agent_with_exact_metadata_contract(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                admin = service.update_current_user(admin, {"timezone": "Asia/Shanghai"})
                schedule = self._create(service, admin)
                started = service.run_private_schedule_now(admin, schedule["id"])
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)

                run = service.private_schedule_runs(admin, schedule["id"])["runs"][0]
                self.assertEqual(run["id"], started["run"]["id"])
                self.assertEqual(run["status"], "succeeded")
                self.assertIsNotNone(run["response_message_id"])
                messages = service.list_messages(admin, "private", str(admin["id"]))
                self.assertEqual(messages[0]["author_type"], "system")
                marker = messages[0]["metadata"]["scheduled_task"]
                self.assertEqual(marker["schedule_id"], schedule["id"])
                self.assertNotIn("scheduled_task", messages[1]["metadata"])

                call = agent.calls[0]
                self.assertIn("当前用户时区: Asia/Shanghai", call["system_prompt"])
                self.assertEqual(call["metadata"]["trigger"], "scheduled")
                self.assertIs(call["metadata"]["unattended"], True)
                self.assertEqual(call["metadata"]["schedule_id"], str(schedule["id"]))
                self.assertEqual(call["metadata"]["schedule_run_id"], str(run["id"]))
                self.assertTrue(call["metadata"]["scheduled_for"].endswith("Z"))

                service.run_private_schedule_now(admin, schedule["id"])
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                seeded = agent.calls[1]["history"]
                first_prompt = next(item for item in seeded if item["content"] == "Prepare the report")
                self.assertEqual(first_prompt["role"], "user")
                first_report = next(item for item in seeded if item["content"] == "scheduled report")
                self.assertEqual(first_report["role"], "assistant")
            finally:
                service.close()

    def test_private_prompt_has_deterministic_utc_clock_and_user_timezone(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                admin = service.update_current_user(admin, {"timezone": "Asia/Shanghai"})
                scope = service.agent_scopes.ensure_private_scope(admin["id"])
                with mock.patch("enterprise_agent_platform.service.now_ts", return_value=1_700_000_000):
                    prompt = service._private_system_prompt(admin, scope, [])
                self.assertIn("当前 UTC 时间: 2023-11-14T22:13:20Z", prompt)
                self.assertIn("当前用户时区: Asia/Shanghai", prompt)
            finally:
                service.close()

    def test_unattended_authorization_failure_marks_run_blocked_but_keeps_report(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=BlockedToolAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                service.run_private_schedule_now(admin, schedule["id"])
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                run = service.private_schedule_runs(admin, schedule["id"])["runs"][0]
                self.assertEqual(run["status"], "blocked")
                self.assertIn("terminal command needs approval", run["error"])
                response = service.db.query_one(
                    "SELECT content FROM messages WHERE id = ?",
                    (run["response_message_id"],),
                )
                self.assertIn("could not run", response["content"])
                # Simulate a crash after the durable job/reply committed but
                # before the run ledger received its terminal transition.
                service.db.execute(
                    """
                    UPDATE agent_schedule_runs
                    SET status = 'queued', response_message_id = NULL,
                        finished_at = NULL, error = ''
                    WHERE id = ?
                    """,
                    (run["id"],),
                )
                service._sync_schedule_runs_from_jobs()
                restored = service.schedules.get_run(run["id"])
                self.assertEqual(restored["status"], "blocked")
                self.assertEqual(restored["response_message_id"], run["response_message_id"])
                self.assertIn("terminal command needs approval", restored["error"])
            finally:
                service.close()

    def test_resume_is_idempotent_for_an_active_schedule(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                before = service.schedules.get(admin["id"], schedule["id"])
                resumed = service.resume_private_schedule(admin, schedule["id"])["schedule"]
                after = service.schedules.get(admin["id"], schedule["id"])
                self.assertEqual(resumed["state"], "active")
                self.assertEqual(after["revision"], before["revision"])
                self.assertEqual(after["next_run_at"], before["next_run_at"])
            finally:
                service.close()

    def test_block_marker_on_error_message_restores_failed_job_as_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=BlockThenFailAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                service.run_private_schedule_now(admin, schedule["id"])
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                run = service.schedules.latest_run(schedule["id"])
                self.assertEqual(run["status"], "blocked")
                response = service.agent_message_replying_to(
                    "private", str(admin["id"]), int(run["source_message_id"])
                )
                self.assertEqual(response["metadata"]["scheduled_run_status"], "blocked")

                service.db.execute(
                    """
                    UPDATE agent_schedule_runs
                    SET status = 'queued', response_message_id = NULL,
                        finished_at = NULL, error = '' WHERE id = ?
                    """,
                    (run["id"],),
                )
                service._sync_schedule_runs_from_jobs()
                restored = service.schedules.get_run(run["id"])
                self.assertEqual(restored["status"], "blocked")
                self.assertEqual(restored["response_message_id"], response["id"])
                self.assertIn("host command", restored["error"])
            finally:
                service.close()

    def test_schedule_revision_cas_and_exact_history_cursor(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                original = service.schedules.get(admin["id"], schedule["id"])
                first = service.schedules.update(
                    owner_user_id=admin["id"],
                    schedule_id=schedule["id"],
                    fields={"name": "CAS winner", "revision": original["revision"] + 1},
                    expected_revision=original["revision"],
                )
                stale = service.schedules.update(
                    owner_user_id=admin["id"],
                    schedule_id=schedule["id"],
                    fields={"name": "stale write", "revision": original["revision"] + 1},
                    expected_revision=original["revision"],
                )
                self.assertEqual(first["name"], "CAS winner")
                self.assertIsNone(stale)

                timestamp = int(time.time())
                service.db.executemany(
                    """
                    INSERT INTO agent_schedule_runs(
                        schedule_id, schedule_revision, scheduled_for, trigger,
                        status, error, finished_at, created_at, updated_at
                    ) VALUES (?, ?, ?, 'scheduled', 'skipped', '', ?, ?, ?)
                    """,
                    [
                        (
                            schedule["id"],
                            first["revision"],
                            timestamp + index,
                            timestamp,
                            timestamp,
                            timestamp,
                        )
                        for index in range(20)
                    ],
                )
                exact = service.private_schedule_runs(admin, schedule["id"], limit=20)
                self.assertEqual(len(exact["runs"]), 20)
                self.assertIsNone(exact["next_before_id"])
                service.db.execute(
                    """
                    INSERT INTO agent_schedule_runs(
                        schedule_id, schedule_revision, scheduled_for, trigger,
                        status, error, finished_at, created_at, updated_at
                    ) VALUES (?, ?, ?, 'scheduled', 'skipped', '', ?, ?, ?)
                    """,
                    (
                        schedule["id"],
                        first["revision"],
                        timestamp + 20,
                        timestamp,
                        timestamp,
                        timestamp,
                    ),
                )
                paged = service.private_schedule_runs(admin, schedule["id"], limit=20)
                self.assertEqual(len(paged["runs"]), 20)
                self.assertIsNotNone(paged["next_before_id"])
                tail = service.private_schedule_runs(
                    admin,
                    schedule["id"],
                    limit=20,
                    before_id=paged["next_before_id"],
                )
                self.assertEqual(len(tail["runs"]), 1)
                self.assertIsNone(tail["next_before_id"])
                service.db.executemany(
                    """
                    INSERT INTO agent_schedule_runs(
                        schedule_id, schedule_revision, scheduled_for, trigger,
                        status, error, finished_at, created_at, updated_at
                    ) VALUES (?, ?, ?, 'scheduled', 'skipped', '', ?, ?, ?)
                    """,
                    [
                        (
                            schedule["id"],
                            first["revision"],
                            timestamp + index,
                            timestamp,
                            timestamp,
                            timestamp,
                        )
                        for index in range(21, 101)
                    ],
                )
                maximum = service.private_schedule_runs(admin, schedule["id"], limit=100)
                self.assertEqual(len(maximum["runs"]), 100)
                self.assertIsNotNone(maximum["next_before_id"])
                maximum_tail = service.private_schedule_runs(
                    admin,
                    schedule["id"],
                    limit=100,
                    before_id=maximum["next_before_id"],
                )
                self.assertEqual(len(maximum_tail["runs"]), 1)
                self.assertIsNone(maximum_tail["next_before_id"])
            finally:
                service.close()

    def test_overlap_is_skipped_and_manual_overlap_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                service.run_private_schedule_now(admin, schedule["id"])
                self.assertTrue(agent.started.wait(timeout=2))
                with self.assertRaises(ServiceError) as error:
                    service.run_private_schedule_now(admin, schedule["id"])
                self.assertEqual(error.exception.status, 409)

                due = int(time.time()) - 1
                service.db.execute(
                    "UPDATE agent_schedules SET next_run_at = ? WHERE id = ?",
                    (due, schedule["id"]),
                )
                service._dispatch_due_schedules(timestamp=int(time.time()))
                statuses = {
                    row["status"]
                    for row in service.private_schedule_runs(admin, schedule["id"])["runs"]
                }
                self.assertIn("running", statuses)
                self.assertIn("skipped", statuses)
                self.assertEqual(len(agent.calls), 1)
            finally:
                agent.release.set()
                service.close()

    def test_two_completed_run_now_occurrences_in_same_second_are_distinct(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                with mock.patch(
                    "enterprise_agent_platform.service.now_ts", return_value=1_800_000_000
                ), mock.patch(
                    "enterprise_agent_platform.jobs.now_ts", return_value=1_800_000_000
                ):
                    first = service.run_private_schedule_now(admin, schedule["id"])["run"]
                    service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                    second = service.run_private_schedule_now(admin, schedule["id"])["run"]
                    service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                self.assertNotEqual(first["id"], second["id"])
                self.assertEqual(first["scheduled_for"], second["scheduled_for"])
                self.assertEqual(
                    service.db.scalar(
                        """
                        SELECT COUNT(*) FROM agent_schedule_runs
                        WHERE schedule_id = ? AND trigger = 'manual'
                        """,
                        (schedule["id"],),
                    ),
                    2,
                )
                self.assertEqual(len(agent.calls), 2)
            finally:
                service.close()

    def test_missed_recurring_periods_coalesce_to_one_catch_up_run(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                interval = self._create(service, admin, name="Interval")
                cron = self._create(
                    service,
                    admin,
                    name="Cron",
                    schedule={"type": "cron", "expression": "*/5 * * * *"},
                )
                current = int(time.time())
                service.db.execute(
                    "UPDATE agent_schedules SET next_run_at = ? WHERE id IN (?, ?)",
                    (current - 1_800, interval["id"], cron["id"]),
                )
                service._dispatch_due_schedules(timestamp=current)
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                self.assertEqual(
                    service.db.scalar("SELECT COUNT(*) FROM agent_schedule_runs"),
                    2,
                )
                for schedule_id in (interval["id"], cron["id"]):
                    stored = service.schedules.get(admin["id"], schedule_id)
                    self.assertGreater(int(stored["next_run_at"]), current)
                    self.assertEqual(
                        service.db.scalar(
                            "SELECT COUNT(*) FROM agent_schedule_runs WHERE schedule_id = ?",
                            (schedule_id,),
                        ),
                        1,
                    )
                service._dispatch_due_schedules(timestamp=current)
                self.assertEqual(
                    service.db.scalar("SELECT COUNT(*) FROM agent_schedule_runs"),
                    2,
                )
            finally:
                service.close()

    def test_inactive_owner_is_skipped_without_disabling_recurring_definition(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                user = service.create_user(
                    username="scheduled-user",
                    password="scheduled-pass",
                    display_name="Scheduled User",
                    actor=admin,
                )
                schedule = self._create(service, user)
                service.deactivate_user(admin, user["id"])
                due = int(time.time()) - 1
                service.db.execute(
                    "UPDATE agent_schedules SET next_run_at = ? WHERE id = ?",
                    (due, schedule["id"]),
                )
                service._dispatch_due_schedules(timestamp=int(time.time()))
                stored = service.schedules.get(user["id"], schedule["id"])
                self.assertEqual(stored["state"], "active")
                self.assertTrue(stored["enabled"])
                run = service.schedules.latest_run(schedule["id"])
                self.assertEqual(run["status"], "skipped")
                self.assertIn("inactive", run["error"])
            finally:
                service.close()

    def test_inactive_owner_terminally_skips_a_missed_once_occurrence(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                user = service.create_user(
                    username="once-inactive-user",
                    password="once-inactive-pass",
                    display_name="Once Inactive User",
                    actor=admin,
                )
                at = datetime.fromtimestamp(int(time.time()) + 120, timezone.utc).isoformat().replace(
                    "+00:00", "Z"
                )
                schedule = self._create(
                    service,
                    user,
                    schedule={"type": "once", "at": at},
                )
                service.deactivate_user(admin, user["id"])
                service.db.execute(
                    "UPDATE agent_schedules SET next_run_at = ? WHERE id = ?",
                    (int(time.time()) - 1, schedule["id"]),
                )
                service._dispatch_due_schedules(timestamp=int(time.time()))

                stored = service.schedules.get(user["id"], schedule["id"])
                self.assertEqual(stored["state"], "completed")
                self.assertFalse(stored["enabled"])
                self.assertIsNone(stored["next_run_at"])
                self.assertEqual(service.schedules.latest_run(schedule["id"])["status"], "skipped")
            finally:
                service.close()

    def test_automatic_occurrence_invalidates_a_stale_schedule_revision(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                at = datetime.fromtimestamp(int(time.time()) + 120, timezone.utc).isoformat().replace(
                    "+00:00", "Z"
                )
                schedule = self._create(
                    service,
                    admin,
                    schedule={"type": "once", "at": at},
                )
                stale = service.schedules.get(admin["id"], schedule["id"])
                service._materialize_schedule_occurrence(
                    schedule["id"],
                    scheduled_for=int(stale["next_run_at"]),
                    trigger="scheduled",
                    expected_revision=int(stale["revision"]),
                )
                rejected = service.schedules.update(
                    owner_user_id=admin["id"],
                    schedule_id=schedule["id"],
                    fields={"state": "paused", "enabled": 0},
                    expected_revision=int(stale["revision"]),
                )
                self.assertIsNone(rejected)
                current = service.schedules.get(admin["id"], schedule["id"])
                self.assertEqual(current["revision"], int(stale["revision"]) + 1)
                self.assertEqual(current["state"], "completed")
            finally:
                service.close()

    def test_permission_revocation_cancels_running_schedule_and_prevents_reply(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                user = service.create_user(
                    username="revoked-user",
                    password="revoked-pass",
                    display_name="Revoked User",
                    actor=admin,
                )
                schedule = self._create(service, user)
                started = service.run_private_schedule_now(user, schedule["id"])["run"]
                self.assertTrue(agent.started.wait(timeout=2))
                service.update_user(admin, user["id"], {"permission_group": "viewer"})
                agent.release.set()
                service.wait_for_agent_idle("private", str(user["id"]), timeout=5)

                run = service.schedules.get_run(started["id"])
                self.assertEqual(run["status"], "cancelled")
                job = service.jobs.get(int(run["durable_job_id"]))
                self.assertEqual(job.status, "failed")
                self.assertIsNone(
                    service.agent_message_replying_to(
                        "private", str(user["id"]), int(run["source_message_id"])
                    )
                )
            finally:
                agent.release.set()
                service.close()

    def test_revoked_owner_due_occurrence_is_skipped_without_materializing_agent_work(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                user = service.create_user(
                    username="due-revoked-user",
                    password="due-revoked-pass",
                    display_name="Due Revoked User",
                    actor=admin,
                )
                schedule = self._create(service, user)
                service.update_user(admin, user["id"], {"permission_group": "viewer"})
                service.db.execute(
                    "UPDATE agent_schedules SET next_run_at = ? WHERE id = ?",
                    (int(time.time()) - 1, schedule["id"]),
                )
                service._dispatch_due_schedules(timestamp=int(time.time()))

                run = service.schedules.latest_run(schedule["id"])
                self.assertEqual(run["status"], "skipped")
                self.assertIsNone(run["source_message_id"])
                self.assertIsNone(run["durable_job_id"])
                stored = service.schedules.get(user["id"], schedule["id"])
                self.assertEqual(stored["state"], "active")
                self.assertTrue(stored["enabled"])
            finally:
                service.close()

    def test_restart_does_not_surface_cancelled_schedule_after_permission_revocation(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = EnterpriseService(config, agent_client=RecordingAgent())
            _, admin = first.authenticate("admin", "admin")
            user = first.create_user(
                username="restart-revoked-user",
                password="restart-revoked-pass",
                display_name="Restart Revoked User",
                actor=admin,
            )
            schedule = self._create(first, user)
            with mock.patch.object(
                first,
                "_schedule_agent_task",
                side_effect=RuntimeError("hold durable job"),
            ):
                run = first.run_private_schedule_now(user, schedule["id"])["run"]
            first.update_user(admin, user["id"], {"permission_group": "viewer"})
            source_message_id = int(run["source_message_id"])
            self.assertIsNone(
                first.agent_message_replying_to(
                    "private", str(user["id"]), source_message_id
                )
            )
            first.close()

            recovered_agent = RecordingAgent()
            recovered = EnterpriseService(config, agent_client=recovered_agent)
            try:
                # Exercise the repair directly as well as through startup; it
                # must remain silent and idempotent after the permission loss.
                recovered._surface_failed_agent_jobs_without_message()
                self.assertIsNone(
                    recovered.agent_message_replying_to(
                        "private", str(user["id"]), source_message_id
                    )
                )
                self.assertEqual(recovered_agent.calls, [])
                self.assertEqual(recovered.schedules.get_run(run["id"])["status"], "cancelled")
            finally:
                recovered.close()

    def test_late_job_success_cannot_overwrite_cancelled_run(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                user = service.create_user(
                    username="late-cancel-user",
                    password="late-cancel-pass",
                    display_name="Late Cancel User",
                    actor=admin,
                )
                schedule = self._create(service, user)
                original = service._send_private_agent_reply

                def revoke_after_reply(task):
                    response = original(task)
                    service.update_user(admin, user["id"], {"permission_group": "viewer"})
                    return response

                with mock.patch.object(
                    service, "_send_private_agent_reply", side_effect=revoke_after_reply
                ):
                    started = service.run_private_schedule_now(user, schedule["id"])["run"]
                    service.wait_for_agent_idle("private", str(user["id"]), timeout=5)
                run = service.schedules.get_run(started["id"])
                self.assertEqual(run["status"], "cancelled")
                self.assertNotEqual(run["status"], "succeeded")
                self.assertEqual(service.jobs.get(int(run["durable_job_id"])).status, "failed")
                self.assertIsNotNone(
                    service.agent_message_replying_to(
                        "private", str(user["id"]), int(run["source_message_id"])
                    )
                )
            finally:
                service.close()

    def test_job_success_winning_first_cannot_be_overwritten_by_cancellation(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                with mock.patch.object(
                    service,
                    "_schedule_agent_task",
                    side_effect=RuntimeError("hold durable job"),
                ):
                    accepted = service.run_private_schedule_now(admin, schedule["id"])["run"]
                run = service.schedules.get_run(accepted["id"])
                job_id = int(run["durable_job_id"])
                self.assertIsNotNone(service.jobs.mark_running(job_id, lease_seconds=60))
                service.schedules.update_run_status(run["id"], "running")
                self.assertTrue(service.jobs.mark_succeeded(job_id))

                service._cancel_agent_scope_work(
                    "private",
                    str(admin["id"]),
                    reason="later cancellation",
                    cleanup_runtime=False,
                )
                self.assertEqual(service.jobs.get(job_id).status, "succeeded")
                self.assertEqual(service.schedules.get_run(run["id"])["status"], "running")
                service._sync_schedule_runs_from_jobs()
                self.assertEqual(service.schedules.get_run(run["id"])["status"], "succeeded")
            finally:
                service.close()

    def test_restart_repairs_system_source_message_job_gap_once(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = EnterpriseService(config, agent_client=RecordingAgent())
            _, admin = first.authenticate("admin", "admin")
            schedule = self._create(first, admin)
            definition = first.schedules.get(admin["id"], schedule["id"])
            scheduled_for = int(time.time()) + 120
            with first.db.transaction() as conn:
                source = conn.execute(
                    """
                    INSERT INTO messages(
                        scope_type, scope_id, author_type, user_id, username,
                        content, metadata_json, created_at
                    ) VALUES ('private', ?, 'system', ?, 'Scheduled Task', ?, ?, ?)
                    """,
                    (
                        str(admin["id"]),
                        admin["id"],
                        "Repair this run",
                        json.dumps(
                            {
                                "generation": first.account_generation_config(admin),
                                "scheduled_task": {
                                    "schedule_id": schedule["id"],
                                    "schedule_run_id": 1,
                                    "name": schedule["name"],
                                    "scheduled_for": datetime.fromtimestamp(
                                        scheduled_for, timezone.utc
                                    ).isoformat().replace("+00:00", "Z"),
                                },
                            }
                        ),
                        int(time.time()),
                    ),
                ).lastrowid
                run_id = conn.execute(
                    """
                    INSERT INTO agent_schedule_runs(
                        schedule_id, schedule_revision, scheduled_for, trigger,
                        status, source_message_id, created_at, updated_at
                    ) VALUES (?, ?, ?, 'scheduled', 'queued', ?, ?, ?)
                    """,
                    (
                        schedule["id"],
                        definition["revision"],
                        scheduled_for,
                        source,
                        int(time.time()),
                        int(time.time()),
                    ),
                ).lastrowid
                metadata = json.loads(
                    conn.execute("SELECT metadata_json FROM messages WHERE id = ?", (source,)).fetchone()[0]
                )
                metadata["scheduled_task"]["schedule_run_id"] = run_id
                conn.execute(
                    "UPDATE messages SET metadata_json = ? WHERE id = ?",
                    (json.dumps(metadata), source),
                )
            first.close()

            agent = RecordingAgent()
            recovered = EnterpriseService(config, agent_client=agent)
            try:
                recovered.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                run = recovered.schedules.get_run(run_id)
                self.assertIsNotNone(run["durable_job_id"])
                self.assertEqual(run["status"], "succeeded")
                self.assertEqual(len(agent.calls), 1)
            finally:
                recovered.close()

    def test_committed_occurrence_survives_in_memory_wakeup_failure(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                with mock.patch.object(
                    service,
                    "_schedule_agent_task",
                    side_effect=RuntimeError("simulated wake failure"),
                ):
                    accepted = service.run_private_schedule_now(admin, schedule["id"])
                self.assertEqual(accepted["run"]["status"], "queued")
                self.assertEqual(
                    service.db.scalar(
                        "SELECT COUNT(*) FROM agent_schedule_runs WHERE schedule_id = ?",
                        (schedule["id"],),
                    ),
                    1,
                )
                self.assertEqual(
                    service.db.scalar(
                        "SELECT COUNT(*) FROM durable_jobs WHERE kind = 'agent' AND scope_id = ?",
                        (str(admin["id"]),),
                    ),
                    1,
                )

                service._recover_durable_work()
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                run = service.schedules.get_run(accepted["run"]["id"])
                self.assertEqual(run["status"], "succeeded")
                self.assertEqual(len(agent.calls), 1)
            finally:
                service.close()

    def test_committed_occurrence_survives_post_commit_job_reload_failure(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                with mock.patch.object(
                    service.jobs,
                    "get",
                    side_effect=RuntimeError("simulated durable job reload failure"),
                ):
                    accepted = service.run_private_schedule_now(admin, schedule["id"])
                self.assertEqual(accepted["run"]["status"], "queued")
                self.assertEqual(
                    service.db.scalar(
                        "SELECT COUNT(*) FROM agent_schedule_runs WHERE schedule_id = ?",
                        (schedule["id"],),
                    ),
                    1,
                )
                self.assertEqual(
                    service.db.scalar(
                        "SELECT COUNT(*) FROM durable_jobs WHERE kind = 'agent' AND scope_id = ?",
                        (str(admin["id"]),),
                    ),
                    1,
                )

                service._recover_durable_work()
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                run = service.schedules.get_run(accepted["run"]["id"])
                self.assertEqual(run["status"], "succeeded")
                self.assertEqual(len(agent.calls), 1)
            finally:
                service.close()

    def test_recovered_queued_schedule_uses_the_current_user_timezone(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                schedule = self._create(service, admin)
                with mock.patch.object(
                    service,
                    "_schedule_agent_task",
                    side_effect=RuntimeError("hold durable job"),
                ):
                    service.run_private_schedule_now(admin, schedule["id"])
                service.update_current_user(admin, {"timezone": "Asia/Shanghai"})

                service._recover_durable_work()
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                self.assertEqual(len(agent.calls), 1)
                self.assertIn("当前用户时区: Asia/Shanghai", agent.calls[0]["system_prompt"])
                self.assertEqual(agent.calls[0]["metadata"]["actor"]["timezone"], "Asia/Shanghai")
            finally:
                service.close()

    def test_scheduled_telegram_uses_only_verified_private_chat(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.set_setting("telegram_enabled", "1")
                service.set_setting("ENTERPRISE_TELEGRAM_BOT_TOKEN", "123456:token", secret=True)
                challenge = service.update_telegram_private_config(admin, {})
                service.complete_telegram_link(
                    challenge["pending"]["code"],
                    {"id": "12345", "username": "admin_tg"},
                    chat_id=999001,
                )
                schedule = self._create(service, admin, delivery="chat_and_telegram")
                run = service.run_private_schedule_now(admin, schedule["id"])["run"]
                delivery = service.jobs.get_by_key(
                    "telegram_delivery", f"message:{run['source_message_id']}"
                )
                self.assertIsNotNone(delivery)
                self.assertEqual(delivery.payload["chat_id"], 999001)
                self.assertNotEqual(str(delivery.payload["chat_id"]), "12345")
            finally:
                service.close()

    def test_scheduled_telegram_revalidates_link_after_claim_before_send(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            release = threading.Event()
            entered = threading.Event()
            try:
                _, admin = service.authenticate("admin", "admin")
                service.set_setting("telegram_enabled", "1")
                service.set_setting("ENTERPRISE_TELEGRAM_BOT_TOKEN", "123456:token", secret=True)
                challenge = service.update_telegram_private_config(admin, {})
                service.complete_telegram_link(
                    challenge["pending"]["code"],
                    {"id": "12346", "username": "race_tg"},
                    chat_id=999002,
                )
                schedule = self._create(service, admin, delivery="chat_and_telegram")
                run = service.run_private_schedule_now(admin, schedule["id"])["run"]
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)
                delivery = service.jobs.get_by_key(
                    "telegram_delivery", f"message:{run['source_message_id']}"
                )
                self.assertIsNotNone(delivery)

                sent: list[dict] = []

                def handler(actor, payload, message):
                    sent.append({"actor": actor, "payload": payload, "message": message})

                with service._telegram_delivery_lock:
                    service._telegram_delivery_handler = handler
                    service._telegram_delivery_generation += 1
                    generation = service._telegram_delivery_generation

                original_lock = service._telegram_identity_delivery_lock

                def delayed_lock(user_id):
                    if threading.current_thread().name == "scheduled-telegram-race":
                        entered.set()
                        self.assertTrue(release.wait(timeout=3))
                    return original_lock(user_id)

                with mock.patch.object(
                    service,
                    "_telegram_identity_delivery_lock",
                    side_effect=delayed_lock,
                ):
                    worker = threading.Thread(
                        target=service._process_telegram_delivery_job,
                        args=(delivery, handler, generation),
                        name="scheduled-telegram-race",
                    )
                    worker.start()
                    self.assertTrue(entered.wait(timeout=2))
                    service.unlink_telegram_private_config(admin)
                    release.set()
                    worker.join(timeout=5)
                    self.assertFalse(worker.is_alive())

                restored = service.jobs.get(delivery.id)
                self.assertEqual(restored.status, "failed")
                self.assertEqual(sent, [])
                internal_run = service.schedules.get_run(run["id"])
                self.assertIn("changed or was unlinked", internal_run["delivery_warning"])
            finally:
                release.set()
                service.close()

    def test_scheduled_telegram_rechecks_permission_after_claim_before_send(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            release = threading.Event()
            entered = threading.Event()
            worker: threading.Thread | None = None
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="scheduled-member",
                    password="member-password",
                    display_name="Scheduled Member",
                    actor=admin,
                    permission_group="member",
                )
                service.set_setting("telegram_enabled", "1")
                service.set_setting("ENTERPRISE_TELEGRAM_BOT_TOKEN", "123456:token", secret=True)
                challenge = service.update_telegram_private_config(member, {})
                service.complete_telegram_link(
                    challenge["pending"]["code"],
                    {"id": "12347", "username": "permission_race_tg"},
                    chat_id=999003,
                )
                schedule = self._create(service, member, delivery="chat_and_telegram")
                run = service.run_private_schedule_now(member, schedule["id"])["run"]
                service.wait_for_agent_idle("private", str(member["id"]), timeout=5)
                delivery = service.jobs.get_by_key(
                    "telegram_delivery", f"message:{run['source_message_id']}"
                )
                self.assertIsNotNone(delivery)

                sent: list[dict] = []

                def handler(actor, payload, message):
                    sent.append({"actor": actor, "payload": payload, "message": message})

                with service._telegram_delivery_lock:
                    service._telegram_delivery_handler = handler
                    service._telegram_delivery_generation += 1
                    generation = service._telegram_delivery_generation

                original_lock = service._telegram_identity_delivery_lock
                lock_callers: list[int] = []
                revoking_thread = threading.get_ident()

                def delayed_lock(user_id):
                    lock_callers.append(threading.get_ident())
                    if threading.current_thread().name == "scheduled-telegram-revoke-race":
                        entered.set()
                        self.assertTrue(release.wait(timeout=3))
                    return original_lock(user_id)

                with mock.patch.object(
                    service,
                    "_telegram_identity_delivery_lock",
                    side_effect=delayed_lock,
                ):
                    worker = threading.Thread(
                        target=service._process_telegram_delivery_job,
                        args=(delivery, handler, generation),
                        name="scheduled-telegram-revoke-race",
                    )
                    worker.start()
                    self.assertTrue(entered.wait(timeout=2))
                    service.update_user(
                        admin,
                        int(member["id"]),
                        {"permission_group": "viewer"},
                    )
                    release.set()
                    worker.join(timeout=5)
                    self.assertFalse(worker.is_alive())

                self.assertIn(revoking_thread, lock_callers)
                restored = service.jobs.get(delivery.id)
                self.assertEqual(restored.status, "failed")
                self.assertEqual(sent, [])
                internal_run = service.schedules.get_run(run["id"])
                self.assertIn(
                    "private Agent access is unavailable",
                    internal_run["delivery_warning"],
                )
            finally:
                release.set()
                if worker is not None:
                    worker.join(timeout=5)
                service.close()

    def test_rest_surface_manages_but_cannot_create_or_edit_schedules(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            token, admin = service.authenticate("admin", "admin")
            schedule = self._create(service, admin)
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Origin": f"http://{host}:{port}",
            }
            conn = http.client.HTTPConnection(host, port, timeout=5)
            try:
                conn.request("GET", "/api/private-agent/schedules", headers=headers)
                response = conn.getresponse()
                payload = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(payload["schedules"][0]["id"], schedule["id"])

                conn.request(
                    "POST",
                    "/api/private-agent/schedules",
                    body=json.dumps({"name": "not allowed"}),
                    headers=headers,
                )
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.status, 404)

                conn.request(
                    "PUT",
                    f"/api/private-agent/schedules/{schedule['id']}",
                    body=json.dumps({"name": "not allowed"}),
                    headers=headers,
                )
                response = conn.getresponse()
                response.read()
                self.assertEqual(response.status, 404)

                for action, expected_state in (("pause", "paused"), ("resume", "active")):
                    conn.request(
                        "POST",
                        f"/api/private-agent/schedules/{schedule['id']}/{action}",
                        body="{}",
                        headers=headers,
                    )
                    response = conn.getresponse()
                    payload = json.loads(response.read())
                    self.assertEqual(response.status, 200)
                    self.assertEqual(payload["schedule"]["state"], expected_state)

                conn.request(
                    "POST",
                    f"/api/private-agent/schedules/{schedule['id']}/run-now",
                    body="{}",
                    headers=headers,
                )
                response = conn.getresponse()
                payload = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(payload["run"]["schedule_id"], schedule["id"])
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=5)

                conn.request(
                    "GET",
                    f"/api/private-agent/schedules/{schedule['id']}/runs?limit=20",
                    headers=headers,
                )
                response = conn.getresponse()
                payload = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(len(payload["runs"]), 1)

                conn.request(
                    "DELETE",
                    f"/api/private-agent/schedules/{schedule['id']}",
                    body="{}",
                    headers=headers,
                )
                response = conn.getresponse()
                payload = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(payload, {"deleted": True, "id": schedule["id"]})
            finally:
                conn.close()
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
