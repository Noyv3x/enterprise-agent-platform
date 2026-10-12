"""Database access for connectors, secrets, channel enablement, the call audit and the catalog cache.

Secret values are written and read here only; no view or API ever returns them."""
from __future__ import annotations

import json
import time

from .models import AUDIT_RETAIN, McpError, connector_dict

_COLUMNS = ('scope', 'owner_user_id', 'name', 'label', 'transport', 'url', 'command', 'args_json', 'cwd', 'env_keys_json',
            'header_keys_json', 'auth', 'credential_mode', 'oauth_json', 'groups_json', 'enabled', 'disabled_tools_json',
            'source_json', 'timeout_s', 'created_by')


class SecretStore:
    """`mcp_secrets`: `user_id` None is the shared owner."""

    def __init__(self, db):
        self.db = db

    @staticmethod
    def _owner(user_id):
        return 0 if user_id is None else user_id

    def get(self, connector_id, user_id, kind, name):
        with self.db.connect() as conn:
            row = conn.execute("SELECT value,issuer FROM mcp_secrets WHERE connector_id=? AND COALESCE(user_id,0)=? AND kind=? AND name=?",
                               (connector_id, self._owner(user_id), kind, name)).fetchone()
        return (row['value'], row['issuer']) if row else None

    def put(self, connector_id, user_id, kind, name, value, issuer=''):
        with self.db.connect() as conn:
            conn.execute("DELETE FROM mcp_secrets WHERE connector_id=? AND COALESCE(user_id,0)=? AND kind=? AND name=?",
                         (connector_id, self._owner(user_id), kind, name))
            conn.execute("INSERT INTO mcp_secrets(connector_id,user_id,kind,name,value,issuer,updated_at) VALUES (?,?,?,?,?,?,?)",
                         (connector_id, user_id, kind, name, value, issuer, int(time.time())))

    def delete(self, connector_id, user_id, kind=None, name=None):
        sql, args = "DELETE FROM mcp_secrets WHERE connector_id=? AND COALESCE(user_id,0)=?", [connector_id, self._owner(user_id)]
        if kind is not None:
            sql, args = sql + " AND kind=?", [*args, kind]
        if name is not None:
            sql, args = sql + " AND name=?", [*args, name]
        with self.db.connect() as conn:
            conn.execute(sql, args)

    def delete_name(self, connector_id, kind, name):
        """One secret name of every owner (a declared key was removed from the connector)."""
        with self.db.connect() as conn:
            conn.execute("DELETE FROM mcp_secrets WHERE connector_id=? AND kind=? AND name=?", (connector_id, kind, name))

    def delete_kind(self, connector_id, kind):
        """Every owner's secrets of one kind (for example all OAuth tokens after the server URL changed)."""
        with self.db.connect() as conn:
            conn.execute("DELETE FROM mcp_secrets WHERE connector_id=? AND kind=?", (connector_id, kind))

    def names(self, connector_id, user_id, kind):
        with self.db.connect() as conn:
            return {row[0] for row in conn.execute("SELECT name FROM mcp_secrets WHERE connector_id=? AND COALESCE(user_id,0)=? AND kind=?",
                                                   (connector_id, self._owner(user_id), kind))}

    def values(self, connector_id, user_id, kind):
        with self.db.connect() as conn:
            return {row[0]: row[1] for row in conn.execute("SELECT name,value FROM mcp_secrets WHERE connector_id=? AND COALESCE(user_id,0)=? AND kind=?",
                                                           (connector_id, self._owner(user_id), kind))}


