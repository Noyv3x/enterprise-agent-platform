"""Account policies, presentation settings, usage, and Manager control."""
import base64
import hashlib
import io
import json
import re
import sqlite3
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from PIL import Image
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route

from .auth import COOKIE_NAME, PERMISSIONS, TTL, admin_user, body_json, current_user, groups, hash_password, issue_session
from .gates import manager_request

THINKING = {'off', 'minimal', 'low', 'medium', 'high', 'xhigh'}


def setting(conn, key, value, secret=0):
    conn.execute('INSERT INTO settings(key,value,secret,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,secret=excluded.secret,updated_at=excluded.updated_at', (key, value, secret, int(time.time())))


def validate_user(db, fields):
    if set(fields) - {'username', 'display_name', 'role', 'position', 'permission_group', 'model_name', 'chat_model_name', 'thinking_depth', 'timezone', 'active', 'password'}:
        raise HTTPException(400, 'Unknown user field')
    for name in ('username', 'display_name', 'position', 'model_name', 'chat_model_name'):
        if name in fields and (not isinstance(fields[name], str) or len(fields[name]) > 128 or (name == 'username' and not fields[name].strip())):
            raise HTTPException(400, 'Invalid ' + name)
    if 'role' in fields and fields['role'] not in ('admin', 'user'):
        raise HTTPException(400, 'Invalid role')
    if 'permission_group' in fields and (not isinstance(fields['permission_group'], str) or fields['permission_group'] not in {g['name'] for g in groups(db)}):
        raise HTTPException(400, 'Unknown permission group')
    if 'thinking_depth' in fields and (not isinstance(fields['thinking_depth'], str) or fields['thinking_depth'] not in THINKING):
        raise HTTPException(400, 'Invalid thinking depth')
    if 'active' in fields and type(fields['active']) is not bool:
        raise HTTPException(400, 'Invalid active flag')
    if 'timezone' in fields:
        try:
            ZoneInfo(fields['timezone'])
        except (ZoneInfoNotFoundError, ValueError, TypeError):
            raise HTTPException(400, 'Invalid timezone') from None
    if 'password' in fields:
        fields['password_hash'] = hash_password(fields.pop('password'))


def create_user(db, username, password, display_name='', role='user', **fields):
    values = {'username': username, 'password': password, 'display_name': display_name or username, 'role': role, 'position': '', 'permission_group': 'admin' if role == 'admin' else 'member', 'model_name': '', 'thinking_depth': 'off', 'timezone': 'UTC', 'active': True, **fields}
    validate_user(db, values)
    values.update(token_version=1, created_at=int(time.time()))
    try:
        with db.connect() as conn:
            cursor = conn.execute(f"INSERT INTO users({','.join(values)}) VALUES({','.join('?' for _ in values)})", tuple(values.values()))
            return admin_user(conn.execute('SELECT * FROM users WHERE id=?', (cursor.lastrowid,)).fetchone())
    except sqlite3.IntegrityError:
        raise HTTPException(409, 'Username already exists') from None


async def users(request):
    current_user(request, admin=True)
    db = request.app.state.platform.db
    if request.method == 'POST':
        body = await body_json(request)
        if not {'username', 'password'} <= body.keys():
            raise HTTPException(400, 'Username and password required')
        return JSONResponse({'user': create_user(db, **body)}, status_code=201)
    with db.connect() as conn:
        rows = conn.execute('SELECT * FROM users ORDER BY id').fetchall()
    return JSONResponse({'users': [admin_user(row) for row in rows]})


