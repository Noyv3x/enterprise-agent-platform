import asyncio
import io
import json
import os
import stat
import tarfile
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from starlette.exceptions import HTTPException
from starlette.testclient import TestClient

from enterprise_agent_platform import skills as skills_module
from enterprise_agent_platform.admin import create_user
from enterprise_agent_platform.app import create_app
from enterprise_agent_platform.config import Settings
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.queue import Queue
from enterprise_agent_platform.skills import SkillError, Skills, normalize_name, parse_skill, skill_guidance
from enterprise_agent_platform.tools import download

GROUPS = [
    {'name': 'admin', 'permissions': ['read_workspace', 'chat', 'private_agent', 'manage_channels', 'manage_users', 'system_settings', 'install_extensions']},
    {'name': 'member', 'permissions': ['read_workspace', 'chat', 'private_agent', 'install_extensions']},
    {'name': 'plain', 'permissions': ['read_workspace', 'chat', 'private_agent']},
    {'name': 'other', 'permissions': ['read_workspace', 'chat', 'private_agent', 'install_extensions']},
]


def skill_text(name='demo', description='Does demo things', extra='', body='Follow these steps.'):
    return f'---\nname: {name}\ndescription: {description}\n{extra}---\n\n{body}\n'


def write_skill(directory, name, description='Does demo things', extra='', files=None, dirname=None):
    folder = Path(directory) / (dirname or name)
    folder.mkdir(parents=True)
    (folder / 'SKILL.md').write_text(skill_text(name, description, extra))
    for relative, content in (files or {}).items():
        (folder / relative).parent.mkdir(parents=True, exist_ok=True)
        (folder / relative).write_text(content)
    return folder


