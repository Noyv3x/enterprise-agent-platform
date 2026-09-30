"""Deployment-owned Codex device authorization and credential refresh."""
import asyncio
import json
import secrets
import time

import httpx
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route

from .admin import setting
from .auth import body_json, current_user, require_internal, unb64

AUTH = 'https://auth.openai.com'
BASE = 'https://chatgpt.com/backend-api/codex'
CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
KEYS = ('CODEX_OAUTH_ACCESS_TOKEN', 'CODEX_OAUTH_REFRESH_TOKEN', 'CODEX_OAUTH_EXPIRES_AT')


class OAuth:
    def __init__(self, platform):
        self.platform = platform
        self.lock = asyncio.Lock()
        self.flows = {}
        self.models = None
        self.catalog_until = 0

    def credentials(self):
        with self.platform.db.connect() as conn:
            rows = conn.execute('SELECT key,value FROM settings WHERE key IN (?,?,?)', KEYS)
            return {row['key']: row['value'] for row in rows}

    async def request(self, method, url, **kwargs):
        try:
            response = await self.platform.http.request(method, url, timeout=30, **kwargs)
        except httpx.HTTPError:
            raise HTTPException(502, 'OAuth provider unavailable') from None
        return response

    def save(self, payload, previous_refresh=''):
        access = payload.get('access_token')
        if not isinstance(access, str) or not access:
            raise HTTPException(502, 'OAuth response has no access token')
        try:
            expiry = time.time() + max(60, float(payload.get('expires_in', 3600)))
        except (ValueError, TypeError):
            raise HTTPException(502, 'Invalid OAuth expiry') from None
        with self.platform.db.connect() as conn:
            for key, value, secret in ((KEYS[0], access, 1), (KEYS[1], payload.get('refresh_token') or previous_refresh, 1), (KEYS[2], str(expiry), 0)):
                setting(conn, key, value, secret)
        self.models = None
        self.catalog_until = 0

    async def token(self, force_refresh=False):
        async with self.lock:
            credentials = self.credentials()
            if not credentials.get(KEYS[0]):
                raise HTTPException(409, 'Connect a Codex account first')
            expires = float(credentials.get(KEYS[2]) or 0)
            if force_refresh or expires <= time.time() + 90:
                refresh = credentials.get(KEYS[1])
                if not refresh:
                    raise HTTPException(409, 'Reconnect the Codex account')
                response = await self.request('POST', AUTH + '/oauth/token', data={'grant_type': 'refresh_token', 'refresh_token': refresh, 'client_id': CLIENT_ID})
                if response.status_code != 200:
                    raise HTTPException(502, 'Codex refresh failed; reconnect the account')
                self.save(self.payload(response), refresh)
                credentials = self.credentials()
            return credentials

    @staticmethod
    def payload(response):
        try:
            value = response.json()
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except ValueError:
            raise HTTPException(502, 'Invalid OAuth provider response') from None

    async def catalog(self):
        if not self.credentials().get(KEYS[0]):
            return {'models': [], 'connected': False}
        credentials = await self.token()
        if self.models is not None and time.time() < self.catalog_until:
            return {'models': self.models, 'connected': True}
        headers = {'Authorization': 'Bearer ' + credentials[KEYS[0]]}
        try:
            claims = json.loads(unb64(credentials[KEYS[0]].split('.')[1]))
            account = claims.get('https://api.openai.com/auth', {}).get('chatgpt_account_id')
            if account:
                headers['ChatGPT-Account-Id'] = account
        except (ValueError, IndexError, TypeError):
            pass
        response = await self.request('GET', BASE + '/models', params={'client_version': '1.0.0'}, headers=headers)
        if response.status_code != 200:
            raise HTTPException(503, 'Codex model catalog unavailable')
        models = self.payload(response).get('models')
        if not isinstance(models, list):
            raise HTTPException(503, 'Invalid Codex model catalog')
        self.models = []
        for model in models:
            if not isinstance(model, dict) or model.get('visibility', 'list') == 'hide':
                continue
            model_id = model.get('slug') or model.get('id')
            if not isinstance(model_id, str) or not model_id:
                continue
            entry = {'id': model_id, 'name': model.get('display_name') or model.get('name') or model_id}
            for target, sources in (
                ('contextWindow', ('context_window', 'contextWindow')),
                ('maxTokens', ('max_output_tokens', 'max_tokens', 'maxTokens')),
            ):
                for source in sources:
                    value = model.get(source)
                    if type(value) is int and value > 0:
                        entry[target] = value
                        break
            self.models.append(entry)
        self.catalog_until = time.time() + 600
        return {'models': self.models, 'connected': True}

    async def resolve(self, model, force_refresh=False):
        if not isinstance(model, str) or not model:
            raise HTTPException(400, 'Model required')
        credentials = await self.token(force_refresh)
        catalog = await self.catalog()
        if model not in {entry['id'] for entry in catalog['models']}:
            raise HTTPException(409, 'Model is not available')
        return {'provider': 'openai-codex', 'access_token': credentials[KEYS[0]], 'token_type': 'Bearer', 'expires_at': float(credentials[KEYS[2]]), 'base_url': BASE, 'model': model}

    async def start(self):
        response = await self.request('POST', AUTH + '/api/accounts/deviceauth/usercode', json={'client_id': CLIENT_ID})
        if response.status_code != 200:
            raise HTTPException(502, 'Unable to start Codex authorization')
        payload = self.payload(response)
        if not payload.get('device_auth_id') or not payload.get('user_code'):
            raise HTTPException(502, 'Invalid device authorization response')
        flow_id = secrets.token_urlsafe(24)
        flow = {'flow_id': flow_id, 'provider': 'openai-codex', 'kind': 'device_code', 'status': 'waiting_for_user', 'complete': False, 'expires_at': time.time() + float(payload.get('expires_in', 900)), 'verification_url': AUTH + '/codex/device', 'user_code': payload['user_code'], 'poll_interval': max(1, int(payload.get('interval', 5)))}
        self.flows = {key: value for key, value in self.flows.items() if value['public']['expires_at'] > time.time()}
        self.flows[flow_id] = {'public': flow, 'device_auth_id': payload['device_auth_id'], 'next_poll': 0}
        return flow

    async def poll(self, flow_id):
        async with self.lock:
            flow = self.flows.get(flow_id)
            if flow is None or flow['public']['expires_at'] <= time.time():
                raise HTTPException(410, 'Authorization flow expired')
            public = flow['public']
            if public['complete'] or flow['next_poll'] > time.time():
                return public
            flow['next_poll'] = time.time() + public['poll_interval']
            response = await self.request('POST', AUTH + '/api/accounts/deviceauth/token', json={'device_auth_id': flow['device_auth_id'], 'user_code': public['user_code']})
            if response.status_code in (403, 404):
                return public
            if response.status_code != 200:
                raise HTTPException(502, 'Device authorization failed')
            payload = self.payload(response)
            if not payload.get('authorization_code') or not payload.get('code_verifier'):
                raise HTTPException(502, 'Invalid device authorization exchange')
            response = await self.request('POST', AUTH + '/oauth/token', data={'grant_type': 'authorization_code', 'client_id': CLIENT_ID, 'code': payload['authorization_code'], 'code_verifier': payload['code_verifier'], 'redirect_uri': AUTH + '/deviceauth/callback'})
            if response.status_code != 200:
                raise HTTPException(502, 'OAuth code exchange failed')
            self.save(self.payload(response))
            public.update(status='complete', complete=True)
            return public


