import json
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
        self.assertEqual(settings, {'keep', 'model_policies_v1'})
        self.assertEqual(db.schema_version(), 2026101201)
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
        self.assertEqual(self.db.schema_version(), 2026101201)
        with self.db.connect() as conn:
            self.assertEqual([row[0] for row in conn.execute('SELECT version FROM schema_migrations ORDER BY version')],
                             [2026082901, 2026100101, 2026100201, 2026101101, 2026101201])

    def test_background_tasks_migration_is_additive_idempotent_and_constrained(self):
        import sqlite3
        db = self.old_database()
        db.migrate(db.path.parent)
        with db.connect() as conn:
            # A database as 2026100201 left it: no task table yet, live data present.
            conn.execute('DROP TABLE background_tasks')
            conn.execute('DELETE FROM schema_migrations WHERE version=2026101101')
            counts = {name: conn.execute(f'SELECT count(*) FROM {name}').fetchone()[0] for name in ('users', 'messages', 'durable_jobs', 'settings')}
        db.migrate(db.path.parent)
        self.assertEqual(db.schema_version(), 2026101201)
        before = self.shape(db)
        with db.connect() as conn:
            applied = conn.execute('SELECT applied_at FROM schema_migrations WHERE version=2026101101').fetchone()[0]
            self.assertEqual({name: conn.execute(f'SELECT count(*) FROM {name}').fetchone()[0] for name in counts}, counts)
            columns = [row[1] for row in conn.execute('PRAGMA table_info(background_tasks)')]
        self.assertEqual(columns, ['id', 'user_id', 'kind', 'external_id', 'name', 'label', 'agent_type', 'prompt', 'status', 'reason',
                                   'exit_code', 'started_at', 'ended_at', 'result', 'work_json', 'usage_json', 'created_by_message_id',
                                   'created_by_tool_call_id', 'run_job_id', 'delivered_at', 'notice_job_id', 'updated_at'])
        db.migrate(db.path.parent)
        self.assertEqual(self.shape(db), before)
        with db.connect() as conn:
            self.assertEqual(conn.execute('SELECT applied_at FROM schema_migrations WHERE version=2026101101').fetchone()[0], applied)
            self.assertEqual(conn.execute('SELECT count(*) FROM background_tasks').fetchone()[0], 0)
            insert = ("INSERT INTO background_tasks(user_id,kind,external_id,status,result,started_at,updated_at) "
                      "VALUES (?,?,?,?,?,1,1)")
            conn.execute(insert, (1, 'process', 'proc_a', 'running', 'x' * 65536))
            for bad in ((1, 'process', 'proc_b', 'running', 'x' * 65537), (1, 'daemon', 'proc_c', 'running', ''),
                        (1, 'process', 'proc_d', 'paused', ''), (1, 'process', 'proc_a', 'running', ''),
                        (99, 'process', 'proc_e', 'running', '')):
                with self.assertRaises(sqlite3.IntegrityError, msg=bad):
                    conn.execute(insert, bad)

    def before_chat_model_change(self):
        """A database as 2026100101 left it: chat model policies and a model on every conversation."""
        path = self.root / 'before' / 'platform.db'
        path.parent.mkdir()
        db = Database(path)
        db.migrate(path.parent)
        with db.connect() as conn:
            conn.execute('DELETE FROM schema_migrations WHERE version IN (2026100201, 2026101201)')
            conn.execute("DELETE FROM settings WHERE key='model_policies_v1'")
            conn.execute('ALTER TABLE users DROP COLUMN model_policy')
            conn.execute("ALTER TABLE users ADD COLUMN model_name TEXT NOT NULL DEFAULT ''")
            conn.execute("ALTER TABLE users ADD COLUMN thinking_depth TEXT NOT NULL DEFAULT 'medium'")
            conn.execute("ALTER TABLE chat_conversations ADD COLUMN model_id TEXT NOT NULL DEFAULT ''")
            conn.execute('CREATE TABLE chat_model_policies(user_id INTEGER PRIMARY KEY REFERENCES users(id), '
                         'allowed_models_json TEXT NOT NULL, default_model_id TEXT NOT NULL, updated_at TEXT NOT NULL)')
            for uid, name in ((1, 'alice'), (2, 'bob'), (3, 'carol')):
                conn.execute("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,1)", (uid, name, name, 'hash'))
            conn.execute("INSERT INTO chat_model_policies VALUES(1,'[\"a\",\"b\"]','b','now')")
            conn.execute("INSERT INTO chat_model_policies VALUES(2,'[]','','now')")
            conn.execute("INSERT INTO chat_conversations VALUES('c',1,'title','now','now',NULL,'a')")
            conn.execute("INSERT INTO chat_messages(conversation_id,role,content,created_at) VALUES('c','user','hi','now')")
        return db

    def test_chat_model_migration_keeps_admin_choice_and_drops_the_old_model_state(self):
        db = self.before_chat_model_change()
        db.migrate(db.path.parent)
        with db.connect() as conn:
            conversation = [row[1] for row in conn.execute('PRAGMA table_info(chat_conversations)')]
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            counts = [conn.execute(f'SELECT count(*) FROM {name}').fetchone()[0] for name in ('users', 'chat_conversations', 'chat_messages')]
            applied = conn.execute('SELECT applied_at FROM schema_migrations WHERE version=2026100201').fetchone()[0]
        slots, users = self.default_group(db)
        # The first account's explicit chat default survives into the chat and scout slots.
        self.assertEqual({slot: slots[slot][0] for slot in slots}, {'personal': '', 'channel': '', 'worker': '', 'chat': 'b', 'scout': 'b'})
        self.assertEqual(users, {1: 'default', 2: 'default', 3: 'default'})
        self.assertNotIn('model_id', conversation)
        self.assertNotIn('chat_model_policies', tables)
        self.assertEqual(counts, [3, 1, 1])
        before = self.shape(db)
        db.migrate(db.path.parent)
        self.assertEqual(self.shape(db), before)
        with db.connect() as conn:
            self.assertEqual(conn.execute('SELECT applied_at FROM schema_migrations WHERE version=2026100201').fetchone()[0], applied)
        with self.db.connect() as fresh, db.connect() as migrated:
            for table in ('users', 'chat_conversations'):
                self.assertEqual(sorted(tuple(row)[1:] for row in fresh.execute(f'PRAGMA table_info({table})')),
                                 sorted(tuple(row)[1:] for row in migrated.execute(f'PRAGMA table_info({table})')))

    def legacy_users_database(self, name, users):
        """A database as 2026101101 left it: per-account model, chat model and thinking columns, no policy groups."""
        path = self.root / name / 'platform.db'
        path.parent.mkdir()
        db = Database(path)
        db.migrate(path.parent)
        with db.connect() as conn:
            conn.execute("DELETE FROM settings WHERE key='model_policies_v1'")
            conn.execute('DELETE FROM schema_migrations WHERE version=2026101201')
            conn.execute('ALTER TABLE users DROP COLUMN model_policy')
            conn.execute("ALTER TABLE users ADD COLUMN model_name TEXT NOT NULL DEFAULT ''")
            conn.execute("ALTER TABLE users ADD COLUMN thinking_depth TEXT NOT NULL DEFAULT 'medium'")
            conn.execute("ALTER TABLE users ADD COLUMN chat_model_name TEXT NOT NULL DEFAULT ''")
            for uid, role, active, model, chat, thinking in users:
                conn.execute("INSERT INTO users(id,username,display_name,password_hash,role,active,model_name,chat_model_name,thinking_depth,created_at) "
                             "VALUES(?,?,?,?,?,?,?,?,?,1)", (uid, f'u{uid}', f'u{uid}', 'hash', role, active, model, chat, thinking))
        return db

    def default_group(self, db):
        with db.connect() as conn:
            policies = json.loads(conn.execute("SELECT value FROM settings WHERE key='model_policies_v1'").fetchone()[0])
            users = {row['id']: row['model_policy'] for row in conn.execute('SELECT id, model_policy FROM users')}
            columns = {row[1] for row in conn.execute('PRAGMA table_info(users)')}
        self.assertEqual([(policy['name'], policy['label']) for policy in policies], [('default', '默认')])
        self.assertEqual(set(policies[0]['slots']), {'personal', 'channel', 'chat', 'scout', 'worker'})
        self.assertTrue({'model_name', 'chat_model_name', 'thinking_depth'}.isdisjoint(columns))
        return {slot: (value['model'], value['thinking']) for slot, value in policies[0]['slots'].items()}, users

    def test_policy_group_migration_seeds_from_the_lowest_active_administrator(self):
        db = self.legacy_users_database('seed', [
            (1, 'admin', 0, 'inactive-admin', 'inactive-chat', 'high'), (2, 'user', 1, 'member-model', '', 'low'),
            (3, 'admin', 1, 'admin-model', 'admin-chat', 'none'), (4, 'admin', 1, 'later-admin', '', 'xhigh')])
        db.migrate(db.path.parent)
        slots, users = self.default_group(db)
        self.assertEqual(slots, {'personal': ('admin-model', 'off'), 'channel': ('admin-model', 'off'), 'worker': ('admin-model', 'off'),
                                 'chat': ('admin-chat', 'off'), 'scout': ('admin-chat', 'off')})
        self.assertEqual(users, {1: 'default', 2: 'default', 3: 'default', 4: 'default'})
        self.assertEqual(db.schema_version(), 2026101201)
        before = self.shape(db)
        with db.connect() as conn:
            applied = conn.execute('SELECT applied_at FROM schema_migrations WHERE version=2026101201').fetchone()[0]
            conn.execute("UPDATE settings SET value=replace(value,'admin-model','edited') WHERE key='model_policies_v1'")
        db.migrate(db.path.parent)
        self.assertEqual(self.shape(db), before)
        with db.connect() as conn:
            self.assertEqual(conn.execute('SELECT applied_at FROM schema_migrations WHERE version=2026101201').fetchone()[0], applied)
        self.assertEqual(self.default_group(db)[0]['personal'], ('edited', 'off'))

    def test_policy_group_migration_chat_slots_follow_the_personal_model_when_unset(self):
        db = self.legacy_users_database('chat', [(1, 'admin', 1, 'personal', '', 'minimal')])
        db.migrate(db.path.parent)
        slots, _ = self.default_group(db)
        self.assertEqual(set(slots.values()), {('personal', 'minimal')})

    def test_policy_group_migration_without_an_active_administrator_uses_the_lowest_account(self):
        db = self.legacy_users_database('lowest', [(5, 'user', 1, 'five', '', 'high'), (2, 'user', 0, 'two', 'two-chat', 'low'),
                                                   (9, 'admin', 0, 'nine', '', 'xhigh')])
        db.migrate(db.path.parent)
        slots, users = self.default_group(db)
        self.assertEqual(slots, {'personal': ('two', 'low'), 'channel': ('two', 'low'), 'worker': ('two', 'low'),
                                 'chat': ('two-chat', 'low'), 'scout': ('two-chat', 'low')})
        self.assertEqual(users, {2: 'default', 5: 'default', 9: 'default'})

    def test_policy_group_migration_without_accounts_and_fresh_install_use_system_defaults(self):
        db = self.legacy_users_database('empty', [])
        db.migrate(db.path.parent)
        expected = {slot: ('', 'medium') for slot in ('personal', 'channel', 'chat', 'scout', 'worker')}
        self.assertEqual(self.default_group(db)[0], expected)
        self.assertEqual(self.default_group(self.db)[0], expected)
        with self.db.connect() as conn:
            conn.execute("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(1,'new','new','hash',1)")
            self.assertEqual(conn.execute('SELECT model_policy FROM users').fetchone()[0], 'default')

    def test_foreign_keys_and_rollback(self):
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db.connect() as conn:
                conn.execute("INSERT INTO chat_conversations VALUES('c',999,'title','now','now',NULL)")
        with self.assertRaises(RuntimeError):
            with self.db.connect() as conn:
                conn.execute("INSERT INTO settings VALUES('not-committed','v',0,1)")
                raise RuntimeError('rollback')
        with self.db.connect() as conn:
            self.assertIsNone(conn.execute("SELECT * FROM settings WHERE key='not-committed'").fetchone())


if __name__ == '__main__':
    unittest.main()
