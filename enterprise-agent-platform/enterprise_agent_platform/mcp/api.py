"""User, administrator and channel HTTP routes for MCP connectors. No route ever returns a secret value."""
from __future__ import annotations

import ipaddress
import re

from starlette.responses import JSONResponse
from starlette.routing import Route

from ..auth import body_json, current_user, permissions, require_permission
from . import imports
from .gateway import apply_import, origin
from .models import INSTALL, SETTINGS_PRIVATE_NETWORKS, McpError

CREATE_FIELDS = {'name', 'label', 'transport', 'url', 'command', 'args', 'cwd', 'auth', 'env', 'headers', 'timeout_s', 'enabled', 'header_keys', 'env_keys'}
ADMIN_FIELDS = CREATE_FIELDS | {'credential_mode', 'groups', 'oauth_client', 'oauth_scopes', 'secrets'}
PATCH_FIELDS = (CREATE_FIELDS - {'name'}) | {'secrets', 'disabled_tools'}
ADMIN_PATCH_FIELDS = (ADMIN_FIELDS - {'name'}) | {'disabled_tools'}
HOSTNAME = re.compile(r'[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?')


def _svc(request):
    return request.app.state.platform.mcp


def _fields(body, allowed):
    unknown = sorted(set(body) - allowed)
    if unknown:
        raise McpError(400, 'unknown_field', f'Unknown field: {unknown[0]}')
    return body


def scope_info(request, user, scope):
    """A light scope description `{kind, channel_id, scope_key}` after the permission the scope needs."""
    p = request.app.state.platform
    allowed = permissions(p.db, user)
    if scope == 'private':
        needed, info = 'private_agent', {'kind': 'agent', 'channel_id': None, 'scope_key': f"private:{user['id']}"}
    elif scope == 'chat' or scope.startswith('chat-'):
        needed, info = 'chat', {'kind': 'chat', 'channel_id': None, 'scope_key': scope}
        if needed in allowed and scope != 'chat':
            p.queue.conversation(user, scope[5:])  # the user's own, not deleted conversation (404 otherwise)
    elif scope.startswith('channel-') and scope[8:].isdigit():
        needed, info = 'read_workspace', {'kind': 'agent', 'channel_id': int(scope[8:]), 'scope_key': f'channel:{scope[8:]}:main-agent'}
        with p.db.connect() as conn:
            if needed in allowed and not conn.execute('SELECT 1 FROM channels WHERE id=? AND archived=0', (info['channel_id'],)).fetchone():
                raise McpError(404, 'channel_not_found', 'Channel not found')
    else:
        raise McpError(404, 'scope_not_found', 'Unknown scope')
    if needed not in allowed:
        raise McpError(403, 'permission_denied', 'Permission denied')
    return info


def can_install(p, user):
    return INSTALL in permissions(p.db, user)


def owned(request, user, connector_id, admin=False):
    """`(connector, owner)` for a connector the user may act on: their own personal one, an organization one for their groups
    (the administrator route: any organization connector with the shared owner)."""
    svc = _svc(request)
    connector = svc.store.get(connector_id)
    if connector is None:
        raise McpError(404, 'connector_not_found', 'Connector not found')
    if admin:
        if connector['scope'] != 'org':
            raise McpError(404, 'connector_not_found', 'Connector not found')
        # The shared owner for shared credentials; an administrator's own credentials for a per-user connector.
        return connector, svc.owner_for(connector, user['id'])
    if connector['scope'] == 'personal':
        if connector['owner_user_id'] != user['id']:
            raise McpError(404, 'connector_not_found', 'Connector not found')
    elif not svc.group_allows(connector, user) and 'system_settings' not in permissions(request.app.state.platform.db, user):
        raise McpError(404, 'connector_not_found', 'Connector not found')
    return connector, svc.owner_for(connector, user['id'])


def require_install(request, user, transport=None):
    if not can_install(request.app.state.platform, user):
        raise McpError(403, 'permission_denied', 'Managing connectors needs the install_extensions permission')
    if transport == 'stdio' and 'private_agent' not in permissions(request.app.state.platform.db, user):
        raise McpError(403, 'permission_denied', 'Local servers need the personal AI')


