from __future__ import annotations

import json
import sqlite3
from contextlib import nullcontext
from dataclasses import dataclass
from typing import Any, Iterable

from .db import Database, now_ts


INPUT_STATES = frozenset({
    "running", "reserved", "submitting", "accepted", "injected", "unconsumed",
    "succeeded", "failed", "needs_review",
})
TERMINAL_STATES = frozenset({"succeeded", "failed", "needs_review"})


@dataclass(frozen=True)
class AgentRunInput:
    message_id: int
    job_id: int
    parent_job_id: int
    input_group_id: str
    runtime_run_id: str
    state: str
    turn_id: str
    turn_index: int
    last_error: str
    created_at: int
    updated_at: int


class AgentRunInputStore:
    """Runtime input phase on the durable job, with read-only legacy support.

    The phase describes Runtime admission, not a second job lifecycle. Terminal
    state and errors always come from the owning job. Old association rows stay
    intact so a rollback reader can still inspect its historical records.
    """

    def __init__(self, db: Database):
        self.db = db

    def _save(self, conn, job_id: int, association: dict[str, Any]) -> None:
        conn.execute(
            "UPDATE durable_jobs SET payload_json = json_set(payload_json, '$._input', json(?)), "
            "updated_at = ? WHERE id = ?",
            (json.dumps(association, ensure_ascii=False), now_ts(), int(job_id)),
        )

    def _associate(self, conn, message_id, job_id, parent_job_id, input_group_id, state):
        self._save(conn, job_id, {
            "message_id": int(message_id), "parent_job_id": int(parent_job_id),
            "input_group_id": str(input_group_id), "state": state,
        })
        return self.get_by_job(job_id)

    def start_root(self, *, message_id: int, job_id: int, input_group_id: str) -> AgentRunInput:
        with self.db.transaction(immediate=True) as conn:
            previous = self.get_by_job(job_id)
            if previous is not None and previous.state in TERMINAL_STATES:
                return previous
            result = self._associate(conn, message_id, job_id, job_id, input_group_id, "running")
        if result is None:
            raise RuntimeError("Agent input root has no durable job")
        return result

    def reserve_and_claim(
        self, *, message_id: int, job_id: int, parent_job_id: int,
        input_group_id: str, lease_seconds: int,
    ) -> AgentRunInput | None:
        ts = now_ts()
        with self.db.transaction() as conn:
            claimed = conn.execute(
                "UPDATE durable_jobs SET status = 'running', attempts = attempts + 1, "
                "lease_until = ?, last_error = '', updated_at = ? "
                "WHERE id = ? AND status = 'queued' AND available_at <= ?",
                (ts + max(1, int(lease_seconds)), ts, int(job_id), ts),
            )
            if not claimed.rowcount:
                return None
            return self._associate(conn, message_id, job_id, parent_job_id, input_group_id, "reserved")

    def reserve_pending(
        self, *, message_id: int, job_id: int, parent_job_id: int, input_group_id: str,
    ) -> AgentRunInput | None:
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute("SELECT status FROM durable_jobs WHERE id = ?", (int(job_id),)).fetchone()
            if row is None or row["status"] != "queued":
                return None
            return self._associate(conn, message_id, job_id, parent_job_id, input_group_id, "reserved")

    def get_by_message(self, message_id: int) -> AgentRunInput | None:
        row = self.db.query_one(
            "SELECT id FROM durable_jobs WHERE kind = 'agent' "
            "AND json_extract(payload_json, '$._input.message_id') = ?",
            (int(message_id),),
        )
        if row is None:
            row = self.db.query_one(
                "SELECT job_id AS id FROM agent_run_inputs WHERE message_id = ?",
                (int(message_id),),
            )
        return self.get_by_job(int(row["id"])) if row else None

    def get_by_job(self, job_id: int) -> AgentRunInput | None:
        job = self.db.query_one("SELECT * FROM durable_jobs WHERE id = ?", (int(job_id),))
        if job is None:
            return None
        data = json.loads(job["payload_json"]).get("_input")
        if not isinstance(data, dict):
            data = self.db.query_one("SELECT * FROM agent_run_inputs WHERE job_id = ?", (int(job_id),))
        if not data:
            return None
        state = str(job["status"]) if job["status"] in TERMINAL_STATES else str(data["state"])
        return AgentRunInput(
            message_id=int(data["message_id"]), job_id=int(job_id),
            parent_job_id=int(data["parent_job_id"]), input_group_id=str(data["input_group_id"]),
            runtime_run_id=str(data.get("runtime_run_id") or ""), state=state,
            turn_id=str(data.get("turn_id") or ""), turn_index=int(data.get("turn_index") or 0),
            last_error=str(job.get("last_error") or ""),
            created_at=int(job["created_at"]), updated_at=int(job["updated_at"]),
        )

    def for_group(self, input_group_id: str) -> list[AgentRunInput]:
        rows = self.db.query(
            "SELECT id FROM durable_jobs WHERE kind = 'agent' "
            "AND json_extract(payload_json, '$._input.input_group_id') = ? "
            "UNION SELECT job_id AS id FROM agent_run_inputs WHERE input_group_id = ?",
            (str(input_group_id), str(input_group_id)),
        )
        result = [self.get_by_job(int(row["id"])) for row in rows]
        return sorted(
            (item for item in result if item is not None and item.input_group_id == input_group_id),
            key=lambda item: item.message_id,
        )

    def set_runtime_run(self, input_group_id: str, runtime_run_id: str) -> None:
        with self.db.transaction(immediate=True) as conn:
            for item in self.for_group(input_group_id):
                self.transition(item.message_id, item.state, runtime_run_id=runtime_run_id, conn=conn)

    def transition(
        self, message_id: int, state: str, *, allowed_from: Iterable[str] | None = None,
        runtime_run_id: str | None = None, turn_id: str | None = None,
        turn_index: int | None = None, error: str = "", conn: sqlite3.Connection | None = None,
    ) -> bool:
        if state not in INPUT_STATES:
            raise ValueError(f"unsupported Agent input state: {state}")
        with self.db.transaction(immediate=True) if conn is None else nullcontext(conn) as conn:
            item = self.get_by_message(message_id)
            if item is None or (allowed_from and item.state not in allowed_from):
                return False
            # Job transitions own terminal outcomes; input callers only annotate
            # admission/consumption and never resurrect terminal work.
            if item.state in TERMINAL_STATES:
                return item.state == state
            data = {
                "message_id": item.message_id, "parent_job_id": item.parent_job_id,
                "input_group_id": item.input_group_id,
                "state": state if state not in TERMINAL_STATES else item.state,
                "runtime_run_id": item.runtime_run_id if runtime_run_id is None else str(runtime_run_id),
                "turn_id": item.turn_id if turn_id is None else str(turn_id),
                "turn_index": item.turn_index if turn_index is None else max(0, int(turn_index)),
            }
            self._save(conn, item.job_id, data)
            if state in TERMINAL_STATES:
                conn.execute(
                    "UPDATE durable_jobs SET status = ?, last_error = ?, lease_until = 0 "
                    "WHERE id = ? AND status IN ('queued', 'running')",
                    (state, str(error)[:2000], item.job_id),
                )
            return True

    def recover_reserved_jobs(self) -> int:
        """Only inputs proven not submitted may be replayed after restart."""
        rows = self.db.query("SELECT id FROM durable_jobs WHERE kind = 'agent' AND status = 'running'")
        recovered = 0
        with self.db.transaction(immediate=True) as conn:
            for row in rows:
                item = self.get_by_job(int(row["id"]))
                if item is None or item.state not in {"reserved", "unconsumed"}:
                    continue
                self.transition(item.message_id, "unconsumed", conn=conn)
                recovered += conn.execute(
                    "UPDATE durable_jobs SET status = 'queued', lease_until = 0, "
                    "last_error = 'joined input was not submitted before restart', updated_at = ? "
                    "WHERE id = ? AND status = 'running'",
                    (now_ts(), item.job_id),
                ).rowcount
        return recovered
