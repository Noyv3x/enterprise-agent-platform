"""One SDK client connection per (connector, credential owner): lazy, closed when idle, with a cached catalog."""
from __future__ import annotations

import asyncio
import logging
import ssl
import time
from contextlib import AsyncExitStack, suppress

import httpx2
import mcp_types as types
from mcp import Client
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError
from pydantic import ValidationError

from . import net
from .models import CATALOG_TTL_SECONDS, IDLE_SECONDS, McpError
from .stdio import ManagerStdioTransport

log = logging.getLogger(__name__)

CONNECT_TIMEOUT = 30
CLOSE_TIMEOUT = 50
MAX_PAGES = 20
MAX_ITEMS = 1000


def leaf(exc):
    """The innermost exception of an exception group (the SDK runs transports in task groups)."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return exc


def classify(exc, http=None):
    """A typed failure with a fixed message for any exception raised while connecting. Exception text is never passed on:
    it can carry URLs, header values or server-controlled content. `http` is `(status, www_authenticate)` of the last response."""
    if net.find_blocked(exc) is not None:
        return McpError(400, 'mcp_network_blocked', 'This address is not allowed; an administrator can allowlist internal hosts')
    exc = leaf(exc)
    if isinstance(exc, McpError):
        return exc
    status, challenge = http or (None, '')
    if isinstance(exc, httpx2.HTTPStatusError):
        status, challenge = exc.response.status_code, exc.response.headers.get('www-authenticate', '')
    if status in (401, 403):
        if challenge.lower().lstrip().startswith('bearer'):
            return McpError(409, 'needs_auth', 'The server asks the user to sign in', oauth_challenge=True)
        return McpError(409, 'credentials_rejected', f'The server rejected the credentials (HTTP {status})')
    if status is not None and status >= 400:
        return McpError(502, 'connect_failed', f'The server answered HTTP {status}')
    if isinstance(exc, (net.ResponseTooLarge, net.UnsupportedEncoding)):
        return McpError(502, 'connect_failed', 'The server sent a response that is too large or encoded')
    if isinstance(exc, (TimeoutError, httpx2.TimeoutException)):
        return McpError(504, 'connect_timeout', 'The server did not answer in time')
    if isinstance(exc, MCPError):
        return McpError(502, 'mcp_error', 'The server reported a protocol error')
    if isinstance(exc, (httpx2.ConnectError, ssl.SSLError, OSError)):
        return McpError(502, 'connect_failed', 'Could not connect to the server')
    if isinstance(exc, (ValueError, ValidationError)):
        return McpError(502, 'connect_failed', 'The server sent an invalid response')
    return McpError(502, 'connect_failed', f'Unexpected error ({type(exc).__name__})')


def _tool(tool):
    annotations = tool.annotations
    return {'name': tool.name, 'title': tool.title or (annotations.title if annotations else None) or '',
            'description': tool.description or '', 'input_schema': tool.input_schema,
            'read_only': bool(annotations and annotations.read_only_hint)}


def _prompt(prompt):
    return {'name': prompt.name, 'title': prompt.title or '', 'description': prompt.description or '',
            'arguments': [{'name': a.name, 'description': a.description or '', 'required': bool(a.required)} for a in prompt.arguments or []]}


def _resource(resource):
    return {'uri': resource.uri, 'name': resource.name, 'description': resource.description or '', 'mime_type': resource.mime_type or ''}


def _template(template):
    return {'uri': template.uri_template, 'name': template.name, 'description': template.description or '',
            'mime_type': template.mime_type or '', 'template': True}


class Connection:
    def __init__(self, service, connector, owner, user_id):
        self.svc, self.connector, self.owner, self.user_id = service, connector, owner, user_id
        self.key = (connector['id'], owner)
        self.client = None
        self.transport = None
        self.active = []
        self.last_used = time.monotonic()
        self.stale = False
        self.ready = asyncio.get_running_loop().create_future()
        self.stop = asyncio.Event()
        self.task = None
        self.refreshing = None
        self.http = None

    @property
    def dead(self):
        return self.client is None or self.task is None or self.task.done() or (self.transport is not None and self.transport.closed.is_set())

    @property
    def reason(self):
        return self.transport.reason if self.transport is not None else ''

    async def start(self):
        self.task = asyncio.create_task(self._run(), name=f'mcp-{self.key}')
        try:
            await asyncio.wait_for(asyncio.shield(self.ready), CONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            await self.close()
            raise McpError(504, 'connect_timeout', 'The server did not answer in time') from None
        except BaseException:
            await self.close()
            raise

    async def _on_message(self, message):
        if isinstance(message, (types.ToolListChangedNotification, types.PromptListChangedNotification, types.ResourceListChangedNotification)):
            self.stale = True
            self.svc.connections.refresh_soon(self)

    async def _observe(self, response):
        """Remember the last HTTP status and challenge: the SDK reports transport failures without them."""
        self.http = (response.status_code, response.headers.get('www-authenticate', ''))

    def _declared(self, kind, keys):
        return {k: v for k, v in self.svc.secrets.values(self.connector['id'], self.owner, kind).items() if k in keys}

    async def _transport(self, stack):
        c = self.connector
        if c['transport'] == 'stdio':
            env = self._declared('env', c['env_keys'])
            self.transport = ManagerStdioTransport(self.svc.channel, user_id=self.owner, connector_id=c['id'], command=c['command'],
                                                   args=c['args'], cwd=c['cwd'] or '/workspace', env=env)
            return self.transport, 'auto'
        headers = self._declared('header', c['header_keys']) if c['auth'] == 'headers' else {}
        auth = self.svc.oauth.auth_for(c, self.owner) if c['auth'] == 'oauth' else None

        def factory(headers=None, timeout=None, auth=None):
            client = self.svc.guarded_client(self.svc.p, auth=auth, headers=headers, timeout=timeout,
                                             allow_private=c['scope'] == 'org', endpoint=c['url'])
            client.event_hooks = {**client.event_hooks, 'response': [*client.event_hooks.get('response', []), self._observe]}
            return client
        if c['transport'] == 'sse':
            return sse_client(c['url'], headers=headers or None, auth=auth, httpx_client_factory=factory), 'legacy'
        http = await stack.enter_async_context(factory(headers or None, None, auth))
        return streamable_http_client(c['url'], http_client=http), 'auto'

    async def _run(self):
        try:
            async with AsyncExitStack() as stack:
                transport, mode = await self._transport(stack)
                client = Client(transport, mode=mode, elicitation_callback=self.svc.elicitations.callback_for(self),
                                message_handler=self._on_message, cache=None,
                                client_info=types.Implementation(name='agent-platform', version='1'))
                await stack.enter_async_context(client)
                self.client = client
                if not self.ready.done():
                    self.ready.set_result(None)
                await self.stop.wait()
        except BaseException as exc:
            if not self.ready.done():
                self.ready.set_exception(classify(exc, self.http))
            elif not isinstance(exc, asyncio.CancelledError):
                log.info('MCP connection %s ended: %s', self.key, type(leaf(exc)).__name__)
            if isinstance(exc, asyncio.CancelledError):
                raise
        finally:
            self.client = None
            if not self.ready.done():
                self.ready.set_exception(McpError(502, 'connect_failed', 'Connection closed'))
            if self.transport is not None:
                self.transport.closed.set()

    async def close(self):
        self.stop.set()
        if self.task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(self.task), CLOSE_TIMEOUT)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self.task.cancel()
                with suppress(BaseException):
                    await self.task
            except BaseException:
                pass
        if self.ready.done() and not self.ready.cancelled():
            self.ready.exception()  # mark retrieved

    async def fetch_catalog(self):
        client = self.client
        if client is None:
            raise McpError(502, 'connect_failed', 'Connection closed')
        caps = client.server_capabilities
        tools, prompts, resources = [], [], []
        try:
            cursor = None
            for _ in range(MAX_PAGES):
                page = await client.list_tools(cursor=cursor, cache_mode='bypass')
                tools += [_tool(item) for item in page.tools]
                cursor = page.next_cursor
                if not cursor or len(tools) >= MAX_ITEMS:
                    break
        except MCPError as exc:
            if caps.tools:
                raise classify(exc) from exc
        for capability, method, attribute, convert, target in (
                ('prompts', client.list_prompts, 'prompts', _prompt, prompts),
                ('resources', client.list_resources, 'resources', _resource, resources),
                ('resources', client.list_resource_templates, 'resource_templates', _template, resources)):
            if not getattr(caps, capability):
                continue
            try:
                cursor = None
                for _ in range(MAX_PAGES):
                    page = await method(cursor=cursor, cache_mode='bypass')
                    target += [convert(item) for item in getattr(page, attribute)]
                    cursor = page.next_cursor
                    if not cursor or len(target) >= MAX_ITEMS:
                        break
            except MCPError:
                pass
        info = client.server_info
        server = {'name': info.name if info else '', 'version': info.version if info else '',
                  'protocol': client.protocol_version, 'instructions': (client.instructions or '')[:4000]}
        self.stale = False
        return {'server': server, 'tools': tools, 'prompts': prompts, 'resources': resources, 'fetched_at': int(time.time())}


class Connections:
    def __init__(self, service):
        self.svc = service
        self.items = {}
        self.locks = {}
        self.reaper = None
        self.errors = {}
        self.background = set()

    def lock(self, key):
        return self.locks.setdefault(key, asyncio.Lock())

    def live(self, connector_id, owner):
        conn = self.items.get((connector_id, owner))
        return conn if conn is not None and not conn.dead else None

    async def acquire(self, connector, owner, user_id=None, scope_key=None):
        """The live connection for `(connector, owner)`, connecting lazily. Raises a typed `McpError`."""
        key = (connector['id'], owner)
        self.svc.require_runnable(connector)
        self._ensure_reaper()
        async with self.lock(key):
            conn = self.items.get(key)
            if conn is not None and (conn.dead or conn.connector['updated_at'] != connector['updated_at']):
                self.items.pop(key, None)
                await conn.close()
                conn = None
            if conn is None:
                conn = Connection(self.svc, connector, owner, user_id)
                try:
                    await conn.start()
                except McpError as exc:
                    exc = await self.svc.after_failure(connector, owner, exc, scope_key)
                    self.errors[key] = {'code': exc.code, 'error': exc.detail}
                    raise exc
                self.errors.pop(key, None)
                self.items[key] = conn
            conn.last_used = time.monotonic()
            return conn

    async def invalidate(self, connector_id, owner=...):
        """Close the connections of a connector (all owners, or one) after its credentials or configuration changed."""
        for key in [key for key in self.items if key[0] == connector_id and (owner is ... or key[1] == owner)]:
            conn = self.items.pop(key, None)
            self.errors.pop(key, None)
            if conn is not None:
                await conn.close()
        if owner is ...:
            for key in [key for key in self.errors if key[0] == connector_id]:
                self.errors.pop(key, None)

    def refresh_soon(self, conn):
        if conn.refreshing is None or conn.refreshing.done():
            conn.refreshing = asyncio.create_task(self.svc.refresh_catalog(conn))
            self.background.add(conn.refreshing)
            conn.refreshing.add_done_callback(self.background.discard)

    def _ensure_reaper(self):
        if self.reaper is None or self.reaper.done():
            self.reaper = asyncio.create_task(self._reap_loop())

    async def _reap_loop(self):
        while True:
            await asyncio.sleep(60)
            await self.reap()

    async def reap(self, now=None):
        """Close connections idle for 10 minutes and those whose server is gone."""
        now = time.monotonic() if now is None else now
        for key, conn in list(self.items.items()):
            if not conn.active and (conn.dead or now - conn.last_used >= IDLE_SECONDS):
                if self.items.get(key) is conn:
                    self.items.pop(key)
                    await conn.close()

    async def close_all(self):
        if self.reaper is not None:
            self.reaper.cancel()
            with suppress(asyncio.CancelledError):
                await self.reaper
        for task in list(self.background):
            task.cancel()
        items, self.items = list(self.items.values()), {}
        await asyncio.gather(*(conn.close() for conn in items), return_exceptions=True)

    @staticmethod
    def fresh(catalog, now=None):
        return catalog is not None and (now or time.time()) - catalog['fetched_at'] < CATALOG_TTL_SECONDS