async def user_update(request):
    current_user(request, admin=True)
    db = request.app.state.platform.db
    fields = {'active': False} if request.method == 'DELETE' else await body_json(request)
    validate_user(db, fields)
    with db.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT * FROM users WHERE id=?', (request.path_params['id'],)).fetchone()
        if row is None:
            raise HTTPException(404, 'User not found')
        if 'username' in fields and conn.execute('SELECT id FROM users WHERE username=? AND id<>?', (fields['username'], row['id'])).fetchone():
            raise HTTPException(409, 'Username already exists')
        if row['active'] and row['role'] == 'admin' and (fields.get('active') is False or fields.get('role', 'admin') != 'admin'):
            if conn.execute("SELECT count(*) FROM users WHERE active=1 AND role='admin'").fetchone()[0] <= 1:
                raise HTTPException(409, 'Cannot remove the last active administrator')
        if fields:
            assignments = ','.join(key + '=?' for key in fields)
            conn.execute(f'UPDATE users SET {assignments},token_version=token_version+1 WHERE id=?', (*fields.values(), row['id']))
        user = admin_user(conn.execute('SELECT * FROM users WHERE id=?', (row['id'],)).fetchone())
    return JSONResponse({'ok': True} if request.method == 'DELETE' else {'user': user})


async def impersonate(request):
    admin = current_user(request, admin=True)
    p = request.app.state.platform
    with p.db.connect() as conn:
        row = conn.execute('SELECT * FROM users WHERE id=?', (request.path_params['id'],)).fetchone()
    if row is None or not row['active']:
        raise HTTPException(404, 'User not found')
    if row['id'] == admin['id']:
        raise HTTPException(400, 'Cannot impersonate yourself')
    response = JSONResponse({'user': admin_user(row)})
    response.set_cookie(COOKIE_NAME, issue_session(p.settings, row), max_age=TTL, httponly=True, secure=p.settings.public_base_url.startswith('https://'), samesite='lax')
    return response


