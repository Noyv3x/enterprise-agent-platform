from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .db import Database, now_ts


JOB_STATUSES = frozenset({"queued", "running", "succeeded", "failed", "needs_review"})


@dataclass(frozen=True)
class DurableJob:
    id: int
    kind: str
    scope_type: str
    scope_id: str
    dedupe_key: str
    payload: dict[str, Any]
    status: str
    attempts: int
    available_at: int
    lease_until: int
    last_error: str
    created_at: int
    updated_at: int


class DurableJobStore:
    """SQLite-backed work ledger shared by Agent and integration workers.

    The store deliberately separates persistence from worker scheduling. A
    caller first enqueues an idempotent record, then places its numeric id on an
    in-memory wake-up queue. Restart recovery reads the durable ledger again,
    so the in-memory queue is never the source of truth.
    """

    def __init__(self, db: Database):
        self.db = db
        self._init_schema()

    def _init_schema(self) -> None:
        with self.db.transaction() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS durable_jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind TEXT NOT NULL,
                    scope_type TEXT NOT NULL DEFAULT '',
                    scope_id TEXT NOT NULL DEFAULT '',
                    dedupe_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'queued'
                        CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'needs_review')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    available_at INTEGER NOT NULL DEFAULT 0,
                    lease_until INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(kind, dedupe_key)
                );
                CREATE INDEX IF NOT EXISTS idx_durable_jobs_ready
                    ON durable_jobs(kind, status, available_at, id);
                CREATE INDEX IF NOT EXISTS idx_durable_jobs_scope
                    ON durable_jobs(scope_type, scope_id, id);
                """
            )

    def enqueue(
        self,
        *,
        kind: str,
        dedupe_key: str,
        payload: dict[str, Any],
        scope_type: str = "",
        scope_id: str = "",
        available_at: int | None = None,
    ) -> tuple[DurableJob, bool]:
        clean_kind = str(kind or "").strip()
        clean_key = str(dedupe_key or "").strip()
        if not clean_kind or not clean_key:
            raise ValueError("durable job kind and dedupe_key are required")
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        ts = now_ts()
        ready_at = ts if available_at is None else max(0, int(available_at))
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                INSERT INTO durable_jobs(
                    kind, scope_type, scope_id, dedupe_key, payload_json,
                    status, available_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
                ON CONFLICT(kind, dedupe_key) DO NOTHING
                """,
                (clean_kind, str(scope_type), str(scope_id), clean_key, encoded, ready_at, ts, ts),
            )
            row = conn.execute(
                "SELECT * FROM durable_jobs WHERE kind = ? AND dedupe_key = ?",
                (clean_kind, clean_key),
            ).fetchone()
        if row is None:
            raise RuntimeError("durable job insert did not produce a row")
        return self._from_row(dict(row)), cursor.rowcount > 0

    def get(self, job_id: int) -> DurableJob | None:
        row = self.db.query_one("SELECT * FROM durable_jobs WHERE id = ?", (int(job_id),))
        return self._from_row(row) if row else None

    def get_by_key(self, kind: str, dedupe_key: str) -> DurableJob | None:
        row = self.db.query_one(
            "SELECT * FROM durable_jobs WHERE kind = ? AND dedupe_key = ?",
            (str(kind), str(dedupe_key)),
        )
        return self._from_row(row) if row else None

    def ready(self, kind: str, *, limit: int = 100) -> list[DurableJob]:
        rows = self.db.query(
            """
            SELECT * FROM durable_jobs
            WHERE kind = ? AND status = 'queued' AND available_at <= ?
            ORDER BY id LIMIT ?
            """,
            (str(kind), now_ts(), max(1, min(int(limit), 1000))),
        )
        return [self._from_row(row) for row in rows]

    def queued(self, kind: str, *, limit: int | None = 1000) -> list[DurableJob]:
        """Return queued work, including jobs delayed by retry backoff.

        Workers use this during process startup so a future ``available_at`` is
        not forgotten merely because no in-memory timer survived the restart.
        The worker still has to call :meth:`mark_running`, which atomically
        enforces the availability deadline.
        """

        sql = """
            SELECT * FROM durable_jobs
            WHERE kind = ? AND status = 'queued'
            ORDER BY available_at, id
        """
        params: list[Any] = [str(kind)]
        if limit is not None:
            sql += " LIMIT ?"
            params.append(max(1, min(int(limit), 10_000)))
        rows = self.db.query(sql, params)
        return [self._from_row(row) for row in rows]

    def mark_running(self, job_id: int, *, lease_seconds: int) -> DurableJob | None:
        ts = now_ts()
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                UPDATE durable_jobs
                SET status = 'running', attempts = attempts + 1,
                    lease_until = ?, last_error = '', updated_at = ?
                WHERE id = ? AND status = 'queued' AND available_at <= ?
                """,
                (ts + max(1, int(lease_seconds)), ts, int(job_id), ts),
            )
            row = conn.execute("SELECT * FROM durable_jobs WHERE id = ?", (int(job_id),)).fetchone()
        if cursor.rowcount <= 0 or row is None:
            return None
        return self._from_row(dict(row))

    def mark_succeeded(self, job_id: int, *, reconcile: bool = False) -> bool:
        allowed = ("running", "needs_review") if reconcile else ("running",)
        return self._transition(job_id, "succeeded", error="", allowed_from=allowed)

    def mark_failed(self, job_id: int, error: str, *, needs_review: bool = False) -> bool:
        return self._transition(
            job_id,
            "needs_review" if needs_review else "failed",
            error=error,
            allowed_from=("queued", "running"),
        )

    def requeue(self, job_id: int, *, delay_seconds: int = 0, error: str = "") -> bool:
        """Return a job owned by the current worker to the ready queue.

        This is intentionally a running-only compare-and-swap. A stale worker
        must never resurrect work that an administrator, lifecycle reset, or
        restart quarantine already moved to a terminal state.
        """

        ts = now_ts()
        cursor = self.db.execute(
            """
            UPDATE durable_jobs
            SET status = 'queued', available_at = ?, lease_until = 0,
                last_error = ?, updated_at = ?
            WHERE id = ? AND status = 'running'
            """,
            (ts + max(0, int(delay_seconds)), str(error)[:2000], ts, int(job_id)),
        )
        return cursor.rowcount > 0

    def recover_interrupted(self, *, unsafe_kinds: set[str] | frozenset[str]) -> dict[str, int]:
        """Recover jobs left running by a prior process.

        Side-effectful Agent jobs are moved to ``needs_review`` instead of being
        executed twice. Idempotent integration jobs are returned to ``queued``.
        """

        ts = now_ts()
        unsafe = {str(kind) for kind in unsafe_kinds}
        rows = self.db.query("SELECT id, kind FROM durable_jobs WHERE status = 'running'")
        counts = {"queued": 0, "needs_review": 0}
        with self.db.transaction() as conn:
            for row in rows:
                target = "needs_review" if str(row["kind"]) in unsafe else "queued"
                conn.execute(
                    """
                    UPDATE durable_jobs
                    SET status = ?, lease_until = 0,
                        last_error = 'worker interrupted by service restart', updated_at = ?
                    WHERE id = ? AND status = 'running'
                    """,
                    (target, ts, int(row["id"])),
                )
                counts[target] += 1
        return counts

    def counts(
        self,
        *,
        kind: str | None = None,
        scope_type: str | None = None,
        scope_id: str | None = None,
    ) -> dict[str, int]:
        result = {status: 0 for status in JOB_STATUSES}
        clauses: list[str] = []
        params: list[Any] = []
        for column, value in (("kind", kind), ("scope_type", scope_type), ("scope_id", scope_id)):
            if value is not None:
                clauses.append(f"{column} = ?")
                params.append(str(value))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        for row in self.db.query(
            f"SELECT status, count(*) AS count FROM durable_jobs {where} GROUP BY status",
            params,
        ):
            status = str(row["status"])
            if status in result:
                result[status] = int(row["count"])
        return result

    def _transition(
        self,
        job_id: int,
        status: str,
        *,
        error: str,
        allowed_from: tuple[str, ...],
    ) -> bool:
        if status not in JOB_STATUSES:
            raise ValueError(f"invalid durable job status: {status}")
        placeholders = ",".join("?" for _ in allowed_from)
        cursor = self.db.execute(
            f"""
            UPDATE durable_jobs
            SET status = ?, lease_until = 0, last_error = ?, updated_at = ?
            WHERE id = ? AND status IN ({placeholders})
            """,
            (status, str(error)[:2000], now_ts(), int(job_id), *allowed_from),
        )
        return cursor.rowcount > 0

    @staticmethod
    def _from_row(row: dict[str, Any]) -> DurableJob:
        try:
            payload = json.loads(str(row.get("payload_json") or "{}"))
        except json.JSONDecodeError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        return DurableJob(
            id=int(row["id"]),
            kind=str(row["kind"]),
            scope_type=str(row.get("scope_type") or ""),
            scope_id=str(row.get("scope_id") or ""),
            dedupe_key=str(row["dedupe_key"]),
            payload=payload,
            status=str(row["status"]),
            attempts=int(row.get("attempts") or 0),
            available_at=int(row.get("available_at") or 0),
            lease_until=int(row.get("lease_until") or 0),
            last_error=str(row.get("last_error") or ""),
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
        )
