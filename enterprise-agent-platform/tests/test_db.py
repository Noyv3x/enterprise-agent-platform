import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from enterprise_agent_platform.db import Database


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = Database(self.root / 'platform.db')
        self.db.migrate(self.root)

    def seed(self):
        with self.db.connect() as conn:
            conn.execute('DELETE FROM pi_schema_migrations')
            conn.execute("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(1,'alice','Alice','hash',1)")
            conn.execute("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(2,'bob','Bob','hash',1)")
            for key, kind, ident in [('private:1', 'private', '1'), ('channel:3:main-agent', 'channel', '3')]:
                conn.execute('INSERT INTO agent_scopes VALUES(?,?,?,?,?,?,?,?,?)',
                             (key, kind, ident, 'old-session', 'old-life', '/workspace', 'sandbox', 1, 1))
            conn.execute("INSERT INTO agent_runtime_scopes VALUES('private:1','current-session','current-life',1,1)")
            for key, target, owner, content in [
                ('private:1', 'memory', None, 'Private fact'),
                ('channel:3:main-agent', 'memory', None, 'Shared fact'),
                ('channel:3:main-agent', 'user', 2, 'Bob secret'),
            ]:
                conn.execute('INSERT INTO agent_memories(scope_key,target,owner_user_id,content,created_at,updated_at) VALUES(?,?,?,?,1,1)',
                             (key, target, owner, content))

    def test_exports_isolated_memories_active_identity_and_disabled_skills_once(self):
        self.seed()
        workspace = self.root / 'workspaces/user-1'
        workspace.mkdir(parents=True)
        agents = workspace / 'AGENTS.md'
        agents.write_text('Existing instructions')
        package = workspace / '.agent-platform/skills/off'
        package.mkdir(parents=True)
        (package / 'SKILL.md').write_text('disabled instructions')
        inode = package.stat().st_ino
        sidecar = self.root / 'agent-skill-state' / hashlib.sha256(b'private:1').hexdigest() / 'off/.skill.json'
        sidecar.parent.mkdir(parents=True)
        sidecar.write_text('{"enabled":false}')
        self.db.migrate(self.root)
        first = agents.read_bytes()
        self.db.migrate(self.root)
        self.assertEqual(first, agents.read_bytes())
        self.assertIn('Existing instructions', first.decode())
        self.assertEqual(first.decode().count('Private fact'), 1)
        self.assertNotIn('Bob secret', (self.root / 'workspaces/channels/channel-3/AGENTS.md').read_text())
        self.assertIn('Bob secret', (self.root / 'workspaces/user-2/AGENTS.md').read_text())
        self.assertFalse(package.exists())
        self.assertEqual(inode, (workspace / '.agent-platform/skills-disabled/off').stat().st_ino)
        self.assertEqual(sidecar.read_text(), '{"enabled":false}')
        active = json.loads((self.root / 'runtimes/agent/migration/active-sessions.json').read_text())
        self.assertIn({'sid':'agent-private-1','scope_key':'private:1','lifecycle_id':'current-life','session_id':'current-session'}, active)
        with self.db.connect() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM agent_memories').fetchone()[0], 3)

    def test_partial_export_retries_without_duplicate_memory(self):
        self.seed()
        import enterprise_agent_platform.db as module
        original = module._atomic
        def interrupted(directory, name, content):
            if name == 'active-sessions.json':
                raise OSError('interrupted before publication')
            return original(directory, name, content)
        with patch.object(module, '_atomic', interrupted):
            with self.assertRaisesRegex(OSError, 'interrupted'):
                self.db.migrate(self.root)
        with self.db.connect() as conn:
            self.assertIsNone(conn.execute('SELECT * FROM pi_schema_migrations').fetchone())
        self.db.migrate(self.root)
        self.assertEqual((self.root / 'workspaces/user-1/AGENTS.md').read_text().count('Private fact'), 1)

    def test_rollback_restore_refreshes_memory_sources_and_empty_scopes(self):
        import sqlite3
        self.seed()
        snapshot = sqlite3.connect(':memory:')
        self.addCleanup(snapshot.close)
        with self.db.connect() as conn:
            conn.backup(snapshot)
        self.db.migrate(self.root)
        agents = self.root / 'workspaces/user-1/AGENTS.md'
        agents.write_text('Unrelated preface\n' + agents.read_text() + '\nPi-authored appendix\n')
        with self.db.connect() as conn:
            snapshot.backup(conn)
            conn.execute("UPDATE agent_memories SET content='Corrected private fact' WHERE content='Private fact'")
            conn.execute("DELETE FROM agent_memories WHERE content IN ('Shared fact','Bob secret')")
            conn.execute("INSERT INTO agent_memories(scope_key,target,content,created_at,updated_at) "
                         "VALUES('private:1','memory','Additional fact',2,2)")
        self.db.migrate(self.root)
        result = agents.read_text()
        self.assertIn('Unrelated preface\n', result)
        self.assertIn('\nPi-authored appendix\n', result)
        self.assertNotIn('Private fact', result)
        self.assertEqual(result.count('Corrected private fact'), 1)
        self.assertEqual(result.count('Additional fact'), 1)
        self.assertNotIn('Shared fact', (self.root / 'workspaces/channels/channel-3/AGENTS.md').read_text())
        self.assertNotIn('Bob secret', (self.root / 'workspaces/user-2/AGENTS.md').read_text())
        with self.db.connect() as conn:
            conn.execute('DELETE FROM pi_schema_migrations')
        self.db.migrate(self.root)
        self.assertEqual(agents.read_text(), result)

    def test_rollback_preserves_pi_edited_memory_section_without_duplicate(self):
        self.seed()
        self.db.migrate(self.root)
        agents = self.root / 'workspaces/user-1/AGENTS.md'
        edited = agents.read_text().replace('Private fact', 'Pi-maintained fact')
        agents.write_text(edited)
        with self.db.connect() as conn:
            conn.execute('DELETE FROM pi_schema_migrations')
        self.db.migrate(self.root)
        self.assertEqual(agents.read_text(), edited)
        self.assertEqual(list(agents.parent.glob('AGENTS.migrated-conflict-*')), [])
        with self.db.connect() as conn:
            conn.execute('DELETE FROM pi_schema_migrations')
            conn.execute("UPDATE agent_memories SET content='Old release edit' WHERE content='Private fact'")
        with self.assertLogs('enterprise_agent_platform.db', level='WARNING') as warnings:
            self.db.migrate(self.root)
        conflicts = list(agents.parent.glob('AGENTS.migrated-conflict-*'))
        self.assertEqual(len(conflicts), 1)
        self.assertIn('Old release edit', conflicts[0].read_text())
        self.assertNotIn('Private fact', conflicts[0].read_text())
        self.assertIn(str(conflicts[0]), warnings.output[0])
        self.assertEqual(agents.read_text(), edited)
        with self.db.connect() as conn:
            conn.execute('DELETE FROM pi_schema_migrations')
        with self.assertLogs('enterprise_agent_platform.db', level='WARNING'):
            self.db.migrate(self.root)
        self.assertEqual(list(agents.parent.glob('AGENTS.migrated-conflict-*')), conflicts)
        self.assertEqual(agents.read_text(), edited)
        with self.db.connect() as conn:
            conn.execute('DELETE FROM pi_schema_migrations')
            conn.execute("DELETE FROM agent_memories WHERE scope_key='private:1'")
        with self.assertLogs('enterprise_agent_platform.db', level='WARNING'):
            self.db.migrate(self.root)
        deleted = set(agents.parent.glob('AGENTS.migrated-conflict-*')) - set(conflicts)
        self.assertEqual(len(deleted), 1)
        self.assertIn('source now contains no memories', deleted.pop().read_text())
        self.assertEqual(agents.read_text(), edited)

    def test_rejects_workspace_symlink_without_exporting_private_memory(self):
        self.seed()
        outside = self.root / 'outside'
        outside.mkdir()
        (self.root / 'workspaces').mkdir()
        (self.root / 'workspaces/user-1').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.db.migrate(self.root)
        self.assertFalse((outside / 'AGENTS.md').exists())

    def test_swapped_workspace_cannot_read_or_write_host_memory(self):
        self.seed()
        import enterprise_agent_platform.db as module
        workspace = self.root / 'workspaces/user-1'
        workspace.mkdir(parents=True)
        (workspace / 'AGENTS.md').write_text('Original instructions')
        outside = self.root / 'host'
        outside.mkdir()
        (outside / 'AGENTS.md').write_text('HOST SECRET')
        original = module._read_at
        swapped = False
        workspace_inode = workspace.stat().st_ino
        def swap_then_read(directory, name):
            nonlocal swapped
            if name == 'AGENTS.md' and not swapped and os.fstat(directory).st_ino == workspace_inode:
                swapped = True
                workspace.rename(workspace.with_name('pinned'))
                workspace.symlink_to(outside, target_is_directory=True)
            return original(directory, name)
        with patch.object(module, '_read_at', swap_then_read):
            with self.assertRaises(OSError):
                self.db.migrate(self.root)
        exported = (workspace.with_name('pinned') / 'AGENTS.md').read_text()
        self.assertIn('Original instructions', exported)
        self.assertIn('Private fact', exported)
        self.assertNotIn('HOST SECRET', exported)
        self.assertEqual((outside / 'AGENTS.md').read_text(), 'HOST SECRET')

    def test_swapped_skill_parent_cannot_move_host_packages(self):
        self.seed()
        import enterprise_agent_platform.db as module
        skills = self.root / 'workspaces/user-1/.agent-platform/skills'
        package = skills / 'off'
        package.mkdir(parents=True)
        (package / 'SKILL.md').write_text('Tenant package')
        sidecar = self.root / 'agent-skill-state' / hashlib.sha256(b'private:1').hexdigest() / 'off/.skill.json'
        sidecar.parent.mkdir(parents=True)
        sidecar.write_text('{"enabled":false}')
        outside = self.root / 'host-skills'
        (outside / 'off').mkdir(parents=True)
        (outside / 'off/SKILL.md').write_text('HOST SECRET')
        original = module.os.rename
        def swap_then_move(source, target, **kwargs):
            original(skills, skills.with_name('pinned'))
            skills.symlink_to(outside, target_is_directory=True)
            return original(source, target, **kwargs)
        with patch.object(module.os, 'rename', swap_then_move):
            self.db.migrate(self.root)
        moved = skills.parent / 'skills-disabled/off/SKILL.md'
        self.assertEqual(moved.read_text(), 'Tenant package')
        self.assertEqual((outside / 'off/SKILL.md').read_text(), 'HOST SECRET')

    def test_foreign_keys_and_rollback(self):
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db.connect() as conn:
                conn.execute("INSERT INTO chat_conversations VALUES('c',999,'title','model','now','now',NULL)")
        with self.assertRaises(RuntimeError):
            with self.db.connect() as conn:
                conn.execute("INSERT INTO settings VALUES('not-committed','v',0,1)")
                raise RuntimeError('rollback')
        with self.db.connect() as conn:
            self.assertIsNone(conn.execute("SELECT * FROM settings WHERE key='not-committed'").fetchone())

    @unittest.skipUnless(os.environ.get('OLD_PLATFORM_ROOT'), 'requires git-archived previous release package')
    def test_previous_release_reads_migrated_and_fresh_database(self):
        old_root = os.environ['OLD_PLATFORM_ROOT']
        env = dict(os.environ, PYTHONPATH=old_root)
        seed = r'''
from pathlib import Path
import sys
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.skills import SkillStore
root=Path(sys.argv[1]); db=Database(root/'legacy.db')
db.execute("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(1,'alice','Alice','hash',1)")
db.execute("INSERT INTO messages(scope_type,scope_id,author_type,content,created_at) VALUES('private','1','user','old transcript',1)")
db.execute("INSERT INTO agent_scopes VALUES('private:1','private','1','session','life','/workspace','sandbox',1,1)")
db.execute("INSERT INTO agent_memories(scope_key,content,created_at,updated_at) VALUES('private:1','old memory',1,1)")
(root/'workspaces/user-1').mkdir(parents=True)
store=SkillStore(root/'workspaces',lambda key:root/'workspaces/user-1',bundled_skills_dir=None)
store.create('private:1',name='Disabled',description='disabled package',instructions='Keep offline',enabled=False)
store.create('private:1',name='Enabled',description='enabled package',instructions='Keep online')
assert len(store.list('private:1'))==2
db.close()
'''
        subprocess.run([sys.executable, '-c', seed, str(self.root)], cwd=self.root, env=env, check=True, text=True)
        migrated = Database(self.root / 'legacy.db')
        with migrated.connect() as conn:
            before = {row['name']: conn.execute('SELECT * FROM "' + row['name'] + '"').fetchall()
                      for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%' AND name!='sqlite_sequence'")}
        migrated.migrate(self.root)
        migrated.migrate(self.root)
        with migrated.connect() as conn:
            for table, rows in before.items():
                self.assertEqual(rows, conn.execute('SELECT * FROM "' + table + '"').fetchall(), table)
            conn.execute("INSERT INTO messages(scope_type,scope_id,author_type,content,created_at) VALUES('private','1','agent','new transcript',2)")
        reader = r'''
from pathlib import Path
import sys,json
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.skills import SkillStore
root=Path(sys.argv[1])
for name in ('legacy.db','platform.db'):
    db=Database(root/name)
    assert db.query_one('SELECT MAX(version) AS v FROM schema_migrations')['v']==2026082901
    for table in ('users','channels','messages','attachments','token_usage_events','agent_scopes','agent_runtime_scopes','agent_runtime_scope_sessions','agent_memories','external_identities','telegram_link_challenges','telegram_updates','mail_accounts','mail_account_credentials','durable_jobs','agent_run_inputs','agent_schedules','agent_schedule_runs','settings','conversation_revisions'):
        db.query('SELECT * FROM '+table)
    if name=='legacy.db':
        assert [r['content'] for r in db.query('SELECT content FROM messages ORDER BY id')]==['old transcript','new transcript']
        assert db.query("SELECT rowid FROM agent_memory_fts WHERE agent_memory_fts MATCH 'memory'")
        assert len(db.query("SELECT rowid FROM message_fts WHERE message_fts MATCH 'transcript'"))==2
    db.close()
store=SkillStore(root/'workspaces',lambda key:root/'workspaces/user-1',bundled_skills_dir=None)
records=store.list('private:1')
assert [r['name'] for r in records]==['Enabled'],records
assert records[0]['enabled'] is True
print(json.dumps({'old_reader':'passed','databases':['legacy.db','platform.db'],'legacy_tables_read':20,'messages':['old transcript','new transcript'],'fts':'memory and messages','skills':['Enabled'],'disabled':'absent from old listing; sidecar preserved'}))
'''
        result = subprocess.run([sys.executable, '-c', reader, str(self.root)], cwd=self.root, env=env, check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)['old_reader'], 'passed')
        print(result.stdout.strip())


if __name__ == '__main__':
    unittest.main()
