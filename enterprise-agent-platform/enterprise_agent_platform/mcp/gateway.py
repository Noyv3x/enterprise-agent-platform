"""The `mcp` gateway tool (Runtime to Platform) and the shared import / action-required logic."""
from __future__ import annotations

import json
from urllib.parse import urlsplit

from ..auth import permissions
from . import imports
from .models import INSTALL, McpError

CALL_ACTIONS = ('call', 'describe', 'list', 'list_resources', 'read_resource')
MANAGE_ACTIONS = ('add', 'remove', 'import', 'connect', 'enable', 'disable')
ADD_FIELDS = ('name', 'label', 'transport', 'url', 'command', 'args', 'cwd', 'auth', 'env_keys', 'header_keys')


def reply(content, data=None, is_error=False):
    return {'content': content, 'data': data if data is not None else {}, 'is_error': is_error}


def origin(url):
    parts = urlsplit(url)
    return f'{parts.scheme}://{parts.netloc.rpartition("@")[2]}' if parts.scheme and parts.netloc else ''


def card_connector(connector):
    """What the user must see to decide whether to trust a connector: where it connects, and who created it."""
    source = connector['source']
    stdio = connector['transport'] == 'stdio'
    destination = ' '.join([connector['command'], *connector['args']])[:300] if stdio else origin(connector['url'])
    item = {'id': connector['id'], 'name': connector['name'], 'label': connector['label'] or connector['name'], 'scope': connector['scope'],
            'transport': connector['transport'], 'destination': destination,
            'source': 'ai' if source == 'ai' else 'import' if source.startswith('import') else 'manual',
            'state': 'active' if connector['confirmed'] else 'pending_confirmation'}
    item.update(command=connector['command'], args=connector['args']) if stdio else item.update(url=destination)
    return item


def action_required(svc, scope_key, connector, kind, keys=None):
    """Tell the user's conversation that a connector needs confirmation, a sign-in or secret values (entered in a card, never in chat)."""
    event = {'type': 'mcp_action_required', 'kind': kind, 'connector': card_connector(connector)}
    if keys:
        event['keys'] = keys
    svc.p.queue.emit(scope_key, event)


def pending_needs(svc, connector, owner):
    """`(kind, keys)` the user still has to do: `secrets`, `oauth`, or `confirm` when only the confirmation is missing."""
    missing = [key for key, present in svc.secrets_set(connector, owner).items() if not present]
    if missing:
        return 'secrets', missing
    if connector['auth'] == 'oauth' and not svc.oauth.connected(connector['id'], owner):
        return 'oauth', None
    return None if connector['confirmed'] else ('confirm', None)


def apply_import(svc, user, drafts, fmt, scope_key=None, allow_stdio=True, confirmed=False):
    """Create personal connectors from parsed drafts. Literal secrets go to storage; `${VAR}` placeholders are reported missing.

    Every draft is validated before any connector is created. Connectors start unconfirmed unless `confirmed`: the user
    confirms where they connect before secrets are entered or anything is contacted. Returns `(created connectors,
    missing [{connector, kind, keys?}], skipped [{name, reason}])`."""
    todo, skipped = [], []
    for draft in drafts:
        if draft.transport == 'stdio' and not allow_stdio:
            skipped.append({'name': draft.name, 'reason': 'local_not_allowed'})
        elif svc.store.personal_by_name(user['id'], draft.name) or svc.store.org_by_name(draft.name):
            skipped.append({'name': draft.name, 'reason': 'exists'})
        else:
            body = {'name': draft.name, 'label': draft.label, 'transport': draft.transport, 'url': draft.url, 'command': draft.command,
                    'args': draft.args, 'cwd': draft.cwd, 'env': draft.env, 'headers': draft.headers,
                    'auth': 'headers' if draft.headers else 'none'}
            try:
                svc.prepare(user, body, 'personal', f'import:{fmt}', confirmed)
            except McpError as exc:
                raise McpError(400, 'import_invalid', f'Server {draft.name}: {exc.detail}') from exc
            todo.append(body)
    created, missing = [], []
    for body in todo:
        connector = svc.create(user, body, 'personal', source=f'import:{fmt}', confirmed=confirmed)
        created.append(connector)
        need = pending_needs(svc, connector, user['id'])
        if need:
            if need[0] != 'confirm':
                missing.append({'connector': connector['name'], 'kind': need[0], **({'keys': need[1]} if need[1] else {})})
            if scope_key:
                action_required(svc, scope_key, connector, *need)
    return created, missing, skipped


