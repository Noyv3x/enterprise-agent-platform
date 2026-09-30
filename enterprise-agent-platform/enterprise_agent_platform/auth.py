"""Signed sessions and live database-backed authorization."""
import base64
import hashlib
import hmac
import json
import secrets
import time
from collections import OrderedDict, deque
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route


PERMISSIONS = ['read_workspace', 'chat', 'private_agent', 'manage_channels', 'manage_users', 'system_settings']
DEFAULT_GROUPS = {'admin': PERMISSIONS, 'manager': PERMISSIONS[:4], 'member': PERMISSIONS[:3], 'viewer': PERMISSIONS[:1]}
USER_FIELDS = 'id username display_name role position permission_group model_name thinking_depth timezone active'.split()
TTL = 7 * 86400
COOKIE_NAME = 'agent_platform_session'
LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60
MAX_LOGIN_FAILURES = 8
MAX_LOGIN_FAILURES_PER_USER = 50
MAX_LOGIN_FAILURES_PER_CLIENT = 100
MAX_LOGIN_FAILURE_KEYS = 10_000


class LoginAttempts:
    """Bounded sliding failure windows; login runs synchronously after body parsing."""

    def __init__(self):
        self.pairs = OrderedDict()
        self.users = OrderedDict()
        self.clients = OrderedDict()

    def bucket(self, store, key, now):
        failures = store.get(key)
        if failures is None:
            return ()
        while failures and failures[0] < now - LOGIN_FAILURE_WINDOW_SECONDS:
            failures.popleft()
        if not failures:
            del store[key]
        return failures

    def check(self, username, client, now):
        if (len(self.bucket(self.pairs, (username, client), now)) >= MAX_LOGIN_FAILURES
                or len(self.bucket(self.clients, client, now)) >= MAX_LOGIN_FAILURES_PER_CLIENT):
            raise HTTPException(429, 'Too many login attempts')

    def fail(self, username, client, now):
        for store, key, limit in (
            (self.pairs, (username, client), MAX_LOGIN_FAILURES),
            (self.users, username, MAX_LOGIN_FAILURES_PER_USER),
            (self.clients, client, MAX_LOGIN_FAILURES_PER_CLIENT),
        ):
            self.bucket(store, key, now)
            if key not in store:
                if len(store) >= MAX_LOGIN_FAILURE_KEYS:
                    store.popitem(last=False)
                store[key] = deque(maxlen=limit)
            store[key].append(now)
            store.move_to_end(key)
        # The account-wide ceiling does not lock out a correct password from
        # another client, matching the installed authentication contract.
        if (len(self.users[username]) >= MAX_LOGIN_FAILURES_PER_USER
                or len(self.clients[client]) >= MAX_LOGIN_FAILURES_PER_CLIENT):
            raise HTTPException(429, 'Too many login attempts')

    def clear(self, username, client):
        self.pairs.pop((username, client), None)
        self.users.pop(username, None)


def b64(data):
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


def unb64(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def hash_password(password):
    if not isinstance(password, str) or not password or len(password) > 4096:
        raise HTTPException(400, 'Password must contain 1–4096 characters')
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 260000)
    return f'pbkdf2_sha256$260000${b64(salt)}${b64(digest)}'


def verify_password(password, encoded):
    try:
        scheme, rounds, salt, digest = encoded.split('$')
        if scheme != 'pbkdf2_sha256' or not 1 <= int(rounds) <= 2000000 or len(password) > 4096:
            return False
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), unb64(salt), int(rounds))
        return hmac.compare_digest(actual, unb64(digest))
    except (ValueError, TypeError, AttributeError):
        return False


def public_user(row):
    user = {key: row[key] for key in USER_FIELDS}
    user['active'] = bool(user['active'])
    if user['thinking_depth'] == 'none':
        user['thinking_depth'] = 'off'
    return user


def groups(db):
    with db.connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key='permission_groups_v1'").fetchone()
    return json.loads(row['value']) if row else [{'name': name, 'permissions': list(perms)} for name, perms in DEFAULT_GROUPS.items()]


def permissions(db, user):
    if user['role'] == 'admin':
        return list(PERMISSIONS)
    return next((list(group['permissions']) for group in groups(db) if group['name'] == user['permission_group']), [])


def origin_of(value):
    """Canonical scheme://host[:port] with default ports dropped, or None."""
    try:
        parts = urlsplit(value.strip())
        host, port = parts.hostname, parts.port
    except (AttributeError, ValueError):
        return None
    if parts.scheme not in ('http', 'https') or not host:
        return None
    host = f'[{host}]' if ':' in host else host
    return f"{parts.scheme}://{host}" if port in (None, 443 if parts.scheme == 'https' else 80) else f"{parts.scheme}://{host}:{port}"


def forwarded(request, name):
    """First value of a forwarding header, only behind the trusted Manager gateway."""
    if not request.app.state.platform.settings.trusted_proxy:
        return ''
    return request.headers.get(name, '').split(',', 1)[0].strip()


def client_address(request):
    return forwarded(request, 'x-forwarded-for') or (request.client.host if request.client else '')


def same_origin(request):
    settings = request.app.state.platform.settings
    scheme = forwarded(request, 'x-forwarded-proto').lower()
    if scheme not in ('http', 'https'):
        scheme = urlsplit(settings.public_base_url).scheme
    host = forwarded(request, 'x-forwarded-host') or request.headers.get('host', '')
    allowed = {origin_of(settings.public_base_url), origin_of(f'{scheme}://{host}') if host else None} - {None}
    origin = request.headers.get('origin')
    if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and origin_of(origin) not in allowed):
        raise HTTPException(403, 'Cross-origin mutation rejected')