async def models(request):
    current_user(request, admin=True)
    return JSONResponse(await request.app.state.platform.oauth.catalog())


async def start(request):
    current_user(request, admin=True)
    return JSONResponse(await request.app.state.platform.oauth.start())


async def poll(request):
    current_user(request, admin=True)
    return JSONResponse(await request.app.state.platform.oauth.poll(request.path_params['flow_id']))


async def disconnect(request):
    current_user(request, admin=True)
    oauth = request.app.state.platform.oauth
    async with oauth.lock:
        with oauth.platform.db.connect() as conn:
            conn.execute('DELETE FROM settings WHERE key IN (?,?,?)', KEYS)
        oauth.models = None
        oauth.flows.clear()
    return JSONResponse({'ok': True})


async def resolve(request):
    require_internal(request)
    body = await body_json(request)
    if set(body) - {'provider', 'model', 'scope_key', 'force_refresh'} or body.get('provider') != 'openai-codex' or type(body.get('force_refresh', False)) is not bool:
        raise HTTPException(400, 'Invalid credential request')
    return JSONResponse(await request.app.state.platform.oauth.resolve(body.get('model'), body.get('force_refresh', False)))


def routes():
    return [Route('/api/admin/models', models), Route('/api/admin/oauth/start', start, methods=['POST']), Route('/api/admin/oauth/{flow_id}/poll', poll, methods=['POST']), Route('/api/admin/oauth', disconnect, methods=['DELETE']), Route('/api/agent/tools/credentials/resolve', resolve, methods=['POST'])]
