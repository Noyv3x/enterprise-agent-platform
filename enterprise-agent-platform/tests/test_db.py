import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from enterprise_agent_platform.db import Database


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = Database(self.root / 'platform.db')
        self.db.migrate(self.root)

    def test_cli_migrate_creates_owner_only_files_under_permissive_umask(self):
        data = self.root / 'fresh'
        data.mkdir(mode=0o700)
        script = 'import os,sys; os.umask(0o022); sys.argv=["enterprise-agent-platform","migrate","--data",sys.argv[1]]; from enterprise_agent_platform.__main__ import main; main()'
        subprocess.run([sys.executable, '-c', script, str(data)], check=True, capture_output=True, text=True)
        created = [path for path in data.iterdir() if path.is_file()]
        self.assertIn(data / 'platform.db', created)
        for path in created:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, path.name)


    def old_database(self):
        """A database as the pre-Pi rollback-compatible schema left it."""
        path = self.root / 'old' / 'platform.db'
        path.parent.mkdir()
        db = Database(path)
        db.migrate(path.parent)
        dead = ('conversation_revisions(scope_type, scope_id, revision)', 'agent_memories(id INTEGER PRIMARY KEY, content, tags_json)',
                'external_identities(provider, external_id)', 'telegram_link_challenges(user_id)',
                'telegram_updates(update_id)', 'mail_accounts(id INTEGER PRIMARY KEY)',
                'mail_account_credentials(account_id REFERENCES mail_accounts(id) ON DELETE CASCADE)',
                'agent_run_inputs(message_id)', 'agent_runtime_scopes(scope_key REFERENCES agent_scopes(scope_key))',
                'agent_runtime_scope_sessions(scope_key REFERENCES agent_runtime_scopes(scope_key))',
                'pi_schema_migrations(version, applied_at)')
        with db.connect() as conn:
            for table in dead:
                conn.execute('CREATE TABLE ' + table)
            conn.execute("CREATE VIRTUAL TABLE agent_memory_fts USING fts5(content, tags_json, content='agent_memories', content_rowid='id')")
            for name, source in (('message_fts', ''), ('message_fts_trigram', ", tokenize='trigram'")):
                conn.execute(f"CREATE VIRTUAL TABLE {name} USING fts5(content, content='messages', content_rowid='id'{source})")
                conn.execute(f"CREATE TRIGGER {name}_ai AFTER INSERT ON messages BEGIN "
                             f"INSERT INTO {name}(rowid, content) VALUES(new.id, new.content); END")
            conn.execute("CREATE TRIGGER conversation_revision_ai AFTER INSERT ON messages BEGIN "
                         "INSERT INTO conversation_revisions VALUES(new.scope_type, new.scope_id, 1); END")
            conn.execute("CREATE TRIGGER agent_memory_ai AFTER INSERT ON agent_memories BEGIN "
                         "INSERT INTO agent_memory_fts(rowid, content, tags_json) VALUES(new.id, new.content, new.tags_json); END")
            conn.execute("INSERT INTO pi_schema_migrations VALUES(1, 'then')")
            conn.execute("DELETE FROM schema_migrations WHERE version > 2026082901")
            conn.execute("INSERT INTO settings VALUES('durable_agent_jobs_start_message_id', '0', 0, 1)")
            conn.execute("INSERT INTO settings VALUES('keep', 'value', 0, 1)")
            conn.execute("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(1,'alice','Alice','hash',1)")
            conn.execute("INSERT INTO messages(scope_type,scope_id,author_type,user_id,content,created_at) "
                         "VALUES('private','1','user',1,'hello',1)")
            conn.execute("INSERT INTO agent_memories(content, tags_json) VALUES('fact', '[]')")
            for kind in ('agent', 'agent_learning_review', 'agent_learning_review'):
                conn.execute("INSERT INTO durable_jobs(kind,dedupe_key,created_at,updated_at) VALUES(?,?,1,1)",
                             (kind, f'{kind}-{conn.execute("SELECT count(*) FROM durable_jobs").fetchone()[0]}'))
            conn.execute("INSERT INTO agent_schedules(owner_user_id,name,prompt,schedule_json,created_at,updated_at) "
                         "VALUES(1,'daily','p','{}',1,1)")
        return db

    @staticmethod
    def shape(db):
        with db.connect() as conn:
            return sorted(tuple(row) for row in conn.execute(
                "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"))

    def test_forward_migration_drops_pre_pi_state_and_keeps_live_data(self):
        db = self.old_database()
        db.migrate(db.path.parent)
        with db.connect() as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')")}
            counts = {name: conn.execute(f'SELECT count(*) FROM {name}').fetchone()[0]
                      for name in ('users', 'messages', 'agent_schedules')}
            kinds = [row[0] for row in conn.execute('SELECT kind FROM durable_jobs')]
            settings = {row[0] for row in conn.execute('SELECT key FROM settings')}
            conn.execute("INSERT INTO messages(scope_type,scope_id,author_type,user_id,content,created_at) "
                         "VALUES('private','1','user',1,'after',2)")
        for dead in ('conversation_revisions', 'agent_memories', 'agent_memory_fts', 'message_fts', 'message_fts_trigram',
                     'external_identities', 'telegram_link_challenges', 'telegram_updates', 'mail_accounts',
                     'mail_account_credentials', 'agent_run_inputs', 'agent_runtime_scopes',
                     'agent_runtime_scope_sessions', 'pi_schema_migrations', 'conversation_revision_ai',
                     'message_fts_ai', 'message_fts_trigram_ai', 'agent_memory_ai'):
            self.assertNotIn(dead, tables)
        self.assertEqual(counts, {'users': 1, 'messages': 1, 'agent_schedules': 1})
        self.assertEqual(kinds, ['agent'])
        self.assertEqual(settings, {'keep'})
        self.assertEqual(db.schema_version(), 2026100101)
        before = self.shape(db)
        with db.connect() as conn:
            applied = conn.execute('SELECT applied_at FROM schema_migrations WHERE version=2026100101').fetchone()[0]
        db.migrate(db.path.parent)
        self.assertEqual(self.shape(db), before)
        with db.connect() as conn:
            self.assertEqual(conn.execute('SELECT applied_at FROM schema_migrations WHERE version=2026100101').fetchone()[0], applied)

    def test_fresh_database_reaches_the_same_schema_as_a_migrated_one(self):
        old = self.old_database()
        old.migrate(old.path.parent)
        self.assertEqual(self.shape(self.db), self.shape(old))
        self.assertEqual(self.db.schema_version(), 2026100101)
        with self.db.connect() as conn:
            self.assertEqual([row[0] for row in conn.execute('SELECT version FROM schema_migrations ORDER BY version')],
                             [2026082901, 2026100101])

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


if __name__ == '__main__':
    unittest.main()
