import asyncio
import json
import os
import time
from unittest.mock import patch
import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.db import Database
from enterprise_agent_platform.mcp import imports
from enterprise_agent_platform.mcp.imports import detect, import_legacy_workspaces, parse, read_workspace_file
from enterprise_agent_platform.mcp.models import NAME_RE, McpError


def drafts(text, hint=None):
    fmt, items = parse(text, hint)
    return fmt, {d.name: d for d in items}


def code(text, hint=None):
    with unittest.TestCase().assertRaises(McpError) as ctx:
        parse(text, hint)
    return ctx.exception.code


class ClaudeJsonTests(unittest.TestCase):
    def test_mcp_json_stdio_and_remote(self):
        fmt, items = drafts(json.dumps({'mcpServers': {
            'files': {'command': 'npx', 'args': ['-y', 'pkg', '${HOME}/x'], 'env': {'KEY': 'secret'}, 'cwd': 'sub'},
            'web': {'type': 'http', 'url': 'https://e.com/mcp', 'headers': {'X-Key': 'abc'}},
            'plain': {'url': 'https://e.com/plain'},
            'stream': {'type': 'streamable-http', 'url': 'https://e.com/s'},
            'events': {'type': 'sse', 'url': 'https://e.com/sse'},
            'local': {'type': 'stdio', 'command': 'srv'},
        }}), '.mcp.json')
        self.assertEqual(fmt, 'claude')
        self.assertEqual(items['files'].args, ['-y', 'pkg', '${HOME}/x'])
        self.assertEqual((items['files'].env, items['files'].cwd, items['files'].transport), ({'KEY': 'secret'}, 'sub', 'stdio'))
        self.assertEqual(items['web'].headers, {'X-Key': 'abc'})
        self.assertEqual([items[n].transport for n in ('plain', 'stream', 'events', 'local')], ['http', 'http', 'sse', 'stdio'])

    def test_claude_json_projects_dedupe_first_wins(self):
        _, items = drafts(json.dumps({'mcpServers': {'a': {'command': 'top'}}, 'projects': {
            '/p1': {'mcpServers': {'a': {'command': 'p1'}, 'b': {'command': 'b1'}}},
            '/p2': {'mcpServers': {'b': {'command': 'b2'}, 'c': {'url': 'https://c.example'}}},
            '/p3': {'other': 1}}}), '~/.claude.json')
        self.assertEqual({n: d.command for n, d in items.items()}, {'a': 'top', 'b': 'b1', 'c': ''})

    def test_projects_only(self):
        _, items = drafts(json.dumps({'projects': {'/p': {'mcpServers': {'x': {'command': 'c'}}}}}))
        self.assertEqual(list(items), ['x'])

    def test_claude_desktop_and_cursor_formats(self):
        text = json.dumps({'mcpServers': {'a': {'command': 'c'}}})
        self.assertEqual(parse(text, 'claude_desktop_config.json')[0], 'claude-desktop')
        self.assertEqual(parse(text, '/w/.cursor/mcp.json')[0], 'cursor')
        self.assertEqual(parse(text)[0], 'claude')

    def test_cursor_remote_with_headers(self):
        fmt, items = drafts('{"mcpServers": {"r": {"url": "https://x.io/mcp", "headers": {"Authorization": "Bearer tok"}}}}', '.cursor/mcp.json')
        self.assertEqual(fmt, 'cursor')
        self.assertEqual((items['r'].transport, items['r'].headers), ('http', {'Authorization': 'Bearer tok'}))