async def list_connectors(request):
    user = current_user(request)
    svc = _svc(request)
    scope = request.query_params.get('scope', 'private')
    info = scope_info(request, user, scope)
    if info['channel_id'] is not None:
        found = [c for c, _ in svc.candidates(user, info)]
    else:
        found = [c for c in svc.store.org() if c['enabled'] and svc.group_allows(c, user)]
        if can_install(request.app.state.platform, user):
            found += svc.store.personal(user['id'])
        if info['kind'] == 'chat':
            found = [c for c in found if c['transport'] != 'stdio']
    body = {'connectors': [svc.view(c, user['id']) for c in found], 'can_install': can_install(request.app.state.platform, user)}
    if warning := svc.oauth.warning():
        body['oauth_warning'] = warning
    return JSONResponse(body)


async def create_connector(request):
    user = current_user(request)
    body = _fields(await body_json(request), CREATE_FIELDS)
    require_install(request, user, body.get('transport'))
    svc = _svc(request)
    return JSONResponse({'connector': svc.view(svc.create(user, body, 'personal'), user['id'])}, status_code=201)


async def patch_connector(request):
    user = current_user(request)
    connector, owner = owned(request, user, request.path_params['id'])
    body = _fields(await body_json(request), PATCH_FIELDS)
    if connector['scope'] != 'personal':
        raise McpError(403, 'permission_denied', 'Organization connectors are managed by an administrator')
    require_install(request, user, body.get('transport', connector['transport']))
    svc = _svc(request)
    return JSONResponse({'connector': svc.view(await svc.update(user, connector, body, owner), user['id'])})


async def delete_connector(request):
    user = current_user(request)
    connector, _ = owned(request, user, request.path_params['id'])
    if connector['scope'] != 'personal':
        raise McpError(403, 'permission_denied', 'Organization connectors are managed by an administrator')
    require_install(request, user)
    await _svc(request).delete(connector)
    return JSONResponse({'ok': True})


async def connect(request, admin=False):
    user = current_user(request, admin=admin) if not admin else require_permission(request, 'system_settings')
    connector, owner = owned(request, user, request.path_params['id'], admin)
    svc = _svc(request)
    if connector['auth'] != 'oauth':
        raise McpError(400, 'not_oauth', 'This connector does not use OAuth')
    if connector['scope'] == 'org' and connector['credential_mode'] == 'shared' and not admin:
        raise McpError(403, 'permission_denied', 'The administrator connects this connector')
    if admin and connector['credential_mode'] == 'per_user':
        raise McpError(400, 'per_user', 'Each user connects their own account')
    if connector['scope'] == 'personal':
        require_install(request, user)
    svc.require_runnable(connector)
    return JSONResponse({'authorize_url': await svc.oauth.begin(connector, owner, user['id'])})


async def admin_connect(request):
    return await connect(request, admin=True)


async def disconnect(request, admin=False):
    user = require_permission(request, 'system_settings') if admin else current_user(request)
    connector, owner = owned(request, user, request.path_params['id'], admin)
    svc = _svc(request)
    if connector['scope'] == 'org' and connector['credential_mode'] == 'shared' and not admin:
        raise McpError(403, 'permission_denied', 'The administrator disconnects this connector')
    await svc.oauth.disconnect(connector['id'], owner)
    await svc.connections.invalidate(connector['id'], owner)
    return JSONResponse({'ok': True})


async def admin_disconnect(request):
    return await disconnect(request, admin=True)


async def test_connector(request, admin=False):
    user = require_permission(request, 'system_settings') if admin else current_user(request)
    connector, owner = owned(request, user, request.path_params['id'], admin)
    return JSONResponse(await _svc(request).test(connector, owner, user['id']))


async def admin_test(request):
    return await test_connector(request, admin=True)


