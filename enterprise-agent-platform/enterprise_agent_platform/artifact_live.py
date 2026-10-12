"""Live website previews: a dev server the personal AI runs as a named background service, opened in the artifact panel.

A live artifact (`artifacts.kind='live'`) has one `artifact_previews` row holding the capability `preview_id`, the service
name and the process task it is bound to. The capability is stable for the preview's lifetime: when the named service stops the
preview is `stopped` (requests get a 503 page) and the next running process of that name rebinds it, so a framework can be
restarted with the base path the preview handed out. Only an explicit stop, or deleting the artifact, revokes it.
`/artifact-live/<preview_id>/...` authenticates by the capability alone and streams to Manager's executor proxy route over the
Unix socket; Manager, not Platform, picks the destination (the owner's own sandbox IP and the port registered at start).
Nothing here follows redirects or dials a caller-supplied address.
"""
import asyncio
import ipaddress
import logging
import re
import secrets
import time
from contextlib import suppress
from urllib.parse import quote, unquote, urljoin, urlsplit

import httpx
import websockets
from starlette.exceptions import HTTPException
from starlette.responses import RedirectResponse, Response, StreamingResponse
from starlette.routing import Route, WebSocketRoute
from websockets.asyncio.client import unix_connect

from .artifacts import (HTML_INJECT_LIMIT, RENDER_CSP, RENDER_QUERY, VIEW_HEADERS, ArtifactError, inject_helper,
                        runtime_asset)
from .db import now
from .gates import ManagerClientError, _token

log = logging.getLogger(__name__)

PREVIEW_ID = re.compile(r'[A-Za-z0-9_-]{22}')
PROCESS_ID = re.compile(r'proc_[0-9a-z]{1,64}')
LIVE_HEADERS = {**VIEW_HEADERS, 'Cache-Control': 'no-store'}
REQUEST_HEADERS = ('accept', 'accept-language', 'content-type', 'content-length', 'range', 'user-agent')
RESPONSE_HEADERS = ('content-type', 'content-length', 'content-range', 'accept-ranges', 'content-language', 'content-disposition',
                    'content-encoding')
MAX_BODY = 32 * 1024 * 1024
MAX_STREAMS = 64
BUFFER_SECONDS = 10
BUFFER_BUDGET = 64 * 1024 * 1024
SOCKET_LIFETIME = 3600
SOCKET_IDLE = 600
METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
GUIDANCE = ("The base path {base} stays the same for this service as long as the preview exists, so call `preview` FIRST and then start "
            "(or restart) the named background service with it; restarting the service later keeps the same URL. The server must listen on "
            "0.0.0.0 (not 127.0.0.1) and be started with `port`. Frameworks that serve under a base path need it, and the preview needs "
            "base_aware true: Vite `vite --host 0.0.0.0 --base {base}`; Next.js `basePath: '{bare}'` in next.config.js; Astro `base: '{bare}'`; "
            "Create React App `PUBLIC_URL={bare}`. Static servers (python -m http.server, npx serve) need nothing: with base_aware false "
            "(the default) Platform strips the prefix, so use relative asset URLs.")
STOPPED_PAGE = ("<!doctype html><meta charset=utf-8><title>Preview not running</title><body style=\"font:16px system-ui;padding:2rem\">"
                "<p>The service for this preview is not running. Start it again and reload.</p>")


class NotRunning(Exception):
    """The preview is valid but its service is not running (waiting for a first start, or stopped between runs)."""