class JsoncTests(unittest.TestCase):
    def test_vscode_servers_inputs_and_comments(self):
        text = '''{
  // comment
  "inputs": [{"id": "tok", "type": "promptString", "password": true},],
  "servers": {
    /* block */
    "gh": {"type": "http", "url": "https://api.example.com/mcp", /* x */ "headers": {"Authorization": "Bearer ${input:tok}",},},
    "loc": {"command": "node", "args": ["a//b", "c,]"], "env": {"T": "${input:tok}", "OK": "v",}},
  },
}'''
        fmt, items = drafts(text, '.vscode/mcp.json')
        self.assertEqual(fmt, 'vscode')
        self.assertEqual(items['gh'].headers, {'Authorization': ''})
        self.assertEqual(items['loc'].env, {'T': '', 'OK': 'v'})
        self.assertEqual(items['loc'].args, ['a//b', 'c,]'])

    def test_settings_mcp_servers(self):
        fmt, items = drafts('{"editor.x": 1, "mcp": {"servers": {"s": {"command": "c"}}}}')
        self.assertEqual((fmt, list(items)), ('vscode', ['s']))

    def test_slashes_inside_strings_preserved(self):
        _, items = drafts('{"mcpServers": {"w": {"url": "https://h.example/a//b", // trailing\n"headers": {"X": "a /* not */ b"}}}}')
        self.assertEqual(items['w'].url, 'https://h.example/a//b')
        self.assertEqual(items['w'].headers, {'X': 'a /* not */ b'})


class CodexTests(unittest.TestCase):
    def test_toml(self):
        fmt, items = drafts('''
[mcp_servers.fs]
command = "npx"
args = ["-y", "pkg"]
cwd = "work"
env_vars = ["HOST_TOKEN"]
[mcp_servers.fs.env]
A = "lit"
B = "${B}"

[mcp_servers.api]
url = "https://api.example.com/mcp"
bearer_token_env_var = "API_TOKEN"
http_headers = { "X-Org" = "org1" }
env_http_headers = { "X-Secret" = "SECRET_VAR" }

[mcp_servers.other]
url = "https://o.example/mcp"
http_headers = { Authorization = "Bearer keep" }
bearer_token_env_var = "T"
''', 'config.toml')
        self.assertEqual(fmt, 'codex')
        self.assertEqual((items['fs'].env, items['fs'].cwd), ({'A': 'lit', 'B': '', 'HOST_TOKEN': ''}, 'work'))
        self.assertEqual(items['api'].transport, 'http')
        self.assertEqual(items['api'].headers, {'X-Org': 'org1', 'X-Secret': '', 'Authorization': ''})
        self.assertEqual(items['other'].headers, {'Authorization': 'Bearer keep'})

    def test_toml_errors(self):
        self.assertEqual(code('[mcp_servers.x]\ncommand = ""\n'), 'import_invalid')
        self.assertEqual(code('[mcp_servers.x]\nfoo = 1\n'), 'import_invalid')
        self.assertEqual(code('[other]\na = 1\n'), 'import_unrecognized')


class OpencodeTests(unittest.TestCase):
    def test_local_and_remote(self):
        fmt, items = drafts('''{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "loc": {"type": "local", "command": ["npx", "-y", "pkg"], "environment": {"K": "v"}, "enabled": false,},
    "rem": {"type": "remote", "url": "https://r.example/mcp", "headers": {"Authorization": "Bearer {env:TOK}"}},
  }
}''', 'opencode.json')
        self.assertEqual(fmt, 'opencode')
        self.assertEqual((items['loc'].command, items['loc'].args, items['loc'].env), ('npx', ['-y', 'pkg'], {'K': 'v'}))
        self.assertEqual((items['rem'].transport, items['rem'].headers), ('http', {'Authorization': ''}))

    def test_opencode_server_named_servers(self):
        fmt, items = drafts('{"mcp": {"servers": {"type": "local", "command": ["c"]}}}')
        self.assertEqual((fmt, list(items)), ('opencode', ['servers']))

    def test_bad_local_command(self):
        self.assertEqual(code('{"mcp": {"a": {"type": "local", "command": "npx"}}}'), 'import_invalid')


