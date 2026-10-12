"""Real loopback ASGI servers (uvicorn on port 0) for the MCP network and OAuth tests: a fake authorization server and a fake protected resource."""
import asyncio
import base64
import contextlib
import hashlib
import json
import secrets
import time
from unittest.mock import patch
from types import SimpleNamespace
from urllib.parse import parse_qs

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from enterprise_agent_platform.db import Database
from httpcore2._backends.auto import AutoBackend

from enterprise_agent_platform.mcp import net
from enterprise_agent_platform.mcp.store import SecretStore


PUBLIC = '93.184.216.34'


class fake_network:
    """Real loopback servers behind public-looking `*.test` names: DNS answers come from `answers` (default: a public address)
    and every connection the guard has already approved is routed to 127.0.0.1. Usable with `with` and `async with`."""

    def __init__(self, answers=None):
        self.answers = answers if answers is not None else {}
        self.patches = []

    def __enter__(self):
        connect, real, answers = AutoBackend.connect_tcp, net.resolve, self.answers

        async def resolve(host, port):
            return answers.get(host, [PUBLIC]) if host.endswith('.test') else await real(host, port)

        async def route(backend, host, port, timeout=None, local_address=None, socket_options=None):
            known = {PUBLIC} | {address for item in answers.values() for address in item}
            return await connect(backend, '127.0.0.1' if host in known else host, port, timeout=timeout, local_address=local_address, socket_options=socket_options)

        self.patches = [patch.object(net, 'resolve', resolve), patch.object(AutoBackend, 'connect_tcp', route)]
        for item in self.patches:
            item.start()
        return answers

    def __exit__(self, *exc):
        for item in reversed(self.patches):
            item.stop()

    async def __aenter__(self):
        return self.__enter__()

    async def __aexit__(self, *exc):
        self.__exit__(*exc)


class QuietServer(uvicorn.Server):
    def capture_signals(self):
        return contextlib.nullcontext()


class Served:
    def __init__(self, app, host='mcp.test'):
        self.host = host
        self.server = QuietServer(uvicorn.Config(app, host='127.0.0.1', port=0, log_level='critical', lifespan='off'))
        self.task = None
        self.port = None

    async def __aenter__(self):
        self.task = asyncio.create_task(self.server.serve())
        while not self.server.started:
            await asyncio.sleep(0.01)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]
        return self

    @property
    def base(self):
        return f'http://{self.host}:{self.port}'

    async def __aexit__(self, *exc):
        self.server.should_exit = True
        await self.task


SERVE_AS = 'oauth.test'


class FakeAuthorizationServer:
    """Authorization server whose advertised capabilities each test chooses."""

    def __init__(self, *, s256=True, registration=True, cimd=False, expires_in=3600, secret=None):
        self.s256, self.registration, self.cimd, self.expires_in, self.secret = s256, registration, cimd, expires_in, secret
        self.served = None
        self.codes = {}
        self.access = {}      # access token -> client id
        self.reject_new = False
        self.refresh = {}     # refresh token -> client id
        self.registrations = []
        self.requests = []    # (method, path)
        self.token_requests = []
        self.refresh_status = 200
        self.counter = 0
        self.app = Starlette(routes=[
            Route('/.well-known/oauth-authorization-server', self.metadata),
            Route('/register', self.register, methods=['POST']),
            Route('/authorize', self.authorize),
            Route('/token', self.token, methods=['POST'])])

    @property
    def base(self):
        return self.served.base

    def mint(self, client_id):
        self.counter += 1
        access, refresh = f'at-{secrets.token_hex(8)}', f'rt-{secrets.token_hex(8)}'
        self.refresh[refresh] = client_id
        if not self.reject_new:
            self.access[access] = client_id
        return {'access_token': access, 'token_type': 'Bearer', 'expires_in': self.expires_in, 'refresh_token': refresh}

    async def metadata(self, request):
        self.requests.append(('GET', request.url.path))
        body = {'issuer': self.base, 'authorization_endpoint': self.base + '/authorize', 'token_endpoint': self.base + '/token',
                'response_types_supported': ['code'], 'grant_types_supported': ['authorization_code', 'refresh_token'],
                'token_endpoint_auth_methods_supported': ['client_secret_basic', 'none']}
        if self.s256:
            body['code_challenge_methods_supported'] = ['S256']
        if self.registration:
            body['registration_endpoint'] = self.base + '/register'
        if self.cimd:
            body['client_id_metadata_document_supported'] = True
        return JSONResponse(body)

    async def register(self, request):
        self.requests.append(('POST', request.url.path))
        body = await request.json()
        self.registrations.append(body)
        reply = {**body, 'client_id': 'dcr-client', 'token_endpoint_auth_method': 'none'}
        return JSONResponse(reply, status_code=201)

    async def authorize(self, request):
        """The browser leg: returns the redirect the AS would send the user to."""
        self.requests.append(('GET', request.url.path))
        query = dict(request.query_params)
        assert query['code_challenge_method'] == 'S256'
        code = f'code-{secrets.token_hex(8)}'
        self.codes[code] = query
        location = query['redirect_uri'] + '?' + 'code=' + code + '&state=' + query['state']
        return Response(status_code=302, headers={'location': location})

    async def token(self, request):
        self.requests.append(('POST', request.url.path))
        form = {key: values[0] for key, values in parse_qs((await request.body()).decode()).items()}
        self.token_requests.append({'form': form, 'authorization': request.headers.get('authorization')})
        if form['grant_type'] == 'authorization_code':
            issued = self.codes.pop(form.get('code'), None)
            if issued is None:
                return JSONResponse({'error': 'invalid_grant'}, status_code=400)
            digest = base64.urlsafe_b64encode(hashlib.sha256(form['code_verifier'].encode()).digest()).decode().rstrip('=')
            if digest != issued['code_challenge'] or form['redirect_uri'] != issued['redirect_uri']:
                return JSONResponse({'error': 'invalid_grant'}, status_code=400)
            return JSONResponse(self.mint(issued['client_id']))
        if self.refresh_status != 200 or form.get('refresh_token') not in self.refresh:
            return JSONResponse({'error': 'invalid_grant'}, status_code=self.refresh_status if self.refresh_status != 200 else 400)
        self.refresh.pop(form['refresh_token'])
        return JSONResponse(self.mint(form['client_id']))