async def catalog(request, admin=False):
    user = require_permission(request, 'system_settings') if admin else current_user(request)
    connector, owner = owned(request, user, request.path_params['id'], admin)
    svc = _svc(request)
    svc.require_runnable(connector)
    if svc.credentials_state(connector, owner) != 'ok':
        raise McpError(409, 'not_connected', 'The connector needs credentials first (an administrator tests per-user connectors with their own credentials)')
    data = await svc.catalog(connector, owner, user['id'])
    disabled = set(connector['disabled_tools'])
    tools = [{'name': t['name'], 'description': t['description'], 'read_only': t['read_only'], 'enabled': t['name'] not in disabled} for t in data['tools']]
    return JSONResponse({'tools': tools, 'prompts': data['prompts'], 'resources': data['resources']})


async def admin_catalog(request):
    return await catalog(request, admin=True)


async def put_credentials(request):
    user = current_user(request)
    connector, owner = owned(request, user, request.path_params['id'])
    body = _fields(await body_json(request), {'secrets'})
    svc = _svc(request)
    if connector['scope'] == 'org' and connector['credential_mode'] == 'shared':
        raise McpError(403, 'permission_denied', 'The administrator manages shared credentials')
    if connector['scope'] == 'personal':
        require_install(request, user, connector['transport'])
    svc.require_runnable(connector)
    secrets = body.get('secrets')
    if not isinstance(secrets, dict):
        raise McpError(400, 'invalid_connector', 'secrets must be an object')
    svc.apply_secrets(connector, owner, secrets)
    await svc.connections.invalidate(connector['id'], owner)
    return JSONResponse({'connector': svc.view(svc.store.get(connector['id']), user['id'])})


async def confirm_connector(request):
    user = current_user(request)
    connector, _ = owned(request, user, request.path_params['id'])
    if connector['scope'] != 'personal':
        raise McpError(403, 'permission_denied', 'Organization connectors need no confirmation')
    require_install(request, user, connector['transport'])
    svc = _svc(request)
    return JSONResponse({'connector': svc.view(svc.confirm(connector), user['id'])})


async def detected(request):
    user = require_permission(request, 'private_agent')
    p = request.app.state.platform
    root = p.queue.scope(user, 'private')['workspace']
    return JSONResponse({'files': await imports.adetect(root)})


async def import_config(request):
    user = current_user(request)
    body = _fields(await body_json(request), {'path', 'text'})
    require_install(request, user)
    p = request.app.state.platform
    path, text = body.get('path'), body.get('text')
    if (path is None) == (text is None) or not isinstance(path if path is not None else text, str):
        raise McpError(400, 'invalid_arguments', 'Provide exactly one of path or text')
    if path is not None:
        text = await imports.aread(p.queue.scope(require_permission(request, 'private_agent'), 'private')['workspace'], path)
    fmt, drafts = await imports.aparse(text, path)
    # Pasted text is the user's own; a workspace file may have been written by anyone (or the AI), so it starts unconfirmed.
    created, missing, skipped = apply_import(p.mcp, user, drafts, fmt, allow_stdio='private_agent' in permissions(p.db, user), confirmed=path is None)
    return JSONResponse({'connectors': [p.mcp.view(c, user['id']) for c in created], 'missing': missing, 'skipped': skipped})


def _prompt_key(user, scope):
    if scope == 'private':
        return f"private:{user['id']}"
    if scope.startswith('channel-'):
        return f'channel:{scope[8:]}:main-agent'
    return scope


async def list_prompts(request):
    user = current_user(request)
    svc = _svc(request)
    info = scope_info(request, user, request.query_params.get('scope', 'private'))
    prompts, connectors = [], []
    for connector, owner in svc.available(user, info):
        label = connector['label'] or connector['name']
        connectors.append({'name': connector['name'], 'label': label})
        catalog = await svc.catalog_for_run(connector, owner, user['id'])
        for prompt in (catalog or {}).get('prompts', []):
            prompts.append({'connector': connector['name'], 'connector_label': label, **prompt})
    return JSONResponse({'prompts': prompts, 'connectors': connectors})