class CliTests(unittest.TestCase):
    def test_claude_stdio_with_dashes(self):
        fmt, items = drafts('$ claude mcp add -s user -e A=1 -e B=2 files -- npx -y @scope/pkg /data')
        d = items['files']
        self.assertEqual(fmt, 'claude-cli')
        self.assertEqual((d.transport, d.command, d.args, d.env), ('stdio', 'npx', ['-y', '@scope/pkg', '/data'], {'A': '1', 'B': '2'}))

    def test_claude_stdio_without_dashes(self):
        _, items = drafts('claude mcp add files npx -y pkg --flag')
        self.assertEqual((items['files'].command, items['files'].args), ('npx', ['-y', 'pkg', '--flag']))

    def test_claude_http_header(self):
        _, items = drafts('claude mcp add --transport http api https://x.io/mcp --header "Authorization: Bearer abc" -H "X-A: b: c"')
        d = items['api']
        self.assertEqual((d.transport, d.url, d.headers), ('http', 'https://x.io/mcp', {'Authorization': 'Bearer abc', 'X-A': 'b: c'}))

    def test_claude_sse_and_url_default(self):
        _, items = drafts('claude mcp add -t sse ev https://x.io/sse\nclaude mcp add plain https://x.io/p')
        self.assertEqual((items['ev'].transport, items['plain'].transport), ('sse', 'http'))

    def test_claude_multiple_env_values(self):
        _, items = drafts('claude mcp add --env A=1 B=2 C= srv -- cmd')
        self.assertEqual(items['srv'].env, {'A': '1', 'B': '2', 'C': ''})

    def test_continuations_and_multiple_lines(self):
        text = '''claude mcp add one \\
  -e K=v \\
  -- npx pkg

some chatter
claude mcp add --transport http two https://two.example \\
  --header "X-K: v"
codex mcp add three -- run'''
        fmt, items = drafts(text)
        self.assertEqual(fmt, 'claude-cli')
        self.assertEqual(list(items), ['one', 'two', 'three'])
        self.assertEqual(items['one'].env, {'K': 'v'})
        self.assertEqual(items['two'].headers, {'X-K': 'v'})

    def test_add_json(self):
        _, items = drafts('''claude mcp add-json weather '{"type":"http","url":"https://w.example/mcp","headers":{"K":"${K}"}}' ''')
        self.assertEqual((items['weather'].url, items['weather'].headers), ('https://w.example/mcp', {'K': ''}))
        _, items = drafts('claude mcp add-json -s user loc \'{"command":"c","args":["a"]}\'')
        self.assertEqual(items['loc'].args, ['a'])

    def test_codex_stdio_and_url(self):
        fmt, items = drafts('codex mcp add ctx --env A=1 --env B=2 -- npx -y pkg\ncodex mcp add rem --url https://r.example/mcp --bearer-token-env-var TOK')
        self.assertEqual(fmt, 'codex-cli')
        self.assertEqual((items['ctx'].command, items['ctx'].args, items['ctx'].env), ('npx', ['-y', 'pkg'], {'A': '1', 'B': '2'}))
        self.assertEqual((items['rem'].transport, items['rem'].headers), ('http', {'Authorization': ''}))

    def test_cli_errors(self):
        self.assertEqual(code('claude mcp add x -- "unclosed'), 'import_invalid')
        self.assertEqual(code('claude mcp add --transport http x notaurl'), 'import_invalid')
        self.assertEqual(code('claude mcp add --transport ws x https://a.example'), 'import_invalid')
        self.assertEqual(code('claude mcp add -e bad-key=1 x -- cmd'), 'import_invalid')
        self.assertEqual(code('claude mcp add x'), 'import_invalid')
        self.assertEqual(code('claude mcp add --nope x -- c'), 'import_invalid')
        self.assertEqual(code('claude mcp add -H nocolon -t http x https://a.example'), 'import_invalid')
        self.assertEqual(code('claude mcp add-json x not-json'), 'import_invalid')


