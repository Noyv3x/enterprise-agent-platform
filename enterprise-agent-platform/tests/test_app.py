import tempfile
import gzip
import asyncio
from types import SimpleNamespace
from pathlib import Path
import unittest

from starlette.testclient import TestClient
from starlette.exceptions import HTTPException
from enterprise_agent_platform.app import BoundaryMiddleware, create_app
from enterprise_agent_platform.config import Settings
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.gates import Gate


class HttpBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        frontend = self.root / 'static'
        frontend.mkdir()
        (frontend / 'index.html').write_text('<html>application</html>')
        (frontend / 'app-deadbeef.js').write_text('console.log(1)')
        (frontend / 'app-deadbeef.js.gz').write_bytes(gzip.compress(b'console.log(1)'))
        self.app = create_app(Settings(data_dir=self.root, frontend_dir=frontend,
            manager_socket=str(self.root / 'missing.sock'), session_secret='test-secret',
            agent_tool_token='tool-test', runtime_token='runtime-test'))
        self.client = TestClient(self.app)
        self.client.__enter__()
        password = (self.root / 'bootstrap-admin-password.txt').read_text().strip()
        response = self.client.post('/api/auth/login', json={'username': 'admin', 'password': password})
        self.assertEqual(response.status_code, 200, response.text)

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def test_channel_creation_and_duplicate_conflict(self):
        created = self.client.post('/api/channels', json={'name': 'Engineering', 'description': 'Shared work'})
        self.assertEqual(created.status_code, 201, created.text)
        channel = created.json()['channel']
        self.assertEqual(self.client.get('/api/channels').json()['channels'], [channel])
        self.assertEqual(self.client.post('/api/channels', json={'name': 'Engineering'}).status_code, 409)
        self.assertEqual(self.client.delete(f"/api/channels/{channel['id']}").status_code, 200)
        self.assertEqual(self.client.get('/api/channels').json()['channels'], [])

    def test_cross_origin_cookie_mutations_rejected(self):
        response = self.client.post('/api/channels', json={'name': 'Injected'}, headers={'Origin': 'https://attacker.example'})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.get('/api/channels').json()['channels'], [])

    def test_static_routes_do_not_hide_unknown_api(self):
        self.assertEqual(self.client.get('/api/not-a-route').status_code, 404)
        self.assertEqual(self.client.get('/personal').headers['cache-control'], 'no-cache')
        asset = self.client.get('/app-deadbeef.js')
        self.assertEqual(asset.text, 'console.log(1)')
        self.assertIn('immutable', asset.headers['cache-control'])
        self.assertEqual(self.client.get('/missing.js').status_code, 404)
        compressed = self.client.get('/app-deadbeef.js', headers={'Accept-Encoding': 'gzip'})
        self.assertEqual(compressed.headers['content-encoding'], 'gzip')
        self.assertEqual(compressed.text, 'console.log(1)')
        excluded = self.client.get('/app-deadbeef.js', headers={'Accept-Encoding': 'gzip;q=0'})
        self.assertNotIn('content-encoding', excluded.headers)
        self.assertEqual(excluded.text, 'console.log(1)')

    def test_manager_reservation_blocks_normal_routes_not_health(self):
        self.app.state.platform.gate.reserved = 'operation'
        self.assertEqual(self.client.get('/api/bootstrap').status_code, 503)
        self.assertEqual(self.client.get('/healthz').json(), {'status': 'ok', 'service': 'agent-platform'})
        self.app.state.platform.gate.reserved = None
        self.assertEqual(self.client.get('/api/bootstrap').status_code, 200)


class AdmissionRaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_container_startup_fails_closed_without_manager_socket(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / 'manager-token'
            token.write_text('manager-secret')
            app = create_app(Settings(data_dir=root, deployment_mode='container',
                manager_socket=str(root / 'absent.sock'), manager_token_file=token))
            with self.assertRaises(HTTPException) as raised:
                async with app.router.lifespan_context(app):
                    self.fail('Installed startup admitted work without Manager recovery')
            self.assertEqual(raised.exception.status_code, 502)
            self.assertTrue(app.state.platform.gate.closing)
            self.assertEqual(app.state.platform.queue.active, 0)
            self.assertTrue(app.state.platform.http.is_closed)

    async def test_slow_mutation_blocks_reservation_but_response_stream_does_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = Database(root / 'platform.db')
            db.migrate(root)
            platform = SimpleNamespace(db=db, queue=SimpleNamespace(active=0))
            platform.gate = Gate(platform)
            entered, finish_upload, headers_sent, finish_stream = (asyncio.Event() for _ in range(4))

            async def handler(scope, receive, send):
                entered.set()
                await finish_upload.wait()
                with db.connect() as conn:
                    conn.execute("INSERT INTO settings VALUES('uploaded','complete',0,0)")
                await send({'type': 'http.response.start', 'status': 200, 'headers': []})
                headers_sent.set()
                await finish_stream.wait()
                await send({'type': 'http.response.body', 'body': b'ok'})

            async def receive():
                return {'type': 'http.request', 'body': b''}

            async def send(message):
                pass

            task = asyncio.create_task(BoundaryMiddleware(handler, platform)(
                {'type': 'http', 'path': '/api/attachments', 'method': 'POST', 'headers': []}, receive, send))
            await entered.wait()
            blocked = await platform.gate.readiness('update')
            self.assertFalse(blocked['reserved'])
            self.assertEqual(blocked['admissions_in_progress'], 1)
            finish_upload.set()
            await headers_sent.wait()
            self.assertTrue((await platform.gate.readiness('update'))['reserved'])
            with db.connect() as conn:
                self.assertEqual(conn.execute("SELECT value FROM settings WHERE key='uploaded'").fetchone()[0], 'complete')
            finish_stream.set()
            await task


if __name__ == '__main__':
    unittest.main()