class Gateway:
    def __init__(self, service):
        self.svc = service

    async def handle(self, user, info, action, args, context, disconnected, agent_type=None):
        """Dispatch one `mcp` tool request. Typed failures are tool errors, not HTTP errors."""
        try:
            return await self._handle(user, info, action, args, context, disconnected, agent_type)
        except McpError as exc:
            return reply(exc.detail, {'code': exc.code, **exc.payload}, True)

    async def _handle(self, user, info, action, args, context, disconnected, agent_type):
        if not isinstance(args, dict):
            raise McpError(400, 'invalid_arguments', 'arguments must be an object')
        root = info['kind'] == 'agent' and info['channel_id'] is None and agent_type is None
        if action in MANAGE_ACTIONS:
            if not root:
                raise McpError(403, 'not_available', 'Connectors can only be managed by the personal AI')
            if INSTALL not in permissions(self.svc.p.db, user):
                raise McpError(403, 'permission_denied', 'Managing connectors needs the install_extensions permission')
            return await getattr(self, 'm_' + action)(user, info, args)
        if action not in CALL_ACTIONS:
            raise McpError(400, 'unsupported_action', 'Unsupported mcp action')
        return await getattr(self, 'c_' + action)(user, info, args, context, disconnected, agent_type)

    # -- calls ------------------------------------------------------------------------------------------

    def _call_context(self, user, info, context, connector, tool):
        return self.svc.call_context(user, info['scope_key'], connector, tool, str(context.get('run_id') or ''))

    async def _resolve(self, user, info, args, agent_type):
        """`(connector, owner, tool entry)` of a currently exposed tool, by wire name or by connector and tool."""
        exposure = await self.svc.exposure(user, info, agent_type)
        name = args.get('name')
        if isinstance(name, str) and name:
            wanted = {wire: pair for pair, wire in self.svc.names(exposure).items()}.get(name)
            if wanted is None:
                raise McpError(404, 'tool_not_found', f'No available tool named {name}')
            connector_name, tool_name = wanted
        else:
            connector_name, tool_name = args.get('connector'), args.get('tool')
            if not isinstance(connector_name, str) or not isinstance(tool_name, str):
                raise McpError(400, 'invalid_arguments', 'Provide name, or connector and tool')
        for connector, owner, tools in exposure:
            if connector['name'] == connector_name:
                for tool in tools:
                    if tool['name'] == tool_name:
                        return connector, owner, tool
        raise McpError(404, 'tool_not_found', f'No available tool {connector_name}.{tool_name}')

    async def c_call(self, user, info, args, context, disconnected, agent_type):
        connector, owner, tool = await self._resolve(user, info, args, agent_type)
        arguments = args.get('arguments') or {}
        if not isinstance(arguments, dict):
            raise McpError(400, 'invalid_arguments', 'arguments must be an object')
        call = self._call_context(user, info, context, connector, tool['name'])
        result = await self.svc.call_tool(connector, owner, call, tool['name'], arguments, disconnected)
        return result

    async def c_describe(self, user, info, args, context, disconnected, agent_type):
        connector, _, tool = await self._resolve(user, info, args, agent_type)
        text = f"{connector['name']}.{tool['name']}: {tool['description']}\ninput schema:\n{json.dumps(tool['input_schema'], ensure_ascii=False, indent=2)}"
        return reply(text, {'connector': connector['name'], 'tool': tool['name'], 'input_schema': tool['input_schema'], 'read_only': tool['read_only']})

    async def c_list(self, user, info, args, context, disconnected, agent_type):
        rows, lines = [], []
        exposure = {c['id']: tools for c, _, tools in await self.svc.exposure(user, info, agent_type)}
        for connector, owner in self.svc.candidates(user, info):
            status = self.svc.status(connector, owner)
            tools = [t['name'] for t in exposure.get(connector['id'], [])]
            rows.append({'name': connector['name'], 'label': connector['label'] or connector['name'], 'status': status, 'tools': tools})
            lines.append(f"{connector['name']} ({connector['label'] or connector['name']}): {status}" + (f", tools: {', '.join(tools)}" if tools else ''))
        return reply('\n'.join(lines) or 'No connectors are available.', {'connectors': rows})

    async def _connector(self, user, info, args, agent_type):
        name = args.get('connector')
        if not isinstance(name, str):
            raise McpError(400, 'invalid_arguments', 'connector is required')
        for connector, owner, _ in await self.svc.exposure(user, info, agent_type):
            if connector['name'] == name:
                return connector, owner
        connector, owner = self.svc.find(user, info, name)
        if self.svc.credentials_state(connector, owner) != 'ok':
            raise McpError(409, 'not_connected', f'{name} needs credentials before it can be used')
        return connector, owner

    async def c_list_resources(self, user, info, args, context, disconnected, agent_type):
        connector, owner = await self._connector(user, info, args, agent_type)
        catalog = await self.svc.catalog(connector, owner, user['id'])
        lines = [f"{item['uri']} — {item['name']}" + (f" ({item['mime_type']})" if item['mime_type'] else '') for item in catalog['resources']]
        return reply('\n'.join(lines) or 'No resources.', {'resources': catalog['resources']})

    async def c_read_resource(self, user, info, args, context, disconnected, agent_type):
        connector, owner = await self._connector(user, info, args, agent_type)
        uri = args.get('uri')
        if not isinstance(uri, str) or not uri or len(uri) > 4096:
            raise McpError(400, 'invalid_arguments', 'uri is required')
        call = self._call_context(user, info, context, connector, 'resources/read')
        return await self.svc.read_resource(connector, owner, call, uri, disconnected)

    # -- management (personal root, install_extensions) -------------------------------------------------

    def _mine(self, user, args):
        name = args.get('name')
        connector = self.svc.store.personal_by_name(user['id'], name) if isinstance(name, str) else None
        if connector is None:
            raise McpError(404, 'connector_not_found', 'No personal connector with that name')
        return connector

    def _needs_text(self, connector, need):
        if need is None:
            return f"{connector['name']} is ready."
        if need[0] == 'confirm' or not connector['confirmed']:
            return (f"{connector['name']} is waiting for the user to confirm where it connects (a card was shown in the chat); "
                    "it cannot be used or given credentials until then. Do not ask for credentials in chat.")
        if need[0] == 'oauth':
            return f"{connector['name']} needs the user to sign in; a Connect card was shown in the chat. Do not ask for credentials in chat."
        return (f"{connector['name']} needs values for {', '.join(need[1])}; a secure form was shown in the chat. "
                "Never ask the user to paste secrets into the conversation.")

    async def m_add(self, user, info, args):
        if 'env' in args or 'headers' in args:
            raise McpError(400, 'secrets_not_allowed', 'Do not pass secret values; declare env_keys or header_keys and the user fills them in a secure form')
        spec = {key: args[key] for key in ADD_FIELDS if key in args}
        connector = self.svc.create(user, spec, 'personal', source='ai', confirmed=False)
        need = pending_needs(self.svc, connector, user['id'])
        if need:
            action_required(self.svc, info['scope_key'], connector, *need)
        view = self.svc.view(connector, user['id'])
        return reply(f"Added connector {connector['name']}. " + self._needs_text(connector, need), {'connector': view, 'needs': need and {'kind': need[0], 'keys': need[1]}})

    async def m_remove(self, user, info, args):
        connector = self._mine(user, args)
        await self.svc.delete(connector)
        return reply(f"Removed connector {connector['name']}.")

    async def m_import(self, user, info, args):
        path, text = args.get('path'), args.get('text')
        if (path is None) == (text is None) or not isinstance(path or text, str):
            raise McpError(400, 'invalid_arguments', 'Provide exactly one of path or text')
        hint = None
        if path is not None:
            text = await imports.aread(info['workspace'], path)
            hint = path
        fmt, drafts = await imports.aparse(text, hint)
        created, missing, skipped = apply_import(self.svc, user, drafts, fmt, info['scope_key'])
        views = [self.svc.view(c, user['id']) for c in created]
        lines = [f"Imported {len(created)} connector(s) from {fmt}: {', '.join(c['name'] for c in created) or 'none'}."]
        if created:
            lines.append('The user must confirm where each connector connects before anything is contacted; a card was shown in the chat.')
        if skipped:
            lines.append(f"Skipped: {', '.join(item['name'] + ' (' + item['reason'] + ')' for item in skipped)}.")
        for item in missing:
            lines.append(f"{item['connector']} still needs " + ('a sign-in' if item['kind'] == 'oauth' else f"values for {', '.join(item['keys'])}") + ' (the user was asked in a card).')
        return reply('\n'.join(lines), {'connectors': views, 'missing': missing, 'skipped': skipped})

    async def m_connect(self, user, info, args):
        connector = self._mine(user, args)
        need = pending_needs(self.svc, connector, user['id'])
        if need:
            action_required(self.svc, info['scope_key'], connector, *need)
        return reply(self._needs_text(connector, need), {'needs': need and {'kind': need[0], 'keys': need[1]}})

    async def _toggle(self, user, args, enabled):
        connector = self._mine(user, args)
        self.svc.store.update(connector['id'], enabled=int(enabled))
        await self.svc.connections.invalidate(connector['id'])
        return reply(f"{connector['name']} is {'enabled' if enabled else 'disabled'}.")

    async def m_enable(self, user, info, args):
        return await self._toggle(user, args, True)

    async def m_disable(self, user, info, args):
        return await self._toggle(user, args, False)
