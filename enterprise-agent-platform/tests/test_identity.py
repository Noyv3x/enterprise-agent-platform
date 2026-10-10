import base64
import io
import json
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from PIL import Image
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from enterprise_agent_platform import admin, auth, oauth
from enterprise_agent_platform.db import Database


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        db = Database(root / 'platform.db')
        db.migrate(root)
        self.p = SimpleNamespace(db=db, settings=SimpleNamespace(session_secret='test-secret', public_base_url='http://testserver', agent_tool_token='tool-secret', trusted_proxy=False))
        self.p.oauth = oauth.OAuth(self.p)
        self.admin = admin.create_user(db, 'admin', 'admin-password', role='admin')
        self.user = admin.create_user(db, 'member', 'old-password')

        async def guarded(request):
            return JSONResponse({'user': auth.require_permission(request, 'private_agent')})

        async def error(request, exc):
            return JSONResponse({'error': exc.detail}, status_code=exc.status_code)

        self.app = Starlette(routes=auth.routes() + admin.routes() + oauth.routes() + [Route('/guarded', guarded)], exception_handlers={HTTPException: error})
        self.app.state.platform = self.p
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def login(self, name='admin', password='admin-password'):
        response = self.client.post('/api/auth/login', json={'username': name, 'password': password})
        self.assertEqual(response.status_code, 200, response.text)
        return self.client.cookies.get('agent_platform_session')

    def test_password_revokes_copied_cookie_and_legacy_hash(self):
        cookie = self.login('member', 'old-password')
        with self.p.db.connect() as conn:
            row = conn.execute('SELECT password_hash FROM users WHERE id=?', (self.user['id'],)).fetchone()
        self.assertTrue(auth.verify_password('old-password', row[0]))
        for proof in ({}, {'current_password': 'wrong'}):
            response = self.client.patch('/api/me', json={'password': 'new-password', **proof})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(self.client.get('/api/me').status_code, 200)
        response = self.client.patch('/api/me', json={'password': 'new-password', 'current_password': 'old-password'})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('password_hash', response.json()['user'])
        self.assertEqual(self.client.get('/api/me').status_code, 200)
        self.assertNotEqual(self.client.cookies.get('agent_platform_session'), cookie)
        self.assertEqual(self.client.get('/api/me', headers={'Cookie': 'agent_platform_session=' + cookie}).status_code, 401)
        self.assertEqual(self.client.post('/api/auth/login', json={'username': 'member', 'password': 'old-password'}).status_code, 401)
        self.login('member', 'new-password')
        cookie = self.client.cookies.get('agent_platform_session')
        self.assertEqual(self.client.post('/api/auth/logout').status_code, 200)
        self.assertIsNone(self.client.cookies.get('agent_platform_session'))
        self.assertEqual(self.client.get('/api/me', headers={'Cookie': 'agent_platform_session=' + cookie}).status_code, 401)

    def test_live_permission_groups_and_admin_isolation(self):
        member_cookie = self.login('member', 'old-password')
        self.assertEqual(self.client.get('/guarded').status_code, 200)
        self.assertEqual(self.client.get('/api/admin/users').status_code, 403)
        self.login()
        groups = self.client.get('/api/admin/permission-groups').json()['groups']
        next(group for group in groups if group['name'] == 'member')['permissions'] = ['read_workspace']
        self.assertEqual(self.client.put('/api/admin/permission-groups', json={'groups': groups}).status_code, 200)
        self.assertEqual(self.client.get('/guarded', headers={'Cookie': 'agent_platform_session=' + member_cookie}).status_code, 403)
        self.assertEqual(self.client.delete('/api/admin/users/' + str(self.admin['id'])).status_code, 409)
        self.assertEqual(self.client.patch('/api/admin/users/' + str(self.user['id']), json={'active': False}).status_code, 200)
        self.assertEqual(self.client.get('/api/me', headers={'Cookie': 'agent_platform_session=' + member_cookie}).status_code, 401)

    def test_cross_origin_and_admin_user_validation(self):
        self.login()
        self.assertEqual(self.client.patch('/api/me', json={'display_name': 'stolen'}, headers={'Origin': 'https://attacker.example'}).status_code, 403)
        self.assertEqual(self.client.patch('/api/me', json={'role': 'admin'}).status_code, 400)
        self.assertEqual(self.client.get('/api/branding', headers={'Cookie': ''}).json()['branding']['product_name'], 'Agent Platform')
        user_path = f"/api/admin/users/{self.user['id']}"
        self.assertEqual(self.client.patch(user_path, json={'username': 'admin'}).status_code, 409)
        self.assertEqual(self.client.patch(user_path, json={'permission_group': []}).status_code, 400)
        for body in ({'model_policy': []}, {'model_policy': 'missing'}, {'model_name': 'x'}, {'chat_model_name': 'x'}, {'thinking_depth': 'low'}):
            self.assertEqual(self.client.patch(user_path, json=body).status_code, 400, body)

    def policy(self, name='light', **overrides):
        slots = {slot: {'model': 'm-' + name, 'thinking': 'low'} for slot in ('personal', 'channel', 'chat', 'scout', 'worker')}
        return {'name': name, 'label': name.title(), 'slots': {**slots, **overrides}}

    def test_model_policy_list_validation_and_referenced_group_removal(self):
        self.login()
        listing = self.client.get('/api/admin/model-policies').json()
        self.assertEqual([p['name'] for p in listing['policies']], ['default'])
        self.assertEqual(listing['members'], {'default': 2})
        self.assertEqual(listing['policies'][0]['slots']['chat'], {'model': '', 'thinking': 'medium'})
        default = listing['policies'][0]
        light = self.policy()
        broken_slot = self.policy(chat={'model': 'x', 'thinking': 'none'})
        invalid = [
            {}, {'policies': []}, {'policies': 'x'}, {'policies': [default], 'extra': 1}, {'policies': [5]},
            {'policies': [{**default, 'name': 'Bad Name'}]}, {'policies': [{**default, 'name': '1abc'}]},
            {'policies': [{**default, 'name': 'a' * 65}]}, {'policies': [default, default]},
            {'policies': [{**default, 'label': ''}]}, {'policies': [{**default, 'label': 'x' * 65}]}, {'policies': [{**default, 'label': 3}]},
            {'policies': [{k: v for k, v in default.items() if k != 'label'}]}, {'policies': [{**default, 'extra': 1}]},
            {'policies': [{**default, 'slots': {k: v for k, v in default['slots'].items() if k != 'scout'}}]},
            {'policies': [{**default, 'slots': {**default['slots'], 'extra': default['slots']['chat']}}]},
            {'policies': [broken_slot, default]}, {'policies': [self.policy(chat={'model': 'x' * 129, 'thinking': 'low'}), default]},
            {'policies': [self.policy(chat={'model': 5, 'thinking': 'low'}), default]},
            {'policies': [self.policy(chat={'model': 'x'}), default]}, {'policies': [self.policy(chat={'model': 'x', 'thinking': 'low', 'e': 1}), default]},
            {'policies': [self.policy(chat='x'), default]},
        ]
        for body in invalid:
            self.assertEqual(self.client.put('/api/admin/model-policies', json=body).status_code, 400, body)
        self.assertEqual(self.client.get('/api/admin/model-policies').json(), listing)
        saved = self.client.put('/api/admin/model-policies', json={'policies': [default, light, self.policy('spare')]})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()['members'], {'default': 2, 'light': 0, 'spare': 0})
        user_path = f"/api/admin/users/{self.user['id']}"
        self.assertEqual(self.client.patch(user_path, json={'model_policy': 'light'}).json()['user']['model_policy'], 'light')
        self.assertEqual(self.client.get('/api/admin/model-policies').json()['members'], {'default': 1, 'light': 1, 'spare': 0})
        self.assertEqual(self.client.put('/api/admin/model-policies', json={'policies': [default]}).status_code, 409)
        # An inactive account still references its group.
        self.assertEqual(self.client.patch(user_path, json={'active': False}).status_code, 200)
        self.assertEqual(self.client.put('/api/admin/model-policies', json={'policies': [default, self.policy('spare')]}).status_code, 409)
        self.assertEqual(self.client.get('/api/admin/model-policies').json()['members']['light'], 1)
        self.assertEqual(self.client.put('/api/admin/model-policies', json={'policies': [default, light]}).status_code, 200)
        self.assertEqual(self.client.get('/api/admin/model-policies', headers={'Cookie': ''}).status_code, 401)
        self.assertEqual(self.client.patch(f"/api/admin/users/{self.user['id']}", json={'active': True}).status_code, 200)
        self.login('member', 'old-password')
        self.assertEqual(self.client.get('/api/admin/model-policies').status_code, 403)
        self.assertEqual(self.client.put('/api/admin/model-policies', json={'policies': [default]}).status_code, 403)

    def test_user_create_and_update_carry_the_model_policy(self):
        self.login()
        self.assertEqual(self.admin['model_policy'], 'default')
        policies = self.client.get('/api/admin/model-policies').json()['policies']
        self.assertEqual(self.client.put('/api/admin/model-policies', json={'policies': [*policies, self.policy()]}).status_code, 200)
        created = self.client.post('/api/admin/users', json={'username': 'light-user', 'password': 'a-password', 'model_policy': 'light'})
        self.assertEqual((created.status_code, created.json()['user']['model_policy']), (201, 'light'))
        plain = self.client.post('/api/admin/users', json={'username': 'plain', 'password': 'a-password'}).json()['user']
        self.assertEqual(plain['model_policy'], 'default')
        for body in ({'model_policy': 'missing'}, {'model_policy': 5}, {'model_name': 'x'}, {'chat_model_name': ''}, {'thinking_depth': 'low'}):
            self.assertEqual(self.client.post('/api/admin/users', json={'username': 'bad', 'password': 'a-password', **body}).status_code, 400, body)
        listed = {user['username']: user['model_policy'] for user in self.client.get('/api/admin/users').json()['users']}
        self.assertEqual(listed, {'admin': 'default', 'member': 'default', 'light-user': 'light', 'plain': 'default'})
        user_path = f"/api/admin/users/{self.user['id']}"
        updated = self.client.patch(user_path, json={'model_policy': 'light'}).json()['user']
        self.assertEqual(updated['model_policy'], 'light')
        self.assertEqual(self.client.post(user_path + '/impersonate', json={}).json()['user']['model_policy'], 'light')

    def test_users_never_receive_models_policy_groups_or_thinking_depth(self):
        self.login()
        user_path = f"/api/admin/users/{self.user['id']}"
        policies = self.client.get('/api/admin/model-policies').json()['policies']
        self.client.put('/api/admin/model-policies', json={'policies': [*policies, self.policy()]})
        self.client.patch(user_path, json={'model_policy': 'light'})
        hidden = {'model_name', 'chat_model_name', 'thinking_depth', 'model_policy', 'model', 'thinking'}
        login = self.client.post('/api/auth/login', json={'username': 'member', 'password': 'old-password'})
        mine = self.client.get('/api/me').json()['user']
        for user in (login.json()['user'], mine):
            self.assertFalse(hidden & set(user), user)
            self.assertEqual(set(user), {'id', 'username', 'display_name', 'role', 'position', 'permission_group', 'timezone', 'active'})
        for field in ('model_name', 'chat_model_name', 'thinking_depth', 'model_policy'):
            self.assertEqual(self.client.patch('/api/me', json={field: 'default' if field == 'model_policy' else 'low'}).status_code, 400, field)

    def test_admin_impersonation_swaps_session_without_revoking_others(self):
        member_cookie = self.login('member', 'old-password')
        path = f"/api/admin/users/{self.user['id']}/impersonate"
        self.assertEqual(self.client.post(path, json={}).status_code, 403)
        other = admin.create_user(self.p.db, 'other', 'other-password')
        self.assertEqual(self.client.post(f"/api/admin/users/{other['id']}/impersonate", json={}).status_code, 403)

        self.login()
        before = self.client.get('/api/me').json()['user']
        self.assertEqual(self.client.post(path, json={}, headers={'Origin': 'https://attacker.example'}).status_code, 403)
        self.assertEqual(self.client.get('/api/me').json()['user'], before)
        response = self.client.post(path, json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['user']['username'], 'member')
        self.assertNotIn('password_hash', response.json()['user'])
        cookie = response.headers['set-cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=lax', cookie)
        self.assertEqual(self.client.get('/api/me').json()['user']['username'], 'member')
        self.assertEqual(self.client.get('/api/me', headers={'Cookie': 'agent_platform_session=' + member_cookie}).status_code, 200)
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT token_version FROM users WHERE id=?', (self.user['id'],)).fetchone()[0], 1)

    def test_admin_impersonation_rejects_self_inactive_and_missing_targets(self):
        self.login()
        self.assertEqual(self.client.post(f"/api/admin/users/{self.admin['id']}/impersonate", json={}).status_code, 400)
        self.assertEqual(self.client.post('/api/admin/users/9999/impersonate', json={}).status_code, 404)
        self.assertEqual(self.client.patch(f"/api/admin/users/{self.user['id']}", json={'active': False}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/admin/users/{self.user['id']}/impersonate", json={}).status_code, 404)
        self.assertEqual(self.client.get('/api/me').json()['user']['username'], 'admin')

    def test_login_throttles_before_hash_and_expires(self):
        with patch.object(auth.time, 'monotonic', return_value=1000), patch.object(auth, 'verify_password', wraps=auth.verify_password) as verify:
            for _ in range(8):
                self.assertEqual(self.client.post('/api/auth/login', json={'username': 'member', 'password': 'wrong'}).status_code, 401)
            self.assertEqual(verify.call_count, 8)
            for password in ('wrong', 'old-password'):
                self.assertEqual(self.client.post('/api/auth/login', json={'username': 'member', 'password': password}).status_code, 429)
            self.assertEqual(verify.call_count, 8)
        with patch.object(auth.time, 'monotonic', return_value=1901):
            self.login('member', 'old-password')

    def test_login_client_limit_and_bounded_failure_storage(self):
        with patch.object(auth, 'verify_password') as verify:
            for index in range(100):
                response = self.client.post('/api/auth/login', json={'username': f'missing-{index}', 'password': 'wrong'})
                self.assertEqual(response.status_code, 429 if index == 99 else 401)
            self.assertEqual(self.client.post('/api/auth/login', json={'username': 'member', 'password': 'old-password'}).status_code, 429)
            verify.assert_not_called()
        attempts = auth.LoginAttempts()
        with patch.object(auth, 'MAX_LOGIN_FAILURE_KEYS', 10):
            for index in range(30):
                attempts.fail(str(index), str(index), 1000 + index)
            for store in (attempts.pairs, attempts.users, attempts.clients):
                self.assertEqual(len(store), 10)
            for index in range(200):
                try:
                    attempts.fail('account', 'client', 1100 + index)
                except HTTPException as exc:
                    self.assertEqual(exc.status_code, 429)
            self.assertEqual(len(attempts.pairs['account', 'client']), 8)
            self.assertEqual(len(attempts.users['account']), 50)
            self.assertEqual(len(attempts.clients['client']), 100)
            attempts.check('account', 'client', 2200)

    def test_account_limit_allows_correct_password_from_new_client(self):
        attempts = auth.LoginAttempts()
        self.p.login_attempts = attempts
        for index in range(50):
            try:
                attempts.fail('member', f'client-{index}', time.monotonic())
            except HTTPException as exc:
                self.assertEqual(index, 49)
                self.assertEqual(exc.status_code, 429)
        self.login('member', 'old-password')
        self.assertNotIn('member', attempts.users)

    def test_installed_cookie_accepts_legacy_signed_payload(self):
        import hashlib
        import hmac
        payload = {'uid': self.user['id'], 'exp': int(time.time()) + 3600, 'nonce': 'legacy-browser', 'ver': 1}
        body = auth.b64(json.dumps(payload, separators=(',', ':')).encode())
        signature = auth.b64(hmac.new(b'test-secret', body.encode(), hashlib.sha256).digest())
        response = self.client.get('/api/me', headers={'Cookie': 'agent_platform_session=' + body + '.' + signature})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['user']['username'], 'member')

    def test_new_identity_rows_keep_legacy_epoch_timestamps(self):
        lower = int(time.time()) - 5
        self.login()
        self.assertEqual(self.client.patch('/api/admin/branding', json={'product_name': 'Rollback'}).status_code, 200)
        self.p.oauth.save({'access_token': 'new-access', 'refresh_token': 'new-refresh', 'expires_in': 3600})
        with self.p.db.connect() as conn:
            user = conn.execute('SELECT created_at,last_login_at FROM users WHERE id=?', (self.admin['id'],)).fetchone()
            settings = conn.execute("SELECT updated_at FROM settings WHERE key IN ('ui_branding_v1', 'CODEX_OAUTH_ACCESS_TOKEN', 'CODEX_OAUTH_REFRESH_TOKEN', 'CODEX_OAUTH_EXPIRES_AT')").fetchall()
        self.assertEqual(len(settings), 4)
        for timestamp in [*user, *(row[0] for row in settings)]:
            self.assertIs(type(timestamp), int)
            self.assertGreaterEqual(timestamp, lower)
            self.assertLessEqual(timestamp, int(time.time()))
            self.assertEqual(datetime.fromtimestamp(timestamp, timezone.utc).year, datetime.now(timezone.utc).year)

    def test_branding_preserves_rollback_logo_document(self):
        self.login()
        image = io.BytesIO()
        Image.new('RGB', (2, 3), 'red').save(image, format='PNG')
        encoded = base64.b64encode(image.getvalue()).decode()
        logo = 'data:image/png;base64,' + encoded
        response = self.client.patch('/api/admin/branding', json={'logo': logo, 'product_name': 'Acme'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get('/api/branding').json()['branding']['logo'], logo)
        with self.p.db.connect() as conn:
            record = json.loads(conn.execute("SELECT value FROM settings WHERE key='ui_branding_v1'").fetchone()[0])
            stored = conn.execute("SELECT value FROM settings WHERE key='ui_branding_logo_v1'").fetchone()[0]
        self.assertEqual(set(record), {'schema_version', 'revision', 'product_name', 'agent_name', 'primary_color', 'logo'})
        self.assertEqual(record['logo']['width'], 2)
        self.assertEqual(record['logo']['height'], 3)
        self.assertEqual(stored, encoded)
        self.assertEqual(self.client.patch('/api/admin/branding', json={'logo': 'data:image/webp;base64,' + encoded}).status_code, 400)
        self.assertEqual(self.client.patch('/api/admin/branding', json={'logo': None}).json()['branding']['logo'], None)

    def test_device_exchange_refresh_and_gateway(self):
        calls = []

        def upstream(request):
            calls.append(request)
            if request.url.path.endswith('/usercode'):
                return httpx.Response(200, json={'device_auth_id': 'device', 'user_code': 'CODE', 'interval': 1})
            if request.url.path.endswith('/deviceauth/token'):
                return httpx.Response(200, json={'authorization_code': 'code', 'code_verifier': 'verifier'})
            if request.url.path.endswith('/oauth/token'):
                return httpx.Response(200, json={'access_token': 'access-' + str(len(calls)), 'refresh_token': 'refresh', 'expires_in': 3600})
            if request.url.path.endswith('/models'):
                return httpx.Response(200, json={'models': [
                    {'slug': 'gpt-5.5', 'display_name': 'GPT 5.5'},
                    {'slug': 'future-codex', 'context_window': 400000, 'max_output_tokens': 32000},
                    {'id': 'alternate', 'contextWindow': 128000, 'maxTokens': 16000},
                    {'slug': 'invalid-limits', 'context_window': True, 'max_output_tokens': -1},
                    {'slug': 'hidden', 'visibility': 'hide'},
                ]})
            raise AssertionError(request.url)

        self.p.http = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        self.login()
        flow = self.client.post('/api/admin/oauth/start').json()
        self.assertGreater(flow['expires_at'], time.time())
        self.assertLess(flow['expires_at'], time.time() + 1000)
        self.assertTrue(self.client.post('/api/admin/oauth/' + flow['flow_id'] + '/poll').json()['complete'])
        catalog = self.client.get('/api/admin/models').json()['models']
        self.assertEqual(catalog, [
            {'id': 'gpt-5.5', 'name': 'GPT 5.5'},
            {'id': 'future-codex', 'name': 'future-codex', 'contextWindow': 400000, 'maxTokens': 32000},
            {'id': 'alternate', 'name': 'alternate', 'contextWindow': 128000, 'maxTokens': 16000},
            {'id': 'invalid-limits', 'name': 'invalid-limits'},
        ])
        path = '/api/agent/tools/credentials/resolve'
        body = {'provider': 'openai-codex', 'model': 'gpt-5.5'}
        self.assertEqual(self.client.post(path, json=body).status_code, 401)
        first = self.client.post(path, json=body, headers={'Authorization': 'Bearer tool-secret'}).json()
        self.assertEqual(first['model'], 'gpt-5.5')
        dynamic = self.client.post(path, json={**body, 'model': 'future-codex'}, headers={'Authorization': 'Bearer tool-secret'})
        self.assertEqual(dynamic.status_code, 200)
        self.assertEqual(dynamic.json()['model'], 'future-codex')
        refreshed = self.client.post(path, json={**body, 'force_refresh': True}, headers={'Authorization': 'Bearer tool-secret'}).json()
        self.assertNotEqual(first['access_token'], refreshed['access_token'])
        self.assertLess(refreshed['expires_at'], time.time() + 3700)
        unknown = self.client.post(path, json={**body, 'model': 'unavailable'}, headers={'Authorization': 'Bearer tool-secret'})
        self.assertEqual(unknown.status_code, 409)
        self.assertEqual(self.client.delete('/api/admin/oauth').status_code, 200)
        self.assertEqual(self.client.get('/api/admin/models').json(), {'models': [], 'connected': False})


if __name__ == '__main__':
    unittest.main()
