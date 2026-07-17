from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .db import Database, now_ts


MAX_SCHEDULES_PER_USER = 50
MAX_SCHEDULE_NAME_LENGTH = 120
MAX_SCHEDULE_PROMPT_LENGTH = 20_000
MIN_INTERVAL_SECONDS = 300
MAX_INTERVAL_SECONDS = 366 * 24 * 60 * 60
RUN_STATUSES = frozenset(
    {"queued", "running", "succeeded", "failed", "needs_review", "blocked", "skipped", "cancelled"}
)


def rfc3339_utc(timestamp: int | float | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(int(timestamp), timezone.utc).isoformat().replace("+00:00", "Z")


def parse_rfc3339(value: Any, *, field: str) -> int:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} is required")
    try:
        parsed = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError as exc:
        raise ValueError(f"{field} must be an RFC3339 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} must include a timezone offset")
    return int(parsed.astimezone(timezone.utc).timestamp())


def normalize_timezone(value: Any, *, default: str = "UTC") -> str:
    name = str(value or default).strip() or default
    if len(name) > 120 or any(ch.isspace() for ch in name):
        raise ValueError("timezone must be a valid IANA timezone")
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("timezone must be a valid IANA timezone") from exc
    return name


def normalize_schedule(value: Any, *, timezone_name: str, now: int | None = None) -> tuple[dict[str, Any], int]:
    if not isinstance(value, dict):
        raise ValueError("schedule must be an object")
    schedule_type = str(value.get("type") or "").strip().lower()
    current = now_ts() if now is None else int(now)
    if schedule_type == "once":
        at = parse_rfc3339(value.get("at"), field="schedule.at")
        if at <= current:
            raise ValueError("schedule.at must be in the future")
        return {"type": "once", "at": rfc3339_utc(at)}, at
    if schedule_type == "interval":
        try:
            every = int(value.get("every_seconds"))
        except (TypeError, ValueError) as exc:
            raise ValueError("schedule.every_seconds must be an integer") from exc
        if every < MIN_INTERVAL_SECONDS or every > MAX_INTERVAL_SECONDS:
            raise ValueError(
                f"schedule.every_seconds must be between {MIN_INTERVAL_SECONDS} and {MAX_INTERVAL_SECONDS}"
            )
        starts_value = value.get("starts_at")
        starts_at = (
            parse_rfc3339(starts_value, field="schedule.starts_at")
            if starts_value not in {None, ""}
            else current + every
        )
        canonical: dict[str, Any] = {
            "type": "interval",
            "every_seconds": every,
            "starts_at": rfc3339_utc(starts_at),
        }
        return canonical, _next_interval(starts_at, every, current - 1)
    if schedule_type == "cron":
        expression = str(value.get("expression") or "").strip()
        parsed = _CronExpression(expression)
        tz = ZoneInfo(timezone_name)
        parsed.validate_minimum_interval(MIN_INTERVAL_SECONDS, tz)
        next_at = parsed.next_after(current - 1, tz)
        return {"type": "cron", "expression": parsed.expression}, next_at
    raise ValueError("schedule.type must be once, interval or cron")


def next_occurrence(
    schedule: dict[str, Any],
    *,
    timezone_name: str,
    after: int,
) -> int | None:
    schedule_type = str(schedule.get("type") or "")
    if schedule_type == "once":
        at = parse_rfc3339(schedule.get("at"), field="schedule.at")
        return at if at > int(after) else None
    if schedule_type == "interval":
        every = int(schedule["every_seconds"])
        starts = (
            parse_rfc3339(schedule.get("starts_at"), field="schedule.starts_at")
            if schedule.get("starts_at")
            else int(after) + every
        )
        return _next_interval(starts, every, int(after))
    if schedule_type == "cron":
        return _CronExpression(str(schedule["expression"])).next_after(
            int(after), ZoneInfo(normalize_timezone(timezone_name))
        )
    raise ValueError("stored schedule type is invalid")