class HostileInputTests(unittest.TestCase):
    """Input is bounded: tokenizing is linear, nesting cannot blow the stack, scans have budgets, work leaves the event loop."""

    def fast(self, text, hint=None, seconds=1.5):
        began = time.monotonic()
        try:
            parse(text, hint)
        except McpError as exc:
            result = exc.code
        else:
            result = None
        self.assertLess(time.monotonic() - began, seconds)
        return result

    def test_continuations_and_unbalanced_quotes_cost_linear_time(self):
        self.assertEqual(self.fast("claude mcp add a '" + 'x\n' * 150_000), 'import_invalid')
        self.assertEqual(self.fast('claude mcp add a npx ' + 'y \\\n' * 100_000), 'import_invalid')
        self.assertEqual(self.fast('claude mcp add a npx ' + 'z ' * 200_000), 'import_invalid')
        self.assertEqual(self.fast('claude mcp add a npx ' + 'w' * 100_000), 'import_invalid')
        self.assertEqual(self.fast(('claude mcp add s npx pkg\n' * 20_000)), 'import_invalid')

    def test_deep_json_and_toml_are_rejected_not_crashed(self):
        self.assertEqual(self.fast('[' * 300_000), 'import_invalid')
        self.assertEqual(self.fast('{"mcpServers": ' + '{"a": ' * 100_000), 'import_invalid')
        self.assertEqual(self.fast('a = ' + '[' * 200_000, 'config.toml'), 'import_invalid')

    def test_quoting_and_continuations_still_work(self):
        _, items = drafts("claude mcp add s -e 'A=b c' -- npx \\\n  -y \"pkg name\"")
        self.assertEqual((items['s'].command, items['s'].args, items['s'].env), ('npx', ['-y', 'pkg name'], {'A': 'b c'}))
        _, items = drafts("claude mcp add a npx x\nThis isn't a command\nclaude mcp add t --transport http https://t.example/mcp\nit's text again")
        self.assertEqual(list(items), ['a', 't'])

    def test_workspace_scan_has_file_and_byte_budgets(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for i in range(120):
            (root / f'd{i:03d}').mkdir()
            (root / f'd{i:03d}' / 'mcp.json').write_text('x' * 200_000)
        reads = []
        real = imports._read_pinned
        def counting(r, rel):
            text = real(r, rel)
            reads.append(rel)
            return text
        with patch.object(imports, '_read_pinned', counting):
            self.assertEqual(detect(root), [])
        self.assertLessEqual(len(reads), 22)  # 4 MiB budget / 200 KB
        self.assertLessEqual(len(reads), imports.SCAN_FILE_LIMIT)

    def test_parsing_runs_off_the_event_loop_with_a_deadline(self):
        async def run():
            self.assertEqual((await imports.aparse('claude mcp add a npx x'))[0], 'claude-cli')
            with patch.object(imports, 'parse', lambda *a: time.sleep(0.5)), patch.object(imports, 'PARSE_TIMEOUT', 0.05):
                with self.assertRaises(McpError) as raised:
                    await imports.aparse('x')
            self.assertEqual(raised.exception.code, 'import_invalid')
        asyncio.run(run())


class SecretsAndNamesTests(unittest.TestCase):
    def test_placeholders_become_missing(self):
        _, items = drafts(json.dumps({'mcpServers': {'a': {'type': 'http', 'url': 'https://a.example', 'headers': {
            'A': '${TOK}', 'B': 'Bearer $TOK', 'C': '${TOK:-x}', 'D': '', 'E': 'literal'}},
            'b': {'command': 'c', 'env': {'A': '${X}', 'B': '$X', 'C': 'lit', 'D': '', 'E': '${input:id}'}}}}))
        self.assertEqual(items['a'].headers, {'A': '', 'B': '', 'C': '', 'D': '', 'E': 'literal'})
        self.assertEqual(items['b'].env, {'A': '', 'B': '', 'C': 'lit', 'D': '', 'E': ''})

    def test_slug_and_collisions(self):
        fmt, items = parse(json.dumps({'mcpServers': {'My Server!': {'command': 'a'}, 'my-server': {'command': 'b'}, 'MY_SERVER': {'command': 'c'}, '!!!': {'command': 'd'}}}))
        self.assertEqual([d.name for d in items], ['my-server', 'my-server-2', 'my-server-3', 'server'])
        self.assertEqual([d.label for d in items], ['My Server!', 'my-server', 'MY_SERVER', '!!!'])
        self.assertTrue(all(NAME_RE.fullmatch(d.name) for d in items))

    def test_long_name_collision_stays_valid(self):
        long = 'a' * 40
        _, items = parse(json.dumps({'mcpServers': {long: {'command': 'a'}, long + 'b': {'command': 'b'}}}))
        self.assertTrue(all(NAME_RE.fullmatch(d.name) for d in items))
        self.assertEqual(len({d.name for d in items}), 2)


class ErrorTests(unittest.TestCase):
    def test_unrecognized(self):
        for text in ('', '   ', 'hello world', '{not json', '[1, 2]', '{"a": 1}', '{"mcpServers": {}}', '"str"'):
            self.assertEqual(code(text), 'import_unrecognized', text)

    def test_invalid_entries(self):
        def servers(entry):
            return json.dumps({'mcpServers': {'bad': entry}})
        for entry in ({'command': ''}, {'command': '  '}, {'args': ['a']}, {'type': 'http'}, {'url': 'ftp://x.example'},
                      {'url': 'not a url'}, {'type': 'ws', 'url': 'wss://x.example'}, {'command': 'c', 'args': [1]},
                      {'command': 'c', 'args': 'a'}, {'command': 'c', 'env': {'bad-key': '1'}}, {'command': 'c', 'env': {'A': ['x']}},
                      {'url': 'https://a.example', 'headers': {'bad header': 'x'}}, 'string', {'command': 'c', 'env': []}):
            with self.assertRaises(McpError) as ctx:
                parse(servers(entry))
            self.assertEqual((ctx.exception.status_code, ctx.exception.code), (400, 'import_invalid'), entry)
            self.assertIn('bad', ctx.exception.detail)

    def test_limits(self):
        many = {f's{i}': {'command': 'c'} for i in range(65)}
        self.assertEqual(code(json.dumps({'mcpServers': many})), 'import_invalid')
        self.assertEqual(len(parse(json.dumps({'mcpServers': dict(list(many.items())[:64])}))[1]), 64)
        self.assertEqual(code(json.dumps({'mcpServers': {'a': {'command': 'c', 'args': ['x' * (512 * 1024)]}}})), 'import_invalid')


class DetectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'ws'
        self.root.mkdir()
        self.addCleanup(self.tmp.cleanup)

    def put(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def test_detect(self):
        srv = json.dumps({'mcpServers': {'a': {'command': 'c'}, 'b': {'url': 'https://b.example'}}})
        self.put('.mcp.json', srv)
        self.put('.cursor/mcp.json', srv)
        self.put('.vscode/mcp.json', '{"servers": {"v": {"command": "c"},},}')
        self.put('.codex/config.toml', '[mcp_servers.cx]\ncommand = "c"\n')
        self.put('proj/opencode.json', '{"mcp": {"o": {"type": "local", "command": ["c"]}}}')
        self.put('proj/claude_desktop_config.json', srv)
        self.put('.claude/settings.json', '{"permissions": {}}')
        self.put('.claude/settings.local.json', srv)
        self.put('.agent-platform/mcp.json', json.dumps({'mcpServers': {'leg': {'command': 'c'}}}))
        self.put('bad/mcp.json', '{"mcpServers": {"x": {"command": ""}}}')
        self.put('junk/mcp.json', 'garbage')
        self.put('node_modules/mcp.json', srv)
        self.put('.hidden/mcp.json', srv)
        self.put('deep/er/mcp.json', srv)
        self.put('config.toml', '[mcp_servers.no]\ncommand = "c"\n')
        found = detect(self.root)
        self.assertEqual([f['path'] for f in found], sorted(f['path'] for f in found))
        by_path = {f['path']: f for f in found}
        self.assertEqual(set(by_path), {
            '/workspace/.mcp.json', '/workspace/.cursor/mcp.json', '/workspace/.vscode/mcp.json', '/workspace/.codex/config.toml',
            '/workspace/proj/opencode.json', '/workspace/proj/claude_desktop_config.json', '/workspace/.claude/settings.local.json',
            '/workspace/.agent-platform/mcp.json'})
        self.assertEqual(by_path['/workspace/.mcp.json'], {'path': '/workspace/.mcp.json', 'format': 'claude', 'servers': ['a', 'b']})
        self.assertEqual(by_path['/workspace/.cursor/mcp.json']['format'], 'cursor')
        self.assertEqual(by_path['/workspace/.vscode/mcp.json']['format'], 'vscode')
        self.assertEqual(by_path['/workspace/.codex/config.toml']['format'], 'codex')
        self.assertEqual(by_path['/workspace/proj/opencode.json']['format'], 'opencode')
        self.assertEqual(by_path['/workspace/proj/claude_desktop_config.json']['format'], 'claude-desktop')

    def test_symlink_and_oversize_ignored(self):
        outside = Path(self.tmp.name) / 'out.json'
        outside.write_text('{"mcpServers": {"a": {"command": "c"}}}')
        os.symlink(outside, self.root / 'mcp.json')
        os.symlink(self.tmp.name, self.root / 'linked')
        self.put('.mcp.json', json.dumps({'mcpServers': {'a': {'command': 'c', 'args': ['x' * 300_000]}}}))
        self.assertEqual(detect(self.root), [])

    def test_never_raises(self):
        self.assertEqual(detect(Path(self.tmp.name) / 'missing'), [])

    def test_cap(self):
        srv = json.dumps({'mcpServers': {'a': {'command': 'c'}}})
        for i in range(60):
            self.put(f'p{i:02d}/.mcp.json', srv)
        self.assertEqual(len(detect(self.root)), 50)

    def test_read_workspace_file(self):
        self.put('a/mcp.json', 'hello')
        self.assertEqual(read_workspace_file(self.root, '/workspace/a/mcp.json'), 'hello')
        self.assertEqual(read_workspace_file(self.root, 'a/mcp.json'), 'hello')
        os.symlink(self.root / 'a' / 'mcp.json', self.root / 'link.json')
        self.put('big.json', 'x' * (256 * 1024 + 1))
        (self.root / 'bin.json').write_bytes(b'\xff\xfe')
        for path, status, err in (('/workspace/nope.json', 404, 'import_not_found'), ('link.json', 404, 'import_not_found'),
                                  ('/workspace/a', 400, 'import_invalid'), ('/workspace/../x', 400, 'import_invalid'),
                                  ('/etc/passwd', 400, 'import_invalid'), ('', 400, 'import_invalid'),
                                  ('big.json', 400, 'import_invalid'), ('bin.json', 400, 'import_invalid')):
            with self.assertRaises(McpError, msg=path) as ctx:
                read_workspace_file(self.root, path)
            self.assertEqual((ctx.exception.status_code, ctx.exception.code), (status, err), path)


class LegacyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name)
        self.db = Database(self.data / 'app.db')
        self.db.migrate(self.data)
        with self.db.connect() as conn:
            for uid in (1, 2, 3):
                conn.execute("INSERT INTO users(id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, 'x', 1)", (uid, f'u{uid}', f'u{uid}'))

    def workspace(self, uid, text, raw=False):
        path = self.data / 'workspaces' / f'user-{uid}' / '.agent-platform'
        path.mkdir(parents=True, exist_ok=True)
        (path / 'mcp.json').write_text(text if raw else json.dumps(text))

    def rows(self):
        with self.db.connect() as conn:
            return [dict(r) for r in conn.execute('SELECT * FROM mcp_connectors ORDER BY owner_user_id, name')]

    def remigrate(self):
        with self.db.connect() as conn:
            conn.execute('DELETE FROM schema_migrations WHERE version=2026101501')
        self.db.migrate(self.data)

    def test_import_and_idempotence(self):
        self.workspace(1, {'mcpServers': {
            'My.Server': {'command': 'node', 'args': ['a.js'], 'env': {'TOKEN': 'sek', 'EMPTY': ''}, 'cwd': 'tools'},
            'plain': {'command': 'run'},
            'bad-cmd': {'command': ''},
            'bad-env': {'command': 'c', 'env': {'x y': '1'}},
            'bad-args': {'command': 'c', 'args': [1]},
            'bad key!': {'command': 'c'},
            'dup.name': {'command': 'a'},
            'dup-name': {'command': 'b'},
        }})
        self.workspace(2, {'mcpServers': {'plain': {'command': 'two'}}})
        self.workspace(99, {'mcpServers': {'ghost': {'command': 'c'}}})
        self.remigrate()
        rows = {(r['owner_user_id'], r['name']): r for r in self.rows()}
        self.assertEqual(set(rows), {(1, 'my-server'), (1, 'plain'), (1, 'dup-name'), (2, 'plain')})
        row = rows[(1, 'my-server')]
        self.assertEqual((row['scope'], row['label'], row['transport'], row['command'], row['cwd'], row['auth'], row['credential_mode'], row['enabled'],
                          row['source_json'], row['timeout_s'], row['created_by']), ('personal', 'My.Server', 'stdio', 'node', 'tools', 'none', 'shared', 1, '{"kind":"legacy"}', 120, 1))
        self.assertEqual(json.loads(row['args_json']), ['a.js'])
        self.assertEqual(json.loads(row['env_keys_json']), ['TOKEN', 'EMPTY'])
        self.assertEqual((rows[(1, 'plain')]['label'], rows[(1, 'plain')]['cwd']), ('', ''))
        self.assertEqual(rows[(1, 'dup-name')]['command'], 'a')
        self.assertEqual(rows[(2, 'plain')]['command'], 'two')
        with self.db.connect() as conn:
            secrets = [dict(r) for r in conn.execute('SELECT * FROM mcp_secrets')]
            self.assertEqual(len(secrets), 1)
            self.assertEqual((secrets[0]['connector_id'], secrets[0]['user_id'], secrets[0]['kind'], secrets[0]['name'], secrets[0]['value'], secrets[0]['issuer']),
                             (row['id'], 1, 'env', 'TOKEN', 'sek', ''))
            conn.row_factory = __import__('sqlite3').Row
            self.assertEqual(import_legacy_workspaces(conn, self.data), 0)
        self.remigrate()
        self.assertEqual(len(self.rows()), 4)
        self.assertTrue((self.data / 'workspaces' / 'user-1' / '.agent-platform' / 'mcp.json').exists())

    def test_symlink_oversize_and_invalid_files_skipped(self):
        outside = self.data / 'outside.json'
        outside.write_text(json.dumps({'mcpServers': {'s': {'command': 'c'}}}))
        link = self.data / 'workspaces' / 'user-1' / '.agent-platform'
        link.mkdir(parents=True)
        os.symlink(outside, link / 'mcp.json')
        self.workspace(2, {'mcpServers': {'s': {'command': 'c', 'args': ['x' * 300_000]}}})
        self.workspace(3, '{broken', raw=True)
        self.remigrate()
        self.assertEqual(self.rows(), [])
        self.workspace(1, {'mcpServers': {f's{i}': {'command': 'c'} for i in range(33)}})
        self.workspace(2, {'mcpServers': {'s': {'command': 'c'}}, 'extra': 1})
        self.workspace(3, {'mcpServers': {f's{i}': {'command': 'c'} for i in range(32)}})
        (link / 'mcp.json').unlink()
        (link / 'mcp.json').write_text(json.dumps({'mcpServers': {f's{i}': {'command': 'c'} for i in range(33)}}))
        self.remigrate()
        self.assertEqual({r['owner_user_id'] for r in self.rows()}, {3})
        self.assertEqual(len(self.rows()), 32)

    def test_symlinked_workspace_dir_skipped(self):
        real = self.data / 'real' / '.agent-platform'
        real.mkdir(parents=True)
        (real / 'mcp.json').write_text(json.dumps({'mcpServers': {'s': {'command': 'c'}}}))
        (self.data / 'workspaces').mkdir(exist_ok=True)
        os.symlink(self.data / 'real', self.data / 'workspaces' / 'user-1')
        self.remigrate()
        self.assertEqual(self.rows(), [])


if __name__ == '__main__':
    unittest.main()
