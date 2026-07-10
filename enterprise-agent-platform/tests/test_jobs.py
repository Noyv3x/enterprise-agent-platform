from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.db import Database
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
        job, _ = self.jobs.enqueue(kind="cognee", dedupe_key="doc:3", payload={"id": 3})
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
        cognee, _ = self.jobs.enqueue(kind="cognee", dedupe_key="doc:1", payload={})
        telegram, _ = self.jobs.enqueue(kind="telegram_delivery", dedupe_key="message:1", payload={})
        self.jobs.mark_running(agent.id, lease_seconds=60)
        self.jobs.mark_running(cognee.id, lease_seconds=60)
        self.jobs.mark_running(telegram.id, lease_seconds=60)

        counts = self.jobs.recover_interrupted(unsafe_kinds={"agent", "telegram_delivery"})

        self.assertEqual(counts, {"queued": 1, "needs_review": 2})
        self.assertEqual(self.jobs.get(agent.id).status, "needs_review")
        self.assertEqual(self.jobs.get(cognee.id).status, "queued")
        self.assertEqual(self.jobs.get(telegram.id).status, "needs_review")

    def test_queued_includes_delayed_retry_and_counts_can_be_scoped(self):
        first, _ = self.jobs.enqueue(
            kind="cognee",
            dedupe_key="doc:future",
            payload={"id": 8},
            scope_type="knowledge",
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

        self.assertEqual([job.id for job in self.jobs.queued("cognee")], [first.id])
        self.assertEqual(self.jobs.ready("cognee"), [])
        scoped = self.jobs.counts(kind="cognee", scope_type="knowledge", scope_id="8")
        self.assertEqual(scoped["queued"], 1)
        self.assertEqual(sum(scoped.values()), 1)

    def test_unbounded_recovery_read_does_not_strand_jobs_after_default_page(self):
        for index in range(1005):
            self.jobs.enqueue(kind="cognee", dedupe_key=f"doc:{index}", payload={"id": index})

        self.assertEqual(len(self.jobs.queued("cognee")), 1000)
        recovered = self.jobs.queued("cognee", limit=None)
        self.assertEqual(len(recovered), 1005)
        self.assertEqual(recovered[-1].dedupe_key, "doc:1004")


if __name__ == "__main__":
    unittest.main()