def _next_interval(starts_at: int, every: int, after: int) -> int:
    if starts_at > after:
        return starts_at
    elapsed = after - starts_at
    return starts_at + ((elapsed // every) + 1) * every


class _CronExpression:
    """Strict, dependency-free five-field cron parser and calendar iterator."""

    _RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))

    def __init__(self, expression: str):
        fields = str(expression or "").split()
        if len(fields) != 5:
            raise ValueError("cron expression must contain exactly five fields")
        self.expression = " ".join(fields)
        parsed = [self._parse_field(raw, *bounds) for raw, bounds in zip(fields, self._RANGES)]
        self.minutes, self.hours, self.days, self.months, weekdays = parsed
        self.weekdays = {0 if value == 7 else value for value in weekdays}
        # DOM/DOW OR semantics apply only when both fields are genuinely
        # restricted. Treat equivalent full-range spellings such as ``*/1``
        # (and 0-7 for weekdays) as wildcards too; a lexical ``== '*'`` check
        # would incorrectly turn ``0 0 */1 * 1`` into an every-day schedule.
        self.day_wildcard = self.days == set(range(1, 32))
        self.weekday_wildcard = self.weekdays == set(range(0, 7))

    @staticmethod
    def _parse_field(raw: str, minimum: int, maximum: int) -> set[int]:
        if not raw or any(ch not in "0123456789*,-/" for ch in raw):
            raise ValueError("cron fields support only numbers, *, lists, ranges and steps")
        values: set[int] = set()
        for part in raw.split(","):
            if not part:
                raise ValueError("cron field contains an empty list item")
            base, slash, step_text = part.partition("/")
            if slash:
                if "/" in step_text:
                    raise ValueError("cron step is invalid")
                try:
                    step = int(step_text)
                except ValueError as exc:
                    raise ValueError("cron step must be an integer") from exc
                if step <= 0:
                    raise ValueError("cron step must be positive")
            else:
                step = 1
            if base == "*":
                start, end = minimum, maximum
            elif "-" in base:
                start_text, separator, end_text = base.partition("-")
                if not separator or "-" in end_text:
                    raise ValueError("cron range is invalid")
                try:
                    start, end = int(start_text), int(end_text)
                except ValueError as exc:
                    raise ValueError("cron range must be numeric") from exc
            else:
                try:
                    start = int(base)
                except ValueError as exc:
                    raise ValueError("cron value must be numeric") from exc
                # Standard cron also permits a numeric step base (for example
                # ``0/15``), meaning from that value through the field maximum.
                end = maximum if slash else start
            if start < minimum or end > maximum or start > end:
                raise ValueError(f"cron value must be between {minimum} and {maximum}")
            values.update(range(start, end + 1, step))
        if not values:
            raise ValueError("cron field must not be empty")
        return values

    def next_after(self, timestamp: int, tz: ZoneInfo) -> int:
        after = int(timestamp)
        local_start = datetime.fromtimestamp(after, timezone.utc).astimezone(tz).date()
        # Eight years covers the longest meaningful five-field pattern,
        # including leap-day schedules, without minute-by-minute scanning.
        for offset in range(0, 366 * 8 + 3):
            candidate_date = local_start + timedelta(days=offset)
            if candidate_date.month not in self.months or not self._date_matches(candidate_date):
                continue
            for hour in sorted(self.hours):
                for minute in sorted(self.minutes):
                    naive = datetime(
                        candidate_date.year,
                        candidate_date.month,
                        candidate_date.day,
                        hour,
                        minute,
                    )
                    # fold=0 intentionally chooses only the first occurrence in
                    # a repeated DST hour. A round trip rejects nonexistent gap
                    # times rather than silently moving them by an hour.
                    aware = naive.replace(tzinfo=tz, fold=0)
                    utc = aware.astimezone(timezone.utc)
                    if utc.astimezone(tz).replace(tzinfo=None, fold=0) != naive:
                        continue
                    epoch = int(utc.timestamp())
                    if epoch > after:
                        return epoch
        raise ValueError("cron expression has no occurrence within eight years")

    def validate_minimum_interval(self, minimum_seconds: int, tz: ZoneInfo) -> None:
        minute_values = sorted(hour * 60 + minute for hour in self.hours for minute in self.minutes)
        gaps = [right - left for left, right in zip(minute_values, minute_values[1:])]
        if gaps and min(gaps) * 60 < int(minimum_seconds):
            raise ValueError(f"cron occurrences must be at least {minimum_seconds} seconds apart")

        def epoch_for(candidate_date: date, minute_of_day: int) -> int | None:
            naive = datetime.combine(candidate_date, datetime.min.time()) + timedelta(
                minutes=minute_of_day
            )
            aware = naive.replace(tzinfo=tz, fold=0)
            utc = aware.astimezone(timezone.utc)
            if utc.astimezone(tz).replace(tzinfo=None, fold=0) != naive:
                return None
            return int(utc.timestamp())

        def transition_day(candidate_date: date) -> bool:
            # ZoneInfo does not expose its transition table publicly. A small
            # set of local boundary samples cheaply identifies modern IANA
            # transition days; only those rare days need every cron minute
            # materialized for exact gap checks.
            offsets = set()
            for hour in (0, 6, 12, 18, 24):
                naive = datetime.combine(candidate_date, datetime.min.time()) + timedelta(hours=hour)
                offsets.add(naive.replace(tzinfo=tz, fold=0).utcoffset())
            return len(offsets) > 1

        start = datetime.now(timezone.utc).astimezone(tz).date()
        previous_last: int | None = None
        for offset in range(0, 366 * 8 + 3):
            candidate_date = start + timedelta(days=offset)
            if candidate_date.month not in self.months or not self._date_matches(candidate_date):
                continue
            values_to_check = (
                minute_values
                if transition_day(candidate_date)
                else ([minute_values[0]] if len(minute_values) == 1 else [minute_values[0], minute_values[-1]])
            )
            epochs = [
                epoch
                for minute_of_day in values_to_check
                if (epoch := epoch_for(candidate_date, minute_of_day)) is not None
            ]
            if not epochs:
                continue
            if any(right - left < int(minimum_seconds) for left, right in zip(epochs, epochs[1:])):
                raise ValueError(f"cron occurrences must be at least {minimum_seconds} seconds apart")
            if previous_last is not None and epochs[0] - previous_last < int(minimum_seconds):
                raise ValueError(f"cron occurrences must be at least {minimum_seconds} seconds apart")
            previous_last = epochs[-1]

    def _date_matches(self, candidate: date) -> bool:
        day_matches = candidate.day in self.days
        cron_weekday = (candidate.weekday() + 1) % 7
        weekday_matches = cron_weekday in self.weekdays
        if self.day_wildcard and self.weekday_wildcard:
            return True
        if self.day_wildcard:
            return weekday_matches
        if self.weekday_wildcard:
            return day_matches
        return day_matches or weekday_matches