async def permission_groups(request):
    current_user(request, admin=True)
    db = request.app.state.platform.db
    if request.method == 'PUT':
        body = await body_json(request)
        items = body.get('groups')
        if not isinstance(items, list) or not items:
            raise HTTPException(400, 'Groups must be a nonempty list')
        names = set()
        for group in items:
            if not isinstance(group, dict) or set(group) != {'name', 'permissions'} or not isinstance(group['name'], str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', group['name']) or not isinstance(group['permissions'], list) or any(not isinstance(p, str) or p not in PERMISSIONS for p in group['permissions']) or len(group['permissions']) != len(set(group['permissions'])) or group['name'] in names:
                raise HTTPException(400, 'Invalid permission group')
            names.add(group['name'])
        with db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            used = {row[0] for row in conn.execute('SELECT DISTINCT permission_group FROM users')}
            if used - names:
                raise HTTPException(409, 'Cannot remove a group assigned to users')
            setting(conn, 'permission_groups_v1', json.dumps(items))
    return JSONResponse({'groups': groups(db)})


def branding(db):
    result = {'product_name': 'Agent Platform', 'agent_name': 'Agent', 'primary_color': '#1677ff', 'logo': None}
    with db.connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='ui_branding_v1'").fetchone()
        logo = conn.execute("SELECT value FROM settings WHERE key='ui_branding_logo_v1'").fetchone()
    if row:
        document = json.loads(row['value'])
        result.update({key: document[key] for key in result if key in document})
        if isinstance(result['logo'], dict):
            result['logo'] = f"data:{result['logo']['mime_type']};base64,{logo['value']}" if logo else None
    return result


async def brand(request):
    db = request.app.state.platform.db
    if request.url.path.startswith('/api/admin/'):
        current_user(request, admin=True)
    if request.method == 'PATCH':
        body = await body_json(request)
        if set(body) - {'product_name', 'agent_name', 'primary_color', 'logo'}:
            raise HTTPException(400, 'Unknown branding field')
        for key in ('product_name', 'agent_name'):
            if key in body and (not isinstance(body[key], str) or not 1 <= len(body[key].strip()) <= 64):
                raise HTTPException(400, 'Invalid brand name')
        if 'primary_color' in body and (not isinstance(body['primary_color'], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', body['primary_color'])):
            raise HTTPException(400, 'Invalid primary color')
        logo_metadata = None
        if body.get('logo') is not None:
            try:
                prefix, encoded = body['logo'].split(',', 1)
                if prefix not in ('data:image/png;base64', 'data:image/webp;base64') or len(encoded) > 350000:
                    raise ValueError()
                raw = base64.b64decode(encoded, validate=True)
                if len(raw) > 256 * 1024:
                    raise ValueError()
                with Image.open(io.BytesIO(raw)) as image:
                    mime = 'image/png' if image.format == 'PNG' else 'image/webp'
                    if image.format not in ('PNG', 'WEBP') or max(image.size) > 4096 or prefix != f'data:{mime};base64':
                        raise ValueError()
                    logo_metadata = {'mime_type': mime, 'sha256': hashlib.sha256(raw).hexdigest(), 'size_bytes': len(raw), 'width': image.width, 'height': image.height}
                    image.verify()
            except (ValueError, TypeError, AttributeError, OSError, Image.DecompressionBombError):
                raise HTTPException(400, 'Invalid PNG/WebP logo (maximum 256 KiB, 4096 pixels)') from None
        with db.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='ui_branding_v1'").fetchone()
            document = json.loads(row['value']) if row else {'schema_version': 1, 'revision': 0, 'product_name': 'Agent Platform', 'agent_name': 'Agent', 'primary_color': '#1677ff', 'logo': None}
            document.update({key: value for key, value in body.items() if key != 'logo'})
            if 'logo' in body:
                document['logo'] = logo_metadata
                if logo_metadata is None:
                    conn.execute("DELETE FROM settings WHERE key='ui_branding_logo_v1'")
                else:
                    setting(conn, 'ui_branding_logo_v1', encoded)
            document['revision'] = document.get('revision', 0) + 1
            setting(conn, 'ui_branding_v1', json.dumps(document))
    return JSONResponse({'branding': branding(db)})


async def usage(request):
    current_user(request, admin=True)
    totals = dict.fromkeys(('input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'total_tokens'), 0)
    events = []
    with request.app.state.platform.db.connect() as conn:
        for row in conn.execute('SELECT * FROM token_usage_events ORDER BY id DESC'):
            event = dict(row)
            raw = json.loads(event.pop('raw_usage_json') or '{}')
            event['raw_usage'] = raw
            totals['input_tokens'] += event['input_tokens']
            totals['output_tokens'] += event['output_tokens']
            totals['total_tokens'] += event['total_tokens']
            totals['cache_read_tokens'] += raw.get('cache_read', raw.get('cacheRead', 0))
            totals['cache_write_tokens'] += raw.get('cache_write', raw.get('cacheWrite', 0))
            if len(events) < 200:
                if isinstance(event['created_at'], (int, float)):
                    event['created_at'] = datetime.fromtimestamp(event['created_at'], timezone.utc).isoformat()
                events.append(event)
    denominator = totals['input_tokens'] + totals['cache_read_tokens']
    return JSONResponse({**totals, 'cache_hit_ratio': totals['cache_read_tokens'] / denominator if denominator else 0, 'events': events})


async def system(request):
    current_user(request, admin=True)
    suffix = request.url.path.rsplit('/', 1)[-1]
    if suffix == 'system':
        suffix = 'status'
    body = await body_json(request) if request.method != 'GET' else None
    result = await manager_request(request.app.state.platform, request.method, '/v1/' + suffix, body)
    return JSONResponse(result, status_code=202 if suffix == 'operations' else 200)


def routes():
    return [Route('/api/admin/users', users, methods=['GET', 'POST']), Route('/api/admin/users/{id:int}', user_update, methods=['PATCH', 'DELETE']), Route('/api/admin/users/{id:int}/impersonate', impersonate, methods=['POST']), Route('/api/admin/permission-groups', permission_groups, methods=['GET', 'PUT']), Route('/api/branding', brand), Route('/api/admin/branding', brand, methods=['GET', 'PATCH']), Route('/api/admin/usage', usage), Route('/api/admin/system', system), Route('/api/admin/system/config', system, methods=['GET', 'PATCH']), Route('/api/admin/system/check', system, methods=['POST']), Route('/api/admin/system/operations', system, methods=['POST'])]
