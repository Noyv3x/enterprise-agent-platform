import asyncio
import ipaddress
import io
import json
import zipfile
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from starlette.exceptions import HTTPException

from enterprise_agent_platform.db import Database
from enterprise_agent_platform.files import Files, contained, office_preview, open_workspace, bounded_read
from enterprise_agent_platform.schedules import dispatch, next_time, tick
from enterprise_agent_platform.tools import Browser, browser_url, fetch
from enterprise_agent_platform.queue import Queue
from enterprise_agent_platform.gates import Gate


class ToolsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = Database(self.root / 'platform.db')
        self.db.migrate(self.root)
        with self.db.connect() as conn:
            for ident in (1, 2):
                conn.execute('INSERT INTO users(id,username,display_name,password_hash,timezone,created_at) VALUES(?,?,?,?,?,?)', (ident, f'user{ident}', 'User', 'unused', 'UTC', int(time.time())))
        with self.db.connect() as conn:
            self.user = dict(conn.execute('SELECT * FROM users WHERE id=1').fetchone())
        self.p = SimpleNamespace(db=self.db, settings=SimpleNamespace(data_dir=self.root, camofox_url='http://browser', camofox_access_key='secret'))
        self.p.gate = Gate(self.p)
        self.queue = self.p.queue = Queue(self.p)
        self.queue.stopping = True  # Exercise durable admission without launching a Runtime worker.
        self.files = self.p.files = Files(self.p)

    def tearDown(self):
        self.temp.cleanup()

    def scope(self, user, scope):
        return self.queue.scope(user, scope)

    async def test_public_fetch_blocks_each_redirect_and_pins_dns(self):
        resolver = AsyncMock(side_effect=[[(2, 1, 6, '', ('93.184.216.34', 443))], [(2, 1, 6, '', ('127.0.0.1', 80))]])
        requests = []
        def respond(request):
            requests.append(request)
            return httpx.Response(302, headers={'location': 'http://localhost/secrets'})
        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', resolver), patch('enterprise_agent_platform.tools.httpx.AsyncClient', return_value=client):
            with self.assertRaises(HTTPException) as raised:
                await fetch('https://public.example/')
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.host, '93.184.216.34')
        self.assertEqual(requests[0].headers['host'], 'public.example')
        self.assertEqual(requests[0].extensions['sni_hostname'], 'public.example')

    async def test_public_fetch_bounds_response(self):
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'a' * (2 * 1024 * 1024 + 1))))
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', AsyncMock(return_value=[(2, 1, 6, '', ('93.184.216.34', 80))])), patch('enterprise_agent_platform.tools.httpx.AsyncClient', return_value=client):
            with self.assertRaises(HTTPException) as raised:
                await fetch('http://public.example/')
        self.assertEqual(raised.exception.status_code, 413)

    async def test_browser_allows_lan_but_not_core_or_metadata(self):
        answers = AsyncMock(side_effect=[[(2, 1, 6, '', ('192.168.2.10', 80))], [(2, 1, 6, '', ('172.20.0.5', 80))], [(2, 1, 6, '', ('169.254.169.254', 80))]])
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', answers), patch('enterprise_agent_platform.tools.interface_networks', return_value=[ipaddress.ip_network('172.20.0.0/16')]):
            await browser_url('http://nas/')
            for url in ('http://core/', 'http://cloud/'):
                with self.assertRaises(HTTPException):
                    await browser_url(url)
        with self.assertRaises(HTTPException):
            await browser_url('http://user:pass@public.example/')

    async def test_human_lease_blocks_agent_and_other_tab_until_expired(self):
        browser = Browser(self.p)
        browser.acquire(1, 'session:tab-a')
        with self.assertRaises(HTTPException) as competing:
            browser.acquire(1, 'session:tab-b')
        self.assertEqual(competing.exception.status_code, 409)
        with self.assertRaises(HTTPException) as agent:
            await browser.action(1, 'list', {})
        self.assertEqual(agent.exception.status_code, 409)
        browser.check(1, 'session:tab-a')
        browser.leases[1]['deadline'] = time.monotonic() - 1
        browser.check(1)
        with self.assertRaises(HTTPException):
            browser.check(1, 'session:tab-a')
        browser.acquire(1, 'session:tab-b')
        browser.check(1, 'session:tab-b')

    async def test_channel_cannot_use_personal_tools(self):
        with self.db.connect() as conn:
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES(3,'Shared',?)", (int(time.time()),))
        _, context = await self.running_scope('channel-3')
        browser = Browser(self.p)
        for tool in ('browser', 'schedule'):
            with self.assertRaises(HTTPException) as raised:
                await browser.gateway(tool, 'list', {}, context)
            self.assertEqual(raised.exception.status_code, 403)

    async def test_absorbed_channel_author_never_becomes_tool_principal(self):
        with self.db.connect() as conn:
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES(3,'Shared',?)", (int(time.time()),))
        _, context = await self.running_scope('channel-3')
        author = self.queue.user(2)
        child = await self.queue.enqueue(author, 'channel-3', 'A different author inserts input')
        with self.db.connect() as conn:
            job = conn.execute('SELECT status,payload_json FROM durable_jobs WHERE id=?', (child['job_id'],)).fetchone()
        self.assertEqual(job['status'], 'running')
        parent_id = json.loads(job['payload_json'])['parent_job_id']
        browser = Browser(self.p)
        with patch('enterprise_agent_platform.tools.fetch', new_callable=AsyncMock, return_value={'text': 'page'}) as fetch_page:
            result = await browser.gateway('web', 'fetch', {'url': 'https://public.example/'},
                                           {**context, 'owner_user_id': self.user['id']})
            self.assertEqual(result['data'], {'text': 'page'})
            with self.db.connect() as conn:
                conn.execute("UPDATE durable_jobs SET status='failed' WHERE id=?", (parent_id,))
            with self.assertRaises(HTTPException) as rejected:
                await browser.gateway('web', 'fetch', {'url': 'https://public.example/'},
                                      {**context, 'owner_user_id': author['id']})
            self.assertEqual(rejected.exception.status_code, 403)
            self.assertEqual(rejected.exception.detail, 'Tool session has no active owning job')
            fetch_page.assert_awaited_once()

    async def test_schedule_tick_enqueues_once_and_preserves_epoch_schema(self):
        created = await dispatch(self.p, 'create', {'name': 'Reminder', 'prompt': 'Say hello', 'schedule': {'type': 'once', 'at': '2020-01-01T00:00:00Z'}}, self.user)
        await tick(self.p)
        await tick(self.p)
        with self.db.connect() as conn:
            jobs = conn.execute('SELECT * FROM durable_jobs').fetchall()
        self.assertEqual(len(jobs), 1)
        payload = json.loads(jobs[0]['payload_json'])
        self.assertEqual((payload['user_id'], payload['scope'], payload['content']), (1, 'private', 'Say hello'))
        with self.db.connect() as conn:
            run = conn.execute('SELECT * FROM agent_schedule_runs').fetchone()
            schedule = conn.execute('SELECT * FROM agent_schedules').fetchone()
        self.assertEqual(payload['schedule_run_id'], run['id'])
        self.assertEqual(schedule['state'], 'completed')
        self.assertIsInstance(schedule['created_at'], int)
        self.assertEqual(run['scheduled_for'], 1577836800)
        history = await dispatch(self.p, 'history', {'schedule_id': created['schedule']['id']}, self.user)
        self.assertEqual(history['runs'][0]['scheduled_for'], '2020-01-01T00:00:00+00:00')

    async def test_recurrence_and_owner_fence(self):
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.assertEqual(next_time({'type': 'interval', 'every_seconds': 60}, 'UTC', base), int(base.timestamp()) + 60)
        self.assertEqual(next_time({'type': 'cron', 'expression': '0 9 * * *'}, 'America/New_York', base), int(datetime(2026, 1, 1, 14, tzinfo=timezone.utc).timestamp()))
        created = await dispatch(self.p, 'create', {'name': 'Daily', 'prompt': 'Report', 'schedule': {'type': 'interval', 'every_seconds': 60}}, self.user)
        with self.assertRaises(HTTPException):
            await dispatch(self.p, 'get', {'schedule_id': created['schedule']['id']}, {'id': 2})
        await dispatch(self.p, 'delete', {'schedule_id': created['schedule']['id']}, self.user)
        self.assertEqual((await dispatch(self.p, 'list', {}, self.user))['schedules'], [])

    async def test_attachment_upload_binding_and_media_ownership(self):
        info = self.scope(self.user, 'private')
        uploaded = self.files.store(self.user, info, 'report.txt', b'private report')
        with self.db.connect() as conn:
            with self.assertRaises(HTTPException):
                self.files.owned({'id': 2}, uploaded['id'], conn)
            message = conn.execute("INSERT INTO messages(scope_type,scope_id,author_type,username,content,created_at) VALUES('private','1','agent','agent','report',?)", (int(time.time()),)).lastrowid
            self.files.bind(self.user, info, message, [uploaded['id']], conn=conn)
        self.assertEqual(self.files.for_message(info, message), [uploaded])
        with self.assertRaises(HTTPException):
            self.files.bind(self.user, info, message, [uploaded['id']])
        info['workspace'].mkdir(exist_ok=True)
        (info['workspace'] / 'answer.txt').write_text('generated')
        (info['workspace'] / 'escape').symlink_to('/etc/passwd')
        generated = await self.files.deliver(self.user, info, message, 'MEDIA: /workspace/answer.txt\nMEDIA: /workspace/escape\nMEDIA: /workspace/../other')
        self.assertEqual([item['filename'] for item in generated], ['answer.txt'])
        with self.assertRaises(HTTPException):
            contained(info['workspace'], '../user-2/private')

    async def test_workspace_descriptor_survives_path_swap(self):
        root = self.root / 'workspace'
        root.mkdir()
        file = root / 'safe.txt'
        file.write_bytes(b'original')
        fd = open_workspace(root, 'safe.txt')
        file.unlink()
        file.symlink_to('/etc/passwd')
        self.assertEqual(bounded_read(fd), b'original')
        with self.assertRaises(OSError):
            open_workspace(root, 'safe.txt')

    async def test_office_text_and_shared_strings_without_xml_entities(self):
        def archive(parts):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as output:
                for name, content in parts.items():
                    output.writestr(name, content)
            return stream.getvalue()
        docx = archive({'word/document.xml': '<document><p><t>Quarterly report</t></p></document>'})
        self.assertEqual(office_preview(docx, '.docx'), 'Quarterly report')
        xlsx = archive({'xl/sharedStrings.xml': '<sst><si><t>Revenue</t></si></sst>', 'xl/worksheets/sheet1.xml': '<worksheet><row><c t=\"s\"><v>0</v></c><c><v>42</v></c></row></worksheet>'})
        self.assertEqual(office_preview(xlsx, '.xlsx'), 'sheet1.xml\nRevenue\t42')
        pptx = archive({'ppt/slides/slide1.xml': '<slide><p><t>Agenda</t></p></slide>'})
        self.assertEqual(office_preview(pptx, '.pptx'), 'Slide 1\nAgenda')
        unsafe = archive({'word/document.xml': '<!DOCTYPE x [<!ENTITY secret SYSTEM \"file:///etc/passwd\">]><document><p><t>&secret;</t></p></document>'})
        with self.assertRaises(ValueError):
            office_preview(unsafe, '.docx')

    async def test_interval_pause_resume_keeps_legacy_numeric_dates(self):
        created = await dispatch(self.p, 'create', {'name': 'Daily', 'prompt': 'Report', 'schedule': {'type': 'interval', 'every_seconds': 86400}}, self.user)
        ident = created['schedule']['id']
        paused = await dispatch(self.p, 'pause', {'schedule_id': ident}, self.user)
        self.assertEqual(paused['schedule']['state'], 'paused')
        self.assertEqual(paused['schedule']['next_run_at'], created['schedule']['next_run_at'])
        resumed = await dispatch(self.p, 'resume', {'schedule_id': ident}, self.user)
        self.assertTrue(resumed['schedule']['enabled'])
        with self.db.connect() as conn:
            row = conn.execute('SELECT next_run_at,created_at,updated_at FROM agent_schedules WHERE id=?', (ident,)).fetchone()
        self.assertTrue(all(isinstance(value, int) for value in row))

    async def running_scope(self, name, user=None):
        user = user or self.user
        admitted = await self.queue.enqueue(user, name, 'Use a tool')
        with self.db.connect() as conn:
            conn.execute("UPDATE durable_jobs SET status='running' WHERE id=?", (admitted['job_id'],))
        info = self.queue.scope(user, name)
        self.queue.running[info['scope_key']] = 'runtime-run'
        return info, {'sid': info['sid'], 'scope_key': info['sandbox']['scope_key'], 'run_id': 'runtime-run'}

    async def test_schedule_tool_manages_the_personal_ai_schedule_lifecycle(self):
        _, context = await self.running_scope('private')
        browser = Browser(self.p)
        async def call(action, **args):
            return (await browser.gateway('schedule', action, args, context))['data']
        spec = {'type': 'interval', 'every_seconds': 3600}
        created = (await call('create', name='Daily', prompt='Report', schedule=spec))['schedule']
        ident = created['id']
        self.assertEqual((created['state'], created['schedule']), ('active', spec))
        self.assertEqual([item['id'] for item in (await call('list'))['schedules']], [ident])
        self.assertEqual((await call('get', schedule_id=ident))['schedule']['name'], 'Daily')
        updated = (await call('update', schedule_id=ident, name='Weekly', schedule={'type': 'interval', 'every_seconds': 604800}))['schedule']
        self.assertEqual((updated['name'], updated['schedule']['every_seconds']), ('Weekly', 604800))
        self.assertEqual((await call('pause', schedule_id=ident))['schedule']['state'], 'paused')
        self.assertEqual((await call('resume', schedule_id=ident))['schedule']['state'], 'active')
        self.assertEqual((await call('history', schedule_id=ident))['runs'], [])
        ran = (await call('run_now', schedule_id=ident))['schedule']
        self.assertEqual(ran['last_run']['trigger'], 'manual')
        runs = (await call('history', schedule_id=ident))['runs']
        self.assertEqual([run['trigger'] for run in runs], ['manual'])
        with self.db.connect() as conn:
            contents = [json.loads(row[0]).get('content') for row in conn.execute("SELECT payload_json FROM durable_jobs WHERE status='queued'")]
        self.assertIn('Report', contents)
        self.assertEqual(await call('delete', schedule_id=ident), {'ok': True})
        self.assertEqual((await call('list'))['schedules'], [])

    async def test_schedule_tool_only_reaches_the_owners_schedules(self):
        _, owner_context = await self.running_scope('private')
        browser = Browser(self.p)
        created = (await browser.gateway('schedule', 'create', {'name': 'Mine', 'prompt': 'Report', 'schedule': {'type': 'interval', 'every_seconds': 60}}, owner_context))['data']['schedule']
        with self.db.connect() as conn:
            other = dict(conn.execute('SELECT * FROM users WHERE id=2').fetchone())
        _, other_context = await self.running_scope('private', other)
        self.assertEqual((await browser.gateway('schedule', 'list', {}, other_context))['data']['schedules'], [])
        for action in ('get', 'pause', 'delete', 'run_now', 'history'):
            with self.assertRaises(HTTPException) as raised:
                await browser.gateway('schedule', action, {'schedule_id': created['id']}, other_context)
            self.assertEqual(raised.exception.status_code, 404, action)

    async def test_chat_cannot_use_the_schedule_tool(self):
        with self.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations(id,user_id,title,created_at,updated_at) VALUES('conversation',1,'Chat','2026-01-01','2026-01-01')")
        _, context = await self.running_scope('chat-conversation')
        with self.assertRaises(HTTPException) as raised:
            await Browser(self.p).gateway('schedule', 'list', {}, context)
        self.assertEqual(raised.exception.status_code, 403)

    async def test_chat_and_channel_web_use_active_job_without_owner_hint(self):
        with self.db.connect() as conn:
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES(3,'Shared',?)", (int(time.time()),))
            conn.execute("INSERT INTO chat_conversations(id,user_id,title,created_at,updated_at) VALUES('conversation',1,'Chat','2026-01-01','2026-01-01')")
        browser = Browser(self.p)
        for name in ('channel-3', 'chat-conversation'):
            _, context = await self.running_scope(name)
            with patch('enterprise_agent_platform.tools.fetch', AsyncMock(return_value={'content': 'Public page', 'url': 'https://example.com'})):
                value = await browser.gateway('web', 'fetch', {'url': 'https://example.com'}, context)
                self.assertEqual(value['data']['content'], 'Public page')
                with self.assertRaises(HTTPException):
                    await browser.gateway('web', 'fetch', {'url': 'https://example.com'}, context | {'run_id': 'another-run'})

    async def test_claimed_once_occurrence_recovers_after_process_loss(self):
        class ProcessLoss(BaseException):
            pass
        await dispatch(self.p, 'create', {'name': 'Once', 'prompt': 'Recover me', 'schedule': {'type': 'once', 'at': '2020-01-01T00:00:00Z'}}, self.user)
        with patch.object(self.queue, 'enqueue', AsyncMock(side_effect=ProcessLoss)):
            with self.assertRaises(ProcessLoss):
                await tick(self.p)
        with self.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT durable_job_id FROM agent_schedule_runs').fetchone()[0], None)
            self.assertEqual(conn.execute('SELECT state FROM agent_schedules').fetchone()[0], 'completed')
        await tick(self.p)
        await tick(self.p)
        with self.db.connect() as conn:
            jobs = conn.execute('SELECT payload_json FROM durable_jobs').fetchall()
            run = conn.execute('SELECT durable_job_id FROM agent_schedule_runs').fetchone()
        self.assertEqual(len(jobs), 1)
        self.assertIsNotNone(run['durable_job_id'])
        self.assertEqual(json.loads(jobs[0]['payload_json'])['content'], 'Recover me')

    async def test_oversize_images_reject_before_durable_admission(self):
        info = self.scope(self.user, 'private')
        uploads = [self.files.store(self.user, info, f'image-{index}.png', b'x' * (7 * 1024 * 1024)) for index in range(2)]
        with self.assertRaises(HTTPException) as raised:
            await self.queue.enqueue(self.user, 'private', 'Read images', [row['id'] for row in uploads])
        self.assertEqual(raised.exception.status_code, 413)
        with self.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM durable_jobs').fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
            self.assertEqual(conn.execute('SELECT count(*) FROM pending_attachments').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
