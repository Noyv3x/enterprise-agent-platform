from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .db import Database, now_ts


INPUT_STATES = frozenset(
    {
        "running",
        "reserved",
        "submitting",
        "accepted",
        "injected",
        "unconsumed",
        "succeeded",
        "failed",
        "needs_review",
    }
)


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
    """Durable relationship between one Agent run and all joined user turns."""

    def __init__(self, db: Database):
        self.db = db
        self._init_schema()

    def _init_schema(self) -> None:
        with self.db.transaction() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS agent_run_inputs (
                    message_id INTEGER PRIMARY KEY,
                    job_id INTEGER NOT NULL UNIQUE,
                    parent_job_id INTEGER NOT NULL,
                    input_group_id TEXT NOT NULL,
                    runtime_run_id TEXT NOT NULL DEFAULT '',
                    state TEXT NOT NULL
                        CHECK(state IN (
                            'running', 'reserved', 'submitting', 'accepted',
                            'injected', 'unconsumed', 'succeeded', 'failed',
                            'needs_review'
                        )),
                    turn_id TEXT NOT NULL DEFAULT '',
                    turn_index INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_group
                    ON agent_run_inputs(input_group_id, message_id);
                CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_parent
                    ON agent_run_inputs(parent_job_id, message_id);
                CREATE INDEX IF NOT EXISTS idx_agent_run_inputs_runtime
                    ON agent_run_inputs(runtime_run_id, message_id);
                """
            )

    def start_root(
        self,
        *,
        message_id: int,
        job_id: int,
        input_group_id: str,
    ) -> AgentRunInput:
        ts = now_ts()
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO agent_run_inputs(
                    message_id, job_id, parent_job_id, input_group_id,
                    state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'running', ?, ?)
                ON CONFLICT(message_id) DO UPDATE SET
                    job_id = excluded.job_id,
                    parent_job_id = excluded.parent_job_id,
                    input_group_id = excluded.input_group_id,
                    state = CASE
                        WHEN agent_run_inputs.state IN ('succeeded', 'failed', 'needs_review')
                            THEN agent_run_inputs.state
                        ELSE 'running'
                    END,
                    runtime_run_id = CASE
                        WHEN agent_run_inputs.state IN ('succeeded', 'failed', 'needs_review')
                            THEN agent_run_inputs.runtime_run_id
                        ELSE ''
                    END,
                    turn_id = CASE
                        WHEN agent_run_inputs.state IN ('succeeded', 'failed', 'needs_review')
                            THEN agent_run_inputs.turn_id
                        ELSE ''
                    END,
                    turn_index = CASE
                        WHEN agent_run_inputs.state IN ('succeeded', 'failed', 'needs_review')
                            THEN agent_run_inputs.turn_index
                        ELSE 0
                    END,
                    last_error = CASE
                        WHEN agent_run_inputs.state IN ('succeeded', 'failed', 'needs_review')
                            THEN agent_run_inputs.last_error
                        ELSE ''
                    END,
                    updated_at = excluded.updated_at
                """,
                (int(message_id), int(job_id), int(job_id), str(input_group_id), ts, ts),
            )
            row = conn.execute(
                "SELECT * FROM agent_run_inputs WHERE message_id = ?",
                (int(message_id),),
            ).fetchone()
        if row is None:
            raise RuntimeError("Agent input root insert did not produce a row")
        return self._from_row(dict(row))

    def reserve(
        self,
        *,
        message_id: int,
        job_id: int,
        parent_job_id: int,
        input_group_id: str,
    ) -> tuple[AgentRunInput, bool]:
        ts = now_ts()
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                INSERT INTO agent_run_inputs(
                    message_id, job_id, parent_job_id, input_group_id,
                    state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)
                ON CONFLICT(message_id) DO NOTHING
                """,
                (
                    int(message_id),
                    int(job_id),
                    int(parent_job_id),
                    str(input_group_id),
                    ts,
                    ts,
                ),
            )
            row = conn.execute(
                "SELECT * FROM agent_run_inputs WHERE message_id = ?",
                (int(message_id),),
            ).fetchone()
        if row is None:
            raise RuntimeError("Agent input reservation did not produce a row")
        return self._from_row(dict(row)), cursor.rowcount > 0

    def reserve_and_claim(
        self,
        *,
        message_id: int,
        job_id: int,
        parent_job_id: int,
        input_group_id: str,
        lease_seconds: int,
    ) -> AgentRunInput | None:
        """Atomically remove a joined child from FIFO ownership and reserve it."""

        ts = now_ts()
        with self.db.transaction() as conn:
            claimed = conn.execute(
                """
                UPDATE durable_jobs
                SET status = 'running', attempts = attempts + 1,
                    lease_until = ?, last_error = '', updated_at = ?
                WHERE id = ? AND status = 'queued' AND available_at <= ?
                """,
                (
                    ts + max(1, int(lease_seconds)),
                    ts,
                    int(job_id),
                    ts,
                ),
            )
            if claimed.rowcount <= 0:
                return None
            conn.execute(
                """
                INSERT INTO agent_run_inputs(
                    message_id, job_id, parent_job_id, input_group_id,
                    state, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)
                """,
                (
                    int(message_id),
                    int(job_id),
                    int(parent_job_id),
                    str(input_group_id),
                    ts,
                    ts,
                ),
            )
            row = conn.execute(
                "SELECT * FROM agent_run_inputs WHERE message_id = ?",
                (int(message_id),),
            ).fetchone()
        if row is None:
            raise RuntimeError("Agent input claim did not produce a row")
        return self._from_row(dict(row))

    def get_by_message(self, message_id: int) -> AgentRunInput | None:
        row = self.db.query_one(
            "SELECT * FROM agent_run_inputs WHERE message_id = ?",
            (int(message_id),),
        )
        return self._from_row(row) if row else None

    def get_by_job(self, job_id: int) -> AgentRunInput | None:
        row = self.db.query_one(
            "SELECT * FROM agent_run_inputs WHERE job_id = ?",
            (int(job_id),),
        )
        return self._from_row(row) if row else None

    def for_group(self, input_group_id: str) -> list[AgentRunInput]:
        return [
            self._from_row(row)
            for row in self.db.query(
                """
                SELECT * FROM agent_run_inputs
                WHERE input_group_id = ?
                ORDER BY message_id
                """,
                (str(input_group_id),),
            )
        ]

    def set_runtime_run(self, input_group_id: str, runtime_run_id: str) -> None:
        self.db.execute(
            """
            UPDATE agent_run_inputs
            SET runtime_run_id = ?, updated_at = ?
            WHERE input_group_id = ?
            """,
            (str(runtime_run_id), now_ts(), str(input_group_id)),
        )

    def transition(
        self,
        message_id: int,
        state: str,
        *,
        allowed_from: Iterable[str] | None = None,
        runtime_run_id: str | None = None,
        turn_id: str | None = None,
        turn_index: int | None = None,
        error: str = "",
    ) -> bool:
        clean_state = str(state)
        if clean_state not in INPUT_STATES:
            raise ValueError(f"unsupported Agent input state: {clean_state}")
        assignments = ["state = ?", "last_error = ?", "updated_at = ?"]
        params: list[Any] = [clean_state, str(error)[:2000], now_ts()]
        if runtime_run_id is not None:
            assignments.append("runtime_run_id = ?")
            params.append(str(runtime_run_id))
        if turn_id is not None:
            assignments.append("turn_id = ?")
            params.append(str(turn_id))
        if turn_index is not None:
            assignments.append("turn_index = ?")
            params.append(max(0, int(turn_index)))
        sql = f"UPDATE agent_run_inputs SET {', '.join(assignments)} WHERE message_id = ?"
        params.append(int(message_id))
        allowed = tuple(str(item) for item in (allowed_from or ()))
        if allowed:
            placeholders = ",".join("?" for _ in allowed)
            sql += f" AND state IN ({placeholders})"
            params.extend(allowed)
        return self.db.execute(sql, params).rowcount > 0

    def recover_reserved_jobs(self) -> int:
        """Safely requeue inputs that were never submitted to the runtime."""

        ts = now_ts()
        with self.db.transaction() as conn:
            rows = conn.execute(
                """
                SELECT message_id, job_id FROM agent_run_inputs
                WHERE state IN ('reserved', 'unconsumed')
                """
            ).fetchall()
            recovered = 0
            for row in rows:
                cursor = conn.execute(
                    """
                    UPDATE durable_jobs
                    SET status = 'queued', lease_until = 0,
                        last_error = 'joined input was not submitted before restart',
                        updated_at = ?
                    WHERE id = ? AND status = 'running'
                    """,
                    (ts, int(row["job_id"])),
                )
                if cursor.rowcount:
                    recovered += 1
                conn.execute(
                    """
                    UPDATE agent_run_inputs
                    SET state = 'unconsumed', updated_at = ?
                    WHERE message_id = ?
                    """,
                    (ts, int(row["message_id"])),
                )
        return recovered

    def quarantine_interrupted_jobs(self) -> None:
        self.db.execute(
            """
            UPDATE agent_run_inputs
            SET state = 'needs_review',
                last_error = 'worker interrupted after runtime input submission',
                updated_at = ?
            WHERE state IN ('running', 'submitting', 'accepted', 'injected')
              AND job_id IN (
                  SELECT id FROM durable_jobs WHERE status = 'needs_review'
              )
            """,
            (now_ts(),),
        )

    def reconcile_terminal_jobs(self) -> None:
        """Make the input ledger agree with authoritative durable job terminals."""

        self.db.execute(
            """
            UPDATE agent_run_inputs
            SET state = CASE (
                    SELECT status FROM durable_jobs
                    WHERE durable_jobs.id = agent_run_inputs.job_id
                )
                    WHEN 'succeeded' THEN 'succeeded'
                    WHEN 'needs_review' THEN 'needs_review'
                    WHEN 'failed' THEN 'failed'
                    ELSE state
                END,
                updated_at = ?
            WHERE job_id IN (
                SELECT id FROM durable_jobs
                WHERE status IN ('succeeded', 'needs_review', 'failed')
            )
              AND state != (
                CASE (
                    SELECT status FROM durable_jobs
                    WHERE durable_jobs.id = agent_run_inputs.job_id
                )
                    WHEN 'succeeded' THEN 'succeeded'
                    WHEN 'needs_review' THEN 'needs_review'
                    WHEN 'failed' THEN 'failed'
                    ELSE state
                END
              )
            """,
            (now_ts(),),
        )

    @staticmethod
    def _from_row(row: dict[str, Any]) -> AgentRunInput:
        return AgentRunInput(
            message_id=int(row["message_id"]),
            job_id=int(row["job_id"]),
            parent_job_id=int(row["parent_job_id"]),
            input_group_id=str(row["input_group_id"]),
            runtime_run_id=str(row.get("runtime_run_id") or ""),
            state=str(row["state"]),
            turn_id=str(row.get("turn_id") or ""),
            turn_index=int(row.get("turn_index") or 0),
            last_error=str(row.get("last_error") or ""),
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
        )
