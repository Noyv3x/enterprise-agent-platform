import asyncio
import base64
import json
import logging
import re
import tempfile
import time
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

import httpx
import httpx2
from starlette.applications import Starlette

from enterprise_agent_platform.auth import COOKIE_NAME, issue_session
from enterprise_agent_platform.mcp import net, oauth
from enterprise_agent_platform.mcp.models import McpError
from enterprise_agent_platform.mcp.oauth import OAuthManager
from mcp_oauth_support import FakeAuthorizationServer, FakeResource, Served, allow, connector, fake_network, platform

CALLBACK = '/api/mcp/oauth/callback'


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.text = []

    def emit(self, record):
        if not record.name.startswith(('httpx2', 'httpcore2', 'mcp', 'enterprise_agent_platform')):
            return  # The tests' own browser and servers are not the Platform.
        self.text.append(self.format(record))
        if record.exc_info:
            self.text.append(logging.Formatter().formatException(record.exc_info))


class OAuthCase(unittest.IsolatedAsyncioTestCase):
    base = 'http://127.0.0.1:8765'

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.p = platform(Path(self.temp.name), self.base)
        self.oauth = self.p.mcp.oauth = OAuthManager(self.p)
        self.app = Starlette(routes=self.oauth.routes())
        self.app.state.platform = self.p
        self.stack = AsyncExitStack()
        self.dns = self.stack.enter_context(fake_network())
        loopback = self.real_loopback = oauth.loopback  # The fake authorization server speaks plain http under a `.test` name.
        self.stack.enter_context(patch.object(oauth, 'loopback', lambda host: host.endswith('.test') or loopback(host)))
        self.web = await self.stack.enter_async_context(httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url=self.base))
        self.browser = await self.stack.enter_async_context(httpx.AsyncClient(follow_redirects=False))
        self.logs = Capture()
        logging.getLogger().addHandler(self.logs)
        self.old_level = logging.getLogger().level
        logging.getLogger().setLevel(logging.DEBUG)

    async def asyncTearDown(self):
        logging.getLogger().removeHandler(self.logs)
        logging.getLogger().setLevel(self.old_level)
        for flow in list(self.oauth.active.values()):
            self.oauth._discard(flow)
        await self.stack.aclose()
        self.temp.cleanup()

    async def serve(self, **kwargs):
        auth = FakeAuthorizationServer(**kwargs)
        auth.served = await self.stack.enter_async_context(Served(auth.app, 'oauth.test'))
        resource = FakeResource(auth)
        resource.served = await self.stack.enter_async_context(Served(resource.app))
        return auth, resource

    def cookie(self, user_id):
        with self.p.db.connect() as conn:
            row = conn.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
        return {COOKIE_NAME: issue_session(self.p.settings, row)}

    def cookie_header(self, user_id):
        return {'cookie': f'{COOKIE_NAME}={self.cookie(user_id)[COOKIE_NAME]}'}

    async def consent(self, url, user=1, **override):
        """The browser leg: the authorization server redirects back, the browser calls our callback."""
        redirect = await self.browser.get(re.sub(r'^http://[^:/]+', 'http://127.0.0.1', url))
        query = {key: values[0] for key, values in parse_qs(urlsplit(redirect.headers['location']).query).items()}
        query.update(override)
        return await self.web.get(CALLBACK, params=query, headers=self.cookie_header(user) if user else None), query

    def page(self, response):
        return json.loads(re.search(r'const m=(\{.*?\});try', response.text).group(1))

    async def connect(self, conn, owner=1, actor=1):
        url = await self.oauth.begin(conn, owner, actor)
        response, query = await self.consent(url, user=actor)
        self.assertEqual(response.status_code, 200, response.text)
        await asyncio.sleep(0.1)  # Let the server finish with the abandoned post-authorization probe.
        return url, response, query

    async def call(self, conn, owner):
        async with net.guarded_client(self.p, auth=self.oauth.auth_for(conn, owner)) as client:
            return await client.post(conn['url'], json={'jsonrpc': '2.0', 'id': 1, 'method': 'ping'})

    def tokens(self, conn, owner):
        row = self.p.mcp.secrets.get(conn['id'], owner, 'oauth_tokens', 'tokens')
        return (json.loads(row[0]), row[1]) if row else None

    def expire(self, conn, owner):
        value, issuer = self.tokens(conn, owner)[0], self.tokens(conn, owner)[1]
        value['expires_at'] = time.time() - 10
        self.p.mcp.secrets.put(conn['id'], owner, 'oauth_tokens', 'tokens', json.dumps(value), issuer)

    def assertNoSecrets(self, auth, *extra):
        secrets_seen = [*auth.access, *auth.refresh, *extra]
        self.assertTrue(secrets_seen)
        logged = '\n'.join(self.logs.text)
        for secret in secrets_seen:
            self.assertNotIn(secret, logged)