class AgentScheduleStore:
    def __init__(self, db: Database):
        self.db = db
        self._init_schema()

    def _init_schema(self) -> None:
        with self.db.transaction() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS agent_schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    schedule_json TEXT NOT NULL,
                    timezone TEXT NOT NULL DEFAULT 'UTC',
                    delivery TEXT NOT NULL DEFAULT 'chat'
                        CHECK(delivery IN ('chat', 'chat_and_telegram')),
                    state TEXT NOT NULL DEFAULT 'active'
                        CHECK(state IN ('active', 'paused', 'completed')),
                    enabled INTEGER NOT NULL DEFAULT 1,
                    next_run_at INTEGER,
                    last_run_id INTEGER,
                    revision INTEGER NOT NULL DEFAULT 1,
                    retry_after INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    deleted_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
                    ON agent_schedules(enabled, next_run_at, id);
                CREATE INDEX IF NOT EXISTS idx_agent_schedules_owner
                    ON agent_schedules(owner_user_id, deleted_at, id);

                CREATE TABLE IF NOT EXISTS agent_schedule_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    schedule_id INTEGER NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
                    schedule_revision INTEGER NOT NULL DEFAULT 1,
                    occurrence_key TEXT,
                    scheduled_for INTEGER NOT NULL,
                    trigger TEXT NOT NULL DEFAULT 'scheduled'
                        CHECK(trigger IN ('scheduled', 'manual')),
                    status TEXT NOT NULL DEFAULT 'queued'
                        CHECK(status IN ('queued', 'running', 'succeeded', 'failed',
                                         'needs_review', 'blocked', 'skipped', 'cancelled')),
                    durable_job_id INTEGER REFERENCES durable_jobs(id),
                    source_message_id INTEGER REFERENCES messages(id),
                    response_message_id INTEGER REFERENCES messages(id),
                    started_at INTEGER,
                    finished_at INTEGER,
                    error TEXT NOT NULL DEFAULT '',
                    delivery_warning TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    UNIQUE(schedule_id, schedule_revision, occurrence_key)
                );
                CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_schedule
                    ON agent_schedule_runs(schedule_id, id DESC);
                CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_job
                    ON agent_schedule_runs(durable_job_id);
                """
            )

    def get(self, owner_user_id: int, schedule_id: int) -> dict[str, Any] | None:
        return self.db.query_one(
            """
            SELECT * FROM agent_schedules
            WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL
            """,
            (int(schedule_id), int(owner_user_id)),
        )

    def get_any(self, schedule_id: int) -> dict[str, Any] | None:
        return self.db.query_one(
            "SELECT * FROM agent_schedules WHERE id = ? AND deleted_at IS NULL",
            (int(schedule_id),),
        )

    def list(self, owner_user_id: int) -> list[dict[str, Any]]:
        return self.db.query(
            """
            SELECT * FROM agent_schedules
            WHERE owner_user_id = ? AND deleted_at IS NULL
            ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                     COALESCE(next_run_at, 9223372036854775807), id DESC
            """,
            (int(owner_user_id),),
        )

    def create(
        self,
        *,
        owner_user_id: int,
        name: str,
        prompt: str,
        schedule: dict[str, Any],
        timezone_name: str,
        delivery: str,
        next_run_at: int,
    ) -> dict[str, Any]:
        ts = now_ts()
        with self.db.transaction() as conn:
            conn.execute("BEGIN IMMEDIATE")
            count = conn.execute(
                "SELECT COUNT(*) FROM agent_schedules WHERE owner_user_id = ? AND deleted_at IS NULL",
                (int(owner_user_id),),
            ).fetchone()[0]
            if int(count) >= MAX_SCHEDULES_PER_USER:
                raise ValueError(f"a user may have at most {MAX_SCHEDULES_PER_USER} schedules")
            cursor = conn.execute(
                """
                INSERT INTO agent_schedules(
                    owner_user_id, name, prompt, schedule_json, timezone, delivery,
                    state, enabled, next_run_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
                """,
                (
                    int(owner_user_id),
                    name,
                    prompt,
                    json.dumps(schedule, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
                    timezone_name,
                    delivery,
                    int(next_run_at),
                    ts,
                    ts,
                ),
            )
            row = conn.execute("SELECT * FROM agent_schedules WHERE id = ?", (cursor.lastrowid,)).fetchone()
        if row is None:
            raise RuntimeError("schedule insert did not produce a row")
        return dict(row)

    def update(
        self,
        *,
        owner_user_id: int,
        schedule_id: int,
        fields: dict[str, Any],
        expected_revision: int | None = None,
    ) -> dict[str, Any] | None:
        if not fields:
            return self.get(owner_user_id, schedule_id)
        assignments = ", ".join(f"{key} = ?" for key in fields)
        ts = now_ts()
        revision_clause = " AND revision = ?" if expected_revision is not None else ""
        params: list[Any] = [*fields.values(), ts, int(schedule_id), int(owner_user_id)]
        if expected_revision is not None:
            params.append(int(expected_revision))
        cursor = self.db.execute(
            f"""
            UPDATE agent_schedules SET {assignments}, updated_at = ?
            WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL
              {revision_clause}
            """,
            params,
        )
        if not cursor.rowcount:
            return None
        return self.db.query_one(
            "SELECT * FROM agent_schedules WHERE id = ? AND owner_user_id = ?",
            (int(schedule_id), int(owner_user_id)),
        )

    def due(self, timestamp: int, *, limit: int = 100) -> list[dict[str, Any]]:
        return self.db.query(
            """
            SELECT * FROM agent_schedules
            WHERE deleted_at IS NULL AND enabled = 1 AND state = 'active'
              AND next_run_at IS NOT NULL AND next_run_at <= ? AND retry_after <= ?
            ORDER BY next_run_at, id LIMIT ?
            """,
            (int(timestamp), int(timestamp), max(1, min(int(limit), 500))),
        )

    def next_due_at(self) -> int | None:
        value = self.db.scalar(
            """
            SELECT MIN(CASE WHEN retry_after > next_run_at THEN retry_after ELSE next_run_at END)
            FROM agent_schedules
            WHERE deleted_at IS NULL AND enabled = 1 AND state = 'active'
              AND next_run_at IS NOT NULL
            """
        )
        return int(value) if value is not None else None

    def runs(
        self,
        owner_user_id: int,
        schedule_id: int,
        *,
        limit: int,
        before_id: int | None = None,
    ) -> list[dict[str, Any]]:
        params: list[Any] = [int(schedule_id), int(owner_user_id)]
        before = ""
        if before_id is not None:
            before = " AND r.id < ?"
            params.append(int(before_id))
        params.append(max(1, min(int(limit), 101)))
        return self.db.query(
            f"""
            SELECT r.* FROM agent_schedule_runs r
            JOIN agent_schedules s ON s.id = r.schedule_id
            WHERE r.schedule_id = ? AND s.owner_user_id = ? AND s.deleted_at IS NULL
            {before}
            ORDER BY r.id DESC LIMIT ?
            """,
            params,
        )

    def get_run(self, run_id: int) -> dict[str, Any] | None:
        return self.db.query_one(
            "SELECT * FROM agent_schedule_runs WHERE id = ?",
            (int(run_id),),
        )

    def latest_run(self, schedule_id: int) -> dict[str, Any] | None:
        return self.db.query_one(
            "SELECT * FROM agent_schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1",
            (int(schedule_id),),
        )

    def missing_job_runs(self) -> list[dict[str, Any]]:
        return self.db.query(
            """
            SELECT r.*, s.owner_user_id, s.name, s.prompt, s.timezone, s.delivery,
                   s.schedule_json
            FROM agent_schedule_runs r
            JOIN agent_schedules s ON s.id = r.schedule_id
            WHERE r.status = 'queued' AND r.source_message_id IS NOT NULL
              AND r.durable_job_id IS NULL
            ORDER BY r.id
            """
        )

    def update_run_status(
        self,
        run_id: int,
        status: str,
        *,
        response_message_id: int | None = None,
        error: str = "",
        delivery_warning: str | None = None,
    ) -> bool:
        if status not in RUN_STATUSES:
            raise ValueError("invalid schedule run status")
        ts = now_ts()
        assignments = ["status = ?", "updated_at = ?"]
        params: list[Any] = [status, ts]
        if status == "running":
            assignments.append("started_at = COALESCE(started_at, ?)")
            params.append(ts)
        if status in {"succeeded", "failed", "needs_review", "blocked", "skipped", "cancelled"}:
            assignments.append("finished_at = ?")
            params.append(ts)
        if response_message_id is not None:
            assignments.append("response_message_id = ?")
            params.append(int(response_message_id))
        if error:
            assignments.append("error = ?")
            params.append(str(error)[:2000])
        if delivery_warning is not None:
            assignments.append("delivery_warning = ?")
            params.append(str(delivery_warning)[:1000])
        params.append(int(run_id))
        allowed_from = ("queued",) if status == "running" else ("queued", "running")
        placeholders = ",".join("?" for _ in allowed_from)
        params.extend(allowed_from)
        cursor = self.db.execute(
            f"""
            UPDATE agent_schedule_runs SET {', '.join(assignments)}
            WHERE id = ? AND status IN ({placeholders})
            """,
            params,
        )
        return cursor.rowcount > 0

    def record_dispatch_error(
        self,
        schedule_id: int,
        error: str,
        *,
        retry_at: int,
        expected_revision: int,
    ) -> None:
        self.db.execute(
            """
            UPDATE agent_schedules
            SET last_error = ?, retry_after = ?, updated_at = ?
            WHERE id = ? AND deleted_at IS NULL AND state = 'active' AND revision = ?
            """,
            (
                str(error)[:2000],
                int(retry_at),
                now_ts(),
                int(schedule_id),
                int(expected_revision),
            ),
        )

    @staticmethod
    def decoded_schedule(row: dict[str, Any]) -> dict[str, Any]:
        try:
            value = json.loads(str(row.get("schedule_json") or "{}"))
        except json.JSONDecodeError:
            value = {}
        return value if isinstance(value, dict) else {}