def make_zip(entries):
    """str -> file, ('x', text) -> executable file, ('link', target) -> symlink, trailing '/' -> directory."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, content in entries.items():
            info = zipfile.ZipInfo(name)
            if name.endswith('/'):
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
                archive.writestr(info, '')
            elif isinstance(content, tuple) and content[0] == 'link':
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, content[1])
            elif isinstance(content, tuple):
                info.external_attr = (stat.S_IFREG | 0o755) << 16
                archive.writestr(info, content[1])
            else:
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, content)
    return buffer.getvalue()


def make_tar(entries):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, content in entries.items():
            info = tarfile.TarInfo(name)
            if name.endswith('/'):
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                archive.addfile(info)
            elif isinstance(content, tuple) and content[0] in ('link', 'hardlink'):
                info.type = tarfile.SYMTYPE if content[0] == 'link' else tarfile.LNKTYPE
                info.linkname = content[1]
                archive.addfile(info)
            else:
                data = (content[1] if isinstance(content, tuple) else content).encode()
                info.size, info.mode = len(data), 0o755 if isinstance(content, tuple) else 0o644
                archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class Web:
    """A fake of the SSRF-guarded download: URL -> bytes."""

    def __init__(self):
        self.pages = {}
        self.requested = []

    async def __call__(self, url, limit, message, deadline=30):
        self.requested.append(url)
        if url not in self.pages:
            raise httpx.HTTPStatusError('missing', request=httpx.Request('GET', url), response=httpx.Response(404))
        return url, self.pages[url], '', None


class FrontmatterTests(unittest.TestCase):
    def test_yaml_frontmatter_fields_and_legacy_values(self):
        text = ('---\nname: "Quarterly Report"\ndescription: >-\n  Builds the quarterly report: with colons,\n  across lines.\nversion: 1.5\n'
                'license: MIT\ncompatibility: python\nmetadata:\n  author: a\nallowed-tools: Read Bash\ndisable-model-invocation: true\n'
                'category: ops\ntags: [a, b]\n---\n# Body\n')
        meta = parse_skill(text, 'folder', True)
        self.assertEqual(meta['name'], 'quarterly-report')
        self.assertEqual(meta['description'], 'Builds the quarterly report: with colons, across lines.')
        self.assertEqual((meta['version'], meta['hidden']), ('1.5', True))
        self.assertEqual(meta['frontmatter']['tags'], ['a', 'b'])
        self.assertEqual(meta['frontmatter']['metadata'], {'author': 'a'})
        self.assertEqual(meta['body'], '# Body\n')
        self.assertIn('normalized', ' '.join(meta['warnings']))

    def test_version_may_live_in_metadata(self):
        self.assertEqual(parse_skill('---\nname: a\ndescription: d\nmetadata:\n  version: "2"\n---\n', 'a', True)['version'], '2')

    def test_discovery_is_lenient(self):
        # Missing name falls back to the directory; missing description excludes the skill with a warning.
        self.assertEqual(parse_skill('---\ndescription: d\n---\n', 'My_Dir', False)['name'], 'my-dir')
        missing = parse_skill('---\nname: a\n---\n', 'a', False)
        self.assertIsNone(missing['description'])
        self.assertIn('Missing description', missing['warnings'])
        self.assertIsNone(parse_skill('no frontmatter at all', 'a', False)['description'])
        # Invalid YAML (unquoted colon in a flow context) is read line by line instead of failing.
        loose = parse_skill('---\nname: a\ndescription: Use for: everything [now\n---\n', 'a', False)
        self.assertEqual(loose['description'], 'Use for: everything [now')
        self.assertIn('leniently', ' '.join(loose['warnings']))
        long = parse_skill('---\nname: a\ndescription: ' + 'x' * 2000 + '\n---\n', 'a', False)
        self.assertEqual(len(long['description']), 1024)
        self.assertIn('truncated', ' '.join(long['warnings']))
        self.assertEqual(parse_skill('---\nname: ' + 'a' * 80 + '\ndescription: d\n---\n', 'dir', False)['name'], '')

    def test_installs_are_strict(self):
        for text, fragment in (('no frontmatter', 'frontmatter'), ('---\ndescription: d\n---\n', 'name'), ('---\nname: a\n---\n', 'description'),
                               ('---\nname: a\ndescription: ' + 'x' * 1025 + '\n---\n', '1024'),
                               ('---\nname: ' + 'a' * 65 + '\ndescription: d\n---\n', '64'), ('---\nname: "!!!"\ndescription: d\n---\n', 'normalize')):
            with self.assertRaises(SkillError, msg=text) as raised:
                parse_skill(text, 'dir', True)
            self.assertEqual(raised.exception.code, 'skill_invalid')
            self.assertIn(fragment, raised.exception.detail)
        self.assertEqual(normalize_name('My Skill_Name--v2'), 'my-skill-name-v2')


class SkillCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = Database(self.root / 'platform.db')
        self.db.migrate(self.root)
        with self.db.connect() as conn:
            conn.execute("INSERT INTO settings(key,value,secret,updated_at) VALUES('permission_groups_v1',?,0,1)", (json.dumps(GROUPS),))
            for uid, name, group, role in ((1, 'alice', 'member', 'user'), (2, 'bob', 'plain', 'user'), (3, 'carol', 'other', 'user'), (9, 'root', 'admin', 'admin')):
                conn.execute('INSERT INTO users(id,username,display_name,password_hash,role,permission_group,created_at) VALUES(?,?,?,?,?,?,1)',
                             (uid, name, name.title(), 'x', role, group))
            conn.execute("INSERT INTO channels(id,name,created_at) VALUES(3,'Shared',1)")
        self.builtin = self.root / 'builtin'
        self.builtin.mkdir()
        self.p = SimpleNamespace(db=self.db, settings=SimpleNamespace(data_dir=self.root, builtin_skills_dir=self.builtin))
        self.skills = self.p.skills = Skills(self.p)
        self.queue = self.p.queue = Queue(self.p)
        self.alice, self.bob, self.carol, self.root_user = (self.user(uid) for uid in (1, 2, 3, 9))
        self.web = Web()
        patcher = patch.object(skills_module, 'download', self.web)
        patcher.start()
        self.addCleanup(patcher.stop)

    def user(self, uid):
        with self.db.connect() as conn:
            return dict(conn.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone())

    def info(self, user, scope):
        return self.queue.scope(user, scope)

    def names(self, user, scope):
        return {item['name']: item['location'] for item in self.skills.catalog(user, self.info(user, scope))}

    def workspace(self, user, scope='private'):
        return self.info(user, scope)['workspace']

    def personal_dir(self, user=None, scope='private'):
        return self.workspace(user or self.alice, scope) / '.agent-platform' / 'skills'

    async def install(self, spec, user=None, replace=False):
        user = user or self.alice
        _, workspace, _ = self.skills.workspace_for(user, 'private')
        return await self.skills.install(user, 'personal', user['id'], workspace, spec, replace)

    async def install_org(self, spec, replace=False, groups=None):
        return await self.skills.install(self.root_user, 'org', None, None, spec, replace, json.dumps(groups) if groups else None)

    def set_pref(self, user, key, enabled):
        with self.db.connect() as conn:
            conn.execute('INSERT INTO skill_preferences VALUES(?,?,?,1)', (user['id'], key, int(enabled)))

    def set_groups(self, groups):
        with self.db.connect() as conn:
            conn.execute("UPDATE settings SET value=? WHERE key='permission_groups_v1'", (json.dumps(groups),))

    def installed_leftovers(self, directory):
        return sorted(path.name for path in Path(directory).iterdir() if path.name.startswith('.')) if Path(directory).exists() else []


class CatalogTests(SkillCase):
    async def test_precedence_personal_then_org_then_builtin(self):
        write_skill(self.builtin, 'dup', 'built-in version')
        write_skill(self.builtin, 'only-builtin')
        await self.install_org({'content': {'name': 'dup', 'description': 'org version', 'body': 'x'}})
        await self.install_org({'content': {'name': 'org-only', 'description': 'org', 'body': 'x'}})
        before = self.names(self.alice, 'private')
        self.assertEqual(before['dup'], '/opt/agent-platform/skills/org/dup/SKILL.md')
        self.assertEqual(before['only-builtin'], '/opt/agent-platform/skills/builtin/only-builtin/SKILL.md')
        await self.install({'content': {'name': 'dup', 'description': 'personal version', 'body': 'x'}})
        after = self.catalog_entries(self.alice, 'private')
        self.assertEqual(after['dup'], {'name': 'dup', 'description': 'personal version', 'location': '/workspace/.agent-platform/skills/dup/SKILL.md'})
        self.assertEqual(set(after), {'dup', 'org-only', 'only-builtin'})
        # A hash-suffixed directory still loads under its frontmatter name.
        write_skill(self.personal_dir(), 'html-presentations', dirname='html-presentations-56eb1e92')
        self.assertEqual(self.names(self.alice, 'private')['html-presentations'],
                         '/workspace/.agent-platform/skills/html-presentations-56eb1e92/SKILL.md')

    def catalog_entries(self, user, scope):
        return {item['name']: item for item in self.skills.catalog(user, self.info(user, scope))}

    async def test_hidden_skills_leave_the_catalog_but_stay_visible(self):
        write_skill(self.builtin, 'quiet', extra='disable-model-invocation: true\n')
        write_skill(self.builtin, 'loud')
        self.assertEqual(set(self.names(self.alice, 'private')), {'loud'})
        visible = {skill.name: skill for skill in self.skills.visible(self.alice, 'private', self.workspace(self.alice))}
        self.assertTrue(visible['quiet'].hidden)
        self.assertEqual(self.skills.invoke(self.alice, self.info(self.alice, 'private'), '/quiet go'),
                         '[The user invoked the "quiet" skill. Read /opt/agent-platform/skills/builtin/quiet/SKILL.md first and follow it; '
                         'resolve its relative paths against /opt/agent-platform/skills/builtin/quiet.]\ngo')

    async def test_user_preferences_apply_to_private_and_chat_but_not_channel(self):
        write_skill(self.builtin, 'alpha')
        write_skill(self.builtin, 'beta')
        await self.install({'content': {'name': 'mine', 'description': 'mine', 'body': 'x'}})
        await self.skills.install(self.alice, 'channel', 3, self.workspace(self.alice, 'channel-3'),
                                  {'content': {'name': 'shared', 'description': 'channel skill', 'body': 'x'}})
        for key in ('builtin:alpha', 'personal:mine'):
            self.set_pref(self.alice, key, False)
        self.set_pref(self.alice, 'builtin:beta', True)
        self.assertEqual(set(self.names(self.alice, 'private')), {'beta'})
        conversation = self.make_chat(self.alice)
        self.assertEqual(set(self.names(self.alice, conversation)), {'beta'})
        # The shared channel ignores the user's preferences and offers channel skills.
        self.assertEqual(set(self.names(self.alice, 'channel-3')), {'alpha', 'beta', 'shared'})

    def make_chat(self, user):
        with self.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations(id,user_id,title,created_at,updated_at) VALUES('c1',?,'t','now','now')", (user['id'],))
        return 'chat-c1'

    async def test_chat_has_no_workspace_skills(self):
        write_skill(self.builtin, 'alpha')
        await self.install({'content': {'name': 'mine', 'description': 'mine', 'body': 'x'}})
        chat = self.make_chat(self.alice)
        self.assertEqual(set(self.names(self.alice, chat)), {'alpha'})
        self.assertEqual(set(self.names(self.alice, 'private')), {'alpha', 'mine'})

    async def test_org_groups_enabled_flag_and_builtin_org_disable(self):
        write_skill(self.builtin, 'alpha')
        write_skill(self.builtin, 'beta')
        await self.install_org({'content': {'name': 'everyone', 'description': 'all', 'body': 'x'}})
        await self.install_org({'content': {'name': 'members-only', 'description': 'm', 'body': 'x'}}, groups=['member'])
        await self.install_org({'content': {'name': 'switched-off', 'description': 'off', 'body': 'x'}})
        with self.db.connect() as conn:
            conn.execute("UPDATE skills SET enabled=0 WHERE name='switched-off'")
            conn.execute("INSERT INTO settings(key,value,secret,updated_at) VALUES('builtin_skills_disabled_v1','[\"beta\"]',0,1)")
        self.assertEqual(set(self.names(self.alice, 'private')), {'alpha', 'everyone', 'members-only'})
        self.assertEqual(set(self.names(self.carol, 'private')), {'alpha', 'everyone'})
        # Channels use the triggering user's group.
        self.assertEqual(set(self.names(self.alice, 'channel-3')), {'alpha', 'everyone', 'members-only'})
        self.assertEqual(set(self.names(self.carol, 'channel-3')), {'alpha', 'everyone'})

    async def test_losing_install_extensions_hides_personal_skills_and_refuses_installs(self):
        await self.install({'content': {'name': 'mine', 'description': 'mine', 'body': 'x'}})
        write_skill(self.builtin, 'alpha')
        self.assertEqual(set(self.names(self.alice, 'private')), {'alpha', 'mine'})
        self.set_groups([{**group, 'permissions': [p for p in group['permissions'] if p != 'install_extensions']} for group in GROUPS])
        self.assertEqual(set(self.names(self.alice, 'private')), {'alpha'})
        with self.assertRaises(SkillError) as raised:
            self.skills.require_install(self.alice)
        self.assertEqual((raised.exception.status_code, raised.exception.code), (403, 'install_extensions_required'))
        info = self.info(self.alice, 'private')
        for action, args in (('install', {'content': {'name': 'x', 'description': 'd', 'body': 'b'}}), ('update', {'name': 'mine'}), ('remove', {'name': 'mine'})):
            result = await self.skills.gateway(self.alice, info, action, args)
            self.assertTrue(result['is_error'])
            self.assertEqual(result['data']['error'], 'install_extensions_required')
        self.assertTrue((self.personal_dir() / 'mine' / 'SKILL.md').exists())
        # Channel skills do not depend on the personal permission.
        await self.skills.install(self.root_user, 'channel', 3, self.workspace(self.root_user, 'channel-3'),
                                  {'content': {'name': 'chan', 'description': 'c', 'body': 'x'}})
        self.assertIn('chan', self.names(self.alice, 'channel-3'))

    async def test_discovery_never_follows_symlinks(self):
        secret = self.root / 'secret.md'
        secret.write_text(skill_text('leaked'))
        directory = self.personal_dir()
        write_skill(directory, 'safe')
        (directory / 'linked').mkdir()
        (directory / 'linked' / 'SKILL.md').symlink_to(secret)
        outside = self.root / 'outside'
        write_skill(outside, 'outside')
        (directory / 'dirlink').symlink_to(outside / 'outside', target_is_directory=True)
        self.assertEqual(set(self.names(self.alice, 'private')), {'safe'})


class InstallTests(SkillCase):
    async def test_workspace_directory_keeps_the_executable_bit(self):
        source = write_skill(self.workspace(self.alice) / 'stuff', 'my-skill', files={'references/a.md': 'ref'})
        (source / 'scripts').mkdir()
        (source / 'scripts' / 'run.sh').write_text('#!/bin/sh\n')
        (source / 'scripts' / 'run.sh').chmod(0o755)
        installed = await self.install({'path': '/workspace/stuff/my-skill'})
        target = self.personal_dir() / 'my-skill'
        self.assertEqual(installed.location, '/workspace/.agent-platform/skills/my-skill/SKILL.md')
        self.assertEqual((target / 'references' / 'a.md').read_text(), 'ref')
        self.assertEqual(stat.S_IMODE((target / 'scripts' / 'run.sh').stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((target / 'SKILL.md').stat().st_mode), 0o644)
        self.assertEqual(installed.source, {'kind': 'workspace'})
        with self.db.connect() as conn:
            self.assertEqual(json.loads(conn.execute("SELECT source_json FROM skills WHERE name='my-skill'").fetchone()[0]),
                             {'kind': 'workspace', 'path': '/workspace/stuff/my-skill'})
        self.assertEqual(self.installed_leftovers(self.personal_dir()), [])

    async def test_workspace_zip_and_skill_file(self):
        workspace = self.workspace(self.alice)
        (workspace / 'pack.zip').write_bytes(make_zip({'SKILL.md': skill_text('zipped'), 'data.txt': 'd'}))
        (workspace / 'other.skill').write_bytes(make_zip({'wrapper/': '', 'wrapper/SKILL.md': skill_text('wrapped')}))
        self.assertEqual((await self.install({'path': 'pack.zip'})).name, 'zipped')
        self.assertEqual((await self.install({'path': '/workspace/other.skill'})).name, 'wrapped')
        self.assertEqual((self.personal_dir() / 'zipped' / 'data.txt').read_text(), 'd')

    async def test_workspace_path_is_confined(self):
        outside = self.root / 'outside'
        write_skill(outside, 'evil')
        (self.workspace(self.alice) / 'link').symlink_to(outside / 'evil', target_is_directory=True)
        for value in ('/etc', '../outside/evil', '/workspace/../outside/evil', '', '.', 'link'):
            with self.assertRaises(SkillError, msg=value):
                await self.install({'path': value})
        self.assertFalse((self.personal_dir() / 'evil').exists())

    async def test_workspace_directory_with_a_symlink_is_rejected(self):
        source = write_skill(self.workspace(self.alice), 'linky')
        (source / 'leak').symlink_to(self.root / 'platform.db')
        with self.assertRaises(SkillError) as raised:
            await self.install({'path': 'linky'})
        self.assertIn('Symbolic links', raised.exception.detail)
        self.assertEqual(self.installed_leftovers(self.personal_dir()), [])

    def tree(self, extra=None):
        entries = {'skills-abc123/': '', 'skills-abc123/README.md': 'readme',
                   'skills-abc123/skills/foo/SKILL.md': skill_text('foo', 'The foo skill'), 'skills-abc123/skills/foo/run.sh': ('x', '#!/bin/sh'),
                   'skills-abc123/skills/bar/SKILL.md': skill_text('bar', 'The bar skill')}
        return make_tar({**entries, **(extra or {})})

    async def test_github_tree_url_uses_the_codeload_tarball_and_subpath(self):
        self.web.pages['https://codeload.github.com/acme/skills/tar.gz/main'] = self.tree()
        installed = await self.install({'url': 'https://github.com/acme/skills/tree/main/skills/foo'})
        self.assertEqual(self.web.requested, ['https://codeload.github.com/acme/skills/tar.gz/main'])
        self.assertEqual(installed.name, 'foo')
        self.assertEqual(stat.S_IMODE((self.personal_dir() / 'foo' / 'run.sh').stat().st_mode), 0o755)
        self.assertFalse((self.personal_dir() / 'foo' / 'README.md').exists())
        self.assertEqual(installed.source, {'kind': 'url', 'url': 'https://github.com/acme/skills/tree/main/skills/foo'})
        with self.db.connect() as conn:
            row = conn.execute("SELECT source_json,installed_by FROM skills WHERE name='foo'").fetchone()
        self.assertEqual(json.loads(row['source_json']), {'kind': 'url', 'url': 'https://github.com/acme/skills/tree/main/skills/foo', 'subpath': 'skills/foo'})
        self.assertEqual(row['installed_by'], 1)

    async def test_github_blob_url_and_explicit_subpath(self):
        self.web.pages['https://codeload.github.com/acme/skills/tar.gz/v1'] = self.tree()
        self.assertEqual((await self.install({'url': 'https://github.com/acme/skills/blob/v1/skills/bar/SKILL.md'})).name, 'bar')
        self.web.pages['https://codeload.github.com/acme/skills/tar.gz/HEAD'] = self.tree()
        self.assertEqual((await self.install({'url': 'https://github.com/acme/skills', 'subpath': 'skills/foo'})).name, 'foo')
        self.assertEqual(self.web.requested[-1], 'https://codeload.github.com/acme/skills/tar.gz/HEAD')

    async def test_several_skills_without_subpath_list_the_candidates(self):
        self.web.pages['https://codeload.github.com/acme/skills/tar.gz/HEAD'] = self.tree()
        with self.assertRaises(SkillError) as raised:
            await self.install({'url': 'https://github.com/acme/skills'})
        self.assertEqual((raised.exception.status_code, raised.exception.code), (409, 'skill_candidates'))
        self.assertEqual(raised.exception.payload['candidates'], [{'name': 'bar', 'subpath': 'skills/bar'}, {'name': 'foo', 'subpath': 'skills/foo'}])
        self.assertEqual(self.installed_leftovers(self.personal_dir()), [])
        # The same through the AI tool: a typed error with the candidates.
        result = await self.skills.gateway(self.alice, self.info(self.alice, 'private'), 'install', {'url': 'https://github.com/acme/skills'})
        self.assertTrue(result['is_error'])
        self.assertEqual(result['data']['error'], 'skill_candidates')
        self.assertEqual([c['name'] for c in result['data']['candidates']], ['bar', 'foo'])

    async def test_several_skills_in_a_zip_and_a_directory_need_a_subpath(self):
        data = make_zip({'a/SKILL.md': skill_text('aa'), 'b/SKILL.md': skill_text('bb')})
        self.web.pages['https://example.com/two.zip'] = data
        with self.assertRaises(SkillError) as raised:
            await self.install({'url': 'https://example.com/two.zip'})
        self.assertEqual([c['subpath'] for c in raised.exception.payload['candidates']], ['a', 'b'])
        self.assertEqual((await self.install({'url': 'https://example.com/two.zip', 'subpath': 'b'})).name, 'bb')
        folder = self.workspace(self.alice) / 'many'
        write_skill(folder, 'one')
        write_skill(folder, 'two')
        with self.assertRaises(SkillError) as raised:
            await self.install({'path': 'many'})
        self.assertEqual(raised.exception.code, 'skill_candidates')
        self.assertEqual((await self.install({'path': 'many', 'subpath': 'two'})).name, 'two')

    async def test_direct_zip_url(self):
        self.web.pages['https://example.com/pack.skill'] = make_zip({'SKILL.md': skill_text('packed', 'Packed skill'), 'assets/x.txt': 'x'})
        installed = await self.install({'url': 'https://example.com/pack.skill'})
        self.assertEqual((installed.name, installed.source), ('packed', {'kind': 'url', 'url': 'https://example.com/pack.skill'}))
        self.assertEqual((self.personal_dir() / 'packed' / 'assets' / 'x.txt').read_text(), 'x')

    async def test_raw_skill_md_url(self):
        self.web.pages['https://raw.githubusercontent.com/acme/s/main/SKILL.md'] = skill_text('raw-one', 'From a raw file').encode()
        installed = await self.install({'url': 'https://raw.githubusercontent.com/acme/s/main/SKILL.md'})
        self.assertEqual((installed.name, installed.description), ('raw-one', 'From a raw file'))
        self.assertEqual([path.name for path in (self.personal_dir() / 'raw-one').iterdir()], ['SKILL.md'])
        self.web.pages['https://example.com/binary'] = b'\x00\x01\x02'
        with self.assertRaises(SkillError):
            await self.install({'url': 'https://example.com/binary'})

    async def test_inline_content_and_uploads(self):
        installed = await self.install({'content': {'name': 'Saved Flow', 'description': 'A saved workflow: with a colon', 'body': '# Steps\n1. a',
                                                    'files': {'scripts/go.sh': 'echo hi', 'notes/n.md': 'n'}}})
        self.assertEqual((installed.name, installed.source), ('saved-flow', {'kind': 'ai'}))
        self.assertEqual(installed.description, 'A saved workflow: with a colon')
        folder = self.personal_dir() / 'saved-flow'
        self.assertIn('# Steps', (folder / 'SKILL.md').read_text())
        self.assertEqual((folder / 'scripts' / 'go.sh').read_text(), 'echo hi')
        for bad in ({'name': 'x', 'description': 'd'}, {'name': 'x', 'description': 'd', 'body': 'b', 'files': {'../evil': 'x'}},
                    {'name': 'x', 'description': 'd', 'body': 'b', 'files': {'SKILL.md': 'x'}}, {'name': '', 'description': 'd', 'body': 'b'}):
            with self.assertRaises(SkillError, msg=bad):
                await self.install({'content': bad})
        uploaded = await self.install({'upload': make_zip({'SKILL.md': skill_text('uploaded')})})
        self.assertEqual(uploaded.source, {'kind': 'upload'})

    async def test_unsafe_archives_are_rejected_and_leave_nothing_behind(self):
        good = {'SKILL.md': skill_text('evil')}
        cases = {
            'zip-slip': make_zip({**good, '../escape.txt': 'x'}),
            'nested zip-slip': make_zip({**good, 'a/../../escape.txt': 'x'}),
            'absolute': make_zip({**good, '/etc/passwd': 'x'}),
            'backslash': make_zip({**good, '..\\escape.txt': 'x'}),
            'zip symlink': make_zip({**good, 'link': ('link', '/etc/passwd')}),
            'tar symlink': make_tar({**good, 'link': ('link', '/etc/passwd')}),
            'tar hardlink': make_tar({**good, 'link': ('hardlink', 'SKILL.md')}),
            'tar slip': make_tar({**good, '../escape.txt': 'x'}),
            'garbage': b'PK\x03\x04not really a zip',
        }
        for label, data in cases.items():
            with self.assertRaises(SkillError, msg=label) as raised:
                await self.install({'upload': data})
            self.assertEqual(raised.exception.code, 'skill_invalid', label)
        self.assertFalse((self.root / 'escape.txt').exists())
        self.assertFalse((self.personal_dir() / 'escape.txt').exists())
        self.assertFalse((self.personal_dir() / 'evil').exists())
        self.assertEqual(self.installed_leftovers(self.personal_dir()), [])

    async def test_size_and_count_limits(self):
        data = make_zip({'SKILL.md': skill_text('big'), 'blob.bin': 'x' * 200})
        with patch.object(skills_module, 'MAX_UNPACKED', 100):
            with self.assertRaises(SkillError) as raised:
                await self.install({'upload': data})
        self.assertEqual(raised.exception.status_code, 413)
        many = make_zip({'SKILL.md': skill_text('many'), **{f'f{i}.txt': 'x' for i in range(5)}})
        with patch.object(skills_module, 'MAX_FILES', 3):
            with self.assertRaises(SkillError) as raised:
                await self.install({'upload': many})
        self.assertIn('more than 3 files', raised.exception.detail)
        with patch.object(skills_module, 'MAX_SKILL_MD', 20):
            with self.assertRaises(SkillError):
                await self.install({'upload': make_zip({'SKILL.md': skill_text('wide')})})
        self.assertEqual(self.installed_leftovers(self.personal_dir()), [])
        self.assertFalse((self.personal_dir() / 'big').exists())

    async def test_declared_size_cannot_hide_a_bomb(self):
        archive = make_zip({'SKILL.md': skill_text('bomb'), 'blob.bin': 'x' * 5000})
        entries, _ = skills_module._archive(archive)
        with patch.object(skills_module, 'MAX_UNPACKED', 1000), patch.object(skills_module, '_archive', return_value=(
                [skills_module.Entry(e.parts, e.kind, 1 if e.parts[-1] == 'blob.bin' else e.size, e.executable, e.handle) for e in entries],
                zipfile.ZipFile(io.BytesIO(archive)).open)):
            with self.assertRaises(SkillError) as raised:
                await self.install({'upload': archive})
        self.assertEqual(raised.exception.status_code, 413)

    async def test_tar_limits_apply_while_streaming(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            for index in range(skills_module.MAX_FILES * 2 + 5):
                archive.addfile(tarfile.TarInfo(f'many/f{index}'))
        with self.assertRaises(SkillError) as raised:
            await self.install({'upload': buffer.getvalue()})
        self.assertEqual((raised.exception.status_code, raised.exception.code), (413, 'skill_invalid'))
        # One member bigger than the unpacked limit is refused at its header, before its data is read.
        buffer = io.BytesIO()
        size = skills_module.MAX_UNPACKED + 1
        with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
            info = tarfile.TarInfo('huge.bin')
            info.size = size
            archive.addfile(info, io.BytesIO(bytes(size)))
        started = time.monotonic()
        with patch.object(tarfile.ExFileObject, 'read', side_effect=AssertionError('member data was read')):
            with self.assertRaises(SkillError) as raised:
                await self.install({'upload': buffer.getvalue()})
        self.assertEqual((raised.exception.status_code, raised.exception.code), (413, 'skill_invalid'))
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(self.installed_leftovers(self.personal_dir()), [])

    async def test_zip_entries_with_permission_bits_only_are_regular_files(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            for name, text in (('SKILL.md', skill_text('perm-only')), ('run.sh', 'echo')):
                info = zipfile.ZipInfo(name)
                info.external_attr = 0o755 << 16  # no file-type field
                archive.writestr(info, text)
            plain = zipfile.ZipInfo('notes.txt')
            plain.external_attr = 0
            archive.writestr(plain, 'n')
        installed = await self.install({'upload': buffer.getvalue()})
        folder = self.personal_dir() / 'perm-only'
        self.assertEqual((installed.name, (folder / 'notes.txt').read_text()), ('perm-only', 'n'))
        self.assertEqual(stat.S_IMODE((folder / 'run.sh').stat().st_mode), 0o755)
        device = io.BytesIO()
        with zipfile.ZipFile(device, 'w') as archive:
            archive.writestr('SKILL.md', skill_text('dev'))
            info = zipfile.ZipInfo('node')
            info.external_attr = (stat.S_IFCHR | 0o666) << 16
            archive.writestr(info, '')
        with self.assertRaises(SkillError):
            await self.install({'upload': device.getvalue()})

    async def test_update_refuses_a_renamed_skill_and_changes_nothing(self):
        url = 'https://example.com/pack.zip'
        self.web.pages[url] = make_zip({'SKILL.md': skill_text('pack', 'one')})
        await self.install({'url': url})
        await self.install({'content': {'name': 'other', 'description': 'untouched', 'body': 'b'}})
        self.web.pages[url] = make_zip({'SKILL.md': skill_text('other', 'hijack')})
        with self.assertRaises(SkillError) as raised:
            await self.skills.update(self.alice, 'personal', 1, self.workspace(self.alice), 'pack')
        self.assertEqual((raised.exception.status_code, raised.exception.code), (409, 'skill_update_renamed'))
        self.assertEqual(raised.exception.payload, {'name': 'pack', 'new_name': 'other'})
        self.assertIn('untouched', (self.personal_dir() / 'other' / 'SKILL.md').read_text())
        self.assertIn('one', (self.personal_dir() / 'pack' / 'SKILL.md').read_text())
        self.assertEqual(self.installed_leftovers(self.personal_dir()), [])
        result = await self.skills.gateway(self.alice, self.info(self.alice, 'private'), 'update', {'name': 'pack'})
        self.assertEqual((result['is_error'], result['data']['error'], result['data']['new_name']), (True, 'skill_update_renamed', 'other'))

    async def test_name_conflict_needs_replace(self):
        await self.install({'content': {'name': 'dup', 'description': 'first', 'body': 'one'}})
        with self.assertRaises(SkillError) as raised:
            await self.install({'content': {'name': 'dup', 'description': 'second', 'body': 'two'}})
        self.assertEqual((raised.exception.status_code, raised.exception.code), (409, 'skill_exists'))
        self.assertIn('first', (self.personal_dir() / 'dup' / 'SKILL.md').read_text())
        replaced = await self.install({'content': {'name': 'dup', 'description': 'second', 'body': 'two'}}, replace=True)
        self.assertEqual(replaced.description, 'second')
        # A hash-suffixed duplicate of the same name counts as a conflict too, and replace retires it.
        write_skill(self.personal_dir(), 'hashed', dirname='hashed-0a1b2c3d')
        with self.assertRaises(SkillError):
            await self.install({'content': {'name': 'hashed', 'description': 'new', 'body': 'x'}})
        await self.install({'content': {'name': 'hashed', 'description': 'new', 'body': 'x'}}, replace=True)
        self.assertEqual(sorted(path.name for path in self.personal_dir().iterdir()), ['dup', 'hashed'])

    async def test_replace_is_atomic_and_failures_keep_the_old_version(self):
        await self.install({'content': {'name': 'live', 'description': 'old', 'body': 'old body', 'files': {'old.txt': 'old'}}})
        directory = self.personal_dir()
        # An invalid replacement is rejected before anything changes.
        with self.assertRaises(SkillError):
            await self.install({'upload': make_zip({'SKILL.md': '---\nname: live\n---\n'})}, replace=True)
        # A failure while writing the new tree leaves the old one untouched and cleans up.
        with patch.object(skills_module, '_write_tree', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                await self.install({'content': {'name': 'live', 'description': 'new', 'body': 'new body'}}, replace=True)
        self.assertEqual((directory / 'live' / 'old.txt').read_text(), 'old')
        self.assertIn('old body', (directory / 'live' / 'SKILL.md').read_text())
        self.assertEqual(self.installed_leftovers(directory), [])
        # A good replacement swaps the whole directory: no stale files, no temporary directories.
        installed = await self.install({'content': {'name': 'live', 'description': 'new', 'body': 'new body', 'files': {'new.txt': 'new'}}}, replace=True)
        self.assertEqual(installed.description, 'new')
        self.assertEqual(sorted(path.name for path in (directory / 'live').iterdir()), ['SKILL.md', 'new.txt'])
        self.assertEqual(self.installed_leftovers(directory), [])
        # Without renameat2 the two-step rename fallback gives the same result.
        with patch.object(skills_module, '_renameat2', return_value=False):
            await self.install({'content': {'name': 'live', 'description': 'third', 'body': 'b', 'files': {'third.txt': 't'}}}, replace=True)
            await self.install({'content': {'name': 'fresh', 'description': 'fresh', 'body': 'b'}})
        self.assertEqual(sorted(path.name for path in (directory / 'live').iterdir()), ['SKILL.md', 'third.txt'])
        self.assertTrue((directory / 'fresh' / 'SKILL.md').exists())
        self.assertEqual(self.installed_leftovers(directory), [])

    async def test_update_refetches_the_recorded_url(self):
        url = 'https://example.com/pack.zip'
        self.web.pages[url] = make_zip({'SKILL.md': skill_text('pack', 'version one')})
        await self.install({'url': url})
        self.web.pages[url] = make_zip({'SKILL.md': skill_text('pack', 'version two'), 'extra.txt': 'e'})
        updated = await self.skills.update(self.alice, 'personal', 1, self.workspace(self.alice), 'pack')
        self.assertEqual(updated.description, 'version two')
        self.assertTrue((self.personal_dir() / 'pack' / 'extra.txt').exists())
        self.assertEqual(self.web.requested, [url, url])
        # Only URL installs can update; the tool reports a typed error.
        await self.install({'content': {'name': 'local', 'description': 'd', 'body': 'b'}})
        with self.assertRaises(SkillError) as raised:
            await self.skills.update(self.alice, 'personal', 1, self.workspace(self.alice), 'local')
        self.assertEqual(raised.exception.code, 'skill_not_updatable')
        with self.assertRaises(SkillError) as raised:
            await self.skills.update(self.alice, 'personal', 1, self.workspace(self.alice), 'ghost')
        self.assertEqual(raised.exception.status_code, 404)

    async def test_update_keeps_the_recorded_subpath(self):
        self.web.pages['https://codeload.github.com/acme/skills/tar.gz/main'] = self.tree()
        await self.install({'url': 'https://github.com/acme/skills/tree/main/skills/foo'})
        self.web.pages['https://codeload.github.com/acme/skills/tar.gz/main'] = self.tree({'skills-abc123/skills/foo/SKILL.md': skill_text('foo', 'foo v2')})
        updated = await self.skills.update(self.alice, 'personal', 1, self.workspace(self.alice), 'foo')
        self.assertEqual(updated.description, 'foo v2')

    async def test_remove_deletes_files_and_row(self):
        await self.install({'content': {'name': 'gone', 'description': 'd', 'body': 'b', 'files': {'a/b.txt': 'x'}}})
        await self.skills.remove('personal', 1, self.workspace(self.alice), 'gone')
        self.assertFalse((self.personal_dir() / 'gone').exists())
        self.assertEqual(self.installed_leftovers(self.personal_dir()), [])
        with self.db.connect() as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM skills WHERE name='gone'").fetchone())
        with self.assertRaises(SkillError):
            await self.skills.remove('personal', 1, self.workspace(self.alice), 'gone')

    async def test_org_skills_are_world_readable(self):
        installed = await self.install_org({'upload': make_zip({'SKILL.md': skill_text('shared'), 'bin/tool': ('x', '#!/bin/sh'), 'docs/a.md': 'a'})}, groups=['member'])
        target = self.root / 'skills' / 'org' / 'shared'
        self.assertEqual(installed.location, '/opt/agent-platform/skills/org/shared/SKILL.md')
        self.assertEqual(stat.S_IMODE((self.root / 'skills' / 'org').stat().st_mode), 0o755)
        self.assertEqual([stat.S_IMODE(p.stat().st_mode) for p in (target, target / 'bin', target / 'docs')], [0o755] * 3)
        self.assertEqual([stat.S_IMODE(p.stat().st_mode) for p in (target / 'SKILL.md', target / 'docs' / 'a.md', target / 'bin' / 'tool')], [0o644, 0o644, 0o755])
        with self.db.connect() as conn:
            row = conn.execute("SELECT tier,owner_id,groups_json,enabled FROM skills WHERE name='shared'").fetchone()
        self.assertEqual((row['tier'], row['owner_id'], json.loads(row['groups_json']), row['enabled']), ('org', None, ['member'], 1))
        with self.assertRaises(SkillError):
            await self.install_org({'upload': make_zip({'SKILL.md': skill_text('shared')})})
        await self.install_org({'upload': make_zip({'SKILL.md': skill_text('shared', 'again')})}, replace=True)
        with self.db.connect() as conn:  # replacing without groups keeps the assignment
            self.assertEqual(json.loads(conn.execute("SELECT groups_json FROM skills WHERE name='shared'").fetchone()[0]), ['member'])
        await self.skills.remove('org', None, None, 'shared')
        self.assertFalse(target.exists())


class DownloadGuardTests(SkillCase):
    """These use the real download helper, so the SSRF rules apply to skill URLs."""

    def setUp(self):
        super().setUp()
        patch.stopall()

    async def test_private_and_loopback_urls_are_refused(self):
        for url in ('http://127.0.0.1/pack.zip', 'http://localhost/pack.zip', 'http://10.0.0.5/x.zip', 'http://[::1]/x.zip',
                    'https://user:pw@example.com/x.zip', 'file:///etc/passwd', 'ftp://example.com/x.zip'):
            with self.assertRaises(SkillError, msg=url) as raised:
                await self.install({'url': url})
            self.assertEqual(raised.exception.code, 'skill_fetch_failed', url)
            self.assertEqual(raised.exception.status_code, 400, url)
        result = await self.skills.gateway(self.alice, self.info(self.alice, 'private'), 'install', {'url': 'http://169.254.169.254/latest'})
        self.assertTrue(result['is_error'])
        self.assertEqual(result['data']['error'], 'skill_fetch_failed')

    async def test_redirects_are_revalidated_and_the_address_is_pinned(self):
        resolver = AsyncMock(side_effect=[[(2, 1, 6, '', ('93.184.216.34', 443))], [(2, 1, 6, '', ('127.0.0.1', 80))]])
        seen = []

        def respond(request):
            seen.append((request.url.host, request.headers['host']))
            return httpx.Response(302, headers={'location': 'http://internal.example/secret.zip'})
        client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', resolver), patch('enterprise_agent_platform.tools.httpx.AsyncClient', return_value=client):
            with self.assertRaises(SkillError) as raised:
                await self.install({'url': 'https://public.example/pack.zip'})
        self.assertEqual(raised.exception.code, 'skill_fetch_failed')
        self.assertEqual(seen, [('93.184.216.34', 'public.example')])

    async def test_download_is_streamed_under_the_size_cap(self):
        resolver = AsyncMock(return_value=[(2, 1, 6, '', ('93.184.216.34', 443))])
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'x' * 5000)))
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', resolver), patch('enterprise_agent_platform.tools.httpx.AsyncClient', return_value=client), \
                patch.object(skills_module, 'MAX_DOWNLOAD', 1000):
            with self.assertRaises(SkillError) as raised:
                await self.install({'url': 'https://public.example/pack.zip'})
        self.assertEqual(raised.exception.status_code, 413)
        resolver = AsyncMock(return_value=[(2, 1, 6, '', ('93.184.216.34', 443))])
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(404)))
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', resolver), patch('enterprise_agent_platform.tools.httpx.AsyncClient', return_value=client):
            with self.assertRaises(SkillError) as raised:
                await self.install({'url': 'https://public.example/pack.zip'})
        self.assertEqual((raised.exception.status_code, raised.exception.code), (502, 'skill_fetch_failed'))

    async def test_a_public_download_installs(self):
        resolver = AsyncMock(return_value=[(2, 1, 6, '', ('93.184.216.34', 443))])
        body = make_zip({'SKILL.md': skill_text('remote')})
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=body)))
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', resolver), patch('enterprise_agent_platform.tools.httpx.AsyncClient', return_value=client):
            self.assertEqual((await self.install({'url': 'https://public.example/pack.zip'})).name, 'remote')


class InvocationTests(SkillCase):
    async def test_explicit_invocation_prefixes_and_strips_the_token(self):
        write_skill(self.builtin, 'alpha')
        info = self.info(self.alice, 'private')
        sentence = ('[The user invoked the "alpha" skill. Read /opt/agent-platform/skills/builtin/alpha/SKILL.md first and follow it; '
                    'resolve its relative paths against /opt/agent-platform/skills/builtin/alpha.]')
        self.assertEqual(self.skills.invoke(self.alice, info, '/alpha make a report'), sentence + '\nmake a report')
        self.assertEqual(self.skills.invoke(self.alice, info, '  /alpha\nsecond line\nthird'), sentence + '\nsecond line\nthird')
        self.assertEqual(self.skills.invoke(self.alice, info, '/Alpha'), sentence)
        for text in ('/unknown do it', '/compact', 'please /alpha', '/alphabet x', '//alpha', 'alpha', '/ alpha', ''):
            self.assertEqual(self.skills.invoke(self.alice, info, text), text, text)

    async def test_invocation_follows_the_scope_catalog(self):
        write_skill(self.builtin, 'alpha')
        await self.install({'content': {'name': 'mine', 'description': 'd', 'body': 'b'}})
        private = self.info(self.alice, 'private')
        self.assertIn('/workspace/.agent-platform/skills/mine/SKILL.md', self.skills.invoke(self.alice, private, '/mine go'))
        chat = self.info(self.alice, self.make_chat_scope(self.alice))
        self.assertEqual(self.skills.invoke(self.alice, chat, '/mine go'), '/mine go')
        self.assertIn('alpha', self.skills.invoke(self.alice, chat, '/alpha go'))
        self.set_pref(self.alice, 'builtin:alpha', False)
        self.assertEqual(self.skills.invoke(self.alice, private, '/alpha go'), '/alpha go')
        # Losing the permission removes personal skills from the scope, so they are no longer invocable.
        self.set_groups([{**group, 'permissions': [p for p in group['permissions'] if p != 'install_extensions']} for group in GROUPS])
        self.assertEqual(self.skills.invoke(self.alice, private, '/mine go'), '/mine go')

    def make_chat_scope(self, user):
        with self.db.connect() as conn:
            conn.execute("INSERT INTO chat_conversations(id,user_id,title,created_at,updated_at) VALUES('c9',?,'t','now','now')", (user['id'],))
        return 'chat-c9'


class GatewayToolTests(SkillCase):
    async def call(self, action, user=None, scope='private', **args):
        user = user or self.alice
        return await self.skills.gateway(user, self.info(user, scope), action, args)

    async def test_personal_lifecycle(self):
        write_skill(self.builtin, 'alpha')
        installed = await self.call('install', content={'name': 'flow', 'description': 'A flow', 'body': 'steps', 'files': {'x.txt': 'x'}})
        self.assertFalse(installed['is_error'])
        self.assertIn('/workspace/.agent-platform/skills/flow', installed['content'])
        self.assertIn('next message', installed['content'])
        listed = await self.call('list')
        self.assertEqual({(s['name'], s['tier']) for s in listed['data']['skills']}, {('alpha', 'builtin'), ('flow', 'personal')})
        info = await self.call('info', name='flow')
        self.assertEqual(info['data']['frontmatter'], {'name': 'flow', 'description': 'A flow'})
        self.assertEqual({f['path'] for f in info['data']['files']}, {'SKILL.md', 'x.txt'})
        self.assertEqual(info['data']['source'], {'kind': 'ai'})
        self.assertEqual((await self.call('info', name='nope'))['data']['error'], 'skill_not_found')
        conflict = await self.call('install', content={'name': 'flow', 'description': 'again', 'body': 'b'})
        self.assertEqual(conflict['data']['error'], 'skill_exists')
        again = await self.call('install', content={'name': 'flow', 'description': 'again', 'body': 'b'}, replace=True)
        self.assertFalse(again['is_error'])
        self.assertEqual((await self.call('update', name='flow'))['data']['error'], 'skill_not_updatable')
        self.assertFalse((await self.call('remove', name='flow'))['is_error'])
        self.assertEqual([s['name'] for s in (await self.call('list'))['data']['skills']], ['alpha'])
        # Exactly one source is required.
        for args in ({}, {'url': 'https://example.com/a.zip', 'path': 'x'}):
            self.assertEqual((await self.call('install', **args))['data']['error'], 'skill_invalid')
        self.assertTrue((await self.call('frobnicate'))['is_error'])

    async def test_channel_skills_live_in_the_channel_workspace(self):
        installed = await self.call('install', scope='channel-3', content={'name': 'chan', 'description': 'channel skill', 'body': 'b'})
        self.assertFalse(installed['is_error'])
        self.assertTrue((self.personal_dir(scope='channel-3') / 'chan' / 'SKILL.md').exists())
        self.assertFalse((self.personal_dir() / 'chan').exists())
        with self.db.connect() as conn:
            row = conn.execute("SELECT tier,owner_id FROM skills WHERE name='chan'").fetchone()
        self.assertEqual((row['tier'], row['owner_id']), ('channel', 3))
        self.assertIn('chan', self.names(self.carol, 'channel-3'))
        self.assertNotIn('chan', self.names(self.alice, 'private'))
        # Anyone in the channel may be the triggering user; the action needs *their* permission.
        denied = await self.call('remove', user=self.bob, scope='channel-3', name='chan')
        self.assertEqual(denied['data']['error'], 'install_extensions_required')
        self.assertFalse((await self.call('remove', user=self.carol, scope='channel-3', name='chan'))['is_error'])

    async def test_chat_scope_is_not_a_tool_scope_and_the_guidance_differs(self):
        personal, channel = skill_guidance(True), skill_guidance(False)
        for text in (personal, channel):
            self.assertIn('Agent Skills format', text)
            self.assertIn('only with the `skill` tool', text)
            for product in ('Claude Code', 'Claude Desktop', 'claude.ai', 'Codex', 'Cursor', 'Gemini CLI', 'OpenCode'):
                self.assertIn(product, text)
            for path in ('.claude/skills', '~/.codex/skills', '.agents/skills'):
                self.assertIn(path, text)
            self.assertIn('one plain sentence, in their language', text)
            self.assertIn("the user's own computer, a desktop app, an app restart", text)
        self.assertIn('/workspace/.agent-platform/mcp.json', personal)
        self.assertIn('"mcpServers"', personal)
        for foreign in ('claude mcp add', 'codex mcp add', '.mcp.json', '~/.claude.json', '~/.codex/config.toml', 'claude_desktop_config.json'):
            self.assertIn(foreign, personal)
        self.assertNotIn('mcp', channel.lower())
        self.assertNotIn('MCP', channel)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        frontend = self.root / 'static'
        frontend.mkdir()
        (frontend / 'index.html').write_text('x')
        self.builtin = self.root / 'builtin'
        self.builtin.mkdir()
        write_skill(self.builtin, 'alpha', 'Built-in alpha')
        write_skill(self.builtin, 'quiet', 'Hidden', extra='disable-model-invocation: true\n')
        self.app = create_app(Settings(data_dir=self.root, frontend_dir=frontend, builtin_skills_dir=self.builtin, manager_socket=str(self.root / 'missing.sock'),
                                       session_secret='test-secret', agent_tool_token='tool-test', runtime_token='runtime-test'))
        self.admin = TestClient(self.app)
        self.admin.__enter__()
        self.addCleanup(self.admin.__exit__, None, None, None)
        self.platform = self.app.state.platform
        password = (self.root / 'bootstrap-admin-password.txt').read_text().strip()
        self.assertEqual(self.admin.post('/api/auth/login', json={'username': 'admin', 'password': password}).status_code, 200)
        with self.platform.db.connect() as conn:
            conn.execute("INSERT INTO settings(key,value,secret,updated_at) VALUES('permission_groups_v1',?,0,1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(GROUPS),))
        self.clients = {}
        for name, group in (('alice', 'member'), ('bob', 'plain'), ('carol', 'other')):
            create_user(self.platform.db, name, 'secret-pass-1', permission_group=group)
            client = TestClient(self.app)
            self.assertEqual(client.post('/api/auth/login', json={'username': name, 'password': 'secret-pass-1'}).status_code, 200)
            self.clients[name] = client
        self.web = Web()
        patcher = patch.object(skills_module, 'download', self.web)
        patcher.start()
        self.addCleanup(patcher.stop)

    def zip_file(self, name='shipped', description='Shipped skill'):
        return make_zip({'SKILL.md': skill_text(name, description), 'scripts/run.sh': ('x', 'echo')})

    def test_user_list_install_read_preference_update_and_delete(self):
        alice = self.clients['alice']
        listing = alice.get('/api/skills?scope=private').json()
        self.assertTrue(listing['can_install'])
        by_name = {s['name']: s for s in listing['skills']}
        self.assertEqual(set(by_name), {'alpha', 'quiet'})  # hidden-from-model skills are still listed for the user
        self.assertEqual(by_name['alpha']['key'], 'builtin:alpha')
        self.assertEqual({k: by_name['alpha'][k] for k in ('tier', 'source', 'enabled', 'user_disableable', 'manageable', 'version')},
                         {'tier': 'builtin', 'source': None, 'enabled': True, 'user_disableable': True, 'manageable': False, 'version': None})
        created = alice.post('/api/skills', files={'file': ('shipped.skill', self.zip_file(), 'application/zip')})
        self.assertEqual(created.status_code, 201, created.text)
        skill = created.json()['skill']
        self.assertEqual((skill['key'], skill['tier'], skill['source'], skill['manageable']), ('personal:shipped', 'personal', {'kind': 'upload'}, True))
        conflict = alice.post('/api/skills', files={'file': ('shipped.skill', self.zip_file(), 'application/zip')})
        self.assertEqual((conflict.status_code, conflict.json()['code']), (409, 'skill_exists'))
        replaced = alice.post('/api/skills', files={'file': ('s.skill', self.zip_file(description='Second'), 'application/zip')}, data={'replace': 'true'})
        self.assertEqual(replaced.json()['skill']['description'], 'Second')
        detail = alice.get('/api/skills/personal:shipped').json()
        self.assertIn('Second', detail['content'])
        self.assertEqual({f['path'] for f in detail['files']}, {'SKILL.md', 'scripts/run.sh'})
        self.assertEqual(alice.get('/api/skills/personal%3Ashipped').status_code, 200)
        self.assertEqual(alice.get('/api/skills/builtin:alpha').json()['skill']['name'], 'alpha')
        toggled = alice.put('/api/skills/builtin:alpha/preference', json={'enabled': False})
        self.assertFalse(toggled.json()['skill']['enabled'])
        self.assertFalse({s['name']: s for s in alice.get('/api/skills?scope=private').json()['skills']}['alpha']['enabled'])
        self.assertEqual(alice.put('/api/skills/builtin:alpha/preference', json={'enabled': 'no'}).status_code, 400)
        # URL install and update from the recorded URL.
        self.web.pages['https://example.com/pack.zip'] = self.zip_file('linked', 'v1')
        self.assertEqual(alice.post('/api/skills', json={'url': 'https://example.com/pack.zip'}).status_code, 201)
        self.web.pages['https://example.com/pack.zip'] = self.zip_file('linked', 'v2')
        updated = alice.post('/api/skills/personal:linked/update')
        self.assertEqual((updated.status_code, updated.json()['skill']['description']), (200, 'v2'))
        self.assertEqual(alice.post('/api/skills/personal:shipped/update').json()['code'], 'skill_not_updatable')
        self.assertEqual(alice.delete('/api/skills/personal:shipped').json(), {'ok': True})
        self.assertEqual(alice.get('/api/skills/personal:shipped').status_code, 404)
        self.assertEqual(alice.delete('/api/skills/builtin:alpha').status_code, 403)
        self.assertEqual(alice.delete('/api/skills/org:nothing').status_code, 404)

    def test_install_and_update_responses_keep_the_users_preference(self):
        alice = self.clients['alice']
        self.web.pages['https://example.com/pack.zip'] = self.zip_file('pref', 'v1')
        self.assertTrue(alice.post('/api/skills', json={'url': 'https://example.com/pack.zip'}).json()['skill']['enabled'])
        self.assertFalse(alice.put('/api/skills/personal:pref/preference', json={'enabled': False}).json()['skill']['enabled'])
        self.web.pages['https://example.com/pack.zip'] = self.zip_file('pref', 'v2')
        for response in (alice.post('/api/skills/personal:pref/update'), alice.get('/api/skills/personal:pref'),
                         alice.post('/api/skills', json={'url': 'https://example.com/pack.zip', 'replace': True})):
            self.assertIn(response.status_code, (200, 201))
            self.assertFalse(response.json()['skill']['enabled'])
        upload = alice.post('/api/skills', files={'file': ('p.skill', self.zip_file('pref', 'v3'), 'application/zip')}, data={'replace': 'true'})
        self.assertFalse(upload.json()['skill']['enabled'])
        with self.platform.db.connect() as conn:
            self.assertEqual(conn.execute("SELECT enabled FROM skill_preferences WHERE skill_key='personal:pref'").fetchall()[0][0], 0)

    def test_candidates_error_is_typed_in_the_api(self):
        self.web.pages['https://example.com/two.zip'] = make_zip({'a/SKILL.md': skill_text('aa'), 'b/SKILL.md': skill_text('bb')})
        response = self.clients['alice'].post('/api/skills', json={'url': 'https://example.com/two.zip'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()['code'], 'skill_candidates')
        self.assertEqual(response.json()['candidates'], [{'name': 'aa', 'subpath': 'a'}, {'name': 'bb', 'subpath': 'b'}])
        picked = self.clients['alice'].post('/api/skills', json={'url': 'https://example.com/two.zip', 'subpath': 'b'})
        self.assertEqual(picked.json()['skill']['name'], 'bb')

    def test_permission_and_owner_checks(self):
        alice, bob, carol = (self.clients[name] for name in ('alice', 'bob', 'carol'))
        # No install_extensions: reads work, every install action is refused with a typed 403.
        self.assertFalse(bob.get('/api/skills?scope=private').json()['can_install'])
        for call in (lambda: bob.post('/api/skills', files={'file': ('s.skill', self.zip_file(), 'application/zip')}),
                     lambda: bob.post('/api/skills', json={'url': 'https://example.com/pack.zip'}),
                     lambda: bob.post('/api/skills/personal:x/update'), lambda: bob.delete('/api/skills/personal:x')):
            response = call()
            self.assertEqual((response.status_code, response.json()['code']), (403, 'install_extensions_required'))
        self.assertEqual(alice.post('/api/skills', files={'file': ('s.skill', self.zip_file(), 'application/zip')}).status_code, 201)
        # A personal skill is reachable only by its owner.
        self.assertEqual(carol.get('/api/skills/personal:shipped').status_code, 404)
        self.assertEqual(carol.delete('/api/skills/personal:shipped').status_code, 404)
        self.assertEqual(carol.post('/api/skills/personal:shipped/update').status_code, 404)
        self.assertEqual(carol.put('/api/skills/personal:shipped/preference', json={'enabled': False}).status_code, 404)
        self.assertNotIn('shipped', [s['name'] for s in carol.get('/api/skills?scope=private').json()['skills']])
        # Losing the permission hides the user's own personal skills (list and detail).
        with self.platform.db.connect() as conn:
            groups = [{**g, 'permissions': [p for p in g['permissions'] if p != 'install_extensions']} for g in GROUPS]
            conn.execute("UPDATE settings SET value=? WHERE key='permission_groups_v1'", (json.dumps(groups),))
        self.assertNotIn('shipped', [s['name'] for s in alice.get('/api/skills?scope=private').json()['skills']])
        self.assertEqual(alice.get('/api/skills/personal:shipped').status_code, 404)
        # Scope permissions: private needs private_agent, channels need an existing channel, unknown scopes are errors.
        self.assertEqual(alice.get('/api/skills?scope=channel-99').status_code, 404)
        self.assertEqual(alice.get('/api/skills?scope=bogus').status_code, 400)
        self.assertEqual(TestClient(self.app).get('/api/skills').status_code, 401)
        self.assertEqual(TestClient(self.app).get('/api/admin/skills').status_code, 401)
        for client in (alice, bob):
            self.assertEqual(client.get('/api/admin/skills').status_code, 403)
            self.assertEqual(client.post('/api/admin/skills', json={'url': 'https://example.com/pack.zip'}).status_code, 403)
            self.assertEqual(client.patch('/api/admin/skills/x', json={'enabled': False}).status_code, 403)
            self.assertEqual(client.put('/api/admin/skills/builtin/alpha', json={'enabled': False}).status_code, 403)

    def test_cross_origin_mutations_are_rejected(self):
        response = self.clients['alice'].post('/api/skills', json={'url': 'https://example.com/pack.zip'}, headers={'Origin': 'https://attacker.example'})
        self.assertEqual(response.status_code, 403)

    def test_chat_and_channel_scopes(self):
        alice = self.clients['alice']
        chat = alice.get('/api/skills?scope=chat').json()
        self.assertEqual({s['name'] for s in chat['skills']}, {'alpha', 'quiet'})
        channel = self.admin.post('/api/channels', json={'name': 'Shared'}).json()['channel']
        listing = alice.get(f"/api/skills?scope=channel-{channel['id']}").json()
        self.assertEqual({s['name'] for s in listing['skills']}, {'alpha', 'quiet'})
        self.assertFalse(any(s['user_disableable'] for s in listing['skills'] if s['tier'] == 'channel'))
        self.assertEqual(alice.put('/api/skills/channel:1:x/preference', json={'enabled': False}).status_code, 404)

    def test_admin_org_skill_lifecycle(self):
        alice, bob, carol = (self.clients[name] for name in ('alice', 'bob', 'carol'))
        created = self.admin.post('/api/admin/skills', files={'file': ('org.skill', self.zip_file('company', 'Company skill'), 'application/zip')},
                                  data={'groups': json.dumps(['member'])})
        self.assertEqual(created.status_code, 201, created.text)
        skill = created.json()['skill']
        self.assertEqual((skill['key'], skill['tier'], skill['groups'], skill['enabled']), ('org:company', 'org', ['member'], True))
        listing = self.admin.get('/api/admin/skills').json()
        self.assertEqual([s['name'] for s in listing['org']], ['company'])
        self.assertEqual({s['name']: s['org_enabled'] for s in listing['builtin']}, {'alpha': True, 'quiet': True})
        self.assertEqual(listing['groups'], ['admin', 'member', 'plain', 'other'])
        self.assertTrue((self.root / 'skills' / 'org' / 'company' / 'SKILL.md').exists())
        # Visibility follows the assigned groups; the administrator can read any org skill.
        self.assertIn('company', [s['name'] for s in alice.get('/api/skills?scope=chat').json()['skills']])
        self.assertNotIn('company', [s['name'] for s in carol.get('/api/skills?scope=chat').json()['skills']])
        self.assertEqual(carol.get('/api/skills/org:company').status_code, 404)
        self.assertEqual(alice.get('/api/skills/org:company').status_code, 200)
        self.assertEqual(self.admin.get('/api/skills/org:company').status_code, 200)
        patched = self.admin.patch('/api/admin/skills/company', json={'groups': ['*']})
        self.assertEqual(patched.json()['skill']['groups'], ['*'])
        self.assertIn('company', [s['name'] for s in carol.get('/api/skills?scope=chat').json()['skills']])
        self.assertEqual(self.admin.patch('/api/admin/skills/company', json={'groups': ['nonexistent']}).status_code, 400)
        self.assertEqual(self.admin.patch('/api/admin/skills/company', json={'groups': ['*', 'member']}).status_code, 400)
        self.assertEqual(self.admin.patch('/api/admin/skills/company', json={'enabled': 'x'}).status_code, 400)
        self.admin.patch('/api/admin/skills/company', json={'enabled': False})
        self.assertNotIn('company', [s['name'] for s in alice.get('/api/skills?scope=chat').json()['skills']])
        self.assertEqual(alice.get('/api/skills/org:company').status_code, 404)
        self.assertEqual(self.admin.get('/api/skills/org:company').status_code, 200)
        # Org skills cannot be changed through the personal API.
        self.admin.patch('/api/admin/skills/company', json={'enabled': True})
        self.assertEqual(alice.delete('/api/skills/org:company').status_code, 403)
        self.assertEqual(alice.put('/api/skills/org:company/preference', json={'enabled': False}).json()['skill']['enabled'], False)
        self.assertEqual(carol.put('/api/skills/org:company/preference', json={'enabled': False}).status_code, 200)
        # Install conflict, then URL install and update.
        self.assertEqual(self.admin.post('/api/admin/skills', files={'file': ('o.skill', self.zip_file('company'), 'application/zip')}).json()['code'], 'skill_exists')
        self.web.pages['https://example.com/org.zip'] = self.zip_file('remote-org', 'v1')
        self.assertEqual(self.admin.post('/api/admin/skills', json={'url': 'https://example.com/org.zip'}).status_code, 201)
        self.web.pages['https://example.com/org.zip'] = self.zip_file('remote-org', 'v2')
        self.assertEqual(self.admin.post('/api/admin/skills/remote-org/update').json()['skill']['description'], 'v2')
        self.assertEqual(self.admin.post('/api/admin/skills/company/update').json()['code'], 'skill_not_updatable')
        self.assertEqual(self.admin.delete('/api/admin/skills/company').json(), {'ok': True})
        self.assertFalse((self.root / 'skills' / 'org' / 'company').exists())
        self.assertEqual(self.admin.delete('/api/admin/skills/company').status_code, 404)

    def test_admin_can_disable_builtin_skills_organization_wide(self):
        alice = self.clients['alice']
        self.assertEqual(self.admin.put('/api/admin/skills/builtin/alpha', json={'enabled': False}).json(), {'ok': True})
        self.assertNotIn('alpha', [s['name'] for s in alice.get('/api/skills?scope=private').json()['skills']])
        self.assertEqual(alice.get('/api/skills/builtin:alpha').status_code, 404)
        self.assertEqual(self.admin.get('/api/skills/builtin:alpha').status_code, 200)
        self.assertEqual({s['name']: s['org_enabled'] for s in self.admin.get('/api/admin/skills').json()['builtin']}, {'alpha': False, 'quiet': True})
        self.assertEqual(self.admin.put('/api/admin/skills/builtin/missing', json={'enabled': False}).status_code, 404)
        self.assertEqual(self.admin.put('/api/admin/skills/builtin/alpha', json={'enabled': True}).json(), {'ok': True})
        self.assertIn('alpha', [s['name'] for s in alice.get('/api/skills?scope=private').json()['skills']])

    def test_admin_permission_groups_accept_install_extensions(self):
        groups = self.admin.get('/api/admin/permission-groups').json()['groups']
        self.assertEqual(groups, GROUPS)
        edited = [{**g, 'permissions': g['permissions'] + (['install_extensions'] if g['name'] == 'plain' else [])} for g in groups]
        self.assertEqual(self.admin.put('/api/admin/permission-groups', json={'groups': edited}).status_code, 200)
        self.assertTrue(self.clients['bob'].get('/api/skills?scope=private').json()['can_install'])
        self.assertIn('install_extensions', self.admin.get('/api/bootstrap').json()['permissions'])


class DownloadFunctionTests(unittest.IsolatedAsyncioTestCase):
    async def test_download_returns_final_url_and_body(self):
        resolver = AsyncMock(return_value=[(2, 1, 6, '', ('93.184.216.34', 443))])
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'abc', headers={'content-type': 'text/plain'})))
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', resolver), patch('enterprise_agent_platform.tools.httpx.AsyncClient', return_value=client):
            url, body, content_type, _ = await download('https://public.example/x', 10, 'too big')
        self.assertEqual((url, body, content_type), ('https://public.example/x', b'abc', 'text/plain'))
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'abc')))
        with patch.object(asyncio.get_running_loop(), 'getaddrinfo', resolver), patch('enterprise_agent_platform.tools.httpx.AsyncClient', return_value=client):
            with self.assertRaises(HTTPException) as raised:
                await download('https://public.example/x', 2, 'too big')
        self.assertEqual((raised.exception.status_code, raised.exception.detail), (413, 'too big'))


if __name__ == '__main__':
    unittest.main()