class FlowTests(OAuthCase):
    async def test_authorization_code_flow_with_pkce_and_dynamic_registration(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url, oauth={'scopes': ['read', 'write']})
        url = await self.oauth.begin(conn, 1, 1)
        query = {key: values[0] for key, values in parse_qs(urlsplit(url).query).items()}
        self.assertTrue(url.startswith(auth.base + '/authorize?'))
        self.assertEqual((query['response_type'], query['code_challenge_method'], query['client_id'], query['scope'], query['resource']),
                         ('code', 'S256', 'dcr-client', 'read write', resource.url))
        self.assertEqual(query['redirect_uri'], self.base + CALLBACK)
        self.assertEqual(len(auth.registrations), 1)
        self.assertEqual((auth.registrations[0]['application_type'], auth.registrations[0]['redirect_uris']), ('web', [self.base + CALLBACK]))
        self.assertIn(query['state'], self.oauth.flows)
        self.assertFalse(self.oauth.connected(conn['id'], 1))

        response, _ = await self.consent(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn('已连接 Notion，可以关闭此页', response.text)
        self.assertEqual(self.page(response), {'type': 'mcp-connected', 'connector': conn['id'], 'label': 'Notion'})
        self.assertIn('window.opener.postMessage(m,location.origin)', response.text)
        self.assertIn("BroadcastChannel('mcp-oauth')", response.text)
        self.assertNotIn(query['state'], self.oauth.flows)
        self.assertEqual(self.p.invalidated, [(conn['id'], 1)])
        self.assertTrue(self.oauth.connected(conn['id'], 1))
        stored, issuer = self.tokens(conn, 1)
        self.assertEqual(issuer, auth.base)
        self.assertEqual(stored['tokens']['access_token'] in auth.access, True)
        exchange = auth.token_requests[0]['form']
        self.assertEqual((exchange['grant_type'], exchange['redirect_uri'], exchange['client_id']), ('authorization_code', self.base + CALLBACK, 'dcr-client'))
        self.assertEqual(len(exchange['code_verifier']), 128)

        before = len(resource.calls)
        reply = await self.call(conn, 1)  # A later call presents the stored token without any new flow.
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(resource.calls[before], 'Bearer ' + stored['tokens']['access_token'])
        self.assertEqual(len(auth.token_requests), 1)
        self.assertNoSecrets(auth)

    async def test_state_mismatch_replay_and_expiry(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url)
        url = await self.oauth.begin(conn, 1, 1)
        state = parse_qs(urlsplit(url).query)['state'][0]

        forged, _ = await self.consent(url, state='forged-state')
        self.assertEqual(forged.status_code, 400)
        self.assertEqual(self.page(forged)['type'], 'mcp-connect-failed')
        self.assertEqual(self.page(forged)['code'], 'oauth_state_invalid')
        self.assertFalse(self.oauth.connected(conn['id'], 1))
        self.assertIn(state, self.oauth.flows)  # The real flow is untouched by a forged callback.

        # The authorization code from one browser leg cannot be completed under another pending state.
        other = await self.oauth.begin(connector(self.p, resource.url, name='other'), 1, 1)
        other_state = parse_qs(urlsplit(other).query)['state'][0]
        crossed, _ = await self.consent(url, state=other_state)
        self.assertEqual(crossed.status_code, 502)
        self.assertEqual(self.page(crossed)['code'], 'oauth_failed')

        ok, query = await self.consent(url)
        self.assertEqual(ok.status_code, 200)
        exchanged = len(auth.token_requests)
        replay = await self.web.get(CALLBACK, params=query, headers=self.cookie_header(1))
        self.assertEqual(len(auth.token_requests), exchanged)
        self.assertEqual((replay.status_code, self.page(replay)['code']), (400, 'oauth_state_invalid'))

        late_conn = connector(self.p, resource.url, name='late')
        late = await self.oauth.begin(late_conn, 1, 1)
        real = time.monotonic()
        with patch.object(oauth, 'clock', lambda: real + oauth.FLOW_SECONDS + 1):
            expired, _ = await self.consent(late)
        self.assertEqual((expired.status_code, self.page(expired)['code']), (400, 'oauth_state_invalid'))
        self.assertFalse(self.oauth.connected(late_conn['id'], 1))
        self.assertNotIn(parse_qs(urlsplit(late).query)['state'][0], self.oauth.flows)

    async def test_pending_flow_times_out_by_itself(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url)
        with patch.object(oauth, 'FLOW_SECONDS', 0.2):
            url = await self.oauth.begin(conn, 1, 1)
            state = parse_qs(urlsplit(url).query)['state'][0]
            flow = self.oauth.flows[state]
            await flow.task
        self.assertEqual(flow.error.code, 'oauth_state_invalid')
        self.assertNotIn(state, self.oauth.flows)
        self.assertNotIn((conn['id'], 1), self.oauth.active)

    async def test_callback_needs_the_user_who_started_the_flow(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url)
        url = await self.oauth.begin(conn, 1, 1)
        stranger, _ = await self.consent(url, user=2)
        self.assertEqual(self.page(stranger)['type'], 'mcp-connect-failed')
        self.assertFalse(self.oauth.connected(conn['id'], 1))
        url = await self.oauth.begin(conn, 1, 1)
        anonymous, _ = await self.consent(url, user=None)
        self.assertEqual(self.page(anonymous)['type'], 'mcp-connect-failed')
        self.assertFalse(self.oauth.connected(conn['id'], 1))
        self.assertEqual(auth.token_requests, [])

    async def test_user_denial_is_reported(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url)
        url = await self.oauth.begin(conn, 1, 1)
        state = parse_qs(urlsplit(url).query)['state'][0]
        response = await self.web.get(CALLBACK, params={'error': 'access_denied', 'state': state}, headers=self.cookie_header(1))
        self.assertEqual(self.page(response)['code'], 'oauth_failed')
        self.assertEqual(self.page(response)['connector'], conn['id'])

    async def test_page_escapes_everything(self):
        page = self.oauth.page(None, '</script><b>x', McpError(400, 'oauth_failed', '</script><script>alert(1)</script>'))
        self.assertNotIn('<script>alert', page.body.decode())
        self.assertEqual(page.body.decode().count('<script'), 1)
        self.assertIn("script-src 'nonce-", page.headers['content-security-policy'])

    async def test_legacy_sse_connectors_are_probed_with_a_get(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url, transport='sse')
        url, _, _ = await self.connect(conn)
        self.assertTrue(url.startswith(auth.base + '/authorize?'))
        self.assertTrue(self.oauth.connected(conn['id'], 1))

    async def test_client_metadata_document(self):
        response = await self.web.get('/api/mcp/oauth/client.json')
        self.assertEqual(response.status_code, 200)
        document = response.json()
        self.assertEqual((document['client_id'], document['redirect_uris'], document['application_type'], document['token_endpoint_auth_method']),
                         (self.base + '/api/mcp/oauth/client.json', [self.base + CALLBACK], 'web', 'none'))


class RegistrationTests(OAuthCase):
    async def test_preregistered_client_is_used_and_bound_to_the_issuer(self):
        auth, resource = await self.serve(registration=False)
        conn = connector(self.p, resource.url)
        self.p.mcp.secrets.put(conn['id'], None, 'oauth_client', 'client', json.dumps({'client_id': 'pre-client', 'client_secret': 'sh-secret'}), '')
        url, _, _ = await self.connect(conn)
        self.assertEqual(parse_qs(urlsplit(url).query)['client_id'], ['pre-client'])
        self.assertEqual(auth.registrations, [])
        basic = base64.b64encode(b'pre-client:sh-secret').decode()
        self.assertEqual(auth.token_requests[0]['authorization'], 'Basic ' + basic)
        self.assertEqual(self.p.mcp.secrets.get(conn['id'], None, 'oauth_client', 'client')[1], auth.base)
        self.assertNoSecrets(auth, 'sh-secret')

    async def test_preregistered_client_bound_to_another_issuer_is_refused(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url)
        self.p.mcp.secrets.put(conn['id'], None, 'oauth_client', 'client', json.dumps({'client_id': 'pre-client'}), 'https://other-issuer.example/')
        with self.assertRaises(McpError) as caught:
            await self.oauth.begin(conn, 1, 1)
        self.assertEqual(caught.exception.code, 'oauth_failed')
        self.assertEqual(auth.registrations, [])

    async def test_cimd_is_used_on_https_when_advertised(self):
        self.p.settings.public_base_url = 'https://platform.example'
        auth, resource = await self.serve(cimd=True)
        conn = connector(self.p, resource.url)
        url, _, _ = await self.connect(conn)
        self.assertEqual(parse_qs(urlsplit(url).query)['client_id'], ['https://platform.example/api/mcp/oauth/client.json'])
        self.assertEqual(parse_qs(urlsplit(url).query)['redirect_uri'], ['https://platform.example' + CALLBACK])
        self.assertEqual(auth.registrations, [])

    async def test_cimd_is_not_used_on_plain_http(self):
        auth, resource = await self.serve(cimd=True)
        conn = connector(self.p, resource.url)
        url, _, _ = await self.connect(conn)
        self.assertEqual(parse_qs(urlsplit(url).query)['client_id'], ['dcr-client'])
        self.assertEqual(len(auth.registrations), 1)

    async def test_dcr_is_used_on_https_without_cimd_support(self):
        self.p.settings.public_base_url = 'https://platform.example'
        auth, resource = await self.serve(cimd=False)
        conn = connector(self.p, resource.url)
        url, _, _ = await self.connect(conn)
        self.assertEqual(parse_qs(urlsplit(url).query)['client_id'], ['dcr-client'])
        self.assertEqual(len(auth.registrations), 1)

    async def test_no_registration_option_is_a_typed_error_and_nothing_is_guessed(self):
        auth, resource = await self.serve(registration=False, cimd=False)
        conn = connector(self.p, resource.url)
        with self.assertRaises(McpError) as caught:
            await self.oauth.begin(conn, 1, 1)
        self.assertEqual((caught.exception.status_code, caught.exception.code), (409, 'oauth_registration_required'))
        self.assertEqual([item for item in auth.requests if item[0] == 'POST'], [])  # No guessed /register, no token call.
        self.assertEqual(self.oauth.flows, {})
        # An administrator's manual client resolves it.
        self.p.mcp.secrets.put(conn['id'], None, 'oauth_client', 'client', json.dumps({'client_id': 'manual'}), '')
        url = await self.oauth.begin(conn, 1, 1)
        self.assertEqual(parse_qs(urlsplit(url).query)['client_id'], ['manual'])

    async def test_servers_without_s256_are_refused_before_any_registration(self):
        auth, resource = await self.serve(s256=False)
        conn = connector(self.p, resource.url)
        with self.assertRaises(McpError) as caught:
            await self.oauth.begin(conn, 1, 1)
        self.assertEqual(caught.exception.code, 'oauth_pkce_unsupported')
        self.assertEqual([item for item in auth.requests if item[0] == 'POST'], [])
        self.p.mcp.secrets.put(conn['id'], None, 'oauth_client', 'client', json.dumps({'client_id': 'pre'}), '')
        with self.assertRaises(McpError) as caught:  # Also when a client is already registered.
            await self.oauth.begin(conn, 1, 1)
        self.assertEqual(caught.exception.code, 'oauth_pkce_unsupported')

    async def test_plain_http_non_loopback_needs_https(self):
        for base, warning in (('http://platform.lan', 'https_required'), ('http://192.168.1.5:8080', 'https_required'), ('https://platform.example', None),
                              ('http://127.0.0.1:8765', None), ('http://localhost:8080', None), ('http://[::1]:8080', None)):
            with self.subTest(base=base):
                self.p.settings.public_base_url = base
                self.assertEqual(self.oauth.warning(), warning)
        self.p.settings.public_base_url = 'http://platform.lan'
        with self.assertRaises(McpError) as caught:
            await self.oauth.begin({'id': 1, 'url': 'https://x.example/mcp'}, 1, 1)
        self.assertEqual(caught.exception.code, 'oauth_https_required')

    async def test_all_oauth_traffic_goes_through_the_network_guard(self):
        auth, resource = await self.serve()
        self.dns['mcp.test'] = ['10.1.1.1']
        conn = connector(self.p, resource.url)
        with self.assertRaises(McpError) as caught:  # An internal address needs the administrator's allowlist.
            await self.oauth.begin(conn, 1, 1)
        self.assertEqual(caught.exception.code, 'mcp_network_blocked')
        allow(self.p.db, '10.0.0.0/8')
        self.assertIsInstance(await self.oauth.begin(conn, 1, 1), str)
        mine = connector(self.p, resource.url, name='mine', scope='personal', owner_user_id=1)
        with self.assertRaises(McpError) as caught:  # The allowlist never applies to personal connectors.
            await self.oauth.begin(mine, 1, 1)
        self.assertEqual(caught.exception.code, 'mcp_network_blocked')

    async def test_authorization_server_on_a_private_address_is_refused_even_if_the_resource_is_allowed(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url)
        allow(self.p.db, 'mcp.test')
        self.dns['mcp.test'] = ['10.1.1.1']
        self.dns['oauth.test'] = ['10.9.9.9']
        with self.assertRaises(McpError) as caught:
            await self.oauth.begin(conn, 1, 1)
        self.assertEqual(caught.exception.code, 'mcp_network_blocked')
        self.assertEqual(auth.requests, [])

    async def test_authorize_url_must_be_https_or_loopback(self):
        with patch.object(oauth, 'loopback', self.real_loopback):
            for url, ok in (('https://as.example/authorize?x=1', True), ('http://127.0.0.1:9/authorize', True), ('http://localhost/authorize', True),
                            ('http://as.example/authorize', False), ('javascript:alert(1)', False), ('https://u:p@as.example/a', False), ('//as.example/a', False),
                            ('data:text/html,x', False)):
                with self.subTest(url=url):
                    self.assertEqual(oauth.safe_authorize_url(url), ok)

    async def test_plain_http_authorization_endpoint_is_refused(self):
        auth, resource = await self.serve()
        with patch.object(oauth, 'loopback', self.real_loopback):
            conn = connector(self.p, resource.url)
            with self.assertRaises(McpError) as caught:
                await self.oauth.begin(conn, 1, 1)
        self.assertEqual(caught.exception.code, 'oauth_failed')
        self.assertEqual(self.oauth.flows, {})
        self.assertEqual([item for item in auth.requests if item[0] == 'POST'], [item for item in auth.requests if item == ('POST', '/register')])


class TokenLifecycleTests(OAuthCase):
    async def connected(self, **kwargs):
        auth, resource = await self.serve(**kwargs)
        conn = connector(self.p, resource.url)
        await self.connect(conn)
        return auth, resource, conn

    async def test_issuer_binding(self):
        auth, resource, conn = await self.connected()
        stored, issuer = self.tokens(conn, 1)
        self.assertEqual(issuer, auth.base)
        self.p.mcp.secrets.put(conn['id'], 1, 'oauth_tokens', 'tokens', json.dumps(stored), 'https://evil.example/')
        self.assertFalse(self.oauth.connected(conn['id'], 1))
        before = (len(resource.calls), len(auth.token_requests))
        with self.assertRaises(McpError) as caught:
            await self.call(conn, 1)
        self.assertEqual((caught.exception.status_code, caught.exception.code), (409, 'needs_auth'))
        self.assertNotIn('Bearer', ' '.join(str(item) for item in resource.calls[before[0]:]))  # The foreign-issuer token is never presented.
        self.assertEqual(len(auth.token_requests), before[1])

    async def test_refresh_when_the_token_has_expired(self):
        auth, resource, conn = await self.connected()
        old = self.tokens(conn, 1)[0]['tokens']
        self.expire(conn, 1)
        reply = await self.call(conn, 1)
        self.assertEqual(reply.status_code, 200)
        refresh = auth.token_requests[-1]['form']
        self.assertEqual((refresh['grant_type'], refresh['refresh_token'], refresh['client_id']), ('refresh_token', old['refresh_token'], 'dcr-client'))
        new = self.tokens(conn, 1)[0]
        self.assertNotEqual(new['tokens']['access_token'], old['access_token'])
        self.assertGreater(new['expires_at'], time.time())
        self.assertEqual(resource.calls[-1], 'Bearer ' + new['tokens']['access_token'])
        self.assertNoSecrets(auth)

    async def test_a_revoked_token_is_refreshed_and_retried_exactly_once(self):
        auth, resource, conn = await self.connected()
        auth.access.clear()  # Revoked server-side although not expired.
        before, grants = len(resource.calls), len(auth.token_requests)
        reply = await self.call(conn, 1)
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(len(resource.calls) - before, 2)
        self.assertEqual([item['form']['grant_type'] for item in auth.token_requests[grants:]], ['refresh_token'])

    async def test_a_second_401_after_refresh_needs_auth_without_looping(self):
        auth, resource, conn = await self.connected()
        auth.access.clear()
        auth.reject_new = True
        before, grants = len(resource.calls), len(auth.token_requests)
        with self.assertRaises(McpError) as caught:
            await self.call(conn, 1)
        self.assertEqual((caught.exception.status_code, caught.exception.code), (409, 'needs_auth'))
        self.assertEqual(len(resource.calls) - before, 2)
        self.assertEqual(len(auth.token_requests) - grants, 1)

    async def test_a_refused_refresh_removes_the_tokens(self):
        auth, resource, conn = await self.connected()
        self.expire(conn, 1)
        auth.refresh_status = 400
        with self.assertRaises(McpError) as caught:
            await self.call(conn, 1)
        self.assertEqual((caught.exception.status_code, caught.exception.code), (409, 'needs_auth'))
        self.assertIsNone(self.tokens(conn, 1))
        self.assertFalse(self.oauth.connected(conn['id'], 1))

    async def test_an_unreachable_authorization_server_keeps_the_tokens(self):
        auth, resource, conn = await self.connected()
        self.expire(conn, 1)
        auth.refresh_status = 503
        with self.assertRaises(McpError):
            await self.call(conn, 1)
        self.assertIsNotNone(self.tokens(conn, 1))

    async def test_refresh_survives_a_restart_and_uses_the_verified_token_endpoint(self):
        auth, resource, conn = await self.connected()
        self.expire(conn, 1)
        self.p.mcp.oauth = self.oauth = OAuthManager(self.p)  # A fresh process knows nothing in memory.
        reply = await self.call(conn, 1)
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(auth.token_requests[-1]['form']['grant_type'], 'refresh_token')
        # The token request went to the authorization server found at connect time, not to a guessed path on the resource.
        self.assertEqual([item for item in resource.calls if item is None], resource.calls[:len([item for item in resource.calls if item is None])])

    async def test_disconnect_deletes_the_tokens_only(self):
        auth, resource, conn = await self.connected()
        self.assertTrue(self.oauth.connected(conn['id'], 1))
        await self.oauth.disconnect(conn['id'], 1)
        self.assertIsNone(self.p.mcp.secrets.get(conn['id'], 1, 'oauth_tokens', 'tokens'))
        self.assertFalse(self.oauth.connected(conn['id'], 1))
        self.assertIsNotNone(self.p.mcp.secrets.get(conn['id'], None, 'oauth_client', 'dcr'))
        with self.assertRaises(McpError) as caught:
            await self.call(conn, 1)
        self.assertEqual((caught.exception.status_code, caught.exception.code), (409, 'needs_auth'))

    async def test_disconnect_cancels_a_pending_flow(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url)
        url = await self.oauth.begin(conn, 1, 1)
        await self.oauth.disconnect(conn['id'], 1)
        response, _ = await self.consent(url)
        self.assertEqual(self.page(response)['code'], 'oauth_state_invalid')
        self.assertFalse(self.oauth.connected(conn['id'], 1))

    async def test_owners_and_connectors_are_isolated(self):
        auth, resource = await self.serve()
        mine = connector(self.p, resource.url, name='mine', mode='per_user')
        await self.connect(mine, owner=1, actor=1)
        self.assertEqual((self.oauth.connected(mine['id'], 1), self.oauth.connected(mine['id'], 2), self.oauth.connected(mine['id'], None)), (True, False, False))
        self.assertEqual((await self.call(mine, 1)).status_code, 200)
        before = len(resource.calls)
        for owner in (2, None):
            with self.assertRaises(McpError) as caught:
                await self.call(mine, owner)
            self.assertEqual((caught.exception.status_code, caught.exception.code), (409, 'needs_auth'))
        self.assertEqual([item for item in resource.calls[before:]], [None, None])  # They were never given user 1's token.

        shared = connector(self.p, resource.url, name='shared', mode='shared')
        await self.connect(shared, owner=None, actor=1)
        self.assertEqual((self.oauth.connected(shared['id'], None), self.oauth.connected(shared['id'], 1), self.oauth.connected(shared['id'], 2)), (True, False, False))
        self.assertEqual((await self.call(shared, None)).status_code, 200)
        self.assertEqual(self.tokens(mine, 1)[0]['tokens']['access_token'] == self.tokens(shared, None)[0]['tokens']['access_token'], False)
        other = connector(self.p, resource.url, name='twin', mode='per_user')
        self.assertFalse(self.oauth.connected(other['id'], 1))

    async def test_no_token_or_secret_leaves_through_pages_errors_or_logs(self):
        auth, resource = await self.serve()
        conn = connector(self.p, resource.url)
        self.p.mcp.secrets.put(conn['id'], None, 'oauth_client', 'client', json.dumps({'client_id': 'pre', 'client_secret': 'very-secret-value'}), '')
        url = await self.oauth.begin(conn, 1, 1)
        response, query = await self.consent(url)
        blobs = [url, response.text, json.dumps(dict(response.headers))]
        self.expire(conn, 1)
        auth.refresh_status = 400
        with self.assertRaises(McpError) as caught:
            await self.call(conn, 1)
        blobs += [str(caught.exception.detail), json.dumps(caught.exception.payload)]
        failed = await self.web.get(CALLBACK, params={'code': query['code'], 'state': query['state']}, headers=self.cookie_header(1))
        blobs.append(failed.text)
        every = [*auth.access, *auth.refresh, 'very-secret-value', query['code']]
        for blob in blobs:
            for secret in every:
                self.assertNotIn(secret, blob)
        self.assertNoSecrets(auth, 'very-secret-value', query['code'])

    async def test_oauth_http_errors_do_not_escape_as_raw_exceptions(self):
        auth, resource = await self.serve()
        conn = connector(self.p, 'http://closed.test:9/mcp')  # Resolves to a public address; nothing listens there.
        with self.assertRaises(McpError) as caught:
            await self.oauth.begin(conn, 1, 1)
        self.assertEqual(caught.exception.code, 'oauth_failed')
        self.assertIsInstance(httpx2.ConnectError('x'), httpx2.HTTPError)