class FakeResource:
    """Protected MCP endpoint at /mcp advertising `auth` as its authorization server."""

    def __init__(self, auth):
        self.auth = auth
        self.served = None
        self.calls = []       # (authorization header or None)
        self.hosts = []
        self.app = Starlette(routes=[
            Route('/.well-known/oauth-protected-resource/mcp', self.prm),
            Route('/mcp', self.mcp, methods=['GET', 'POST'])])

    @property
    def url(self):
        return self.served.base + '/mcp'

    async def prm(self, request):
        return JSONResponse({'resource': self.url, 'authorization_servers': [self.auth.base]})

    async def mcp(self, request):
        header = request.headers.get('authorization')
        self.calls.append(header)
        self.hosts.append(request.headers.get('host'))
        if header and header.removeprefix('Bearer ') in self.auth.access:
            return JSONResponse({'jsonrpc': '2.0', 'id': 0, 'result': {}})
        return Response(status_code=401, headers={'www-authenticate': f'Bearer resource_metadata="{self.served.base}/.well-known/oauth-protected-resource/mcp"'})


def allow(db, *entries):
    with db.connect() as conn:
        conn.execute('INSERT OR REPLACE INTO settings(key,value,secret,updated_at) VALUES(?,?,0,?)', (net.SETTING, json.dumps(list(entries)), int(time.time())))


def platform(root, public_base_url='http://127.0.0.1:8765'):
    db = Database(root / 'platform.db')
    db.migrate(root)
    with db.connect() as conn:
        for ident in (1, 2):
            conn.execute('INSERT INTO users(id,username,display_name,password_hash,timezone,created_at) VALUES(?,?,?,?,?,?)',
                         (ident, f'user{ident}', 'User', 'unused', 'UTC', int(time.time())))
    invalidated = []

    async def invalidate(connector_id, owner):
        invalidated.append((connector_id, owner))

    mcp = SimpleNamespace(secrets=SecretStore(db), guarded_client=lambda platform, **kw: net.guarded_client(platform, **kw),
                          connections=SimpleNamespace(invalidate=invalidate))
    settings = SimpleNamespace(public_base_url=public_base_url, session_secret='test-secret', data_dir=root)
    return SimpleNamespace(db=db, settings=settings, mcp=mcp, invalidated=invalidated)


def connector(p, url, *, name='notion', scope='org', mode='per_user', transport='http', oauth=None, owner_user_id=None):
    with p.db.connect() as conn:
        cid = conn.execute("INSERT INTO mcp_connectors(scope,owner_user_id,name,label,transport,url,auth,credential_mode,oauth_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'oauth',?,?,?,?)",
                           (scope, owner_user_id, name, name.title(), transport, url, mode, json.dumps(oauth or {}), int(time.time()), int(time.time()))).lastrowid
    return {'id': cid, 'scope': scope, 'name': name, 'label': name.title(), 'url': url, 'transport': transport, 'oauth': oauth or {}}
