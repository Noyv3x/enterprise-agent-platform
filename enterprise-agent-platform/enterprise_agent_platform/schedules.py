"""Private-agent schedules; each occurrence is submitted once to the durable queue."""
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from starlette.exceptions import HTTPException


def now():
    return int(time.time())


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None


def run_view(row):
    value = dict(row)
    for key in ('scheduled_for', 'started_at', 'finished_at', 'created_at', 'updated_at'):
        value[key] = iso(value[key])
    return value


def next_time(spec, zone, base=None):
    base = base or datetime.now(timezone.utc)
    try:
        tz = ZoneInfo(zone)
        kind = spec['type']
        if kind == 'once':
            value = datetime.fromisoformat(spec['at'].replace('Z', '+00:00'))
            if value.tzinfo is None:
                raise ValueError('Timestamp requires timezone')
            return int(value.timestamp())
        if kind == 'interval':
            seconds = spec['every_seconds']
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or seconds < 1:
                raise ValueError('Interval must be positive')
            return int((base + timedelta(seconds=seconds)).timestamp())
        if kind == 'cron':
            return int(croniter(spec['expression'], base.astimezone(tz)).get_next(datetime).timestamp())
    except (KeyError, TypeError, ValueError, OverflowError, ZoneInfoNotFoundError) as exc:
        raise HTTPException(400, 'Invalid schedule or timezone') from exc
    raise HTTPException(400, 'Unknown schedule type')


def project(conn, row):
    last = conn.execute('SELECT * FROM agent_schedule_runs WHERE id=?', (row['last_run_id'],)).fetchone()
    return {'id': row['id'], 'name': row['name'], 'prompt': row['prompt'], 'schedule': json.loads(row['schedule_json']),
            'timezone': row['timezone'], 'delivery': 'chat', 'state': row['state'], 'enabled': bool(row['enabled']),
            'next_run_at': iso(row['next_run_at']), 'last_run': run_view(last) if last else None,
            'created_at': iso(row['created_at']), 'updated_at': iso(row['updated_at'])}


def owned(conn, ident, user):
    row = conn.execute('SELECT * FROM agent_schedules WHERE id=? AND owner_user_id=? AND deleted_at IS NULL', (ident, user['id'])).fetchone()
    if not row:
        raise HTTPException(404, 'Schedule not found')
    return row


async def occurrence(p, row, user, scheduled_for, manual=False):
    timestamp = now()
    with p.db.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        current = owned(conn, row['id'], user)
        if not manual and (not current['enabled'] or current['next_run_at'] != scheduled_for):
            return
        key = uuid.uuid4().hex if manual else scheduled_for
        cursor = conn.execute('INSERT OR IGNORE INTO agent_schedule_runs(schedule_id,schedule_revision,occurrence_key,scheduled_for,trigger,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
                              (row['id'], current['revision'], key, scheduled_for, 'manual' if manual else 'scheduled', 'queued', timestamp, timestamp))
        if not cursor.rowcount:
            return
        run_id = cursor.lastrowid
        spec = json.loads(current['schedule_json'])
        following = current['next_run_at'] if manual else (None if spec['type'] == 'once' else next_time(spec, current['timezone']))
        enabled = current['enabled'] if manual else int(following is not None)
        conn.execute('UPDATE agent_schedules SET next_run_at=?,enabled=?,state=?,last_run_id=?,updated_at=? WHERE id=?',
                     (following, enabled, 'active' if enabled else 'completed', run_id, timestamp, row['id']))
    try:
        await p.queue.enqueue(user, 'private', row['prompt'], schedule_run_id=run_id)
    except Exception as exc:
        with p.db.connect() as conn:
            conn.execute("UPDATE agent_schedule_runs SET status='failed',error=?,finished_at=?,updated_at=? WHERE id=?", (str(exc)[:1000], now(), now(), run_id))
        raise