class Pump:
    """Iterates a byte source until it ends or the preview ends (`stop` set). A timed-out `next` keeps the pending read, so
    the caller may stop buffering and keep streaming from the same source."""

    def __init__(self, source, stop):
        self.iterator = source.__aiter__()
        self.stopper = asyncio.ensure_future(stop.wait())
        self.pending = None

    async def next(self, timeout=None):
        """The next chunk, or None at the end (or when stopped); `TimeoutError` after `timeout` seconds without losing the read."""
        if self.pending is None:
            self.pending = asyncio.ensure_future(self.iterator.__anext__())
        done, _ = await asyncio.wait({self.pending, self.stopper}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if not done:
            raise TimeoutError
        if self.pending not in done:
            await self.close()
            return None
        task, self.pending = self.pending, None
        try:
            return task.result()
        except StopAsyncIteration:
            return None

    async def close(self):
        self.stopper.cancel()
        if self.pending is not None:
            self.pending.cancel()
            with suppress(BaseException):
                await self.pending
            self.pending = None

    async def chunks(self):
        try:
            while (chunk := await self.next()) is not None:
                yield chunk
        finally:
            await self.close()


class Live:
    def __init__(self, platform):
        self.p = platform
        # preview_id -> callables that end each open request or WebSocket of that preview.
        self.streams = {}
        # Bytes of upstream HTML currently held in memory across all previews, against BUFFER_BUDGET.
        self.buffered = 0
        self.loop = None

    # -- state ---------------------------------------------------------------------------------

    @staticmethod
    def load(conn, where, args):
        return conn.execute('SELECT p.*,a.owner_user_id,a.title FROM artifact_previews p JOIN artifacts a ON a.id=p.artifact_id '
                            f'WHERE {where}', args).fetchone()

    def sync(self, conn, row):
        """`(state, changed, process id)`. A preview follows its service: it binds to the newest running named process of the owner
        and is `stopped` between runs; only `revoked_at` (an explicit stop) ends it for good."""
        stamp = int(time.time())
        external = None
        task_id = row['task_id']
        if row['revoked_at'] is not None:
            state = 'stopped'
        else:
            task = conn.execute('SELECT status,external_id FROM background_tasks WHERE id=?', (task_id,)).fetchone() if task_id is not None else None
            if task is not None and task['status'] == 'running':
                state, external = 'running', task['external_id']
            else:
                found = conn.execute("SELECT id,external_id FROM background_tasks WHERE user_id=? AND kind='process' AND status='running' AND name=? "
                                     'ORDER BY id DESC LIMIT 1', (row['owner_user_id'], row['service'])).fetchone()
                if found is not None:
                    state, external, task_id = 'running', found['external_id'], found['id']
                else:
                    state = 'waiting' if task_id is None else 'stopped'
        changed = state != row['state'] or task_id != row['task_id']
        if changed:
            conn.execute('UPDATE artifact_previews SET state=?,task_id=?,updated_at=? WHERE artifact_id=?', (state, task_id, stamp, row['artifact_id']))
            conn.execute('UPDATE artifacts SET updated_at=? WHERE id=?', (now(), row['artifact_id']))
        return state, changed, external

    def snapshot(self, where, args, cause='state', quiet=False):
        """`(row, state, process id)` after syncing, or None; a change is announced and a stop ends the preview's open streams."""
        with self.p.db.connect() as conn:
            row = self.load(conn, where, args)
            if row is None:
                return None
            state, changed, external = self.sync(conn, row)
            if changed:
                row = self.load(conn, where, args)
        if changed and not quiet:
            self.announce(row, state, cause)
        if state != 'running':
            self.close(row['preview_id'])
        return row, state, external

    @staticmethod
    def public(row, state):
        return {'state': state, 'base_path': f"/artifact-live/{row['preview_id']}/", 'path': row['start_path'], 'service': row['service'],
                'task_id': f"bg-{row['task_id']}" if row['task_id'] is not None else None, 'revoked': row['revoked_at'] is not None}

    def announce(self, row, state, cause='state'):
        info = self.p.queue.scope(self.p.queue.user(row['owner_user_id']), 'private', authorize=False)
        with self.p.db.connect() as conn:
            view = self.p.artifacts.view(conn, row['artifact_id'])
        self.p.queue.emit(info['scope_key'], {'type': 'artifact', 'artifact': view, 'version': 0, 'preview': self.public(row, state), 'cause': cause})

    def status(self, ident):
        got = self.snapshot('p.artifact_id=?', (ident,))
        if got is None:
            raise HTTPException(404, 'Artifact not found')
        return self.public(got[0], got[1])

    def revoke(self, ident):
        """The user's explicit stop: the capability dies now (the service keeps running)."""
        stamp = int(time.time())
        with self.p.db.connect() as conn:
            conn.execute('UPDATE artifact_previews SET revoked_at=?,state=?,updated_at=? WHERE artifact_id=? AND revoked_at IS NULL',
                         (stamp, 'stopped', stamp, ident))
            conn.execute('UPDATE artifacts SET updated_at=? WHERE id=?', (now(), ident))
        got = self.snapshot('p.artifact_id=?', (ident,))
        self.announce(got[0], got[1])
        self.close(got[0]['preview_id'])
        return self.public(got[0], got[1])

    def process_started(self, uid, name, tid):
        """Hook of `register_process`: bind this user's previews of the service the process serves."""
        if not name:
            return
        with self.p.db.connect() as conn:
            ids = [row[0] for row in conn.execute(
                'SELECT p.preview_id FROM artifact_previews p JOIN artifacts a ON a.id=p.artifact_id '
                'WHERE a.owner_user_id=? AND p.service=? AND p.revoked_at IS NULL AND (p.task_id IS NULL OR p.task_id!=?)', (uid, name, tid))]
        for preview_id in ids:
            self.snapshot('p.preview_id=?', (preview_id,))

    def task_ended(self, tid):
        """Hook of `Tasks.settle`: the previews bound to the finished task become `stopped` (and stay valid for a restart)."""
        with self.p.db.connect() as conn:
            ids = [row[0] for row in conn.execute('SELECT preview_id FROM artifact_previews WHERE task_id=? AND revoked_at IS NULL', (tid,))]
        for preview_id in ids:
            self.snapshot('p.preview_id=?', (preview_id,))

    def close(self, preview_id):
        """End every open request and WebSocket of the preview; safe to call from a worker thread."""
        for stop in list(self.streams.get(preview_id, ())):
            try:
                inside = asyncio.get_running_loop() is self.loop
            except RuntimeError:
                inside = False
            if inside or self.loop is None:
                stop()
            else:
                self.loop.call_soon_threadsafe(stop)

    # -- the artifact tool -----------------------------------------------------------------------

    @staticmethod
    def clean_path(value):
        if not isinstance(value, str) or not value.startswith('/') or len(value) > 500 or re.search(r'[\x00-\x20\x7f\\?#]', value):
            raise ArtifactError(400, 'preview_invalid', 'path must start with / and contain no spaces, ?, # or backslashes')
        if any(unquote(part) in ('.', '..') for part in value.split('/')):
            raise ArtifactError(400, 'preview_invalid', 'path must not contain . or .. segments')
        return value

    async def declared_port(self, uid, service):
        """The port Manager registered for the owner's running service, `(running, port)`; unverifiable counts as not running."""
        with self.p.db.connect() as conn:
            task = conn.execute("SELECT external_id FROM background_tasks WHERE user_id=? AND kind='process' AND status='running' AND name=? "
                                'ORDER BY id DESC LIMIT 1', (uid, service)).fetchone()
        if task is None:
            return False, None
        try:
            process = await self.p.tasks.find_process(uid, task['external_id'])
        except (ManagerClientError, httpx.HTTPError, OSError, ValueError):
            return False, None
        return process is not None, (process or {}).get('port')

    async def preview(self, user, info, args, job_id):
        if info['kind'] != 'agent' or info['channel_id'] is not None:
            raise ArtifactError(403, 'preview_unavailable', 'Live previews are available only in the personal AI')
        service = args.get('service')
        if not isinstance(service, str) or not 1 <= len(service.strip()) <= 128 or re.search(r'[\x00-\x1f\x7f]', service):
            raise ArtifactError(400, 'preview_invalid', 'service must be the name of a running named background service')
        service = service.strip()
        port = args.get('port')
        if port is not None and (not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535):
            raise ArtifactError(400, 'preview_invalid', 'port must be an integer from 1 to 65535')
        path = self.clean_path(args.get('path', '/'))
        title = args.get('title')
        if title is not None and (not isinstance(title, str) or len(title.strip()) > 200):
            raise ArtifactError(400, 'preview_invalid', 'title must be a string of at most 200 characters')
        base_aware = args.get('base_aware', False)
        if not isinstance(base_aware, bool):
            raise ArtifactError(400, 'preview_invalid', 'base_aware must be a boolean')
        running, declared = await self.declared_port(user['id'], service)
        if running and declared is None:
            raise ArtifactError(409, 'preview_no_port', f'Service {service} runs without a declared port. Restart it as a named service '
                                'with the bash `port` parameter so the preview can reach it')
        row, state = await asyncio.to_thread(self.upsert, user, service, declared or port, path, (title or '').strip(), base_aware, job_id)
        base = f"/artifact-live/{row['preview_id']}/"
        public = {**self.public(row, state), 'preview_id': row['preview_id'], 'port': row['port'], 'base_aware': bool(row['base_aware'])}
        with self.p.db.connect() as conn:
            artifact = self.p.artifacts.view(conn, row['artifact_id'])
        wait = ('' if state == 'running' else f' Service {service} is not running; the preview opens when it runs as a named background service '
                f'started with `port`, so start (or restart) it now using the base path {base}.')
        text = (f"Live preview {artifact['title']} (id {artifact['id']}, service {service}) is {state}.{wait} The user can open it in the artifact panel. "
                + GUIDANCE.format(base=base, bare=base.rstrip('/')))
        return {'content': text, 'data': {'artifact': artifact, 'preview': public}, 'is_error': False}

    def upsert(self, user, service, port, path, title, base_aware, job_id):
        stamp, iso = int(time.time()), now()
        with self.p.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute("SELECT p.* FROM artifact_previews p JOIN artifacts a ON a.id=p.artifact_id "
                               "WHERE a.scope_type='private' AND a.scope_id=? AND p.service=?", (str(user['id']), service)).fetchone()
            if row is None:
                ident = conn.execute("INSERT INTO artifacts(scope_type,scope_id,owner_user_id,path,kind,title,latest_version,created_at,updated_at) "
                                     "VALUES ('private',?,?,?,'live',?,0,?,?)", (str(user['id']), user['id'], f'live:{service}', title or service, iso, iso)).lastrowid
                conn.execute('INSERT INTO artifact_previews(artifact_id,preview_id,service,port,start_path,base_aware,created_at,updated_at) '
                             'VALUES (?,?,?,?,?,?,?,?)', (ident, secrets.token_urlsafe(16), service, port, path, int(base_aware), stamp, stamp))
            else:
                ident = row['artifact_id']
                if row['revoked_at'] is not None:
                    conn.execute("UPDATE artifact_previews SET preview_id=?,task_id=NULL,state='waiting',revoked_at=NULL WHERE artifact_id=?",
                                 (secrets.token_urlsafe(16), ident))
                conn.execute('UPDATE artifact_previews SET port=COALESCE(?,port),start_path=?,base_aware=?,updated_at=? WHERE artifact_id=?',
                             (port, path, int(base_aware), stamp, ident))
                conn.execute('UPDATE artifacts SET title=COALESCE(NULLIF(?,\'\'),title),updated_at=? WHERE id=?', (title, iso, ident))
        if job_id is not None:
            self.p.artifacts.refs.setdefault(job_id, []).append((ident, 0))
        row, state, _ = self.snapshot('p.artifact_id=?', (ident,), quiet=True)
        self.announce(row, state, 'preview')
        return row, state

    def render_target(self, row, page):
        """`(view path, page)` of a running preview for the renderer; the page defaults to the preview's start path."""
        got = self.snapshot('p.artifact_id=?', (row['id'],))
        if got is None:
            raise ArtifactError(404, 'artifact_not_found', 'No such artifact in this conversation')
        preview, state, _ = got
        if state != 'running':
            raise ArtifactError(409, 'preview_not_running', f'The live preview is {state}; start the service first')
        relative = (page if page is not None else preview['start_path']).lstrip('/')
        if re.search(r'[\x00-\x20\x7f\\?#]', relative) or any(unquote(part) in ('.', '..') for part in relative.split('/')):
            raise ArtifactError(404, 'artifact_page_not_found', f'No page {page} in this preview')
        return f"/artifact-live/{preview['preview_id']}/{quote(relative, safe='/')}", relative

    # -- proxying ----------------------------------------------------------------------------------

    def authorize(self, preview_id):
        """The preview row and Manager process id for a live capability. Unknown or revoked is 404; a valid preview whose service
        is not running raises `NotRunning` (a 503 page)."""
        if not PREVIEW_ID.fullmatch(preview_id):
            raise HTTPException(404, 'Not found')
        got = self.snapshot('p.preview_id=?', (preview_id,))
        if got is None or got[0]['revoked_at'] is not None:
            raise HTTPException(404, 'Not found')
        row, state, external = got
        if state != 'running':
            raise NotRunning
        if not external or not PROCESS_ID.fullmatch(external):
            raise HTTPException(404, 'Not found')
        return row, external

    @staticmethod
    def upstream_path(scope, row):
        """The request path Manager forwards: the prefix stripped, or kept for a base-aware app. Odd segments are 404."""
        prefix = f"/artifact-live/{row['preview_id']}"
        raw = scope.get('raw_path')
        raw = raw.decode('latin-1') if raw else quote(scope['path'], safe="/%:@!$&'()*+,;=-._~")
        rest = raw[len(prefix):] if raw.startswith(prefix) else None
        if rest is None or re.search(r'[\x00-\x20\x7f\\]', rest):
            raise HTTPException(404, 'Not found')
        for part in rest.split('/'):
            decoded = unquote(part)
            if decoded in ('.', '..') or '/' in decoded or '\\' in decoded or '\x00' in decoded:
                raise HTTPException(404, 'Not found')
        rest = rest or '/'
        return (rest if not row['base_aware'] else prefix + rest)

    @staticmethod
    def rewrite_location(value, prefix, base_aware, host, request_path='/'):
        """A redirect target that stays inside the capability prefix. Targets of this very app (path-absolute, relative, or an
        absolute URL on loopback, an IP literal or this host) are re-rooted under the prefix; anything else (another site,
        protocol-relative or backslash forms, other schemes) goes to the preview root instead of leaving Platform."""
        root = prefix + '/'
        value = ''.join(ch for ch in value.strip() if ch >= ' ' and ch != '\x7f')
        if not value or '\\' in value:
            return root
        parts = urlsplit(value)
        if parts.scheme or parts.netloc:
            name = (parts.hostname or '').lower()
            try:
                internal = ipaddress.ip_address(name) is not None
            except ValueError:
                internal = name in ('localhost', host.split(':')[0].lower() if host else '')
            if parts.scheme not in ('', 'http', 'https') or not internal:
                return root
            value = (parts.path or '/') + ('?' + parts.query if parts.query else '') + ('#' + parts.fragment if parts.fragment else '')
        elif not value.startswith('/'):
            # Relative targets resolve against the request's own path; `..` cannot climb above the app root.
            value = urljoin('http://app' + (request_path if request_path.startswith('/') else '/' + request_path), value)[len('http://app'):]
        if value.startswith('//'):
            return root
        if base_aware and (value == prefix or value.startswith(prefix + '/') or value.startswith(prefix + '?')):
            return value
        return prefix + value

    def register(self, preview_id, stop):
        self.loop = asyncio.get_running_loop()
        streams = self.streams.setdefault(preview_id, set())
        if len(streams) >= MAX_STREAMS:
            raise HTTPException(503, 'Too many open requests for this preview')
        streams.add(stop)

        def release():
            streams.discard(stop)
            if not streams and self.streams.get(preview_id) is streams:
                del self.streams[preview_id]
        return release

    def socket_options(self, owner):
        return {'Authorization': 'Bearer ' + _token(self.p, True), 'X-Owner': f'private:{owner}'}

    @staticmethod
    async def limited(request):
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_BODY:
                raise HTTPException(413, 'Request body exceeds 32 MiB')
            yield chunk

    async def forward(self, request, row, external):
        path = self.upstream_path(request.scope, row)
        # The renderer marks its own requests; the marker only tightens the CSP, so a forged one is harmless. It is not forwarded.
        pairs = [part for part in request.scope.get('query_string', b'').decode('latin-1').split('&') if part]
        renderer = f'{RENDER_QUERY}=1' in pairs
        query = '&'.join(part for part in pairs if not part.startswith(RENDER_QUERY + '='))
        headers = {**self.socket_options(row['owner_user_id']), 'Accept-Encoding': 'identity'}
        for name in REQUEST_HEADERS:
            if name in request.headers:
                headers[name] = request.headers[name]
        length = request.headers.get('content-length', '')
        content = None
        if (length.isdigit() and int(length) > 0) or 'transfer-encoding' in request.headers:
            if length.isdigit() and int(length) > MAX_BODY:
                raise HTTPException(413, 'Request body exceeds 32 MiB')
            content = self.limited(request)
        else:
            headers.pop('content-length', None)
        preview_id = row['preview_id']
        stop = asyncio.Event()
        release = self.register(preview_id, stop.set)
        # The bare transport, not a client: a client eagerly parses a redirect's Location, so a malformed one from the app would crash
        # the proxy instead of being rewritten below.
        transport = httpx.AsyncHTTPTransport(uds=str(self.p.settings.manager_socket), retries=0)
        upstream = None

        async def finish():
            if upstream is not None:
                await upstream.aclose()
            await transport.aclose()
            release()
        try:
            url = f'http://localhost/v1/executor/proxy/{external}{path}' + ('?' + query if query else '')
            outgoing = httpx.Request(request.method, url, headers=headers, content=content,
                                     extensions={'timeout': httpx.Timeout(130, connect=10).as_dict()})
            upstream = await transport.handle_async_request(outgoing)
        except (httpx.HTTPError, OSError, ManagerClientError):
            await finish()
            return Response('The preview service could not be reached', status_code=502, media_type='text/plain', headers=LIVE_HEADERS)
        except BaseException:
            await finish()
            raise
        prefix = f'/artifact-live/{preview_id}'
        out = {name: upstream.headers[name] for name in RESPONSE_HEADERS if name in upstream.headers}
        if 'location' in upstream.headers:
            out['location'] = self.rewrite_location(upstream.headers['location'], prefix, bool(row['base_aware']), request.headers.get('host', ''),
                                                    path[len(prefix):] if row['base_aware'] else path)
        out.update(LIVE_HEADERS)
        if renderer:
            out['Content-Security-Policy'] = RENDER_CSP
        asset = runtime_asset(self.p.settings)
        html = (asset is not None and request.method != 'HEAD' and upstream.status_code not in (204, 205, 304)
                and upstream.headers.get('content-type', '').split(';')[0].strip().lower() == 'text/html')
        pump = Pump(upstream.aiter_raw() if not html else upstream.aiter_bytes(), stop)

        async def streamed(first=b''):
            try:
                if first:
                    yield first
                async for chunk in pump.chunks():
                    yield chunk
            finally:
                await pump.close()
                await finish()
        try:
            if not html:
                return StreamingResponse(streamed(), status_code=upstream.status_code, headers=out)
            # HTML is buffered to inject the helper, but never for long and never beyond the global budget: past 10 s, 8 MiB per
            # page or the budget, the response streams on unmodified.
            out.pop('content-length', None)
            out.pop('content-encoding', None)
            data = bytearray()
            reserved = 0
            deadline = asyncio.get_running_loop().time() + BUFFER_SECONDS
            complete = False
            try:
                while True:
                    try:
                        chunk = await pump.next(max(0.0, deadline - asyncio.get_running_loop().time()))
                    except TimeoutError:
                        break
                    if chunk is None:
                        complete = True
                        break
                    if len(data) + len(chunk) > HTML_INJECT_LIMIT or self.buffered + len(chunk) > BUFFER_BUDGET:
                        data.extend(chunk)
                        break
                    data.extend(chunk)
                    self.buffered += len(chunk)
                    reserved += len(chunk)
            finally:
                self.buffered -= reserved
            if complete:
                await pump.close()
                await finish()
                if stop.is_set():
                    raise HTTPException(404, 'Not found')
                return Response(inject_helper(bytes(data), asset[1]), status_code=upstream.status_code, headers=out)
            return StreamingResponse(streamed(bytes(data)), status_code=upstream.status_code, headers=out)
        except httpx.HTTPError:
            await pump.close()
            await finish()
            return Response('The preview service stopped answering', status_code=502, media_type='text/plain', headers=LIVE_HEADERS)
        except BaseException:
            await pump.close()
            await finish()
            raise

    async def bridge(self, websocket, row, external):
        path = self.upstream_path(websocket.scope, row)
        query = websocket.scope.get('query_string', b'').decode('latin-1')
        stop = asyncio.Event()
        try:
            release = self.register(row['preview_id'], stop.set)
        except HTTPException:
            await websocket.close(code=1013)
            return
        upstream = None
        try:
            # Servers may hand over one comma-joined header value; the upgrade offers each protocol once.
            offered = [token.strip() for item in websocket.scope.get('subprotocols') or [] for token in item.split(',') if token.strip()] or None
            try:
                upstream = await unix_connect(str(self.p.settings.manager_socket), f'ws://localhost/v1/executor/proxy/{external}{path}'
                                              + ('?' + query if query else ''), additional_headers=self.socket_options(row['owner_user_id']),
                                              subprotocols=offered, open_timeout=10, compression=None, ping_interval=None, max_size=16 * 1024 * 1024)
            except (OSError, TimeoutError, websockets.exceptions.WebSocketException, ManagerClientError):
                await websocket.close(code=1011)
                return
            await websocket.accept(subprotocol=upstream.subprotocol)

            async def up():
                while True:
                    message = await asyncio.wait_for(websocket.receive(), SOCKET_IDLE)
                    if message['type'] == 'websocket.disconnect':
                        return
                    if message.get('text') is not None:
                        await upstream.send(message['text'])
                    elif message.get('bytes') is not None:
                        await upstream.send(message['bytes'])

            async def down():
                while True:
                    data = await asyncio.wait_for(upstream.recv(), SOCKET_IDLE)
                    await (websocket.send_text(data) if isinstance(data, str) else websocket.send_bytes(data))
            jobs = [asyncio.ensure_future(up()), asyncio.ensure_future(down()), asyncio.ensure_future(stop.wait())]
            try:
                async with asyncio.timeout(SOCKET_LIFETIME):
                    await asyncio.wait(jobs, return_when=asyncio.FIRST_COMPLETED)
            except TimeoutError:
                pass
            finally:
                for job in jobs:
                    job.cancel()
                await asyncio.gather(*jobs, return_exceptions=True)
            code = upstream.close_code if upstream.close_code in (1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011) else 1000
            with suppress(Exception):
                await websocket.close(code=code)
        finally:
            release()
            if upstream is not None:
                with suppress(Exception):
                    await upstream.close()


async def live_root(request):
    preview_id = request.path_params['preview_id']
    if not PREVIEW_ID.fullmatch(preview_id):
        raise HTTPException(404, 'Not found')
    query = request.url.query
    return RedirectResponse(f'/artifact-live/{preview_id}/' + ('?' + query if query else ''), status_code=307)


async def live_http(request):
    live = request.app.state.platform.live
    try:
        row, external = live.authorize(request.path_params['preview_id'])
    except NotRunning:
        return Response(STOPPED_PAGE, status_code=503, media_type='text/html', headers={**LIVE_HEADERS, 'Retry-After': '5'})
    if request.method == 'OPTIONS' and 'access-control-request-method' in request.headers:
        return Response(status_code=204, headers={
            'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': ', '.join(METHODS),
            'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers', '*'), 'Access-Control-Max-Age': '600',
            'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store'})
    return await live.forward(request, row, external)


async def live_socket(websocket):
    live = websocket.app.state.platform.live
    try:
        row, external = live.authorize(websocket.path_params['preview_id'])
    except NotRunning:
        await websocket.close(code=1013)
        return
    except HTTPException:
        await websocket.close(code=1008)
        return
    await live.bridge(websocket, row, external)


def routes():
    return [Route('/artifact-live/{preview_id}', live_root),
            Route('/artifact-live/{preview_id}/{path:path}', live_http, methods=METHODS),
            WebSocketRoute('/artifact-live/{preview_id}/{path:path}', live_socket)]
