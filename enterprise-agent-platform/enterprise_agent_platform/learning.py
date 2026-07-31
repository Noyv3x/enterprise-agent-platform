from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from .db import Database, now_ts
from .jobs import DurableJob


LEARNING_REVIEW_JOB_KIND = "agent_learning_review"
LEARNING_REVIEW_TURN_CADENCE = 10
LEARNING_REVIEW_TOOL_CADENCE = 10
LEARNING_REVIEW_MAX_ATTEMPTS = 3
LEARNING_REVIEW_LEASE_SECONDS = 30 * 60
LEARNING_REVIEW_MUTATION_BUDGET = 20


class LearningReviewBudgetExceeded(RuntimeError):
    """Raised when a durable review has no mutation units remaining."""


@dataclass(frozen=True)
class ForegroundCompletion:
    succeeded: bool
    review_job_id: int | None = None


class LearningReviewStore:
    """Durable cadence and outbox for post-reply memory/Skill reviews."""

    def __init__(self, db: Database):
        self.db = db

    @staticmethod
    def _state_key(scope_key: str) -> str:
        digest = hashlib.sha256(str(scope_key).encode("utf-8")).hexdigest()
        return f"agent_learning_review_state:{digest}"

    @staticmethod
    def _dedupe_key(scope_key: str, lifecycle_id: str, response_message_id: int) -> str:
        material = f"{scope_key}\0{lifecycle_id}\0{int(response_message_id)}"
        return "v1:" + hashlib.sha256(material.encode("utf-8")).hexdigest()

    @staticmethod
    def _decoded_state(raw: Any, *, scope_key: str, lifecycle_id: str) -> dict[str, Any]:
        try:
            value = json.loads(str(raw or "{}"))
        except (TypeError, json.JSONDecodeError):
            value = {}
        if not isinstance(value, dict) or value.get("schema_version") != 1:
            value = {}
        if value.get("scope_key") != scope_key or value.get("lifecycle_id") != lifecycle_id:
            value = {}

        def bounded_counter(candidate: Any) -> int:
            try:
                return max(0, min(int(candidate or 0), 1_000_000))
            except (TypeError, ValueError):
                return 0

        return {
            "schema_version": 1,
            "scope_key": scope_key,
            "lifecycle_id": lifecycle_id,
            "successful_turns": bounded_counter(value.get("successful_turns")),
            "tool_calls": bounded_counter(value.get("tool_calls")),
        }

    def complete_foreground_job(
        self,
        job_id: int,
        *,
        scope_key: str,
        lifecycle_id: str,
        owner_user_id: int,
        source_message_id: int,
        response_message_id: int,
        tool_calls: int,
        tool_trace: list[dict[str, Any]] | None = None,
    ) -> ForegroundCompletion:
        """CAS the foreground job and atomically advance/enqueue review work."""

        clean_scope = str(scope_key or "").strip()
        clean_lifecycle = str(lifecycle_id or "").strip()
        if not clean_scope or not clean_lifecycle:
            raise ValueError("learning review scope and lifecycle are required")
        owner = int(owner_user_id)
        source = int(source_message_id)
        response = int(response_message_id)
        if owner <= 0 or source <= 0 or response <= 0:
            raise ValueError("learning review owner and message ids must be positive")
        completed_tools = max(0, min(int(tool_calls), 10_000))
        timestamp = now_ts()
        state_key = self._state_key(clean_scope)
        review_job_id: int | None = None
        with self.db.transaction(immediate=True) as conn:
            transitioned = conn.execute(
                """
                UPDATE durable_jobs
                SET status = 'succeeded', lease_until = 0, last_error = '', updated_at = ?
                WHERE id = ? AND status = 'running'
                """,
                (timestamp, int(job_id)),
            )
            if transitioned.rowcount <= 0:
                return ForegroundCompletion(False)
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ?", (state_key,)
            ).fetchone()
            state = self._decoded_state(
                row["value"] if row is not None else None,
                scope_key=clean_scope,
                lifecycle_id=clean_lifecycle,
            )
            state["successful_turns"] += 1
            state["tool_calls"] += completed_tools
            reasons: list[str] = []
            if state["successful_turns"] >= LEARNING_REVIEW_TURN_CADENCE:
                reasons.append("turn_cadence")
                state["successful_turns"] %= LEARNING_REVIEW_TURN_CADENCE
            if state["tool_calls"] >= LEARNING_REVIEW_TOOL_CADENCE:
                reasons.append("tool_cadence")
                state["tool_calls"] %= LEARNING_REVIEW_TOOL_CADENCE
            state["last_source_message_id"] = source
            state["last_response_message_id"] = response
            state["updated_at"] = timestamp
            conn.execute(
                """
                INSERT INTO settings(key, value, secret, updated_at)
                VALUES (?, ?, 0, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value, secret = 0, updated_at = excluded.updated_at
                """,
                (
                    state_key,
                    json.dumps(state, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
                    timestamp,
                ),
            )
            if reasons:
                bounded_trace: list[dict[str, str]] = []
                for raw in list(tool_trace or [])[:20]:
                    if not isinstance(raw, dict):
                        continue
                    tool = str(raw.get("tool") or "").strip()[:64]
                    if not tool:
                        continue
                    bounded_trace.append(
                        {
                            "tool": tool,
                            "detail": str(raw.get("detail") or "").strip()[:500],
                        }
                    )
                payload = {
                    "schema_version": 1,
                    "scope_key": clean_scope,
                    "lifecycle_id": clean_lifecycle,
                    "owner_user_id": owner,
                    "source_message_id": source,
                    "response_message_id": response,
                    "reasons": reasons,
                    "tool_trace": bounded_trace,
                    "mutation_budget": {
                        "limit": LEARNING_REVIEW_MUTATION_BUDGET,
                        "used": 0,
                    },
                }
                dedupe_key = self._dedupe_key(clean_scope, clean_lifecycle, response)
                conn.execute(
                    """
                    INSERT INTO durable_jobs(
                        kind, scope_type, scope_id, dedupe_key, payload_json,
                        status, available_at, created_at, updated_at
                    ) VALUES (?, 'private', ?, ?, ?, 'queued', ?, ?, ?)
                    ON CONFLICT(kind, dedupe_key) DO NOTHING
                    """,
                    (
                        LEARNING_REVIEW_JOB_KIND,
                        str(owner),
                        dedupe_key,
                        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
                        timestamp,
                        timestamp,
                        timestamp,
                    ),
                )
                review_row = conn.execute(
                    "SELECT id FROM durable_jobs WHERE kind = ? AND dedupe_key = ?",
                    (LEARNING_REVIEW_JOB_KIND, dedupe_key),
                ).fetchone()
                if review_row is None:
                    raise RuntimeError("learning review outbox insert did not produce a job")
                review_job_id = int(review_row["id"])
        return ForegroundCompletion(True, review_job_id)

    @staticmethod
    def context_matches(
        job: DurableJob | None,
        *,
        scope_key: str,
        lifecycle_id: str,
        owner_user_id: int,
        source_message_id: int,
    ) -> bool:
        if job is None or job.kind != LEARNING_REVIEW_JOB_KIND or job.status != "running":
            return False
        payload = job.payload
        try:
            payload_owner = int(payload.get("owner_user_id") or 0)
            payload_source = int(payload.get("source_message_id") or 0)
        except (TypeError, ValueError):
            return False
        return (
            job.scope_type == "private"
            and str(job.scope_id) == str(owner_user_id)
            and payload.get("schema_version") == 1
            and str(payload.get("scope_key") or "") == str(scope_key)
            and str(payload.get("lifecycle_id") or "") == str(lifecycle_id)
            and payload_owner == int(owner_user_id)
            and payload_source == int(source_message_id)
        )

    def context_matches_in_transaction(
        self,
        conn,
        job_id: int,
        *,
        scope_key: str,
        lifecycle_id: str,
        owner_user_id: int,
        source_message_id: int,
    ) -> bool:
        """Recheck a review job on the caller's existing SQLite transaction.

        Review memory authorization and the memory mutation must observe one
        write-serialized snapshot.  Calling ``DurableJobStore.get`` here would
        perform the check outside that boundary and reopen a revoke/reset
        time-of-check/time-of-use window.
        """

        row = conn.execute(
            "SELECT * FROM durable_jobs WHERE id = ?", (int(job_id),)
        ).fetchone()
        if row is None:
            return False
        try:
            payload = json.loads(str(row["payload_json"] or "{}"))
        except (TypeError, json.JSONDecodeError):
            return False
        if not isinstance(payload, dict):
            return False
        try:
            payload_owner = int(payload.get("owner_user_id") or 0)
            payload_source = int(payload.get("source_message_id") or 0)
        except (TypeError, ValueError):
            return False
        return (
            str(row["kind"]) == LEARNING_REVIEW_JOB_KIND
            and str(row["status"]) == "running"
            and str(row["scope_type"] or "") == "private"
            and str(row["scope_id"] or "") == str(owner_user_id)
            and payload.get("schema_version") == 1
            and str(payload.get("scope_key") or "") == str(scope_key)
            and str(payload.get("lifecycle_id") or "") == str(lifecycle_id)
            and payload_owner == int(owner_user_id)
            and payload_source == int(source_message_id)
        )

    def consume_mutation_budget_in_transaction(
        self,
        conn,
        job_id: int,
        units: int,
    ) -> int:
        """Consume persistent review mutation units on the caller's write txn.

        Older in-flight jobs without the field start at zero. Once present, a
        malformed or non-canonical budget fails closed instead of refreshing
        the allowance. The caller must already have revalidated the review
        principal in this same transaction.
        """

        if isinstance(units, bool):
            raise ValueError("learning review mutation units must be an integer")
        requested = int(units)
        if requested <= 0 or requested > LEARNING_REVIEW_MUTATION_BUDGET:
            raise ValueError(
                "learning review mutation units must be between 1 and "
                f"{LEARNING_REVIEW_MUTATION_BUDGET}"
            )
        row = conn.execute(
            "SELECT kind, status, payload_json FROM durable_jobs WHERE id = ?",
            (int(job_id),),
        ).fetchone()
        if (
            row is None
            or str(row["kind"]) != LEARNING_REVIEW_JOB_KIND
            or str(row["status"]) != "running"
        ):
            raise LearningReviewBudgetExceeded(
                "learning review job is not active"
            )
        try:
            payload = json.loads(str(row["payload_json"] or "{}"))
        except (TypeError, json.JSONDecodeError) as exc:
            raise LearningReviewBudgetExceeded(
                "learning review mutation budget is invalid"
            ) from exc
        if not isinstance(payload, dict):
            raise LearningReviewBudgetExceeded(
                "learning review mutation budget is invalid"
            )
        raw_budget = payload.get("mutation_budget")
        if raw_budget is None:
            used = 0
        elif isinstance(raw_budget, dict):
            raw_limit = raw_budget.get("limit")
            raw_used = raw_budget.get("used")
            if (
                isinstance(raw_limit, bool)
                or isinstance(raw_used, bool)
                or not isinstance(raw_limit, int)
                or not isinstance(raw_used, int)
                or raw_limit != LEARNING_REVIEW_MUTATION_BUDGET
                or raw_used < 0
                or raw_used > LEARNING_REVIEW_MUTATION_BUDGET
            ):
                raise LearningReviewBudgetExceeded(
                    "learning review mutation budget is invalid"
                )
            used = raw_used
        else:
            raise LearningReviewBudgetExceeded(
                "learning review mutation budget is invalid"
            )
        next_used = used + requested
        if next_used > LEARNING_REVIEW_MUTATION_BUDGET:
            raise LearningReviewBudgetExceeded(
                "learning review mutation budget is exhausted"
            )
        payload["mutation_budget"] = {
            "limit": LEARNING_REVIEW_MUTATION_BUDGET,
            "used": next_used,
        }
        updated = conn.execute(
            """
            UPDATE durable_jobs
            SET payload_json = ?, updated_at = ?
            WHERE id = ? AND kind = ? AND status = 'running'
            """,
            (
                json.dumps(
                    payload,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ),
                now_ts(),
                int(job_id),
                LEARNING_REVIEW_JOB_KIND,
            ),
        )
        if updated.rowcount != 1:
            raise LearningReviewBudgetExceeded(
                "learning review job is not active"
            )
        return LEARNING_REVIEW_MUTATION_BUDGET - next_used