async def render_prompt(request):
    user = current_user(request)
    body = _fields(await body_json(request), {'scope', 'connector', 'name', 'arguments'})
    svc = _svc(request)
    scope = body.get('scope') or 'private'
    info = scope_info(request, user, scope)
    name, prompt, arguments = body.get('connector'), body.get('name'), body.get('arguments') or {}
    if (not isinstance(name, str) or not isinstance(prompt, str) or not isinstance(arguments, dict)
            or any(not isinstance(k, str) or not isinstance(v, str) for k, v in arguments.items())):
        raise McpError(400, 'invalid_arguments', 'connector, name and string arguments are required')
    connector, owner = svc.find(user, info, name)
    if svc.credentials_state(connector, owner) != 'ok':
        raise McpError(409, 'not_connected', 'The connector needs credentials first')
    call = svc.call_context(user, _prompt_key(user, scope), connector, 'prompts/get')
    call.interactive = scope != 'chat'
    return JSONResponse({'text': await svc.get_prompt(connector, owner, call, prompt, arguments)})


async def answer_elicitation(request):
    user = current_user(request)
    body = _fields(await body_json(request), {'action', 'content'})
    _svc(request).elicitations.answer(user, request.path_params['id'], body.get('action'), body.get('content'))
    return JSONResponse({'ok': True})


# -- administrator -------------------------------------------------------------------------------------------

async def admin_list(request):
    require_permission(request, 'system_settings')
    svc = _svc(request)
    p = request.app.state.platform
    from ..auth import groups
    body = {'connectors': [svc.view(c, None, admin=True) for c in svc.store.org()], 'groups': [g['name'] for g in groups(p.db)],
            'oauth_redirect_uri': svc.oauth.redirect_uri()}
    if warning := svc.oauth.warning():
        body['oauth_warning'] = warning
    return JSONResponse(body)


async def admin_create(request):
    user = require_permission(request, 'system_settings')
    body = _fields(await body_json(request), ADMIN_FIELDS)
    svc = _svc(request)
    return JSONResponse({'connector': svc.view(svc.create(user, body, 'org'), None, admin=True)}, status_code=201)


async def admin_patch(request):
    user = require_permission(request, 'system_settings')
    connector, _ = owned(request, user, request.path_params['id'], admin=True)
    body = _fields(await body_json(request), ADMIN_PATCH_FIELDS)
    svc = _svc(request)
    if body.get('secrets') and connector['credential_mode'] == 'per_user':
        raise McpError(400, 'per_user', 'Each user enters their own credentials')
    updated = await svc.update(user, connector, body, None)
    return JSONResponse({'connector': svc.view(updated, None, admin=True)})


async def admin_delete(request):
    user = require_permission(request, 'system_settings')
    connector, _ = owned(request, user, request.path_params['id'], admin=True)
    await _svc(request).delete(connector)
    return JSONResponse({'ok': True})


async def admin_calls(request):
    require_permission(request, 'system_settings')
    params = request.query_params
    try:
        connector = int(params['connector']) if params.get('connector') else None
        limit = int(params.get('limit', 100))
    except ValueError:
        raise McpError(400, 'invalid_arguments', 'connector and limit must be numbers') from None
    return JSONResponse({'calls': _svc(request).store.calls(connector, limit)})


def parse_networks(value):
    if not isinstance(value, list) or len(value) > 200:
        raise McpError(400, 'invalid_network', 'private_networks must be a list of at most 200 entries')
    entries = []
    for item in value:
        text = item.strip() if isinstance(item, str) else ''
        try:
            ipaddress.ip_network(text, strict=False)
        except ValueError:
            if not HOSTNAME.fullmatch(text) or '..' in text:
                raise McpError(400, 'invalid_network', f'Invalid entry: {str(item)[:100]}') from None
        entries.append(text)
    return list(dict.fromkeys(entries))


async def admin_settings(request):
    require_permission(request, 'system_settings')
    svc = _svc(request)
    if request.method == 'PUT':
        body = _fields(await body_json(request), {'private_networks'})
        svc.store.put_setting(SETTINGS_PRIVATE_NETWORKS, parse_networks(body.get('private_networks')))
    return JSONResponse({'private_networks': svc.private_networks()})


# -- channels ------------------------------------------------------------------------------------------------

