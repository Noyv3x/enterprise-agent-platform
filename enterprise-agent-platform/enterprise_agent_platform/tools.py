"""Authenticated web tools and scope-owned Camofox sessions."""
import asyncio
from contextlib import nullcontext
import base64
import fcntl
import ipaddress
import json
import socket
import struct
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup
from markdownify import markdownify
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .auth import body_json, require_permission, require_internal, session_identity


async def public_url(url):
    if not isinstance(url, str):
        raise HTTPException(400, 'URL must be a string')
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise HTTPException(400, 'A public HTTP(S) URL is required')
    try:
        port = parts.port or (443 if parts.scheme == 'https' else 80)
        addresses = await asyncio.get_running_loop().getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise HTTPException(400, 'URL host cannot be resolved') from exc
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise HTTPException(400, 'Private and reserved network addresses are forbidden')
    return parts, addresses[0][4][0]


def interface_networks():
    """Linux container interface addresses; no deployment subnet configuration."""
    networks = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        for _, name in socket.if_nameindex():
            packed = struct.pack('256s', name.encode()[:15])
            try:
                address = socket.inet_ntoa(fcntl.ioctl(sock.fileno(), 0x8915, packed)[20:24])
                mask = socket.inet_ntoa(fcntl.ioctl(sock.fileno(), 0x891B, packed)[20:24])
            except OSError:
                continue  # IPv6-only interfaces have no SIOCGIFADDR record.
            networks.append(ipaddress.ip_network(f'{address}/{mask}', strict=False))
    ipv6 = Path('/proc/net/if_inet6')
    if ipv6.exists():
        for line in ipv6.read_text().splitlines():
            address, _, prefix, *_ = line.split()
            networks.append(ipaddress.ip_network(f'{ipaddress.IPv6Address(int(address, 16))}/{int(prefix, 16)}', strict=False))
    return networks


