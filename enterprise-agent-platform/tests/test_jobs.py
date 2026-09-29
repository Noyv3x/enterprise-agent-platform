from __future__ import annotations

import tempfile
import sqlite3
import threading
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.db import Database
from enterprise_agent_platform.agent_inputs import AgentRunInputStore
from enterprise_agent_platform.jobs import DurableJobStore


class DurableJobStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / "jobs.db")
        self.jobs = DurableJobStore(self.db)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_enqueue_is_idempotent_by_kind_and_key(self):
        first, created = self.jobs.enqueue(
            kind="agent", dedupe_key="message:7", payload={"value": 1}, scope_type="private", scope_id="2"
        )
        second, created_again = self.jobs.enqueue(
            kind="agent", dedupe_key="message:7", payload={"value": 2}, scope_type="private", scope_id="2"
        )
        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(first.id, second.id)
        self.assertEqual(second.payload, {"value": 1})

    def test_claim_and_success_transition(self):
        job, _ = self.jobs.enqueue(kind="retryable", dedupe_key="item:3", payload={"id": 3})
        claimed = self.jobs.mark_running(job.id, lease_seconds=60)
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed.status, "running")
        self.assertEqual(claimed.attempts, 1)
        self.assertIsNone(self.jobs.mark_running(job.id, lease_seconds=60))
        self.assertTrue(self.jobs.mark_succeeded(job.id))
        self.assertEqual(self.jobs.get(job.id).status, "succeeded")

    def test_terminal_transitions_are_compare_and_swap(self):
        succeeded, _ = self.jobs.enqueue(kind="agent", dedupe_key="message:success", payload={})
        self.assertIsNotNone(self.jobs.mark_running(succeeded.id, lease_seconds=60))
        self.assertTrue(self.jobs.mark_succeeded(succeeded.id))
        self.assertFalse(self.jobs.mark_failed(succeeded.id, "late cancellation"))
        self.assertEqual(self.jobs.get(succeeded.id).status, "succeeded")

        failed, _ = self.jobs.enqueue(kind="agent", dedupe_key="message:failed", payload={})
        self.assertIsNotNone(self.jobs.mark_running(failed.id, lease_seconds=60))
        self.assertTrue(self.jobs.mark_failed(failed.id, "conversation cleared"))
        self.assertFalse(self.jobs.mark_succeeded(failed.id))
        self.assertFalse(self.jobs.requeue(failed.id, error="stale worker retry"))
        self.assertEqual(self.jobs.get(failed.id).status, "failed")

        interrupted, _ = self.jobs.enqueue(kind="agent", dedupe_key="message:review", payload={})
        self.assertIsNotNone(self.jobs.mark_running(interrupted.id, lease_seconds=60))
        self.jobs.recover_interrupted(unsafe_kinds={"agent"})
        self.assertFalse(self.jobs.mark_succeeded(interrupted.id))
        self.assertTrue(self.jobs.mark_succeeded(interrupted.id, reconcile=True))
        self.assertEqual(self.jobs.get(interrupted.id).status, "succeeded")

    def test_restart_recovery_does_not_repeat_unsafe_agent_job(self):
        agent, _ = self.jobs.enqueue(kind="agent", dedupe_key="message:1", payload={})
        retryable, _ = self.jobs.enqueue(
            kind="retryable", dedupe_key="item:1", payload={}
        )
        telegram, _ = self.jobs.enqueue(kind="telegram_delivery", dedupe_key="message:1", payload={})
        self.jobs.mark_running(agent.id, lease_seconds=60)
        self.jobs.mark_running(retryable.id, lease_seconds=60)
        self.jobs.mark_running(telegram.id, lease_seconds=60)

        counts = self.jobs.recover_interrupted(unsafe_kinds={"agent", "telegram_delivery"})

        self.assertEqual(counts, {"queued": 1, "needs_review": 2})
        self.assertEqual(self.jobs.get(agent.id).status, "needs_review")
        self.assertEqual(self.jobs.get(retryable.id).status, "queued")
        self.assertEqual(self.jobs.get(telegram.id).status, "needs_review")

    def test_restart_quarantines_claimed_reviews_but_preserves_unsubmitted_work(self):
        for kind in ("agent", "agent_learning_review"):
            with self.subTest(kind=kind):
                submitted, _ = self.jobs.enqueue(kind=kind, dedupe_key="submitted", payload={})
                queued, _ = self.jobs.enqueue(kind=kind, dedupe_key="unsubmitted", payload={})
                self.jobs.mark_running(submitted.id, lease_seconds=60)
                self.jobs.recover_interrupted(unsafe_kinds={kind})
                self.assertEqual(self.jobs.get(submitted.id).status, "needs_review")
                self.assertIsNone(self.jobs.mark_running(submitted.id, lease_seconds=60))
                self.assertEqual(self.jobs.get(queued.id).status, "queued")
                self.assertIsNotNone(self.jobs.mark_running(queued.id, lease_seconds=60))

    def test_queued_includes_delayed_retry_and_counts_can_be_scoped(self):
        first, _ = self.jobs.enqueue(
            kind="retryable",
            dedupe_key="item:future",
            payload={"id": 8},
            scope_type="maintenance",
            scope_id="8",
            available_at=2_000_000_000,
        )
        self.jobs.enqueue(
            kind="agent",
            dedupe_key="message:other",
            payload={},
            scope_type="private",
            scope_id="9",
        )

        self.assertEqual(
            [job.id for job in self.jobs.queued("retryable")], [first.id]
        )
        self.assertEqual(self.jobs.ready("retryable"), [])
        scoped = self.jobs.counts(
            kind="retryable", scope_type="maintenance", scope_id="8"
        )
        self.assertEqual(scoped["queued"], 1)
        self.assertEqual(sum(scoped.values()), 1)

    def test_unbounded_recovery_read_does_not_strand_jobs_after_default_page(self):
        for index in range(1005):
            self.jobs.enqueue(
                kind="retryable",
                dedupe_key=f"item:{index}",
                payload={"id": index},
            )

        self.assertEqual(len(self.jobs.queued("retryable")), 1000)
        recovered = self.jobs.queued("retryable", limit=None)
        self.assertEqual(len(recovered), 1005)
        self.assertEqual(recovered[-1].dedupe_key, "item:1004")

    def test_enqueue_participates_in_producer_rollback(self):
        with self.assertRaisesRegex(RuntimeError, "producer failed"):
            with self.db.transaction() as conn:
                self.jobs.enqueue(kind="agent", dedupe_key="atomic", payload={}, conn=conn)
                raise RuntimeError("producer failed")
        self.assertIsNone(self.jobs.get_by_key("agent", "atomic"))

    def test_joined_restart_only_replays_unsubmitted_input(self):
        inputs = AgentRunInputStore(self.db)
        root, _ = self.jobs.enqueue(kind="agent", dedupe_key="root", payload={})
        self.jobs.mark_running(root.id, lease_seconds=60)
        inputs.start_root(message_id=1, job_id=root.id, input_group_id="group")
        children = []
        for message_id in (2, 3):
            job, _ = self.jobs.enqueue(kind="agent", dedupe_key=str(message_id), payload={})
            inputs.reserve_and_claim(
                message_id=message_id, job_id=job.id, parent_job_id=root.id,
                input_group_id="group", lease_seconds=60,
            )
            children.append(job)
        inputs.transition(3, "submitting", allowed_from=("reserved",))
        self.assertEqual(inputs.recover_reserved_jobs(), 1)
        self.jobs.recover_interrupted(unsafe_kinds={"agent"})
        self.assertEqual(self.jobs.get(children[0].id).status, "queued")
        self.assertEqual(inputs.get_by_message(2).state, "unconsumed")
        self.assertEqual(inputs.get_by_message(3).state, "needs_review")
        self.assertEqual(inputs.get_by_message(1).state, "needs_review")
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM agent_run_inputs"), 0)
        self.assertFalse(self.jobs.requeue(children[1].id))

    def test_delayed_acknowledgement_cannot_erase_injected_turn(self):
        inputs = AgentRunInputStore(self.db)
        job, _ = self.jobs.enqueue(kind="agent", dedupe_key="joined-race", payload={})
        inputs.reserve_and_claim(
            message_id=2, job_id=job.id, parent_job_id=1,
            input_group_id="race", lease_seconds=60,
        )
        inputs.transition(2, "submitting")
        observed = threading.Event()
        release = threading.Event()
        failures = []
        original_get = inputs.get_by_message

        def pause_ack_read(message_id):
            result = original_get(message_id)
            if threading.current_thread().name == "delayed-ack":
                observed.set()
                if not release.wait(5):
                    raise RuntimeError("acknowledgement barrier timed out")
            return result

        def acknowledge():
            try:
                inputs.transition(2, "accepted", allowed_from=("submitting",))
            except BaseException as exc:
                failures.append(exc)

        # An immediate lock timeout exposes contention deterministically instead
        # of relying on scheduler sleeps. The real worker waits for this lock.
        self.db.execute("PRAGMA busy_timeout = 0")
        deferred = False
        with mock.patch.object(inputs, "get_by_message", side_effect=pause_ack_read):
            worker = threading.Thread(target=acknowledge, name="delayed-ack")
            worker.start()
            try:
                self.assertTrue(observed.wait(5))
                try:
                    inputs.transition(
                        2, "injected", allowed_from=("submitting", "accepted"),
                        turn_id="consumed-turn", turn_index=7,
                    )
                except sqlite3.OperationalError as exc:
                    if "locked" not in str(exc):
                        raise
                    deferred = True
            finally:
                release.set()
                worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        if deferred:
            inputs.transition(
                2, "injected", allowed_from=("submitting", "accepted"),
                turn_id="consumed-turn", turn_index=7,
            )
        association = inputs.get_by_message(2)
        self.assertEqual((association.state, association.turn_id, association.turn_index),
                         ("injected", "consumed-turn", 7))
        self.assertFalse(inputs.transition(2, "accepted", allowed_from=("submitting", "accepted")))


if __name__ == "__main__":
    unittest.main()
