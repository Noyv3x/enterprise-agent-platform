"""The Platform MCP service: connector rules, availability per scope, catalogs, calls and run payloads."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import suppress
from urllib.parse import urlsplit

import mcp_types as types
from mcp.shared.exceptions import MCPError

from ..auth import groups as permission_groups, permissions
from . import net
from .connections import Connection, Connections, classify
from .elicit import CURRENT_CALL, CallContext, Elicitations
from .models import (AUTHS, INSTALL, TOOL_NAME_RE, clean_line, clean_secret, clean_text, clip_bytes, CREDENTIAL_MODES, DEFAULT_TIMEOUT_S, DEFERRED_SCHEMA_BYTES, DEFERRED_TOOLS, ENV_KEY_RE, HEADER_KEY_RE, MAX_TIMEOUT_S,
                     SETTINGS_PRIVATE_NETWORKS, TRANSPORTS, McpError, tool_names, validate_name)
from .gateway import Gateway, action_required
from .oauth import OAuthManager
from .results import flatten_prompt, map_resource, map_tool_result
from .stdio import ManagerChannel
from .store import Store

log = logging.getLogger(__name__)

BACKGROUND_FETCH_TIMEOUT = 20
DESCRIPTION_BYTES = 4000
SCHEMA_BYTES = 64 * 1024
MAX_TOOLS = 200
MAX_TOTAL_BYTES = 480 * 1024
CATALOG_BYTES = 60_000


def _text(value, field, limit, required=False):
    if value is None or value == '':
        if required:
            raise McpError(400, 'invalid_connector', f'{field} is required')
        return ''
    if not isinstance(value, str) or len(value) > limit or '\x00' in value or '\n' in value or '\r' in value:
        raise McpError(400, 'invalid_connector', f'{field} is invalid')
    return value


def _mapping(value, field, key_re):
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 64 or any(not isinstance(k, str) or not key_re.fullmatch(k) for k in value):
        raise McpError(400, 'invalid_connector', f'{field} must map valid names to values')
    return {key: clean_secret(item) for key, item in value.items()}


def _keys(value, field, key_re):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 64 or any(not isinstance(k, str) or not key_re.fullmatch(k) for k in value):
        raise McpError(400, 'invalid_connector', f'{field} must be a list of valid names')
    return list(dict.fromkeys(value))


def _url(value):
    value = _text(value, 'url', 2048, required=True)
    parts = urlsplit(value)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise McpError(400, 'invalid_connector', 'url must be an http(s) URL without credentials')
    return value


class McpService:
    def __init__(self, platform):
        self.p = platform
        self.store = Store(platform.db)
        self.secrets = self.store.secrets
        # Replaceable seams: the guarded outbound client factory and the Manager channel.
        self.guarded_client = net.guarded_client
        self.channel = ManagerChannel(platform)
        self.oauth = OAuthManager(platform)
        self.elicitations = Elicitations(self)
        self.connections = Connections(self)
        self.fetching = {}
        self.gateway = Gateway(self)

    async def close(self):
        await self.connections.close_all()

    # -- credentials and status ----------------------------------------------------------------------

    @staticmethod
    def owner_for(connector, user_id):
        """The credential owner: the user for personal and per-user connectors, `None` (shared) otherwise."""
        if connector['scope'] == 'personal':
            return connector['owner_user_id']
        return user_id if connector['credential_mode'] == 'per_user' else None

    def secret_keys(self, connector):
        if connector['transport'] == 'stdio':
            return 'env', connector['env_keys']
        if connector['auth'] == 'headers':
            return 'header', connector['header_keys']
        return 'header', []

    def secrets_set(self, connector, owner):
        kind, keys = self.secret_keys(connector)
        have = self.secrets.names(connector['id'], owner, kind)
        return {key: key in have for key in keys}

    def credentials_state(self, connector, owner):
        """`'ok'`, `'needs_secrets'` or `'needs_auth'`."""
        if not all(self.secrets_set(connector, owner).values()):
            return 'needs_secrets'
        if connector['auth'] == 'oauth' and not self.oauth.connected(connector['id'], owner):
            return 'needs_auth'
        return 'ok'

    def status(self, connector, owner):
        if not connector['confirmed']:
            return 'pending_confirmation'
        state = self.credentials_state(connector, owner)
        if state != 'ok':
            return state
        if self.connections.live(connector['id'], owner) is not None:
            return 'connected'
        error = self.connections.errors.get((connector['id'], owner))
        if error:
            return 'needs_auth' if error['code'] == 'needs_auth' else 'error'
        return 'idle'

    def view(self, connector, user_id=None, admin=False):
        """The ConnectorView of a connector for a user; `admin` is the administrator's view of an organization connector."""
        per_user_org = connector['scope'] == 'org' and connector['credential_mode'] == 'per_user'
        shared_org = connector['scope'] == 'org' and connector['credential_mode'] == 'shared'
        # Whose credentials the view reports: the caller's own, except the administrator's view of a shared connector.
        owner = None if admin and shared_org else self.owner_for(connector, user_id)
        if admin and per_user_org:
            status, secrets = 'idle', {}
        else:
            status = self.status(connector, owner)
            secrets = {} if shared_org and not admin else self.secrets_set(connector, owner)
        cache = self.store.cache_get(connector['id'], owner)
        error = self.connections.errors.get((connector['id'], owner))
        item = {'id': connector['id'], 'scope': connector['scope'], 'name': connector['name'], 'label': connector['label'] or connector['name'],
                'transport': connector['transport'], 'auth': connector['auth'], 'credential_mode': connector['credential_mode'],
                'enabled': connector['enabled'], 'status': status, 'secrets_set': secrets, 'source': connector['source'],
                'header_keys': connector['header_keys'], 'env_keys': connector['env_keys'], 'disabled_tools': connector['disabled_tools'],
                'timeout_s': connector['timeout_s'], 'manageable': admin or connector['scope'] == 'personal'}
        if connector['url']:
            item['url'] = connector['url']
        if connector['command']:
            item.update(command=connector['command'], args=connector['args'], cwd=connector['cwd'] or None)
        if error and status in ('error', 'needs_auth'):
            item['last_error'] = error['error']
        if cache is not None:
            item['tool_count'] = len(cache['tools'])
        if connector['auth'] == 'oauth' and (warning := self.oauth.warning()):
            item['oauth_warning'] = warning
        if connector['scope'] == 'org':
            item['groups'] = connector['groups']
        if admin and connector['scope'] == 'org':
            item['oauth'] = {'scopes': connector['oauth'].get('scopes', []), 'client_id': connector['oauth'].get('client_id'),
                             'client_secret_set': self._client_secret(connector)}
        return item

    def _client_secret(self, connector):
        found = self.secrets.get(connector['id'], None, 'oauth_client', 'client')
        return bool(found and json.loads(found[0]).get('client_secret'))

    # -- availability ---------------------------------------------------------------------------------

    @staticmethod
    def group_allows(connector, user):
        return '*' in connector['groups'] or user['permission_group'] in connector['groups']

    @staticmethod
    def channel_eligible(connector):
        """Channels use only organization connectors that every user may use, with shared credentials and a remote server."""
        return (connector['scope'] == 'org' and connector['credential_mode'] == 'shared' and connector['transport'] != 'stdio'
                and connector['groups'] == ['*'])

    def candidates(self, user, info):
        """`[(connector, owner)]` of enabled, confirmed connectors the scope may use, whatever their credential state."""
        if info['channel_id'] is not None:
            enabled = set(self.store.channel_ids(info['channel_id']))
            return [(c, None) for c in self.store.org() if c['enabled'] and c['id'] in enabled and self.channel_eligible(c)]
        allowed = permissions(self.p.db, user)
        found = [(c, self.owner_for(c, user['id'])) for c in self.store.org() if c['enabled'] and self.group_allows(c, user)]
        if INSTALL in allowed:
            found += [(c, user['id']) for c in self.store.personal(user['id'])
                      if c['enabled'] and c['confirmed'] and (c['transport'] != 'stdio' or 'private_agent' in allowed)]
        if info['kind'] == 'chat':
            found = [(c, o) for c, o in found if c['transport'] != 'stdio']
        return found

    def require_runnable(self, connector):
        """Refuse to connect a connector its owner may not use (permissions can change after it was created) or that is unconfirmed."""
        if not connector['confirmed']:
            raise McpError(409, 'confirmation_required', 'Confirm where this connector connects before it is used')
        if connector['scope'] != 'personal':
            return
        try:
            allowed = permissions(self.p.db, self.p.queue.user(connector['owner_user_id']))
        except Exception:
            raise McpError(403, 'permission_denied', 'The connector owner is not available') from None
        if INSTALL not in allowed or (connector['transport'] == 'stdio' and 'private_agent' not in allowed):
            raise McpError(403, 'permission_denied', 'The connector owner may not use this connector')

    def available(self, user, info):
        """Candidates whose credentials are present."""
        return [(c, o) for c, o in self.candidates(user, info) if self.credentials_state(c, o) == 'ok']

    def find(self, user, info, name):
        """A candidate connector by name; a personal one wins over an organization connector."""
        found = [(c, o) for c, o in self.candidates(user, info) if c['name'] == name]
        if not found:
            raise McpError(404, 'connector_not_found', f'No connector named {name} is available here')
        return sorted(found, key=lambda item: item[0]['scope'] != 'personal')[0]

    # -- catalogs -------------------------------------------------------------------------------------

    async def catalog(self, connector, owner, user_id=None, refresh=False):
        """The connector's tools, prompts and resources: cached, refetched when older than 10 minutes or stale."""
        cached = self.store.cache_get(connector['id'], owner)
        conn = self.connections.live(connector['id'], owner)
        if cached and not refresh and self.connections.fresh(cached) and not (conn and conn.stale):
            return cached
        return await self._fetch(await self.connections.acquire(connector, owner, user_id))

    async def _fetch(self, conn):
        try:
            catalog = await conn.fetch_catalog()
        except McpError:
            raise
        except Exception as exc:
            raise classify(exc) from exc
        self.store.cache_put(conn.connector['id'], conn.owner, catalog)
        return catalog

    async def refresh_catalog(self, conn):
        with suppress(Exception):
            await self._fetch(conn)

    async def catalog_for_run(self, connector, owner, user_id):
        """A catalog without making a run wait on a slow server: the cache when there is one (refreshed in the background)."""
        cached = self.store.cache_get(connector['id'], owner)
        if cached is not None:
            if not self.connections.fresh(cached):
                self._refresh_later(connector, owner, user_id)
            return cached
        try:
            return await asyncio.wait_for(self.catalog(connector, owner, user_id), BACKGROUND_FETCH_TIMEOUT)
        except (McpError, asyncio.TimeoutError):
            return None

    def _refresh_later(self, connector, owner, user_id):
        key = (connector['id'], owner)
        if key in self.fetching and not self.fetching[key].done():
            return

        async def refresh():
            with suppress(Exception):
                await self.catalog(connector, owner, user_id, refresh=True)
        self.fetching[key] = asyncio.create_task(refresh())

    @staticmethod
    def enabled_tools(connector, catalog):
        disabled = set(connector['disabled_tools'])
        return [tool for tool in catalog['tools'] if tool['name'] not in disabled and TOOL_NAME_RE.fullmatch(tool['name'])
                and isinstance(tool['input_schema'], dict)]

    async def exposure(self, user, info, agent_type=None):
        """`[(connector, owner, [tool])]` of the tools a scope can call; scouts only get read-only tools."""
        found = []
        available = self.available(user, info)
        catalogs = await asyncio.gather(*(self.catalog_for_run(connector, owner, user['id']) for connector, owner in available))
        for (connector, owner), catalog in zip(available, catalogs):
            if catalog is None:
                continue
            tools = self.enabled_tools(connector, catalog)
            if agent_type == 'scout':
                tools = [tool for tool in tools if tool['read_only']]
            if tools:
                found.append((connector, owner, tools))
        return found

    async def run_payload(self, user, info, agent_type=None):
        """The run payload's `mcp` entry, or None when the scope has no MCP at all. It always satisfies Runtime's limits:
        descriptions at most 4000 bytes, direct schemas at most 64 KB, at most 200 tools and 512 KB; beyond that the
        tools are listed in `catalog_text` (deferred). A tool with an oversized schema is not registered directly but
        stays callable through `mcp` describe and call."""
        found = await self.exposure(user, info, agent_type)
        personal_root = info['kind'] == 'agent' and info['channel_id'] is None and agent_type is None
        if not found and not self.available(user, info) and not personal_root:
            return None
        names = tool_names([(c['name'], t['name']) for c, _, tools in found for t in tools])
        entries = []
        for connector, _, tools in found:
            label = clean_line(connector['label'] or connector['name'], 64)
            for tool in tools:
                description = clip_bytes(clean_text(f"[{label}] {tool['description']}"), DESCRIPTION_BYTES)
                entries.append({'name': names[(connector['name'], tool['name'])], 'connector': connector['name'], 'tool': tool['name'],
                                'description': description, 'input_schema': tool['input_schema'], 'read_only': tool['read_only']})
        sizes = [len(json.dumps(e['input_schema'], ensure_ascii=False, separators=(',', ':')).encode()) for e in entries]
        direct = [e for e, size in zip(entries, sizes) if size <= SCHEMA_BYTES]
        total = sum(len(e['name']) + len(e['connector']) + len(e['tool']) + len(e['description'].encode()) + size for e, size in zip(entries, sizes) if size <= SCHEMA_BYTES)
        deferred = (len(entries) > DEFERRED_TOOLS or sum(size for size in sizes if size <= SCHEMA_BYTES) > DEFERRED_SCHEMA_BYTES
                    or len(direct) > MAX_TOOLS or total > MAX_TOTAL_BYTES)
        payload = {'tools': [] if deferred else direct, 'deferred': deferred}
        if deferred:
            lines, used = [], 0
            for entry in entries:
                line = f"{entry['connector']}.{entry['tool']} — {clean_line(entry['description'].split(chr(10))[0], 200)}"
                if used + len(line.encode()) + 1 > CATALOG_BYTES:
                    lines.append(f'[catalog truncated: {len(entries) - len(lines)} more tools; use the mcp tool\'s list action]')
                    break
                lines.append(line)
                used += len(line.encode()) + 1
            payload['catalog_text'] = '\n'.join(lines)
        return payload

    def names(self, exposure):
        return tool_names([(c['name'], t['name']) for c, _, tools in exposure for t in tools])

    # -- calls ----------------------------------------------------------------------------------------

    async def _wait(self, task, call, timeout, disconnected):
        """Wait for a call task: the call timeout excludes time spent waiting for the user; a disconnect cancels."""
        while True:
            remaining = timeout + call.pause_total() - (time.monotonic() - call.started)
            if remaining <= 0:
                task.cancel()
                await asyncio.wait({task}, timeout=5)
                raise TimeoutError()
            done, _ = await asyncio.wait({task}, timeout=min(remaining, 0.5 if disconnected else remaining))
            if done:
                return task.result()
            if disconnected is not None and await disconnected():
                task.cancel()
                await asyncio.wait({task}, timeout=5)
                raise asyncio.CancelledError()

    async def _use(self, connector, owner, call, label, operation, disconnected=None, status_of=None):
        """Run `operation(client)` on the connector's connection with elicitation context and an audit row."""
        started, status = time.monotonic(), 'error'
        conn = None
        token = None
        try:
            conn = await self.connections.acquire(connector, owner, call.user_id, call.scope_key)
            conn.active.append(call)
            token = CURRENT_CALL.set(call)
            task = asyncio.ensure_future(operation(conn.client))
            try:
                result = await self._wait(task, call, connector['timeout_s'], disconnected)
            except BaseException:
                if not task.done():
                    task.cancel()
                raise
            status = status_of(result) if status_of else 'ok'
            return result
        except asyncio.CancelledError:
            status = 'cancelled'
            raise
        except TimeoutError:
            status = 'timeout'
            raise McpError(504, 'call_timeout', f'{label} timed out after {connector["timeout_s"]}s; it may still have run on the server') from None
        except MCPError as exc:
            if conn is not None and exc.code == types.CONNECTION_CLOSED:  # the server is gone; the next use reconnects
                conn.stop.set()
            raise McpError(502, 'mcp_error', f'Server error {exc.code}: {clean_line(exc.message, 300)}') from exc
        except McpError:
            raise
        except Exception as exc:
            if conn is not None:
                conn.stop.set()
            raise classify(exc, conn.http if conn is not None else None) from exc
        finally:
            if token is not None:
                CURRENT_CALL.reset(token)
            if conn is not None and call in conn.active:
                conn.active.remove(call)
            self.elicitations.cancel_call(call)
            self.store.record_call(call.user_id, call.scope_key, connector, label, status, (time.monotonic() - started) * 1000)

    async def call_tool(self, connector, owner, call, tool, arguments, disconnected=None):
        if tool in connector['disabled_tools']:
            raise McpError(403, 'tool_disabled', f'Tool {tool} is disabled')
        try:
            result = await self._use(connector, owner, call, tool, lambda client: client.call_tool(tool, arguments or None), disconnected,
                                     status_of=lambda result: 'error' if result.is_error else 'ok')
        except McpError as exc:
            if exc.code in ('call_timeout', 'mcp_error'):
                return {'content': exc.detail, 'data': {}, 'is_error': True}
            raise
        return map_tool_result(result)

    async def read_resource(self, connector, owner, call, uri, disconnected=None):
        result = await self._use(connector, owner, call, 'resources/read', lambda client: client.read_resource(uri), disconnected)
        return map_resource(result)

    async def get_prompt(self, connector, owner, call, name, arguments):
        result = await self._use(connector, owner, call, 'prompts/get', lambda client: client.get_prompt(name, arguments or None))
        return flatten_prompt(result)

    def call_context(self, user, scope_key, connector, tool, run_id=''):
        return CallContext(user_id=user['id'], scope_key=scope_key, connector=connector, tool=tool, run_id=run_id)

    # -- connector rules ------------------------------------------------------------------------------

    def parse_spec(self, body, scope, partial=False, current=None):
        """Validated connector columns from an API or gateway body. `partial` validates only the given fields."""
        fields = {}

        def given(key):
            return key in body
        merged = {**(current or {}), **body}
        if not partial:
            fields['name'] = validate_name(body.get('name'))
        if given('label') or not partial:
            fields['label'] = _text(body.get('label'), 'label', 64)
        transport = merged.get('transport')
        if transport not in TRANSPORTS:
            raise McpError(400, 'invalid_connector', 'transport must be http, sse or stdio')
        if scope == 'org' and transport == 'stdio':
            raise McpError(400, 'invalid_connector', 'Local (stdio) servers are personal connectors only')
        if given('transport') or not partial:
            fields['transport'] = transport
        if transport == 'stdio':
            if given('command') or not partial or (given('transport') and not (current or {}).get('command')):
                fields['command'] = _text(body.get('command'), 'command', 512, required=True)
            if given('args') or not partial:
                args = body.get('args') or []
                if not isinstance(args, list) or len(args) > 64 or any(not isinstance(a, str) or len(a) > 4096 or '\x00' in a for a in args):
                    raise McpError(400, 'invalid_connector', 'args must be at most 64 strings')
                fields['args_json'] = json.dumps(args)
            if given('cwd') or not partial:
                fields['cwd'] = _text(body.get('cwd'), 'cwd', 512)
            if not partial or given('transport'):
                fields['url'] = ''
                fields['auth'] = 'none'
        else:
            if given('url') or not partial or (given('transport') and not (current or {}).get('url')):
                fields['url'] = _url(body.get('url'))
            if given('auth') or given('headers') or given('header_keys') or not partial:
                auth = merged.get('auth') or ('headers' if body.get('headers') or body.get('header_keys') else 'none')
                if auth not in AUTHS:
                    raise McpError(400, 'invalid_connector', 'auth must be none, headers or oauth')
                fields['auth'] = auth
            if given('transport') or not partial:
                fields.update(command='', args_json='[]', cwd='')
        if scope == 'org':
            mode = merged.get('credential_mode') or 'shared'
            if mode not in CREDENTIAL_MODES:
                raise McpError(400, 'invalid_connector', 'credential_mode must be shared or per_user')
            if given('credential_mode') or not partial:
                fields['credential_mode'] = mode
            if given('groups') or not partial:
                fields['groups_json'] = json.dumps(self.parse_groups(body.get('groups', ['*'])))
        if given('timeout_s'):
            value = body['timeout_s']
            if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_TIMEOUT_S:
                raise McpError(400, 'invalid_connector', f'timeout_s must be 1–{MAX_TIMEOUT_S}')
            fields['timeout_s'] = value
        elif not partial:
            fields['timeout_s'] = DEFAULT_TIMEOUT_S
        if given('enabled'):
            fields['enabled'] = int(bool(body['enabled']))
        if given('disabled_tools'):
            tools = body['disabled_tools']
            if not isinstance(tools, list) or len(tools) > 1000 or any(not isinstance(t, str) or len(t) > 256 for t in tools):
                raise McpError(400, 'invalid_connector', 'disabled_tools must be a list of tool names')
            fields['disabled_tools_json'] = json.dumps(list(dict.fromkeys(tools)))
        return fields

    def parse_groups(self, value):
        names = {group['name'] for group in permission_groups(self.p.db)}
        if (not isinstance(value, list) or not value or any(not isinstance(item, str) for item in value) or len(set(value)) != len(value)
                or ('*' in value and len(value) > 1) or any(item != '*' and item not in names for item in value)):
            raise McpError(400, 'invalid_groups', 'groups must be ["*"] or existing permission group names')
        return value

    def declared_keys(self, body, connector_transport, current=None):
        """`(header_keys, env_keys)` after applying a body's `headers`/`env`/`header_keys`/`env_keys` to the current lists."""
        headers = _mapping(body.get('headers'), 'headers', HEADER_KEY_RE)
        env = _mapping(body.get('env'), 'env', ENV_KEY_RE)
        header_keys = list(current['header_keys']) if current else []
        env_keys = list(current['env_keys']) if current else []
        if 'header_keys' in body:
            header_keys = _keys(body['header_keys'], 'header_keys', HEADER_KEY_RE)
        if 'env_keys' in body:
            env_keys = _keys(body['env_keys'], 'env_keys', ENV_KEY_RE)
        header_keys += [k for k in headers if k not in header_keys]
        env_keys += [k for k in env if k not in env_keys]
        if connector_transport == 'stdio':
            if headers:
                raise McpError(400, 'invalid_connector', 'Local servers take env, not headers')
            header_keys = []
        else:
            if env:
                raise McpError(400, 'invalid_connector', 'Remote servers take headers, not env')
            env_keys = []
        return header_keys, env_keys, headers, env

    def write_secrets(self, connector, owner, mapping, kind):
        """Write `{KEY: value|None}`; None deletes, '' only declares the key. Values are never read back by any API."""
        for key, value in mapping.items():
            if value is None:
                self.secrets.delete(connector['id'], owner, kind, key)
            elif value != '':
                self.secrets.put(connector['id'], owner, kind, key, value)

    def prepare(self, user, body, scope, source='manual', confirmed=True):
        """Validate a new connector completely (nothing is written): `(columns, headers, env)`."""
        fields = self.parse_spec(body, scope)
        header_keys, env_keys, headers, env = self.declared_keys(body, fields['transport'])
        if fields['auth'] != 'headers':
            header_keys, headers = [], {}
        meta = {'kind': source, **({} if confirmed else {'confirmed': False})}
        fields.update(scope=scope, owner_user_id=user['id'] if scope == 'personal' else None, created_by=user['id'],
                      header_keys_json=json.dumps(header_keys), env_keys_json=json.dumps(env_keys), source_json=json.dumps(meta))
        if scope == 'org':
            fields['oauth_json'] = json.dumps(self.parse_oauth(body))
        if scope == 'personal' and self.store.org_by_name(fields['name']):
            raise McpError(409, 'name_in_use', 'A connector with this name already exists')
        return fields, headers, env

    def create(self, user, body, scope, source='manual', confirmed=True):
        """Create a connector (personal for `user`, or organization) and store its secret values. Returns the connector."""
        fields, headers, env = self.prepare(user, body, scope, source, confirmed)
        connector_id = self.store.insert(**fields)
        connector = self.store.get(connector_id)
        owner = user['id'] if scope == 'personal' else None
        if scope == 'personal' or connector['credential_mode'] == 'shared':
            self.write_secrets(connector, owner, headers, 'header')
            self.write_secrets(connector, owner, env, 'env')
        if scope == 'org':
            self.set_oauth_client(connector, body)
        return self.store.get(connector_id)

    def confirm(self, connector):
        """The owner confirmed where the connector connects; it is enabled from now on."""
        self.store.update(connector['id'], source_json=json.dumps({'kind': connector['source']}), enabled=1)
        return self.store.get(connector['id'])

    async def after_failure(self, connector, owner, exc, scope_key):
        """A connect failure that proves the server wants OAuth: remember it and ask the user to sign in (personal connectors)."""
        if not exc.payload.get('oauth_challenge'):
            return exc
        if connector['scope'] == 'personal' and connector['auth'] == 'none':
            self.store.update(connector['id'], auth='oauth')
            action_required(self, scope_key or f"private:{owner}", self.store.get(connector['id']), 'oauth')
            return McpError(409, 'needs_auth', 'The server needs the user to sign in; use Connect')
        return McpError(409, 'credentials_rejected', 'The server rejected the credentials')

    @staticmethod
    def parse_oauth(body, current=None):
        oauth = dict(current or {})
        if 'oauth_scopes' in body:
            scopes = body['oauth_scopes']
            if not isinstance(scopes, list) or len(scopes) > 32 or any(not isinstance(s, str) or not s or len(s) > 256 or ' ' in s for s in scopes):
                raise McpError(400, 'invalid_connector', 'oauth_scopes must be a list of scope names')
            oauth['scopes'] = scopes
        if 'oauth_client' in body:
            client = body['oauth_client']
            if client is None:
                oauth.pop('client_id', None)
            else:
                if not isinstance(client, dict) or not isinstance(client.get('client_id'), str) or not client['client_id'] or len(client['client_id']) > 512:
                    raise McpError(400, 'invalid_connector', 'oauth_client needs a client_id')
                oauth['client_id'] = client['client_id']
        return oauth

    def set_oauth_client(self, connector, body):
        if 'oauth_client' not in body:
            return
        client = body['oauth_client']
        if client is None:
            self.secrets.delete(connector['id'], None, 'oauth_client')
            return
        secret = client.get('client_secret')
        if secret is None:
            found = self.secrets.get(connector['id'], None, 'oauth_client', 'client')
            secret = json.loads(found[0]).get('client_secret') if found else None
        if secret is not None and not isinstance(secret, str):
            raise McpError(400, 'invalid_connector', 'client_secret must be a string')
        record = {'client_id': client['client_id'], **({'client_secret': secret} if secret else {})}
        self.secrets.put(connector['id'], None, 'oauth_client', 'client', json.dumps(record), issuer='')

    async def update(self, user, connector, body, owner):
        """Apply a PATCH to a connector and the caller-owner's secrets; closes the connection so it reconnects with the changes.
        Everything is validated before anything is written."""
        scope = connector['scope']
        fields = self.parse_spec(body, scope, partial=True, current=connector)
        raw = body.get('secrets')
        if raw is not None and not isinstance(raw, dict):
            raise McpError(400, 'invalid_connector', 'secrets must be an object')
        transport = fields.get('transport', connector['transport'])
        header_keys, env_keys, headers, env = self.declared_keys(body, transport, connector)
        if transport != 'stdio' and fields.get('auth', connector['auth']) != 'headers':
            header_keys = []
        if 'header_keys' in body or 'headers' in body or 'auth' in fields or 'transport' in fields:
            fields['header_keys_json'] = json.dumps(header_keys)
        if 'env_keys' in body or 'env' in body or 'transport' in fields:
            fields['env_keys_json'] = json.dumps(env_keys)
        if scope == 'org' and ('oauth_scopes' in body or 'oauth_client' in body):
            fields['oauth_json'] = json.dumps(self.parse_oauth(body, connector['oauth']))
        writes = {}
        for key, value in {**headers, **env, **{k: clean_secret(v) for k, v in (raw or {}).items()}}.items():
            if key in env_keys:
                writes[key] = ('env', value)
            elif key in header_keys:
                writes[key] = ('header', value)
            elif value is None and (key in connector['env_keys'] or key in connector['header_keys']):
                continue  # clearing a key that is being removed: it is deleted for every owner below
            else:
                raise McpError(400, 'unknown_secret', f'{key} is not a declared header or environment key')
        if scope == 'org' and 'oauth_client' in body and body['oauth_client'] is not None and not isinstance(body['oauth_client'].get('client_secret', ''), str):
            raise McpError(400, 'invalid_connector', 'client_secret must be a string')
        # -- validated; write --
        self.store.update(connector['id'], **fields)
        updated = self.store.get(connector['id'])
        for key in set(connector['header_keys']) - set(header_keys):
            self.secrets.delete_name(connector['id'], 'header', key)
        for key in set(connector['env_keys']) - set(env_keys):
            self.secrets.delete_name(connector['id'], 'env', key)
        for key, (kind, value) in writes.items():
            self.write_secrets(updated, owner, {key: value}, kind)
        if scope == 'org':
            self.set_oauth_client(updated, body)
        current = {'url': connector['url'], 'command': connector['command'], 'args_json': json.dumps(connector['args']),
                   'transport': connector['transport'], 'auth': connector['auth'], 'cwd': connector['cwd']}
        if any(fields[key] != current[key] for key in current if key in fields):
            self.store.cache_drop(connector['id'])
        if fields.get('url', connector['url']) != connector['url']:
            # Tokens are issuer-bound, not URL-bound: a different server must not inherit them.
            self.store.secrets.delete_kind(connector['id'], 'oauth_tokens')
        await self.connections.invalidate(connector['id'])
        return updated

    def apply_secrets(self, connector, owner, secrets):
        """Route `{KEY: value|None}` to the header or env list the key is declared in; nothing is written if any key is unknown."""
        routed = []
        for key, value in secrets.items():
            value = clean_secret(value)
            if key in connector['env_keys']:
                routed.append((key, value, 'env'))
            elif key in connector['header_keys']:
                routed.append((key, value, 'header'))
            else:
                raise McpError(400, 'unknown_secret', f'{key} is not a declared header or environment key')
        for key, value, kind in routed:
            self.write_secrets(connector, owner, {key: value}, kind)

    async def delete(self, connector):
        await self.connections.invalidate(connector['id'])
        self.store.delete(connector['id'])

    async def test(self, connector, owner, user_id):
        """Connect on a temporary connection (a shared connection is never touched), list and report; a failure is a result."""
        self.require_runnable(connector)
        state = self.credentials_state(connector, owner)
        if state != 'ok':
            return {'ok': False, 'server': None, 'tools': 0, 'error': 'Credentials are missing' if state == 'needs_secrets' else 'Sign in is required'}
        key = (connector['id'], owner)
        conn = Connection(self, connector, owner, user_id)
        try:
            await conn.start()
            catalog = await conn.fetch_catalog()
        except Exception as exc:
            error = classify(exc, conn.http)
            error = await self.after_failure(connector, owner, error, None)
            if self.connections.live(connector['id'], owner) is None:
                self.connections.errors[key] = {'code': error.code, 'error': error.detail}
            return {'ok': False, 'server': None, 'tools': 0, 'error': error.detail}
        finally:
            await conn.close()
        self.store.cache_put(connector['id'], owner, catalog)
        if self.connections.live(connector['id'], owner) is None:
            self.connections.errors.pop(key, None)
        server = catalog['server']
        return {'ok': True, 'server': {'name': server['name'], 'version': server['version'] or None}, 'tools': len(catalog['tools'])}

    # -- settings -------------------------------------------------------------------------------------

    def private_networks(self):
        return self.store.setting(SETTINGS_PRIVATE_NETWORKS, [])