class Store:
    def __init__(self, db):
        self.db = db
        self.secrets = SecretStore(db)

    # -- connectors --------------------------------------------------------------------------------

    def get(self, connector_id):
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM mcp_connectors WHERE id=?", (connector_id,)).fetchone()
        return connector_dict(row) if row else None

    def org(self):
        with self.db.connect() as conn:
            rows = conn.execute("SELECT * FROM mcp_connectors WHERE scope='org' ORDER BY id").fetchall()
        return [connector_dict(row) for row in rows]

    def personal(self, user_id):
        with self.db.connect() as conn:
            rows = conn.execute("SELECT * FROM mcp_connectors WHERE scope='personal' AND owner_user_id=? ORDER BY id", (user_id,)).fetchall()
        return [connector_dict(row) for row in rows]

    def personal_by_name(self, user_id, name):
        return next((item for item in self.personal(user_id) if item['name'] == name), None)

    def org_by_name(self, name):
        return next((item for item in self.org() if item['name'] == name), None)

    def insert(self, **fields):
        """Insert a connector; JSON columns are given already serialized under their column names."""
        values = {'label': '', 'url': '', 'command': '', 'args_json': '[]', 'cwd': '', 'env_keys_json': '[]', 'header_keys_json': '[]',
                  'auth': 'none', 'credential_mode': 'shared', 'oauth_json': '{}', 'groups_json': '["*"]', 'enabled': 1,
                  'disabled_tools_json': '[]', 'source_json': '{"kind":"manual"}', 'timeout_s': 120, 'owner_user_id': None, **fields}
        now = int(time.time())
        with self.db.connect() as conn:
            clash = conn.execute("SELECT 1 FROM mcp_connectors WHERE name=? AND ("
                                 "(scope=? AND COALESCE(owner_user_id,0)=?) OR (?='personal' AND scope='org') OR (?='org' AND scope='personal'))",
                                 (values['name'], values['scope'], values['owner_user_id'] or 0, values['scope'], values['scope'])).fetchone()
            if clash:
                raise McpError(409, 'name_in_use', 'A connector with this name already exists')
            cursor = conn.execute(f"INSERT INTO mcp_connectors({','.join(_COLUMNS)},created_at,updated_at) VALUES ({','.join('?' * (len(_COLUMNS) + 2))})",
                                  (*(values.get(column) for column in _COLUMNS), now, now))
            return cursor.lastrowid

    def update(self, connector_id, **fields):
        if not fields:
            return
        assignments = ','.join(f'{key}=?' for key in fields)
        with self.db.connect() as conn:
            conn.execute(f"UPDATE mcp_connectors SET {assignments},updated_at=? WHERE id=?", (*fields.values(), int(time.time()), connector_id))

    def delete(self, connector_id):
        with self.db.connect() as conn:
            for table in ('mcp_secrets', 'mcp_channel_connectors', 'mcp_catalog_cache'):
                conn.execute(f"DELETE FROM {table} WHERE connector_id=?", (connector_id,))
            conn.execute("DELETE FROM mcp_connectors WHERE id=?", (connector_id,))

    # -- channels ----------------------------------------------------------------------------------

    def channel_ids(self, channel_id):
        with self.db.connect() as conn:
            return [row[0] for row in conn.execute("SELECT connector_id FROM mcp_channel_connectors WHERE channel_id=? ORDER BY connector_id", (channel_id,))]

    def set_channel(self, channel_id, connector_ids, user_id):
        with self.db.connect() as conn:
            existing = {row[0] for row in conn.execute("SELECT connector_id FROM mcp_channel_connectors WHERE channel_id=?", (channel_id,))}
            wanted = set(connector_ids)
            for connector_id in existing - wanted:
                conn.execute("DELETE FROM mcp_channel_connectors WHERE channel_id=? AND connector_id=?", (channel_id, connector_id))
            for connector_id in wanted - existing:
                conn.execute("INSERT INTO mcp_channel_connectors(channel_id,connector_id,enabled_by,created_at) VALUES (?,?,?,?)",
                             (channel_id, connector_id, user_id, int(time.time())))

    # -- audit -------------------------------------------------------------------------------------

    def record_call(self, user_id, scope_key, connector, tool, status, duration_ms):
        """One audit row: who, which connector and tool, status and duration. Never content."""
        with self.db.connect() as conn:
            conn.execute("INSERT INTO mcp_calls(at,user_id,scope_key,connector_id,connector_name,tool,status,duration_ms) VALUES (?,?,?,?,?,?,?,?)",
                         (int(time.time()), user_id, scope_key, connector['id'], connector['name'], tool, status, int(duration_ms)))
            conn.execute("DELETE FROM mcp_calls WHERE id <= (SELECT MAX(id) FROM mcp_calls) - ?", (AUDIT_RETAIN,))

    def calls(self, connector_id=None, limit=100):
        sql = ("SELECT c.id,c.at,c.user_id,u.username,u.display_name,c.scope_key,c.connector_id,c.connector_name,"
               "COALESCE(k.label,'') AS connector_label,c.tool,c.status,c.duration_ms FROM mcp_calls c "
               "LEFT JOIN users u ON u.id=c.user_id LEFT JOIN mcp_connectors k ON k.id=c.connector_id")
        args = []
        if connector_id is not None:
            sql, args = sql + " WHERE c.connector_id=?", [connector_id]
        with self.db.connect() as conn:
            rows = conn.execute(sql + " ORDER BY c.id DESC LIMIT ?", (*args, max(1, min(limit, 500)))).fetchall()
        return [dict(row) for row in rows]

    # -- catalog cache -----------------------------------------------------------------------------

    def cache_get(self, connector_id, user_id):
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM mcp_catalog_cache WHERE connector_id=? AND COALESCE(user_id,0)=?", (connector_id, user_id or 0)).fetchone()
        if not row:
            return None
        return {'server': json.loads(row['server_json']), 'tools': json.loads(row['tools_json']), 'prompts': json.loads(row['prompts_json']),
                'resources': json.loads(row['resources_json']), 'fetched_at': row['fetched_at']}

    def cache_put(self, connector_id, user_id, catalog):
        with self.db.connect() as conn:
            conn.execute("DELETE FROM mcp_catalog_cache WHERE connector_id=? AND COALESCE(user_id,0)=?", (connector_id, user_id or 0))
            conn.execute("INSERT INTO mcp_catalog_cache(connector_id,user_id,server_json,tools_json,prompts_json,resources_json,fetched_at) VALUES (?,?,?,?,?,?,?)",
                         (connector_id, user_id, json.dumps(catalog['server']), json.dumps(catalog['tools']), json.dumps(catalog['prompts']),
                          json.dumps(catalog['resources']), catalog['fetched_at']))

    def cache_drop(self, connector_id, user_id=...):
        with self.db.connect() as conn:
            if user_id is ...:
                conn.execute("DELETE FROM mcp_catalog_cache WHERE connector_id=?", (connector_id,))
            else:
                conn.execute("DELETE FROM mcp_catalog_cache WHERE connector_id=? AND COALESCE(user_id,0)=?", (connector_id, user_id or 0))

    # -- settings ----------------------------------------------------------------------------------

    def setting(self, key, default=None):
        with self.db.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def put_setting(self, key, value):
        with self.db.connect() as conn:
            conn.execute("INSERT INTO settings(key,value,secret,updated_at) VALUES (?,?,0,?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                         (key, json.dumps(value), int(time.time())))