def issue_session(settings, row):
    payload = b64(json.dumps({'uid': row['id'], 'ver': row['token_version'], 'exp': int(time.time()) + TTL, 'nonce': secrets.token_urlsafe(16)}, separators=(',', ':')).encode())
    signature = b64(hmac.new(settings.session_secret.encode(), payload.encode(), hashlib.sha256).digest())
    return payload + '.' + signature


def session_payload(request):
    try:
        body, signature = request.cookies.get(COOKIE_NAME, '').split('.')
        expected = b64(hmac.new(request.app.state.platform.settings.session_secret.encode(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(expected, signature):
            raise ValueError()
        payload = json.loads(unb64(body))
        if payload['exp'] <= time.time() or not isinstance(payload['nonce'], str):
            raise ValueError()
        return payload
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise HTTPException(401, 'Authentication required') from None


def current_user(request, admin=False):
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        same_origin(request)
    payload = session_payload(request)
    with request.app.state.platform.db.connect() as conn:
        row = conn.execute('SELECT * FROM users WHERE id=?', (payload['uid'],)).fetchone()
    if row is None or not row['active'] or row['token_version'] != payload.get('ver', 1):
        raise HTTPException(401, 'Session revoked')
    if admin and row['role'] != 'admin':
        raise HTTPException(403, 'Administrator required')
    return public_user(row)


def session_identity(request):
    current_user(request)
    return session_payload(request)['nonce']


def require_permission(request, name):
    user = current_user(request)
    if name not in permissions(request.app.state.platform.db, user):
        raise HTTPException(403, 'Permission denied')
    return user


def require_internal(request):
    token = request.app.state.platform.settings.agent_tool_token
    if not token or not hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + token):
        raise HTTPException(401, 'Invalid internal credential')


async def body_json(request):
    try:
        body = await request.json()
    except (ValueError, UnicodeError):
        raise HTTPException(400, 'Invalid JSON') from None
    if not isinstance(body, dict):
        raise HTTPException(400, 'Expected JSON object')
    return body


async def login(request):
    same_origin(request)
    body = await body_json(request)
    p = request.app.state.platform
    username = body.get('username', '')
    username = username.strip().lower()[:80] if isinstance(username, str) else ''
    client = client_address(request)
    if not hasattr(p, 'login_attempts'):
        p.login_attempts = LoginAttempts()
    attempts = p.login_attempts
    now = time.monotonic()
    attempts.check(username, client, now)
    with p.db.connect() as conn:
        row = conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        if row is None or not row['active'] or not verify_password(body.get('password', ''), row['password_hash']):
            attempts.fail(username, client, now)
            raise HTTPException(401, 'Invalid username or password')
        conn.execute('UPDATE users SET last_login_at=? WHERE id=?', (int(time.time()), row['id']))
    attempts.clear(username, client)
    response = JSONResponse({'user': public_user(row)})
    response.set_cookie(COOKIE_NAME, issue_session(p.settings, row), max_age=TTL, httponly=True, secure=p.settings.public_base_url.startswith('https://'), samesite='lax')
    return response


async def logout(request):
    user = current_user(request)
    with request.app.state.platform.db.connect() as conn:
        conn.execute('UPDATE users SET token_version=token_version+1 WHERE id=?', (user['id'],))
    response = JSONResponse({'ok': True})
    response.delete_cookie(COOKIE_NAME)
    return response


async def me(request):
    user = current_user(request)
    p = request.app.state.platform
    renewed = None
    if request.method == 'PATCH':
        body = await body_json(request)
        if set(body) - {'display_name', 'timezone', 'password', 'current_password'}:
            raise HTTPException(400, 'Unknown user field')
        if 'timezone' in body:
            try:
                ZoneInfo(body['timezone'])
            except (ZoneInfoNotFoundError, ValueError, TypeError):
                raise HTTPException(400, 'Invalid timezone') from None
        if 'display_name' in body and (not isinstance(body['display_name'], str) or not 1 <= len(body['display_name']) <= 128):
            raise HTTPException(400, 'Invalid display name')
        current_password = body.pop('current_password', None)
        with p.db.connect() as conn:
            if 'password' in body:
                row = conn.execute('SELECT * FROM users WHERE id=?', (user['id'],)).fetchone()
                if not isinstance(current_password, str) or not current_password:
                    raise HTTPException(400, 'Current password required')
                if not verify_password(current_password, row['password_hash']):
                    raise HTTPException(400, 'Current password is incorrect')
                body['password_hash'] = hash_password(body.pop('password'))
            if body:
                assignments = ','.join(key + '=?' for key in body)
                if 'password_hash' in body:
                    assignments += ',token_version=token_version+1'
                conn.execute(f'UPDATE users SET {assignments} WHERE id=?', (*body.values(), user['id']))
            row = conn.execute('SELECT * FROM users WHERE id=?', (user['id'],)).fetchone()
            user = public_user(row)
            if 'password_hash' in body:
                renewed = issue_session(p.settings, row)
    response = JSONResponse({'user': user})
    if renewed:
        response.set_cookie(COOKIE_NAME, renewed, max_age=TTL, httponly=True, secure=p.settings.public_base_url.startswith('https://'), samesite='lax')
    return response


def routes():
    return [Route('/api/auth/login', login, methods=['POST']), Route('/api/auth/logout', logout, methods=['POST']), Route('/api/me', me, methods=['GET', 'PATCH'])]