def _channel(request, user_permission='manage_channels'):
    user = require_permission(request, user_permission)
    p = request.app.state.platform
    channel_id = request.path_params['id']
    with p.db.connect() as conn:
        if not conn.execute('SELECT 1 FROM channels WHERE id=? AND archived=0', (channel_id,)).fetchone():
            raise McpError(404, 'channel_not_found', 'Channel not found')
    return user, channel_id


def _channel_view(svc, channel_id):
    """What a channel manager sees: eligible connectors only, without administrator details (groups, OAuth client, secrets, errors)."""
    items = []
    for c in svc.store.org():
        if svc.channel_eligible(c):
            view = svc.view(c, None, admin=True)
            items.append({'id': c['id'], 'scope': 'org', 'name': c['name'], 'label': view['label'], 'transport': c['transport'], 'auth': c['auth'],
                          'enabled': c['enabled'], 'status': view['status'], 'origin': origin(c['url'])})
    eligible = {item['id'] for item in items}
    return {'connectors': items, 'connector_ids': [i for i in svc.store.channel_ids(channel_id) if i in eligible]}


async def channel_mcp(request):
    user, channel_id = _channel(request)
    svc = _svc(request)
    if request.method == 'PUT':
        body = _fields(await body_json(request), {'connector_ids'})
        ids = body.get('connector_ids')
        if not isinstance(ids, list) or len(ids) > 200 or any(not isinstance(i, int) or isinstance(i, bool) for i in ids):
            raise McpError(400, 'invalid_connectors', 'connector_ids must be a list of connector ids')
        eligible = {c['id'] for c in svc.store.org() if svc.channel_eligible(c)}
        svc.store.set_channel(channel_id, [i for i in dict.fromkeys(ids) if i in eligible], user['id'])
    return JSONResponse(_channel_view(svc, channel_id))


def routes():
    return [Route('/api/mcp/connectors', list_connectors), Route('/api/mcp/connectors', create_connector, methods=['POST']),
            Route('/api/mcp/connectors/{id:int}', patch_connector, methods=['PATCH']), Route('/api/mcp/connectors/{id:int}', delete_connector, methods=['DELETE']),
            Route('/api/mcp/connectors/{id:int}/connect', connect, methods=['POST']),
            Route('/api/mcp/connectors/{id:int}/confirm', confirm_connector, methods=['POST']),
            Route('/api/mcp/connectors/{id:int}/connection', disconnect, methods=['DELETE']),
            Route('/api/mcp/connectors/{id:int}/test', test_connector, methods=['POST']),
            Route('/api/mcp/connectors/{id:int}/catalog', catalog),
            Route('/api/mcp/connectors/{id:int}/credentials', put_credentials, methods=['PUT']),
            Route('/api/mcp/import/detected', detected), Route('/api/mcp/import', import_config, methods=['POST']),
            Route('/api/mcp/prompts', list_prompts), Route('/api/mcp/prompts/render', render_prompt, methods=['POST']),
            Route('/api/mcp/elicitations/{id}', answer_elicitation, methods=['POST']),
            Route('/api/admin/mcp/connectors', admin_list), Route('/api/admin/mcp/connectors', admin_create, methods=['POST']),
            Route('/api/admin/mcp/connectors/{id:int}', admin_patch, methods=['PATCH']), Route('/api/admin/mcp/connectors/{id:int}', admin_delete, methods=['DELETE']),
            Route('/api/admin/mcp/connectors/{id:int}/connect', admin_connect, methods=['POST']),
            Route('/api/admin/mcp/connectors/{id:int}/connection', admin_disconnect, methods=['DELETE']),
            Route('/api/admin/mcp/connectors/{id:int}/test', admin_test, methods=['POST']),
            Route('/api/admin/mcp/connectors/{id:int}/catalog', admin_catalog),
            Route('/api/admin/mcp/calls', admin_calls), Route('/api/admin/mcp/settings', admin_settings, methods=['GET', 'PUT']),
            Route('/api/channels/{id:int}/mcp', channel_mcp, methods=['GET', 'PUT'])]
