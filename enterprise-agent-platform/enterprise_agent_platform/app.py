"""HTTP composition and lifecycle for the Pi-native platform."""
import asyncio
from contextlib import AsyncExitStack, asynccontextmanager, suppress
import json
import logging
import mimetypes
from pathlib import Path
import re
import secrets
import time

import httpx
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Route

from .config import Settings
from .db import Database
from . import auth, admin, oauth, queue, gates, tools, files, schedules, tasks

log = logging.getLogger(__name__)


class Platform:
    def __init__(self, settings):
        self.settings = settings
        self.db = Database(settings.database_path)
        self.http = httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False)
        self.gate = gates.Gate(self)
        self.oauth = oauth.OAuth(self)
        self.browser = tools.Browser(self)
        self.files = files.Files(self)
        self.queue = queue.Queue(self)
        self.tasks = tasks.Tasks(self)

    async def scheduler(self):
        while True:
            await asyncio.sleep(1)
            if not self.gate.reserved and not self.gate.closing:
                try:
                    await schedules.tick(self)
                except Exception:
                    log.exception('Schedule tick failed')


async def health(request):
    return JSONResponse({'status': 'ok', 'service': 'agent-platform'})


async def bootstrap(request):
    user = auth.current_user(request)
    p = request.app.state.platform
    with p.db.connect() as conn:
        branding = admin.branding(p.db)
        allowed = auth.permissions(p.db, user)
        channels = [dict(r) for r in conn.execute('SELECT id,name,description,archived FROM channels WHERE archived=0 ORDER BY id')] if 'read_workspace' in allowed or user['role'] == 'admin' else []
    return JSONResponse({'user': user, 'branding': branding, 'permissions': allowed, 'channels': channels})


async def channels(request):
    p = request.app.state.platform
    user = auth.require_permission(request, 'read_workspace' if request.method == 'GET' else 'manage_channels')
    with p.db.connect() as conn:
        if request.method == 'GET':
            return JSONResponse({'channels': [dict(r) for r in conn.execute('SELECT id,name,description,archived FROM channels WHERE archived=0 ORDER BY id')]})
        data = await auth.body_json(request)
        name = str(data.get('name', '')).strip()
        if not name or len(name) > 120:
            raise HTTPException(400, 'Channel name is required (maximum 120 characters)')
        if conn.execute('SELECT 1 FROM channels WHERE name=?', (name,)).fetchone():
            raise HTTPException(409, 'Channel name already exists')
        cursor = conn.execute('INSERT INTO channels(name,description,created_by,created_at,archived) VALUES(?,?,?,?,0)', (name, str(data.get('description', '')), user['id'], int(time.time())))
        row = conn.execute('SELECT id,name,description,archived FROM channels WHERE id=?', (cursor.lastrowid,)).fetchone()
    return JSONResponse({'channel': dict(row)}, status_code=201)


async def channel(request):
    auth.require_permission(request, 'manage_channels')
    p = request.app.state.platform
    with p.db.connect() as conn:
        row = conn.execute('SELECT id,name,description,archived FROM channels WHERE id=?', (request.path_params['id'],)).fetchone()
        if not row:
            raise HTTPException(404, 'Channel not found')
        if request.method == 'DELETE':
            conn.execute('UPDATE channels SET archived=1 WHERE id=?', (row['id'],))
            return JSONResponse({'ok': True})
        data = await auth.body_json(request)
        name = str(data.get('name', row['name'])).strip()
        if not name or len(name) > 120:
            raise HTTPException(400, 'Invalid channel name')
        if conn.execute('SELECT 1 FROM channels WHERE name=? AND id<>?', (name, row['id'])).fetchone():
            raise HTTPException(409, 'Channel name already exists')
        conn.execute('UPDATE channels SET name=?,description=? WHERE id=?', (name, str(data.get('description', row['description'])), row['id']))
        result = dict(conn.execute('SELECT id,name,description,archived FROM channels WHERE id=?', (row['id'],)).fetchone())
    return JSONResponse({'channel': result})