async def dispatch(platform, action, args, user):
    ident = args.get('schedule_id')
    if action == 'run_now':
        with platform.db.connect() as conn:
            row = owned(conn, ident, user)
        await occurrence(platform, row, user, now(), manual=True)
        action = 'get'
    with platform.db.connect() as conn:
        if action == 'list':
            return {'schedules': [project(conn, row) for row in conn.execute('SELECT * FROM agent_schedules WHERE owner_user_id=? AND deleted_at IS NULL ORDER BY id', (user['id'],)).fetchall()]}
        if action == 'create':
            name, prompt = args.get('name', ''), args.get('prompt', '')
            if not isinstance(name, str) or not name.strip() or not isinstance(prompt, str) or not prompt.strip():
                raise HTTPException(400, 'Schedule name and prompt are required')
            spec, zone = args.get('schedule', {}), args.get('timezone') or user.get('timezone') or 'UTC'
            due, timestamp = next_time(spec, zone), now()
            cursor = conn.execute("INSERT INTO agent_schedules(owner_user_id,name,prompt,schedule_json,timezone,delivery,state,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,'chat','active',1,?,?,?)", (user['id'], name, prompt, json.dumps(spec), zone, due, timestamp, timestamp))
            ident = cursor.lastrowid
        row = owned(conn, ident, user)
        if action == 'history':
            return {'runs': [run_view(run) for run in conn.execute('SELECT * FROM agent_schedule_runs WHERE schedule_id=? ORDER BY id DESC LIMIT 100', (ident,))]}
        if action == 'delete':
            conn.execute("UPDATE agent_schedules SET deleted_at=?,enabled=0,state='paused',updated_at=? WHERE id=?", (now(), now(), ident))
            return {'ok': True}
        if action in {'pause', 'resume'}:
            enabled = action == 'resume'
            due = next_time(json.loads(row['schedule_json']), row['timezone']) if enabled else row['next_run_at']
            conn.execute('UPDATE agent_schedules SET enabled=?,state=?,next_run_at=?,updated_at=? WHERE id=?', (int(enabled), 'active' if enabled else 'paused', due, now(), ident))
        elif action == 'update':
            name, prompt = args.get('name', row['name']), args.get('prompt', row['prompt'])
            if not isinstance(name, str) or not name.strip() or not isinstance(prompt, str) or not prompt.strip():
                raise HTTPException(400, 'Schedule name and prompt are required')
            spec, zone = args.get('schedule', json.loads(row['schedule_json'])), args.get('timezone', row['timezone'])
            due = next_time(spec, zone)
            conn.execute('UPDATE agent_schedules SET name=?,prompt=?,schedule_json=?,timezone=?,next_run_at=?,revision=revision+1,updated_at=? WHERE id=?', (name, prompt, json.dumps(spec), zone, due, now(), ident))
        elif action not in {'create', 'get'}:
            raise HTTPException(400, 'Unsupported schedule action')
        return {'schedule': project(conn, owned(conn, ident, user))}


async def tick(platform):
    if platform.gate.reserved:
        return
    # A process may stop after claiming an occurrence but before creating its job.
    # Queue.enqueue deduplicates by this run's durable_job_id in its transaction.
    with platform.db.connect() as conn:
        pending = conn.execute("SELECT r.id AS pending_run_id,s.* FROM agent_schedule_runs r JOIN agent_schedules s ON s.id=r.schedule_id WHERE r.status='queued' AND r.durable_job_id IS NULL ORDER BY r.id").fetchall()
    for row in pending:
        with platform.db.connect() as conn:
            owner = conn.execute('SELECT * FROM users WHERE id=? AND active=1', (row['owner_user_id'],)).fetchone()
            if not owner or row['deleted_at'] is not None:
                conn.execute("UPDATE agent_schedule_runs SET status='skipped',finished_at=?,updated_at=?,error='Schedule or owner is no longer active' WHERE id=?", (now(), now(), row['pending_run_id']))
                continue
        await platform.queue.enqueue(dict(owner), 'private', row['prompt'], schedule_run_id=row['pending_run_id'])
    with platform.db.connect() as conn:
        rows = conn.execute('SELECT s.* FROM agent_schedules s JOIN users u ON u.id=s.owner_user_id WHERE s.enabled=1 AND s.deleted_at IS NULL AND s.next_run_at<=? AND u.active=1 ORDER BY s.next_run_at,s.id', (now(),)).fetchall()
    for row in rows:
        with platform.db.connect() as conn:
            user = dict(conn.execute('SELECT * FROM users WHERE id=?', (row['owner_user_id'],)).fetchone())
        await occurrence(platform, row, user, row['next_run_at'])