async def browser_url(url):
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise HTTPException(400, 'Browser navigation requires an HTTP(S) URL without credentials')
    hostname = parts.hostname.rstrip('.').lower()
    blocked = {'platform', 'agent-runtime', 'camofox', 'searxng', 'metadata', 'instance-data.ec2.internal',
               'metadata.azure.internal', 'metadata.google.internal', 'metadata.oraclecloud.com'}
    if hostname in blocked or hostname.endswith('.metadata.google.internal'):
        raise HTTPException(400, 'Browser destination is a protected service')
    try:
        answers = await asyncio.get_running_loop().getaddrinfo(hostname, parts.port or 443, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise HTTPException(400, 'Browser host cannot be resolved') from exc
    networks = interface_networks()
    if not answers:
        raise HTTPException(400, 'Browser host cannot be resolved')
    for answer in answers:
        address = ipaddress.ip_address(answer[4][0])
        address = address.ipv4_mapped or address if address.version == 6 else address
        if (address.is_link_local or address.is_multicast or address.is_reserved or address.is_unspecified
                or str(address) in {'100.100.100.200', 'fd00:ec2::254'}
                or any(address.version == network.version and address in network for network in networks)):
            raise HTTPException(400, 'Browser destination is a protected network')


async def fetch(url, max_chars=100000):
    """Pin each request to its validated address, retaining TLS hostname verification."""
    async with asyncio.timeout(30), httpx.AsyncClient(trust_env=False, timeout=10) as client:
        for _ in range(6):
            parts, address = await public_url(url)
            # Host and SNI retain the original origin while TCP uses the checked IP.
            pinned = httpx.URL(url).copy_with(host=address)
            authority = ('[' + parts.hostname + ']' if ':' in parts.hostname else parts.hostname) + (f':{parts.port}' if parts.port else '')
            async with client.stream('GET', pinned, headers={'Host': authority}, extensions={'sni_hostname': parts.hostname}, follow_redirects=False) as response:
                if response.is_redirect:
                    location = response.headers.get('location')
                    if not location:
                        raise HTTPException(502, 'Redirect has no destination')
                    url = urljoin(url, location)
                    continue
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 2 * 1024 * 1024:
                        raise HTTPException(413, 'Web response exceeds 2 MiB')
                text = body.decode(response.encoding or 'utf-8', errors='replace')
                if 'html' in response.headers.get('content-type', ''):
                    document = BeautifulSoup(text, 'html.parser')
                    for element in document(['script', 'style', 'noscript']):
                        element.decompose()
                    text = markdownify(str(document))
                return {'url': url, 'content': text[:max_chars]}
    raise HTTPException(400, 'Too many redirects')


def result(data):
    preview = {key: value for key, value in data.items() if key != 'screenshot'} if isinstance(data, dict) else data
    return {'content': json.dumps(preview, ensure_ascii=False), 'data': data, 'is_error': False}


class Browser:
    def __init__(self, platform):
        self.p = platform
        self.leases = {}
        self.locks = {}

    def lock(self, uid):
        return self.locks.setdefault(uid, asyncio.Lock())

    def lease(self, uid):
        lease = self.leases.get(uid)
        if lease and lease['deadline'] <= time.monotonic():
            self.leases.pop(uid, None)
            lease = None
        return lease

    def public_lease(self, uid):
        lease = self.lease(uid)
        return {key: lease[key] for key in ('holder_user_id', 'expires_at')} if lease else None

    def acquire(self, uid, holder):
        old = self.lease(uid)
        if old and old['holder'] != holder:
            raise HTTPException(409, 'Browser is controlled by another session')
        self.leases[uid] = {'holder': holder, 'holder_user_id': uid, 'deadline': time.monotonic() + 60,
                            'expires_at': datetime.fromtimestamp(time.time() + 60, timezone.utc).isoformat()}
        return self.public_lease(uid)

    def check(self, uid, holder=None):
        lease = self.lease(uid)
        if lease and lease['holder'] != holder:
            raise HTTPException(409, 'Browser is busy: human takeover is active')
        if holder is not None and not lease:
            raise HTTPException(409, 'Acquire the browser lease first')

    async def request(self, uid, method, path, args=None, binary=False):
        identity = f'private:{uid}'
        fields = {**(args or {}), 'userId': identity}
        options = {'params': fields} if method == 'GET' else {'json': fields}
        async with asyncio.timeout(60), self.p.http.stream(method, self.p.settings.camofox_url.rstrip('/') + path,
                                     headers={'Authorization': 'Bearer ' + self.p.settings.camofox_access_key},
                                     timeout=30, **options) as response:
            if response.status_code >= 400:
                raise HTTPException(502, 'Browser service rejected the request')
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 8 * 1024 * 1024:
                    raise HTTPException(413, 'Browser response exceeds 8 MiB')
            return bytes(data) if binary else json.loads(data)

    async def action(self, uid, action, args, holder=None):
        if not isinstance(args, dict) or not isinstance(action, str):
            raise HTTPException(400, 'action must be a string and arguments an object')
        async with self.lock(uid):
            self.check(uid, holder)
            if action == 'list':
                return await self.request(uid, 'GET', '/tabs')
            if action == 'cleanup':
                return await self.request(uid, 'DELETE', '/sessions/' + quote(f'private:{uid}', safe=''))
            if action == 'console':
                if args.get('expression'):
                    raise HTTPException(400, 'Browser console cannot evaluate JavaScript')
                return {'messages': [], 'supported': False, 'detail': 'Camofox does not expose console logs'}
            if action == 'new_tab':
                if args.get('url'):
                    await browser_url(args['url'])
                fields = {'sessionKey': 'agent'}
                if args.get('url'):
                    fields['url'] = args['url']
                return await self.request(uid, 'POST', '/tabs', fields)
            tab = args.get('tab_id')
            if not isinstance(tab, str) or not tab:
                raise HTTPException(400, 'tab_id is required')
            path = '/tabs/' + quote(tab, safe='')
            if action in {'screenshot', 'vision'}:
                data = await self.request(uid, 'GET', path + '/screenshot', {'fullPage': 'false'}, binary=True)
                image = {'tabId': tab, 'screenshot': {'data': base64.b64encode(data).decode(), 'mimeType': 'image/png', 'bytes': len(data)}}
                if action == 'vision':
                    image.update(await self.request(uid, 'GET', path + '/snapshot'))
                    image['question'] = args.get('question', 'Describe the current page')
                return image
            if action == 'close':
                return await self.request(uid, 'DELETE', path)
            allowed = {'navigate', 'click', 'type', 'scroll', 'back', 'forward', 'refresh', 'press', 'wait', 'viewport', 'snapshot', 'links', 'images', 'downloads', 'stats', 'extract'}
            if action not in allowed:
                raise HTTPException(400, 'Unsupported browser action')
            fields = {k: v for k, v in args.items() if k not in {'tab_id', 'userId', 'user_id', 'sessionKey'}}
            if action == 'extract' and not isinstance(fields.get('schema'), dict):
                raise HTTPException(400, 'extract requires a JSON schema object')
            if action == 'navigate':
                if fields.get('url'):
                    await browser_url(fields['url'])
                fields['sessionKey'] = 'agent'
            if isinstance(fields.get('ref'), str):
                fields['ref'] = fields['ref'].lstrip('@')
            for source, target in [('double_click', 'doubleClick'), ('press_enter', 'pressEnter'), ('wait_for_network', 'waitForNetwork')]:
                if source in fields:
                    fields[target] = fields.pop(source)
            readonly = action in {'snapshot', 'links', 'images', 'downloads', 'stats'}
            if action in {'images', 'downloads'}:
                fields.update(includeData='false', consume='false')
            return await self.request(uid, 'GET' if readonly else 'POST', path + '/' + action, fields)

    async def gateway(self, tool, action, args, context, disconnected=None):
        if not isinstance(args, dict) or not isinstance(context, dict):
            raise HTTPException(400, 'arguments and context must be objects')
        # A live subagent run has no conversation job of its own; it may use web tools only.
        if tool == 'web' and self.p.tasks.child_owner(context):
            return await self.web(action, args)
        key = context.get('scope_key', '')
        with self.p.db.connect() as conn:
            session = conn.execute('SELECT scope_key FROM queue_sessions WHERE sid=?', (context.get('sid'),)).fetchone()
            jobs = conn.execute("SELECT payload_json FROM durable_jobs WHERE kind='agent' AND status='running' AND json_extract(payload_json,'$.parent_job_id') IS NULL").fetchall()
            payload = None
            for job in jobs:
                candidate = json.loads(job['payload_json'])
                name = candidate.get('scope', '')
                candidate_key = (f"private:{candidate.get('user_id')}" if name == 'private' else
                                 'channel:' + name[8:] + ':main-agent' if name.startswith('channel-') else name)
                if session and candidate_key == session['scope_key']:
                    payload = candidate
                    break
            user = conn.execute('SELECT * FROM users WHERE id=? AND active=1', (payload['user_id'],)).fetchone() if payload else None
        if not user:
            raise HTTPException(403, 'Tool session has no active owning job')
        user = dict(user)
        uid = user['id']
        scope = self.p.queue.scope(user, payload['scope'])
        if scope['sandbox']['scope_key'] != key or scope['sid'] != context.get('sid'):
            raise HTTPException(403, 'Tool session does not own scope')
        active_run = getattr(self.p.queue, 'running', {}).get(scope['scope_key'])
        if not context.get('run_id') or (active_run and active_run != context['run_id']):
            raise HTTPException(403, 'Tool run is not active')
        if context.get('owner_user_id') not in (None, uid):
            raise HTTPException(403, 'Tool owner does not match active job')
        if tool in {'browser', 'schedule', 'tasks'} and (scope['kind'] != 'agent' or scope['scope_type'] != 'private'):
            raise HTTPException(403, 'This tool is available only to personal AI')
        if tool == 'browser':
            return result(await self.action(uid, action, args))
        if tool == 'tasks':
            async def never():
                return False
            return await self.p.tasks.gateway(user, action, args, context, disconnected or never)
        if tool == 'schedule':
            from .schedules import dispatch
            return result(await dispatch(self.p, action, args, user))
        if tool != 'web':
            raise HTTPException(404, 'Unknown tool')
        return await self.web(action, args)

    async def web(self, action, args):
        if action == 'search':
            query = args.get('query', '')
            if not isinstance(query, str) or not query.strip() or len(query) > 4096:
                raise HTTPException(400, 'Search query must contain 1–4096 characters')
            async with asyncio.timeout(20), self.p.http.stream('GET', self.p.settings.searxng_url.rstrip('/') + '/search', params={'q': query, 'format': 'json', 'categories': 'general'}, timeout=20) as response:
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 2 * 1024 * 1024:
                        raise HTTPException(413, 'Search response exceeds 2 MiB')
                search = json.loads(body)
            rows = []
            for item in search.get('results', [])[:100]:
                try:
                    await public_url(item.get('url', ''))
                except HTTPException:
                    continue
                rows.append({'title': item.get('title', ''), 'url': item['url'], 'description': item.get('content', ''), 'position': len(rows) + 1})
                if len(rows) >= max(1, min(int(args.get('limit', 5)), 100)):
                    break
            return result({'web': rows, 'source': 'managed_search'})
        if action == 'fetch':
            return result(await fetch(args.get('url', ''), max(1, min(int(args.get('max_chars', 100000)), 500000))))
        raise HTTPException(400, 'Unsupported web action')


def holder(request, body):
    value = body.get('holder_id')
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise HTTPException(400, 'holder_id is required')
    return session_identity(request) + ':' + value


async def internal(request):
    require_internal(request)
    body = await body_json(request)
    try:
        platform = request.app.state.platform
        tool, action = request.path_params['tool'], body.get('action')
        # `wait` is a long poll inside an active run, which already blocks maintenance; it holds no admission.
        admission = nullcontext() if tool == 'tasks' and action == 'wait' else platform.gate.admit()
        async with admission:
            return JSONResponse(await platform.browser.gateway(tool, action, body.get('arguments', {}), body.get('context', {}), request.is_disconnected))
    except httpx.HTTPError as exc:
        raise HTTPException(502, 'Tool upstream request failed') from exc
    except TimeoutError as exc:
        raise HTTPException(504, 'Tool request timed out') from exc


async def browser_ui(request):
    user = require_permission(request, 'private_agent')
    browser = request.app.state.platform.browser
    uid = user['id']
    if request.url.path.endswith('/lease'):
        body = await body_json(request)
        identity = holder(request, body)
        async with browser.lock(uid):
            if request.method == 'DELETE':
                browser.check(uid, identity)
                browser.leases.pop(uid, None)
                return JSONResponse({'ok': True})
            return JSONResponse({'lease': browser.acquire(uid, identity)})
    if request.url.path.endswith('/action'):
        body = await body_json(request)
        data = await browser.action(uid, body.get('action'), body.get('arguments', {}), holder(request, body))
        return JSONResponse(result(data))
    if request.url.path.endswith('/screenshot'):
        tab = request.query_params.get('tab_id', '')
        if not tab:
            raise HTTPException(400, 'tab_id is required')
        data = await browser.request(uid, 'GET', '/tabs/' + quote(tab, safe='') + '/screenshot', {'fullPage': 'false'}, binary=True)
        return Response(data, media_type='image/png', headers={'Cache-Control': 'no-store'})
    data = await browser.request(uid, 'GET', '/tabs')
    return JSONResponse({'tabs': data.get('tabs', []) if isinstance(data, dict) else data, 'lease': browser.public_lease(uid)})


def routes():
    return [Route('/internal/agent/tools/{tool}', internal, methods=['POST']),
            Route('/api/browser', browser_ui), Route('/api/browser/action', browser_ui, methods=['POST']),
            Route('/api/browser/lease', browser_ui, methods=['POST', 'DELETE']), Route('/api/browser/screenshot', browser_ui)]