async def static(request):
    root = request.app.state.platform.settings.frontend_dir.resolve()
    requested = request.path_params.get('path', '')
    if requested.startswith(('api/', 'internal/')):
        raise HTTPException(404, 'Not found')
    target = (root / requested).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(404, 'Not found')
    if not target.is_file():
        if Path(requested).suffix:
            raise HTTPException(404, 'Not found')
        target = root / 'index.html'
    if not target.is_file():
        raise HTTPException(404, 'Frontend is not built')
    media = mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
    hashed = re.search(r'[-.][A-Za-z0-9_-]{8,}\.', target.name) is not None
    headers = {'Cache-Control': 'public, max-age=31536000, immutable' if hashed else 'no-cache', 'Vary': 'Accept-Encoding'}
    accepted = {}
    for entry in request.headers.get('accept-encoding', '').split(','):
        name, *parameters = entry.strip().split(';')
        quality = 1.0
        for parameter in parameters:
            if parameter.strip().startswith('q='):
                try:
                    quality = float(parameter.strip()[2:])
                except ValueError:
                    quality = 0
        accepted[name] = quality
    for encoding, suffix in [('br', '.br'), ('gzip', '.gz')]:
        if accepted.get(encoding, accepted.get('*', 0)) > 0 and Path(str(target) + suffix).is_file():
            target = Path(str(target) + suffix)
            headers['Content-Encoding'] = encoding
            break
    return FileResponse(target, media_type=media, headers=headers)


class BoundaryMiddleware:
    def __init__(self, app, platform):
        self.app, self.platform = app, platform

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        bypass = scope['path'].startswith('/internal/manager/') or scope['path'] == '/healthz'
        async with AsyncExitStack() as admission:
            if not bypass:
                try:
                    await admission.enter_async_context(self.platform.gate.admit())
                except HTTPException as exc:
                    return await JSONResponse({'error': exc.detail}, exc.status_code)(scope, receive, send)
            async def secured_send(message):
                if message['type'] == 'http.response.start':
                    # Handlers have finished mutations. Do not keep a read-only SSE
                    # connection or a slow file download blocking an update forever.
                    await admission.aclose()
                    message['headers'] += [(b'x-content-type-options', b'nosniff'), (b'x-frame-options', b'SAMEORIGIN'), (b'referrer-policy', b'same-origin')]
                await send(message)
            await self.app(scope, receive, secured_send)


def create_app(settings=None):
    platform = Platform(settings or Settings.from_env())

    @asynccontextmanager
    async def lifespan(app):
        scheduler = None
        try:
            platform.db.migrate(platform.settings.data_dir)
            with platform.db.connect() as conn:
                empty = not conn.execute('SELECT 1 FROM users LIMIT 1').fetchone()
            if empty:
                password = secrets.token_urlsafe(24)
                admin.create_user(platform.db, 'admin', password, role='admin')
                path = platform.settings.data_dir / 'bootstrap-admin-password.txt'
                path.write_text(password + '\n')
                path.chmod(0o600)
            if platform.settings.deployment_mode == 'container' or Path(platform.settings.manager_socket).exists():
                await platform.gate.restore()
            await platform.queue.start()
            await platform.tasks.start()
            scheduler = asyncio.create_task(platform.scheduler())
            yield
        finally:
            platform.gate.closing = True
            if scheduler is not None:
                scheduler.cancel()
                with suppress(asyncio.CancelledError):
                    await scheduler
            await platform.tasks.stop()
            await platform.queue.stop()
            await platform.http.aclose()

    async def error(request, exc):
        return JSONResponse({'error': exc.detail}, status_code=exc.status_code)

    async def malformed(request, exc):
        return JSONResponse({'error': 'Invalid JSON request'}, status_code=400)

    route_list = [Route('/healthz', health), Route('/api/bootstrap', bootstrap), Route('/api/channels', channels, methods=['GET', 'POST']), Route('/api/channels/{id:int}', channel, methods=['PATCH', 'DELETE'])]
    for module in (auth, admin, oauth, queue, gates, tools, files, tasks):
        route_list.extend(module.routes())
    route_list.append(Route('/{path:path}', static))
    app = Starlette(routes=route_list, lifespan=lifespan, exception_handlers={HTTPException: error, json.JSONDecodeError: malformed})
    app.state.platform = platform
    app.add_middleware(BoundaryMiddleware, platform=platform)
    return app
