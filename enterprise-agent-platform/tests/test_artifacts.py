import io
import json
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

from starlette.testclient import TestClient

from enterprise_agent_platform import artifacts as artifacts_module
from enterprise_agent_platform.admin import create_user
from enterprise_agent_platform.app import create_app
from enterprise_agent_platform.config import Settings

VIEW_CSP = ("sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads "
            "allow-presentation allow-pointer-lock; frame-ancestors 'self'")


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        frontend = self.root / 'static'
        frontend.mkdir()
        (frontend / 'index.html').write_text('<html></html>')
        self.app = create_app(Settings(data_dir=self.root, frontend_dir=frontend, manager_socket=str(self.root / 'missing.sock'),
                                       session_secret='test-secret', agent_tool_token='tool-test', runtime_token='runtime-test'))
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.p = self.app.state.platform
        password = (self.root / 'bootstrap-admin-password.txt').read_text().strip()
        self.assertEqual(self.client.post('/api/auth/login', json={'username': 'admin', 'password': password}).status_code, 200)
        create_user(self.p.db, 'bob', 'bob-password-1', role='user')
        self.bob = TestClient(self.app)
        self.assertEqual(self.bob.post('/api/auth/login', json={'username': 'bob', 'password': 'bob-password-1'}).status_code, 200)
        self.anonymous = TestClient(self.app)
        self.admin = self.p.queue.user(1)
        self.info = self.p.queue.scope(self.admin, 'private')
        self.workspace = Path(self.info['workspace'])

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def write(self, relative, content='x', root=None):
        path = (root or self.workspace) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        return path

    def publish(self, relative, info=None, **kwargs):
        info = info or self.info
        return self.p.artifacts.publish(self.admin, info, info['sandbox']['cwd'] + '/' + relative, **kwargs)

    def versions(self, ident):
        with self.p.db.connect() as conn:
            return [dict(row) for row in conn.execute('SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version', (ident,))]

    def blobs(self):
        folder = self.root / 'artifacts' / 'blobs'
        return {path.name for path in folder.iterdir()} if folder.exists() else set()

    def view_url(self, ident, version, client=None):
        response = (client or self.client).post(f'/api/artifacts/{ident}/versions/{version}/view')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['url']

    def chat(self):
        cid = self.client.post('/api/chat/conversations', json={'title': 'Chat'}).json()['conversation']['id']
        return cid, self.p.queue.scope(self.admin, 'chat-' + cid)

    # -- publishing ----------------------------------------------------------------------------

    def test_single_file_versions_increment_and_identical_content_creates_none(self):
        self.write('report.md', '# One')
        view, version, created = self.publish('report.md')
        self.assertEqual((version, created, view['kind'], view['entry'], view['title'], view['scope'], view['latest_version']),
                         (1, True, 'markdown', 'report.md', 'report', 'private', 1))
        self.assertEqual(view['path'], '/workspace/report.md')
        self.assertEqual(self.publish('report.md')[1:], (1, False))
        self.write('report.md', '# Two')
        view2, version2, created2 = self.publish('report.md', title='Report')
        self.assertEqual((version2, created2, view2['id'], view2['title'], view2['latest_version']), (2, True, view['id'], 'Report', 2))
        self.assertEqual(self.publish('report.md')[1:], (2, False))
        self.assertEqual([row['version'] for row in self.versions(view['id'])], [1, 2])
        self.assertEqual(len(self.blobs()), 2)
        # Reverting to the first content is a new version, not a reuse of version 1.
        self.write('report.md', '# One')
        self.assertEqual(self.publish('report.md')[1:], (3, True))
        self.assertEqual(len(self.blobs()), 2)

    def test_kind_is_derived_from_the_extension_and_other_files_are_refused_with_a_media_hint(self):
        for name, kind in [('a.html', 'web'), ('a.htm', 'web'), ('a.markdown', 'markdown'), ('a.mmd', 'mermaid'), ('a.mermaid', 'mermaid'),
                           ('a.svg', 'svg'), ('a.csv', 'table'), ('a.tsv', 'table'), ('a.png', 'image'), ('a.jpeg', 'image'),
                           ('a.pdf', 'pdf'), ('a.py', 'code'), ('a.json', 'code'), ('a.docx', 'docx'), ('a.xlsx', 'xlsx'),
                           ('a.pptx', 'pptx')]:
            self.write(name, 'content')
            self.assertEqual(self.publish(name)[0]['kind'], kind, name)
        self.write('archive.zip', 'zip')
        with self.assertRaises(artifacts_module.ArtifactError) as raised:
            self.publish('archive.zip')
        self.assertEqual((raised.exception.status_code, raised.exception.code), (415, 'artifact_unsupported_kind'))
        self.assertIn('MEDIA', raised.exception.detail)

    def test_site_snapshot_skips_git_node_modules_and_links_and_never_follows_them(self):
        site = self.workspace / 'site'
        self.write('site/index.html', '<link rel="stylesheet" href="css/app.css">')
        self.write('site/css/app.css', 'body{}')
        self.write('site/js/app.mjs', 'export default 1')
        self.write('site/.git/config', 'secret')
        self.write('site/node_modules/pkg/index.js', 'dep')
        self.write('site/sub/node_modules/pkg/index.js', 'dep')
        self.write('site/.hidden.txt', 'dotfile')
        outside = self.root / 'outside'
        self.write('secret.txt', 'top secret', root=outside)
        os.symlink(outside / 'secret.txt', site / 'link.txt')
        os.symlink(outside, site / 'linked-dir')
        os.symlink(self.workspace / 'site' / 'index.html', site / 'alias.html')
        view, version, created = self.publish('site')
        self.assertEqual((view['kind'], view['entry'], view['title'], version, created), ('site', 'index.html', 'site', 1, True))
        files = self.client.get(f"/api/artifacts/{view['id']}/versions/1/files").json()
        self.assertEqual([item['path'] for item in files['files']], ['.hidden.txt', 'css/app.css', 'index.html', 'js/app.mjs'])
        self.assertEqual(files['entry'], 'index.html')
        self.assertEqual({item['path']: item['mime'] for item in files['files']}['js/app.mjs'], 'text/javascript')
        self.assertFalse(any(b'top secret' in (self.root / 'artifacts' / 'blobs' / name).read_bytes() for name in self.blobs()))
        self.assertEqual(len(self.blobs()), 4)

    def test_site_entry_defaults_to_index_and_must_exist(self):
        self.write('docs/readme.html', '<p>hi</p>')
        with self.assertRaises(artifacts_module.ArtifactError) as raised:
            self.publish('docs')
        self.assertEqual(raised.exception.code, 'artifact_entry_not_found')
        view, version, _ = self.publish('docs', entry='readme.html')
        self.assertEqual((view['entry'], version), ('readme.html', 1))
        with self.assertRaises(artifacts_module.ArtifactError):
            self.publish('docs', entry='../x.html')

    def test_a_symlinked_published_path_and_a_symlinked_parent_are_refused(self):
        outside = self.root / 'outside'
        self.write('page.html', '<p>no</p>', root=outside)
        os.symlink(outside / 'page.html', self.workspace / 'linked.html')
        os.symlink(outside, self.workspace / 'linkdir')
        for relative in ('linked.html', 'linkdir', 'linkdir/page.html'):
            with self.assertRaises(artifacts_module.ArtifactError, msg=relative) as raised:
                self.publish(relative)
            expected = (404, 'artifact_path_not_found') if relative == 'linkdir/page.html' else (400, 'artifact_path_invalid')
            self.assertEqual((raised.exception.status_code, raised.exception.code), expected, relative)
        self.assertEqual(self.blobs(), set())

    def test_paths_must_be_absolute_sandbox_paths_inside_the_workspace(self):
        self.write('ok.md', 'x')
        for value in ('ok.md', '/etc/passwd', '/workspace', '/workspace/', '/workspace/../etc/passwd', '/workspace/a/../ok.md', '/workspacex/ok.md', 5, None):
            with self.assertRaises(artifacts_module.ArtifactError, msg=repr(value)) as raised:
                self.p.artifacts.publish(self.admin, self.info, value)
            self.assertEqual(raised.exception.code, 'artifact_path_invalid', repr(value))
        with self.assertRaises(artifacts_module.ArtifactError) as raised:
            self.publish('missing.md')
        self.assertEqual(raised.exception.code, 'artifact_path_not_found')
        # Redundant separators name the same artifact.
        a = self.publish('ok.md')[0]
        self.assertEqual(self.p.artifacts.publish(self.admin, self.info, '/workspace//ok.md')[0]['id'], a['id'])

    def test_limits_on_files_file_size_and_total_size(self):
        for index in range(3):
            self.write(f'many/{index}.txt', str(index))
        with patch.object(artifacts_module, 'MAX_FILES', 2):
            with self.assertRaises(artifacts_module.ArtifactError) as raised:
                self.publish('many')
        self.assertEqual((raised.exception.status_code, raised.exception.code), (413, 'artifact_too_many_files'))
        self.write('big/a.txt', 'a' * 10)
        with patch.object(artifacts_module, 'MAX_FILE', 5):
            with self.assertRaises(artifacts_module.ArtifactError) as raised:
                self.publish('big')
            self.assertEqual(raised.exception.code, 'artifact_file_too_large')
            with self.assertRaises(artifacts_module.ArtifactError) as raised:
                self.publish('big/a.txt')
            self.assertEqual(raised.exception.code, 'artifact_file_too_large')
        self.write('total/a.txt', 'a' * 6)
        self.write('total/b.txt', 'b' * 6)
        with patch.object(artifacts_module, 'MAX_TOTAL', 10):
            with self.assertRaises(artifacts_module.ArtifactError) as raised:
                self.publish('total')
        self.assertEqual((raised.exception.status_code, raised.exception.code), (413, 'artifact_too_large'))
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM artifacts').fetchone()[0], 0)
        self.assertEqual(self.blobs(), set())
        self.assertEqual(artifacts_module.MAX_FILES, 1000)
        self.assertEqual((artifacts_module.MAX_FILE, artifacts_module.MAX_TOTAL), (32 * 1024 * 1024, 50 * 1024 * 1024))

    def test_published_snapshot_is_immutable_when_the_workspace_changes(self):
        self.write('page.html', '<p>one</p>')
        view = self.publish('page.html')[0]
        self.write('page.html', '<p>two</p>')
        self.publish('page.html')
        first = self.client.get(self.view_url(view['id'], 1))
        second = self.client.get(self.view_url(view['id'], 2))
        self.assertEqual((first.text, second.text), ('<p>one</p>', '<p>two</p>'))

    # -- MEDIA ---------------------------------------------------------------------------------

    def test_media_viewable_kinds_become_artifacts_and_other_files_stay_attachments(self):
        for name in ('page.html', 'notes.md', 'chart.svg', 'flow.mmd', 'data.csv', 'old.htm', 'a.markdown', 'b.mermaid', 'c.tsv'):
            self.write(name, 'content ' + name)
        for name in ('doc.docx', 'sheet.xlsx', 'deck.pptx', 'doc.pdf'):
            self.write(name, 'office ' + name)
        self.write('pic.png', 'png')
        self.write('script.py', 'print(1)')
        text = '\n'.join('MEDIA: /workspace/' + name for name in (
            'page.html', 'notes.md', 'chart.svg', 'flow.mmd', 'data.csv', 'old.htm', 'a.markdown', 'b.mermaid', 'c.tsv',
            'doc.docx', 'sheet.xlsx', 'deck.pptx', 'doc.pdf', 'pic.png', 'script.py'))
        import asyncio
        _, job, payload = self.running_job()
        delivered = asyncio.run(self.p.files.deliver(self.admin, self.info, payload['message_id'], text, job['id']))
        self.assertEqual(sorted(item['filename'] for item in delivered), ['pic.png', 'script.py'])
        listing = self.client.get('/api/artifacts?scope=private').json()['artifacts']
        self.assertEqual(sorted(item['path'] for item in listing), sorted('/workspace/' + name for name in (
            'page.html', 'notes.md', 'chart.svg', 'flow.mmd', 'data.csv', 'old.htm', 'a.markdown', 'b.mermaid', 'c.tsv',
            'doc.docx', 'sheet.xlsx', 'deck.pptx', 'doc.pdf')))
        kinds = {item['path']: item['kind'] for item in listing}
        self.assertEqual([kinds['/workspace/' + name] for name in ('doc.docx', 'sheet.xlsx', 'deck.pptx', 'doc.pdf')], ['docx', 'xlsx', 'pptx', 'pdf'])
        with self.p.db.connect() as conn:
            rows = conn.execute('SELECT message_id,job_id FROM artifact_versions').fetchall()
        self.assertEqual({(row[0], row[1]) for row in rows}, {(payload['message_id'], job['id'])})

    # -- Office viewer and attachment view tokens -------------------------------------------------

    def static_file(self, relative, content):
        path = self.root / 'static' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def upload(self, name, data, scope='private', client=None):
        response = (client or self.client).post(f'/api/attachments?scope={scope}', files={'file': (name, data)})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['attachment']

    def mint(self, ident, client=None):
        return (client or self.client).post(f'/api/attachments/{ident}/view')

    def test_office_artifact_view_url_is_the_sandboxed_viewer_page_and_raw_gives_the_bytes(self):
        from enterprise_agent_platform import file_viewer
        for name, kind in (('r.docx', 'docx'), ('b.xlsx', 'xlsx'), ('d.pptx', 'pptx')):
            data = b'PK\x03\x04 ' + name.encode() + ' 中文'.encode()
            self.write(name, data)
            view = self.publish(name)[0]
            self.assertEqual(view['kind'], kind)
            url = self.view_url(view['id'], 1)
            page = self.anonymous.get(url)
            self.assertEqual(page.status_code, 200)
            self.assertTrue(page.headers['content-type'].startswith('text/html'))
            self.assertEqual(page.headers['content-security-policy'], file_viewer.VIEWER_CSP)
            self.assertNotIn('allow-same-origin', page.headers['content-security-policy'])
            self.assertIn('/file-viewer/viewer.js', page.text)
            self.assertIn(f'data-kind="{kind}"', page.text)
            self.assertNotIn('artifact-runtime', page.text)
            raw = self.anonymous.get(url + '?raw=1')
            self.assertEqual((raw.status_code, raw.content), (200, data))
            self.assertEqual(raw.headers['access-control-allow-origin'], '*')
            self.assertEqual(raw.headers['content-security-policy'], VIEW_CSP)
            # Downloads are unchanged: the plain file as an attachment.
            download = self.client.get(f"/api/artifacts/{view['id']}/versions/1/download")
            self.assertEqual((download.content, download.headers['content-disposition'].split(';')[0]), (data, 'attachment'))
            self.assertEqual(self.anonymous.get(url.rsplit('/', 1)[0] + '/other.docx').status_code, 404)

    def test_the_viewer_page_language_follows_the_lang_query_and_only_known_values(self):
        self.write('x.docx', 'PK')
        url = self.view_url(self.publish('x.docx')[0]['id'], 1)
        for query, expected in (('?lang=zh-TW', 'zh-TW'), ('?lang=zh-CN', 'zh-CN'), ('?lang=en', 'en'), ('?lang="><x', 'en'), ('', 'en')):
            self.assertIn(f'<html lang="{expected}"', self.anonymous.get(url + query).text, query)

    def test_the_viewer_title_is_escaped_and_a_site_folder_keeps_its_plain_files(self):
        self.write('x.docx', 'PK')
        view = self.publish('x.docx', title='</title><script>alert(1)</script>')[0]
        page = self.anonymous.get(self.view_url(view['id'], 1))
        self.assertNotIn('<script>alert', page.text)
        self.write('site/index.html', '<p>x</p>')
        self.write('site/report.docx', 'PK')
        site = self.publish('site')[0]
        base = self.view_url(site['id'], 1).rsplit('/', 1)[0]
        plain = self.anonymous.get(base + '/report.docx')
        self.assertEqual((plain.status_code, plain.content, plain.headers['content-security-policy']), (200, b'PK', VIEW_CSP))

    def test_viewer_assets_are_public_cors_readable_cacheable_and_contained(self):
        self.static_file('file-viewer/viewer.js', 'import("./chunk-docx-ABCD1234.js")')
        self.static_file('file-viewer/chunk-docx-ABCD1234.js', 'export const render = 1')
        self.static_file('file-viewer/notes.txt', 'nope')
        self.static_file('secret.js', 'outside')
        entry = self.anonymous.get('/file-viewer/viewer.js')
        chunk = self.anonymous.get('/file-viewer/chunk-docx-ABCD1234.js')
        for response in (entry, chunk):
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.headers['content-type'].startswith('text/javascript'))
            self.assertEqual(response.headers['access-control-allow-origin'], '*')
            self.assertEqual(response.headers['cross-origin-resource-policy'], 'cross-origin')
            self.assertEqual(response.headers['x-content-type-options'], 'nosniff')
        self.assertEqual(entry.headers['cache-control'], 'no-cache')
        self.assertIn('immutable', chunk.headers['cache-control'])
        import gzip
        (self.root / 'static' / 'file-viewer' / 'viewer.js.gz').write_bytes(gzip.compress(b'import("./chunk-docx-ABCD1234.js")'))
        packed = self.anonymous.get('/file-viewer/viewer.js', headers={'accept-encoding': 'gzip'})
        self.assertEqual((packed.headers['content-encoding'], packed.text), ('gzip', 'import("./chunk-docx-ABCD1234.js")'))
        self.assertNotIn('content-encoding', self.anonymous.get('/file-viewer/viewer.js', headers={'accept-encoding': 'identity'}).headers)
        for path in ('/file-viewer/notes.txt', '/file-viewer/missing.js', '/file-viewer/%2e%2e/secret.js', '/file-viewer/..%2fsecret.js', '/file-viewer/'):
            self.assertEqual(self.anonymous.get(path).status_code, 404, path)

    def test_attachment_view_kinds_and_the_bytes_each_serves(self):
        office = b'PK\x03\x04 office ' + '中文'.encode()
        cases = {'a.docx': 'docx', 'b.xlsx': 'xlsx', 'c.pptx': 'pptx', 'd.pdf': 'pdf', 'e.png': 'image', 'f.txt': 'text',
                 'g.md': 'text', 'h.ts': 'text', 'i.zip': 'other'}
        for name, kind in cases.items():
            attachment = self.upload(name, office)
            self.assertEqual(attachment['view_kind'], kind, name)
            response = self.mint(attachment['id'])
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual((body['kind'], sorted(body)), (kind, ['expires_at', 'kind', 'url']), name)
            self.assertRegex(body['url'], r'^/attachment-view/-?\d+\.\d+\.[A-Za-z0-9_-]+/')
            served = self.anonymous.get(body['url'])
            self.assertEqual(served.status_code, 200, name)
            self.assertEqual(served.headers['x-content-type-options'], 'nosniff')
            self.assertEqual(served.headers['referrer-policy'], 'no-referrer')
            if kind in ('docx', 'xlsx', 'pptx'):
                self.assertIn(f'data-kind="{kind}"', served.text)
                raw = self.anonymous.get(body['url'] + '?raw=1')
                self.assertEqual((raw.content, raw.headers['access-control-allow-origin']), (office, '*'))
            elif kind == 'other':
                self.assertEqual(served.headers['content-disposition'].split(';')[0], 'attachment')
                self.assertEqual(served.headers['content-security-policy'], 'sandbox')
            else:
                self.assertEqual(served.headers['content-security-policy'], VIEW_CSP)
                self.assertEqual(served.content, office.decode('utf-8', 'replace').encode() if kind == 'text' else office)
        # HTML uploads are shown as text, never as a page.
        html = self.upload('p.html', '<script>alert(1)</script>')
        shown = self.anonymous.get(self.mint(html['id']).json()['url'])
        self.assertTrue(shown.headers['content-type'].startswith('text/plain'))

    def test_text_attachments_are_cut_at_two_mebibytes_on_a_character_boundary(self):
        attachment = self.upload('big.txt', ('中' * 1_000_000).encode())
        served = self.anonymous.get(self.mint(attachment['id']).json()['url'])
        self.assertEqual(served.headers['content-type'], 'text/plain; charset=utf-8')
        self.assertLessEqual(len(served.content), 2 * 1024 * 1024)
        self.assertNotIn('\ufffd', served.text[:-1])

    def test_attachment_view_mint_is_authorized_like_the_download(self):
        mine = self.upload('mine.docx', b'PK')
        self.assertEqual(self.mint(mine['id'], self.bob).status_code, 404)
        self.assertEqual(self.mint(99999).status_code, 404)
        self.assertEqual(self.mint(-99999).status_code, 404)
        self.assertEqual(self.mint(mine['id'], self.anonymous).status_code, 401)
        # A pending upload belongs to its uploader until a message binds it.
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM pending_attachments').fetchone()[0], 1)
        # Chat attachments use negative ids and the conversation's owner check.
        cid, _ = self.chat()
        chat = self.upload('c.docx', b'PK', scope='chat-' + cid)
        self.assertLess(chat['id'], 0)
        response = self.mint(chat['id'])
        self.assertEqual((response.status_code, response.json()['kind']), (200, 'docx'))
        self.assertEqual(self.anonymous.get(response.json()['url'] + '?raw=1').content, b'PK')
        self.assertEqual(self.mint(chat['id'], self.bob).status_code, 404)

    def test_attachment_view_tokens_expire_and_cannot_be_forged_or_reused_across_kinds(self):
        attachment = self.upload('t.docx', b'PK')
        url = self.mint(attachment['id']).json()['url']
        token, name = url.split('/')[2:4]
        ident, expires, signature = token.split('.')
        self.assertEqual(self.anonymous.get(url).status_code, 200)
        self.assertTrue(7190 <= int(expires) - time.time() <= 7201)
        with patch('enterprise_agent_platform.files.time.time', return_value=time.time() + 7300):
            self.assertEqual(self.anonymous.get(url).status_code, 404)
        other = f'{int(ident) + 1}.{expires}.{signature}'
        for bad in (other, f'{ident}.{int(expires) + 100}.{signature}', f'{ident}.{expires}.{signature[:-1]}' + ('B' if signature[-1] == 'A' else 'A'), 'x.y.z', f'{ident}.{expires}'):
            self.assertEqual(self.anonymous.get(f'/attachment-view/{bad}/{name}').status_code, 404, bad)
        # An artifact token is not an attachment token and vice versa.
        self.write('r.docx', 'PK')
        view = self.publish('r.docx')[0]
        artifact_token = self.p.artifacts.mint(view['id'], 1)[0]
        self.assertEqual(self.anonymous.get(f'/attachment-view/{artifact_token}/r.docx').status_code, 404)
        self.assertEqual(self.anonymous.get(f'/artifact-view/{token}/{name}').status_code, 404)

    def test_attachment_view_tokens_stop_with_their_chat_or_channel(self):
        cid, _ = self.chat()
        chat = self.upload('c.docx', b'PK', scope='chat-' + cid)
        chat_url = self.mint(chat['id']).json()['url']
        channel = self.client.post('/api/channels', json={'name': 'Team'}).json()['channel']
        shared = self.upload('s.docx', b'PK', scope=f"channel-{channel['id']}")
        channel_url = self.mint(shared['id']).json()['url']
        for url in (chat_url, channel_url):
            self.assertEqual(self.anonymous.get(url + '?raw=1').status_code, 200)
        self.p.queue.runtime = AsyncMock(return_value={})
        self.assertEqual(self.client.delete(f'/api/chat/conversations/{cid}').status_code, 200)
        self.assertEqual(self.anonymous.get(chat_url + '?raw=1').status_code, 404)
        self.assertEqual(self.client.delete(f"/api/channels/{channel['id']}").status_code, 200)
        self.assertEqual(self.anonymous.get(channel_url + '?raw=1').status_code, 404)

    def test_attachment_view_tokens_are_bound_to_the_file_content(self):
        attachment = self.upload('t.docx', b'PK one')
        url = self.mint(attachment['id']).json()['url']
        self.assertEqual(self.anonymous.get(url).status_code, 200)
        with self.p.db.connect() as conn:
            conn.execute('UPDATE pending_attachments SET sha256=? WHERE id=?', ('0' * 64, attachment['id']))
        self.assertEqual(self.anonymous.get(url).status_code, 404)

    def test_only_the_office_bytes_are_cors_readable_among_attachment_views(self):
        for name, data in (('a.txt', b'x'), ('b.pdf', b'%PDF'), ('c.zip', b'PK'), ('d.docx', b'PK')):
            url = self.mint(self.upload(name, data)['id']).json()['url']
            served = self.anonymous.get(url)
            self.assertNotIn('access-control-allow-origin', served.headers, name)
            self.assertNotIn('cross-origin-resource-policy', served.headers, name)
        self.assertEqual(self.anonymous.get(url + '?raw=1').headers['access-control-allow-origin'], '*')

    def test_the_old_document_text_previews_are_gone_and_only_images_have_a_thumbnail(self):
        docx = self.upload('a.docx', b'PK')
        text = self.upload('a.txt', b'hello')
        self.assertEqual((docx['preview_url'], text['preview_url']), (None, None))
        self.assertEqual(self.client.get(f"/api/attachments/{docx['id']}/preview").status_code, 415)
        self.assertEqual(self.client.get(f"/api/attachments/{text['id']}/preview").status_code, 415)
        buffer = io.BytesIO()
        from PIL import Image
        Image.new('RGB', (4, 4)).save(buffer, 'PNG')
        image = self.upload('a.png', buffer.getvalue())
        self.assertEqual(image['preview_url'], f"/api/attachments/{image['id']}/preview")
        self.assertEqual(self.client.get(image['preview_url']).headers['content-type'], 'image/png')
        self.assertEqual(self.client.get(docx['url']).content, b'PK')

    # -- SSE, gateway and message link ---------------------------------------------------------

    def events(self, key):
        with self.p.db.connect() as conn:
            return [json.loads(row[0]) for row in conn.execute('SELECT event_json FROM queue_events WHERE scope_key=? ORDER BY id', (key,))]

    def running_job(self, scope='private', user=None, message='hello'):
        user = user or self.admin
        info = self.p.queue.scope(user, scope)
        with self.p.db.connect() as conn:
            mid = self.p.queue.insert_message(conn, info, user, 'user', message, {'status': 'running'})
            payload = {'user_id': user['id'], 'scope': scope, 'message_id': mid, 'content': message, 'attachment_ids': []}
            job = conn.execute("INSERT INTO durable_jobs(kind,scope_type,scope_id,dedupe_key,payload_json,status,created_at,updated_at) "
                               "VALUES ('agent',?,?,?,?,'running',1,1)", (info['scope_type'], info['scope_id'], os.urandom(8).hex(), json.dumps(payload))).lastrowid
        return info, {'id': job}, payload

    def context(self, info):
        return {'sid': info['sid'], 'scope_key': info['sandbox']['scope_key'], 'run_id': 'run-1'}

    def test_publish_emits_an_artifact_event_only_when_a_version_is_created(self):
        self.write('page.html', '<p>x</p>')
        view, version, _ = self.publish('page.html')
        self.publish('page.html')
        events = [event for event in self.events('private:1') if event['type'] == 'artifact']
        self.assertEqual(events, [{'type': 'artifact', 'artifact': view, 'version': 1}])
        self.write('page.html', '<p>y</p>')
        view2 = self.publish('page.html')[0]
        events = [event for event in self.events('private:1') if event['type'] == 'artifact']
        self.assertEqual([event['version'] for event in events], [1, 2])
        self.assertEqual(events[1]['artifact'], view2)
        # The live event stream replays it with the event name and the artifact payload.
        import asyncio

        async def first_artifact():
            async for chunk in self.p.queue.events(self.admin, 'private', 0):
                if b'event: artifact' in chunk:
                    return chunk
        chunk = asyncio.run(asyncio.wait_for(first_artifact(), 3)).decode()
        self.assertIn('event: artifact', chunk)
        self.assertEqual(json.loads(chunk.split('data: ', 1)[1])['artifact']['path'], '/workspace/page.html')

    def test_gateway_publish_and_list_in_every_root_scope_and_not_for_subagents(self):
        import asyncio
        self.write('plan.md', '# Plan')
        info, job, _ = self.running_job()
        result = asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': '/workspace/plan.md', 'title': 'Plan'}, self.context(info)))
        self.assertFalse(result['is_error'])
        self.assertIn('version 1', result['content'])
        self.assertIn('artifact panel', result['content'])
        self.assertEqual((result['data']['version'], result['data']['created'], result['data']['artifact']['title']), (1, True, 'Plan'))
        listing = asyncio.run(self.p.browser.gateway('artifacts', 'list', {}, self.context(info)))
        self.assertEqual([item['path'] for item in listing['data']['artifacts']], ['/workspace/plan.md'])
        self.assertIn('v1', listing['content'])
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT job_id FROM artifact_versions').fetchone()[0], job['id'])
        bad = asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': '/workspace/deck.pptx'}, self.context(info)))
        self.assertTrue(bad['is_error'])
        self.assertEqual(bad['data']['error'], 'artifact_path_not_found')
        self.write('archive.zip', 'zip')
        bad = asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': '/workspace/archive.zip'}, self.context(info)))
        self.assertEqual(bad['data']['error'], 'artifact_unsupported_kind')
        self.assertIn('MEDIA', bad['content'])
        # Chat and channel root runs publish into their own scopes.
        cid, chat_info = self.chat()
        self.write('c.md', '# chat', root=Path(chat_info['workspace']))
        chat_info, _, _ = self.running_job('chat-' + cid)
        shown = asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': f'/workspace/{cid}/c.md'}, self.context(chat_info)))
        self.assertEqual(shown['data']['artifact']['scope'], 'chat-' + cid)
        outside = asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': '/workspace/plan.md'}, self.context(chat_info)))
        self.assertEqual(outside['data']['error'], 'artifact_path_invalid')
        channel = self.client.post('/api/channels', json={'name': 'Team'}).json()['channel']
        channel_info, _, _ = self.running_job(f"channel-{channel['id']}")
        self.write('ch.html', '<p>c</p>', root=Path(channel_info['workspace']))
        shown = asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': '/workspace/ch.html'}, self.context(channel_info)))
        self.assertEqual(shown['data']['artifact']['scope'], f"channel-{channel['id']}")
        # A subagent run has no conversation job and cannot publish.
        child = {'sid': 'agent-private-1-bg-4', 'scope_key': 'private:1/delegate/bg-4', 'run_id': 'run-9'}
        with self.assertRaises(Exception) as raised:
            asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': '/workspace/plan.md'}, child))
        self.assertEqual(raised.exception.status_code, 403)

    def test_message_persistence_links_versions_and_lists_them_in_metadata(self):
        import asyncio
        self.write('a.md', '# A')
        self.write('b.html', '<p>b</p>')
        self.write('pack.zip', 'zip')
        info, job, payload = self.running_job()
        asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': '/workspace/a.md', 'title': 'Alpha'}, self.context(info)))
        text = 'Done.\nMEDIA: /workspace/b.html\nMEDIA: /workspace/pack.zip'
        asyncio.run(self.p.queue.finish(job, payload, self.admin, info, {'type': 'run_end', 'status': 'completed', 'text': text, 'usage': {}}))
        page = self.p.queue.messages(self.admin, 'private')['messages']
        reply = next(message for message in page if message['role'] == 'assistant')
        listing = {item['path']: item for item in self.client.get('/api/artifacts?scope=private').json()['artifacts']}
        self.assertEqual(reply['metadata']['artifacts'], [
            {'id': listing['/workspace/a.md']['id'], 'version': 1, 'title': 'Alpha', 'kind': 'markdown', 'path': '/workspace/a.md'},
            {'id': listing['/workspace/b.html']['id'], 'version': 1, 'title': 'b', 'kind': 'web', 'path': '/workspace/b.html'}])
        self.assertEqual([item['filename'] for item in reply['attachments']], ['pack.zip'])
        self.assertEqual(reply['metadata']['status'], 'completed')
        for item in listing.values():
            detail = self.client.get(f"/api/artifacts/{item['id']}").json()
            self.assertEqual([version['message_id'] for version in detail['versions']], [reply['id']])
        # The run_end event carries the same message, so the live reply shows the cards.
        end = next(event for event in self.events('private:1') if event['type'] == 'run_end')
        self.assertEqual(end['message']['metadata']['artifacts'], reply['metadata']['artifacts'])
        self.assertEqual(sum(event['type'] == 'artifact' for event in self.events('private:1')), 2)

    def test_a_reply_without_artifacts_has_no_artifact_metadata(self):
        import asyncio
        info, job, payload = self.running_job()
        asyncio.run(self.p.queue.finish(job, payload, self.admin, info, {'type': 'run_end', 'status': 'completed', 'text': 'plain', 'usage': {}}))
        reply = [m for m in self.p.queue.messages(self.admin, 'private')['messages'] if m['role'] == 'assistant'][0]
        self.assertNotIn('artifacts', reply['metadata'])

    # -- user APIs and authorization -----------------------------------------------------------

    def test_listing_detail_files_source_and_view_for_the_owner(self):
        self.write('one.md', '# 一')
        self.write('two.csv', 'a,b\n1,2\n')
        first = self.publish('one.md')[0]
        self.write('one.md', '# 二')
        self.publish('one.md')
        second = self.publish('two.csv')[0]
        listing = self.client.get('/api/artifacts?scope=private').json()['artifacts']
        self.assertEqual([item['id'] for item in listing], [second['id'], first['id']])
        self.assertEqual(listing[1]['latest_version'], 2)
        self.assertEqual(set(listing[0]), {'id', 'scope', 'path', 'kind', 'title', 'entry', 'latest_version', 'created_at', 'updated_at'})
        detail = self.client.get(f"/api/artifacts/{first['id']}").json()
        self.assertEqual(detail['artifact']['id'], first['id'])
        self.assertEqual([item['version'] for item in detail['versions']], [2, 1])
        self.assertEqual(set(detail['versions'][0]), {'version', 'entry', 'created_at', 'total_size', 'file_count', 'message_id'})
        self.assertEqual((detail['versions'][0]['file_count'], detail['versions'][0]['message_id']), (1, None))
        source = self.client.get(f"/api/artifacts/{first['id']}/versions/1/source").json()
        self.assertEqual(source, {'content': '# 一', 'truncated': False, 'mime': 'text/markdown'})
        self.assertEqual(self.client.get(f"/api/artifacts/{first['id']}/versions/2/source?path=one.md").json()['content'], '# 二')
        self.assertEqual(self.client.get(f"/api/artifacts/{first['id']}/versions/3/source").status_code, 404)
        self.assertEqual(self.client.get(f"/api/artifacts/{first['id']}/versions/1/source?path=nope.md").status_code, 404)
        self.assertEqual(self.client.get('/api/artifacts/999').status_code, 404)
        self.assertEqual(self.client.get('/api/artifacts/abc').status_code, 404)
        self.assertEqual(self.client.get('/api/artifacts?scope=bogus').status_code, 404)
        self.assertEqual(self.anonymous.get('/api/artifacts?scope=private').status_code, 401)

    def test_source_is_text_only_and_truncated_at_two_megabytes(self):
        big = 'é' * (artifacts_module.SOURCE_LIMIT // 2 + 10)
        self.write('big.md', big)
        self.write('pic.png', b'\x89PNG\r\n\x1a\n')
        entry = self.publish('big.md')[0]
        source = self.client.get(f"/api/artifacts/{entry['id']}/versions/1/source").json()
        self.assertTrue(source['truncated'])
        self.assertLessEqual(len(source['content'].encode()), artifacts_module.SOURCE_LIMIT)
        self.assertEqual(source['content'], 'é' * (artifacts_module.SOURCE_LIMIT // 2))
        image = self.publish('pic.png')[0]
        refused = self.client.get(f"/api/artifacts/{image['id']}/versions/1/source")
        self.assertEqual((refused.status_code, refused.json()['code']), (415, 'artifact_not_text'))
        exact = 'a' * artifacts_module.SOURCE_LIMIT
        self.write('exact.md', exact)
        shown = self.client.get(f"/api/artifacts/{self.publish('exact.md')[0]['id']}/versions/1/source").json()
        self.assertEqual((shown['truncated'], len(shown['content'])), (False, artifacts_module.SOURCE_LIMIT))

    def test_download_single_file_and_site_zip(self):
        self.write('report.md', '# Report')
        self.write('site/index.html', '<p>home</p>')
        self.write('site/css/app.css', 'body{}')
        self.write('site/.git/config', 'nope')
        single = self.publish('report.md')[0]
        download = self.client.get(f"/api/artifacts/{single['id']}/versions/1/download")
        self.assertEqual((download.status_code, download.content), (200, b'# Report'))
        self.assertTrue(download.headers['content-disposition'].startswith('attachment'))
        self.assertIn('report.md', download.headers['content-disposition'])
        site = self.publish('site')[0]
        archive = self.client.get(f"/api/artifacts/{site['id']}/versions/1/download")
        self.assertEqual(archive.headers['content-type'], 'application/zip')
        self.assertTrue(archive.headers['content-disposition'].startswith('attachment'))
        self.assertIn('site-v1.zip', archive.headers['content-disposition'])
        with zipfile.ZipFile(io.BytesIO(archive.content)) as zipped:
            self.assertEqual(sorted(zipped.namelist()), ['css/app.css', 'index.html'])
            self.assertEqual(zipped.read('index.html'), b'<p>home</p>')
        self.write('report.md', '# Report 2')
        self.publish('report.md')
        old = self.client.get(f"/api/artifacts/{single['id']}/versions/1/download")
        self.assertEqual(old.content, b'# Report')
        self.assertEqual(self.client.get(f"/api/artifacts/{single['id']}/versions/9/download").status_code, 404)

    def test_scopes_authorize_like_their_conversation_and_foreign_users_get_404(self):
        self.write('mine.md', '# mine')
        private = self.publish('mine.md')[0]
        cid, chat_info = self.chat()
        self.write('c.md', '# chat', root=Path(chat_info['workspace']))
        chat = self.p.artifacts.publish(self.admin, chat_info, f'/workspace/{cid}/c.md')[0]
        channel = self.client.post('/api/channels', json={'name': 'Team'}).json()['channel']
        channel_info = self.p.queue.scope(self.admin, f"channel-{channel['id']}")
        self.write('ch.md', '# channel', root=Path(channel_info['workspace']))
        shared = self.p.artifacts.publish(self.admin, channel_info, '/workspace/ch.md')[0]
        self.assertEqual((private['scope'], chat['scope'], shared['scope']), ('private', f'chat-{cid}', f"channel-{channel['id']}"))
        self.assertEqual([item['id'] for item in self.client.get(f'/api/artifacts?scope=chat-{cid}').json()['artifacts']], [chat['id']])
        self.assertEqual([item['id'] for item in self.client.get(f"/api/artifacts?scope=channel-{channel['id']}").json()['artifacts']], [shared['id']])
        self.assertEqual(self.client.get(f'/api/artifacts?scope=private').json()['artifacts'][0]['id'], private['id'])
        # Bob's own scopes never show the admin's artifacts.
        self.assertEqual(self.bob.get('/api/artifacts?scope=private').json()['artifacts'], [])
        self.assertEqual(self.bob.get(f'/api/artifacts?scope=chat-{cid}').status_code, 404)
        for item in (private, chat):
            self.assertEqual(self.bob.get(f"/api/artifacts/{item['id']}").status_code, 404)
            for suffix in ('files', 'source', 'download'):
                self.assertEqual(self.bob.get(f"/api/artifacts/{item['id']}/versions/1/{suffix}").status_code, 404, suffix)
            self.assertEqual(self.bob.post(f"/api/artifacts/{item['id']}/versions/1/view").status_code, 404)
        # Channel artifacts follow read access to the channel.
        self.assertEqual(self.bob.get(f"/api/artifacts/{shared['id']}").status_code, 200)
        self.assertEqual([item['id'] for item in self.bob.get(f"/api/artifacts?scope=channel-{channel['id']}").json()['artifacts']], [shared['id']])
        with self.p.db.connect() as conn:
            conn.execute("UPDATE users SET permission_group='no-such-group' WHERE username='bob'")
        self.assertEqual(self.bob.get(f"/api/artifacts/{shared['id']}").status_code, 404)
        self.assertEqual(self.bob.get(f"/api/artifacts?scope=channel-{channel['id']}").status_code, 403)
        # A deleted chat's artifacts are unreachable.
        self.assertEqual(self.anonymous.get(f"/api/artifacts/{private['id']}").status_code, 401)

    # -- view tokens and the view route --------------------------------------------------------

    def test_view_url_token_expiry_tampering_and_other_versions(self):
        self.write('site/index.html', '<p>v1</p>')
        view = self.publish('site')[0]
        self.write('site/index.html', '<p>v2</p>')
        self.write('site/only-v2.js', 'export {}')
        self.publish('site')
        response = self.client.post(f"/api/artifacts/{view['id']}/versions/1/view")
        body = response.json()
        self.assertTrue(body['url'].startswith('/artifact-view/') and body['url'].endswith('/index.html'))
        self.assertGreater(time.time() + 7201, __import__('datetime').datetime.fromisoformat(body['expires_at']).timestamp())
        self.assertLess(time.time() + 7100, __import__('datetime').datetime.fromisoformat(body['expires_at']).timestamp())
        token = body['url'].split('/')[2]
        # No cookies are involved: an anonymous client reads exactly that version.
        self.assertEqual(self.anonymous.get(body['url']).text, '<p>v1</p>')
        # Another version's file is not reachable with this version's token.
        self.assertEqual(self.anonymous.get(f'/artifact-view/{token}/only-v2.js').status_code, 404)
        v2 = self.view_url(view['id'], 2)
        self.assertEqual(self.anonymous.get(v2).text, '<p>v2</p>')
        self.assertEqual(self.anonymous.get(v2.replace('index.html', 'only-v2.js')).text, 'export {}')
        # Tampering with any field or the signature, expiry, junk and a missing artifact are plain 404s.
        aid, version, expires, signature = token.split('.')
        # Always a different signature: a fixed replacement could equal the real one by chance.
        tampered = signature[:-2] + ('AB' if signature[-2:] != 'AB' else 'AC')
        forged = [f'{aid}.2.{expires}.{signature}', f'{int(aid) + 1}.{version}.{expires}.{signature}', f'{aid}.{version}.{int(expires) + 99}.{signature}',
                  f'{aid}.{version}.{expires}.{tampered}', f'{aid}.{version}.{expires}.', 'garbage', f'{aid}.{version}.{expires}.{signature}.x',
                  f'{aid}.{version}.-5.{signature}']
        for value in forged:
            self.assertEqual(self.anonymous.get(f'/artifact-view/{value}/index.html').status_code, 404, value)
        past = f'{aid}.{version}.{int(time.time()) - 1}'
        self.assertEqual(self.anonymous.get(f'/artifact-view/{past}.{self.p.artifacts.sign(past)}/index.html').status_code, 404)
        missing = f'999.1.{int(time.time()) + 100}'
        self.assertEqual(self.anonymous.get(f'/artifact-view/{missing}.{self.p.artifacts.sign(missing)}/index.html').status_code, 404)
        unknown = f'{aid}.7.{int(time.time()) + 100}'
        self.assertEqual(self.anonymous.get(f'/artifact-view/{unknown}.{self.p.artifacts.sign(unknown)}/index.html').status_code, 404)
        # The signature is bound to the platform secret.
        self.p.settings.session_secret = 'another-secret'
        self.assertEqual(self.anonymous.get(body['url']).status_code, 404)

    def test_view_route_headers_are_exact(self):
        self.write('page.html', '<p>é</p>')
        self.write('style.css', 'body{}')
        self.write('bin/app.wasm', b'\0asm')
        ident = self.publish('page.html')[0]['id']
        response = self.anonymous.get(self.view_url(ident, 1))
        self.assertEqual(response.status_code, 200)
        headers = response.headers
        self.assertEqual(headers['content-security-policy'], VIEW_CSP)
        self.assertNotIn('allow-same-origin', headers['content-security-policy'])
        self.assertEqual(headers.get_list('referrer-policy'), ['no-referrer'])
        self.assertEqual(headers.get_list('x-content-type-options'), ['nosniff'])
        self.assertEqual(headers.get_list('x-frame-options'), ['SAMEORIGIN'])
        self.assertEqual(headers['access-control-allow-origin'], '*')
        self.assertEqual(headers['cross-origin-resource-policy'], 'cross-origin')
        self.assertEqual(headers['cache-control'], 'private, max-age=7200')
        self.assertEqual(headers['content-type'], 'text/html; charset=utf-8')
        self.assertNotIn('content-disposition', headers)
        self.assertNotIn('set-cookie', headers)
        # An ordinary Platform response keeps the defaults.
        health = self.anonymous.get('/healthz')
        self.assertEqual(health.headers.get_list('referrer-policy'), ['same-origin'])
        self.assertEqual(health.headers.get_list('x-content-type-options'), ['nosniff'])

    def test_text_types_carry_a_charset_and_binary_types_do_not(self):
        self.write('site/index.html', '<script type="module" src="js/app.mjs"></script>')
        self.write('site/js/app.mjs', 'export default 1')
        self.write('site/app.css', 'a{}')
        self.write('site/data.json', '{}')
        self.write('site/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.write('site/font.woff2', b'wOF2')
        self.write('site/app.wasm', b'\0asm')
        ident = self.publish('site')[0]['id']
        base = self.view_url(ident, 1).rsplit('/', 1)[0]
        types = {name: self.anonymous.get(f'{base}/{name}').headers['content-type'] for name in
                 ('index.html', 'js/app.mjs', 'app.css', 'data.json', 'logo.svg', 'font.woff2', 'app.wasm')}
        self.assertEqual(types, {'index.html': 'text/html; charset=utf-8', 'js/app.mjs': 'text/javascript; charset=utf-8',
                                 'app.css': 'text/css; charset=utf-8', 'data.json': 'application/json; charset=utf-8',
                                 'logo.svg': 'image/svg+xml; charset=utf-8', 'font.woff2': 'font/woff2', 'app.wasm': 'application/wasm'})
        for name in ('js/app.mjs', 'font.woff2'):
            self.assertEqual(self.anonymous.get(f'{base}/{name}').headers['access-control-allow-origin'], '*')

    def test_relative_assets_directory_indexes_and_redirects_resolve_under_the_token_prefix(self):
        self.write('site/index.html', '<img src="img/a.png">')
        self.write('site/img/a.png', b'\x89PNG')
        self.write('site/docs/index.html', '<p>docs</p>')
        self.write('site/docs/guide.html', '<p>guide</p>')
        self.write('site/deep/only.txt', 'x')
        ident = self.publish('site')[0]['id']
        entry_url = self.view_url(ident, 1)
        base = entry_url.rsplit('/', 1)[0]
        self.assertEqual(self.anonymous.get(base + '/img/a.png').content, b'\x89PNG')
        self.assertEqual(self.anonymous.get(base + '/docs/guide.html').text, '<p>guide</p>')
        self.assertEqual(self.anonymous.get(base + '/').text, '<img src="img/a.png">')
        self.assertEqual(self.anonymous.get(base + '/docs/').text, '<p>docs</p>')
        redirect = self.anonymous.get(base + '/docs', follow_redirects=False)
        self.assertEqual((redirect.status_code, redirect.headers['location']), (307, base + '/docs/'))
        self.assertEqual(self.anonymous.get(base + '/docs').text, '<p>docs</p>')
        self.assertEqual(self.anonymous.get(base + '/deep/').status_code, 404)
        self.assertEqual(self.anonymous.get(base + '/img/missing.png').status_code, 404)
        self.assertEqual(self.anonymous.get(base + '/img').status_code, 404)

    def test_a_single_file_artifact_serves_only_its_file(self):
        self.write('solo.html', '<p>solo</p>')
        self.write('neighbor.html', '<p>neighbor</p>')
        ident = self.publish('solo.html')[0]['id']
        url = self.view_url(ident, 1)
        self.assertEqual(self.anonymous.get(url).text, '<p>solo</p>')
        self.assertEqual(self.anonymous.get(url.rsplit('/', 1)[0] + '/neighbor.html').status_code, 404)
        self.assertEqual(self.anonymous.get(url.rsplit('/', 1)[0] + '/').text, '<p>solo</p>')

    def test_path_traversal_and_odd_paths_are_rejected(self):
        self.write('site/index.html', '<p>in</p>')
        self.write('secret.txt', 'outside the artifact')
        ident = self.publish('site')[0]['id']
        base = self.view_url(ident, 1).rsplit('/', 1)[0]
        for path in ('..%2Fsecret.txt', '%2e%2e/secret.txt', '..\\secret.txt', '%00', 'a/%00b', '.%2e/secret.txt', '%2e%2e%2fsecret.txt',
                     'index.html/%2e%2e/%2e%2e/secret.txt', '%2Fetc%2Fpasswd'):
            response = self.anonymous.get(f'{base}/{path}')
            self.assertEqual(response.status_code, 404, path)
            self.assertNotIn('outside the artifact', response.text)
        # Dot segments reach the handler unnormalized when a client sends them raw.
        import asyncio
        from starlette.exceptions import HTTPException
        from starlette.requests import Request
        token = base.split('/')[2]
        for path in ('../secret.txt', 'a/../../secret.txt', './../secret.txt', 'docs/../../../etc/passwd', '..'):
            request = Request({'type': 'http', 'method': 'GET', 'path': f'/artifact-view/{token}/{path}', 'query_string': b'', 'headers': [],
                               'app': self.app, 'path_params': {'token': token, 'path': path}})
            with self.assertRaises(HTTPException, msg=path) as raised:
                asyncio.run(artifacts_module.artifact_view(request))
            self.assertEqual(raised.exception.status_code, 404, path)
        # The blob store is not browsable through the route either.
        sha = next(iter(self.blobs()))
        self.assertEqual(self.anonymous.get(f'{base}/{sha}').status_code, 404)

    # -- deletion ------------------------------------------------------------------------------

    def test_deleting_a_chat_removes_its_artifacts_and_only_orphan_blobs(self):
        cid, chat_info = self.chat()
        workspace = Path(chat_info['workspace'])
        self.write('own.md', '# only in chat', root=workspace)
        self.write('shared.md', '# shared content', root=workspace)
        self.write('site/index.html', '<p>chat site</p>', root=workspace)
        cwd = f'/workspace/{cid}/'
        for relative in ('own.md', 'shared.md', 'site'):
            self.p.artifacts.publish(self.admin, chat_info, cwd + relative)
        self.write('mine.md', '# shared content')
        keep = self.publish('mine.md')[0]
        other_cid, other_info = self.chat()
        self.write('o.md', '# other chat', root=Path(other_info['workspace']))
        other = self.p.artifacts.publish(self.admin, other_info, f'/workspace/{other_cid}/o.md')[0]
        before = self.blobs()
        self.assertEqual(len(before), 4)
        self.p.queue.runtime = AsyncMock(return_value={})
        self.assertEqual(self.client.delete(f'/api/chat/conversations/{cid}').status_code, 200)
        with self.p.db.connect() as conn:
            self.assertEqual([row[0] for row in conn.execute('SELECT id FROM artifacts ORDER BY id')], [keep['id'], other['id']])
            self.assertEqual(conn.execute("SELECT count(*) FROM artifact_versions WHERE artifact_id NOT IN (?,?)", (keep['id'], other['id'])).fetchone()[0], 0)
        # Blobs of the deleted chat go; the one still referenced by another scope's version stays.
        self.assertEqual(len(self.blobs()), 2)
        self.assertEqual(self.client.get(f"/api/artifacts/{keep['id']}/versions/1/source").json()['content'], '# shared content')
        self.assertEqual(self.client.get(f'/api/artifacts?scope=chat-{cid}').status_code, 404)
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM artifacts WHERE scope_type=? AND scope_id=?', ('chat', cid)).fetchone()[0], 0)

    def test_view_tokens_stop_working_after_the_chat_is_deleted(self):
        cid, chat_info = self.chat()
        self.write('p.html', '<p>x</p>', root=Path(chat_info['workspace']))
        ident = self.p.artifacts.publish(self.admin, chat_info, f'/workspace/{cid}/p.html')[0]['id']
        url = self.view_url(ident, 1)
        self.assertEqual(self.anonymous.get(url).status_code, 200)
        self.p.queue.runtime = AsyncMock(return_value={})
        self.client.delete(f'/api/chat/conversations/{cid}')
        self.assertEqual(self.anonymous.get(url).status_code, 404)
        self.assertEqual(self.blobs(), set())

    # -- system prompt -------------------------------------------------------------------------

    def test_system_prompt_guides_artifacts_in_every_scope(self):
        cid, _ = self.chat()
        channel = self.client.post('/api/channels', json={'name': 'Team'}).json()['channel']
        for scope, cwd in (('private', '/workspace'), (f'chat-{cid}', f'/workspace/{cid}'), (f"channel-{channel['id']}", '/workspace')):
            info = self.p.queue.scope(self.admin, scope)
            prompt = self.p.queue.resources(info, self.admin)['system_prompt']
            self.assertIn('`artifact` tool', prompt, scope)
            self.assertIn('multi-file websites (publish the folder', prompt, scope)
            self.assertIn('Mermaid', prompt)
            self.assertIn('same path', prompt)
            self.assertIn('do not create v2/v3 copies', prompt)
            self.assertIn(f'MEDIA: {cwd}/path', prompt, scope)
            self.assertIn('DOCX, XLSX, PPTX', prompt, scope)

    def test_the_run_request_offers_the_artifact_tool_to_root_runs(self):
        from enterprise_agent_platform.queue import BUILTINS
        self.assertIn('artifact', BUILTINS)


    # -- review regressions --------------------------------------------------------------------

    def test_oversized_tree_is_refused_before_the_remaining_files_are_read(self):
        for name in ('a.txt', 'b.txt', 'c.txt', 'd.txt'):
            self.write(f'big/{name}', 'x' * 6)
        real = artifacts_module._read
        calls = []

        def counting(directory, name):
            calls.append(name)
            return real(directory, name)
        with patch.object(artifacts_module, 'MAX_TOTAL', 10), patch.object(artifacts_module, '_read', counting):
            with self.assertRaises(artifacts_module.ArtifactError) as raised:
                self.publish('big')
        self.assertEqual(raised.exception.code, 'artifact_too_large')
        self.assertEqual(calls, ['a.txt'])

    def test_every_text_kind_extension_has_a_text_mime(self):
        for suffix, kind in artifacts_module.EXTENSION_KIND.items():
            mime = artifacts_module.mime_of('x' + suffix)
            if kind in ('code', 'markdown', 'mermaid', 'table', 'svg'):
                self.assertTrue(artifacts_module.is_text(mime), (suffix, mime))
        with patch.object(artifacts_module.mimetypes, 'guess_type', return_value=(None, None)):
            for suffix in ('.go', '.rs', '.yaml', '.toml', '.sql', '.vue', '.log', '.patch', '.sh', '.scss', '.mmd', '.ts'):
                self.assertEqual(artifacts_module.mime_of('a' + suffix), 'text/plain; charset=utf-8', suffix)
        self.assertEqual(artifacts_module.mime_of('a.md'), 'text/markdown')
        self.assertEqual(artifacts_module.mime_of('a.csv'), 'text/csv')
        self.write('main.go', 'package main')
        ident = self.publish('main.go')[0]['id']
        self.assertEqual(self.client.get(f'/api/artifacts/{ident}/versions/1/source').json()['content'], 'package main')
        self.assertEqual(self.anonymous.get(self.view_url(ident, 1)).headers['content-type'], 'text/plain; charset=utf-8')

    def test_blob_collection_unlinks_while_holding_the_lock(self):
        cid, chat_info = self.chat()
        self.write('o.md', '# doomed', root=Path(chat_info['workspace']))
        self.p.artifacts.publish(self.admin, chat_info, f'/workspace/{cid}/o.md')
        self.write('same.md', '# doomed')
        locked = []
        real = Path.unlink

        def watching(path, *args, **kwargs):
            locked.append(self.p.artifacts.blob_lock.locked())
            return real(path, *args, **kwargs)
        with patch.object(Path, 'unlink', watching):
            self.p.artifacts.delete_scope('chat', cid)
        self.assertEqual(locked, [True])
        # A publish of the same bytes afterwards stores the blob again and stays viewable.
        view = self.publish('same.md')[0]
        self.assertEqual(self.client.get(f"/api/artifacts/{view['id']}/versions/1/source").json()['content'], '# doomed')

    def test_unchanged_republish_still_links_the_existing_version_to_the_reply(self):
        import asyncio
        self.write('a.md', '# A')
        self.write('b.html', '<p>b</p>')
        self.publish('a.md')
        self.publish('b.html')
        info, job, payload = self.running_job()
        tool = asyncio.run(self.p.browser.gateway('artifacts', 'publish', {'path': '/workspace/a.md'}, self.context(info)))
        self.assertFalse(tool['data']['created'])
        text = 'Here.\nMEDIA: /workspace/b.html'
        asyncio.run(self.p.queue.finish(job, payload, self.admin, info, {'type': 'run_end', 'status': 'completed', 'text': text, 'usage': {}}))
        reply = [m for m in self.p.queue.messages(self.admin, 'private')['messages'] if m['role'] == 'assistant'][0]
        self.assertEqual([(item['path'], item['version']) for item in reply['metadata']['artifacts']],
                         [('/workspace/a.md', 1), ('/workspace/b.html', 1)])
        self.assertEqual(reply['attachments'], [])
        with self.p.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM artifact_versions').fetchone()[0], 2)
            self.assertEqual(conn.execute('SELECT count(*) FROM artifact_versions WHERE message_id IS NOT NULL').fetchone()[0], 0)
        self.assertEqual(self.p.artifacts.refs, {})

    def test_non_ascii_token_parts_are_a_404_not_a_500(self):
        token = self.view_url(self.write_and_publish(), 1).split('/')[2]
        aid, version, expires, signature = token.split('.')
        for bad in (f'{aid}.{version}.{expires}.{signature[:-1]}é', f'{aid}.{version}.{expires}.é', f'{aid}.{version}.²', '²'):
            self.assertIsNone(self.p.artifacts.verify(bad), bad)
            self.assertEqual(self.anonymous.get(f'/artifact-view/{bad}/index.html').status_code, 404, bad)

    def write_and_publish(self):
        self.write('t/index.html', '<p>t</p>')
        return self.publish('t')[0]['id']

    def test_site_zip_is_built_off_the_event_loop(self):
        import threading
        self.write('z/index.html', '<p>z</p>')
        ident = self.publish('z')[0]['id']
        threads = []
        real = artifacts_module._zip

        def spy(*args):
            threads.append(threading.current_thread() is threading.main_thread())
            return real(*args)
        with patch.object(artifacts_module, '_zip', spy):
            self.assertEqual(self.client.get(f'/api/artifacts/{ident}/versions/1/download').status_code, 200)
        self.assertEqual(threads, [False])

if __name__ == '__main__':
    unittest.main()
