"""Pure parsing of foreign MCP server configuration into drafts, workspace detection and legacy mcp.json migration."""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from starlette.exceptions import HTTPException

from ..files import open_workspace
from .models import ENV_KEY_RE, HEADER_KEY_RE, McpError, slugify

MAX_TEXT = 512 * 1024
MAX_FILE = 256 * 1024
MAX_SERVERS = 64
MAX_DETECTED = 50
MAX_LEGACY_SERVERS = 32
LEGACY_KEY_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')
PLACEHOLDER_RE = re.compile(r'\$\{[^}]*\}|\$[A-Za-z_]|\{(?:env|file):[^}]*\}')
CLI_START_RE = re.compile(r'^\s*(?:[$>]\s*)?(?:npx\s+)?(claude|codex)\s+mcp\s+(add-json|add)(?:\s|$)')
ENV_ASSIGN_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]*=')
WORKSPACE_FILES = ('.mcp.json', 'mcp.json', 'claude_desktop_config.json', '.claude.json', 'opencode.json',
                   '.cursor/mcp.json', '.vscode/mcp.json', '.claude/settings.json', '.claude/settings.local.json',
                   '.agent-platform/mcp.json', '.codex/config.toml')
REMOTE_TYPES = {'http': 'http', 'streamable-http': 'http', 'streamable_http': 'http', 'sse': 'sse'}


@dataclass
class Draft:
    name: str
    transport: str
    url: str = ''
    command: str = ''
    args: list[str] = field(default_factory=list)
    cwd: str = ''
    env: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    label: str = ''


def _invalid(detail):
    return McpError(400, 'import_invalid', detail)


# ---- JSONC -----------------------------------------------------------------

def _strip_comments(text):
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == '\\' else 1
            out.append(text[i:j + 1])
            i = j + 1
        elif text.startswith('//', i):
            while i < n and text[i] not in '\r\n':
                i += 1
        elif text.startswith('/*', i):
            end = text.find('*/', i + 2)
            i = n if end < 0 else end + 2
            out.append(' ')
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def _strip_trailing_commas(text):
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == '\\' else 1
            out.append(text[i:j + 1])
            i = j + 1
            continue
        if c == ',':
            j = i + 1
            while j < n and text[j] in ' \t\r\n':
                j += 1
            if j < n and text[j] in '}]':
                i += 1
                continue
        out.append(c)
        i += 1
    return ''.join(out)


def _jsonc(text):
    return json.loads(_strip_trailing_commas(_strip_comments(text.lstrip('\ufeff'))))


# ---- entry validation ------------------------------------------------------

def _secret(value):
    return '' if value == '' or PLACEHOLDER_RE.search(value) else value


def _pairs(key, value, pattern, what):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise _invalid(f'Server {key}: {what} must be an object')
    result = {}
    for name, item in value.items():
        if not isinstance(name, str) or not pattern.fullmatch(name):
            raise _invalid(f'Server {key}: invalid {what} name {name!r}')
        if isinstance(item, (int, float, bool)):
            item = json.dumps(item)
        if not isinstance(item, str):
            raise _invalid(f'Server {key}: {what} {name} must be a string')
        result[name] = _secret(item)
    return result


def _url(key, value):
    parsed = urlparse(value) if isinstance(value, str) else None
    if parsed is None or parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise _invalid(f'Server {key}: url must be an http(s) URL')
    return value


def _stdio(key, command, args, env, cwd):
    if not isinstance(command, str) or not command.strip():
        raise _invalid(f'Server {key}: command is required')
    if args is None:
        args = []
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise _invalid(f'Server {key}: args must be a list of strings')
    if cwd is None:
        cwd = ''
    if not isinstance(cwd, str):
        raise _invalid(f'Server {key}: cwd must be a string')
    return Draft('', 'stdio', command=command.strip(), args=list(args), cwd=cwd, env=_pairs(key, env, ENV_KEY_RE, 'env'))


def _remote(key, transport, url, headers):
    return Draft('', transport, url=_url(key, url), headers=_pairs(key, headers, HEADER_KEY_RE, 'header'))


def _claude_entry(key, entry):
    if not isinstance(entry, dict):
        raise _invalid(f'Server {key}: entry must be an object')
    kind = entry.get('type')
    if kind is None:
        if entry.get('url'):
            kind = 'http'
        elif 'command' in entry:
            kind = 'stdio'
        else:
            raise _invalid(f'Server {key}: needs a command or a url')
    kind = str(kind).lower()
    if kind == 'stdio':
        return _stdio(key, entry.get('command'), entry.get('args'), entry.get('env'), entry.get('cwd'))
    if kind not in REMOTE_TYPES:
        raise _invalid(f'Server {key}: unsupported type {kind!r}')
    return _remote(key, REMOTE_TYPES[kind], entry.get('url'), entry.get('headers'))


def _codex_entry(key, entry):
    if not isinstance(entry, dict):
        raise _invalid(f'Server {key}: entry must be a table')
    if 'command' in entry:
        draft = _stdio(key, entry.get('command'), entry.get('args'), entry.get('env'), entry.get('cwd'))
        names = entry.get('env_vars') or []
        if not isinstance(names, list):
            raise _invalid(f'Server {key}: env_vars must be a list')
        for item in names:
            item = item.get('name') if isinstance(item, dict) else item
            if not isinstance(item, str) or not ENV_KEY_RE.fullmatch(item):
                raise _invalid(f'Server {key}: invalid env_vars entry {item!r}')
            draft.env.setdefault(item, '')
        return draft
    if 'url' not in entry:
        raise _invalid(f'Server {key}: needs a command or a url')
    draft = _remote(key, 'http', entry.get('url'), entry.get('http_headers'))
    declared = _pairs(key, entry.get('env_http_headers'), HEADER_KEY_RE, 'header')
    for name in declared:
        draft.headers.setdefault(name, '')
    bearer = entry.get('bearer_token_env_var')
    if bearer is not None:
        if not isinstance(bearer, str) or not ENV_KEY_RE.fullmatch(bearer):
            raise _invalid(f'Server {key}: invalid bearer_token_env_var')
        if not any(h.lower() == 'authorization' for h in draft.headers):
            draft.headers['Authorization'] = ''
    return draft


def _opencode_entry(key, entry):
    if not isinstance(entry, dict):
        raise _invalid(f'Server {key}: entry must be an object')
    kind = entry.get('type') or ('local' if 'command' in entry else 'remote' if 'url' in entry else None)
    if kind == 'local':
        command = entry.get('command')
        if not isinstance(command, list) or not command or not all(isinstance(c, str) for c in command):
            raise _invalid(f'Server {key}: command must be a non-empty list of strings')
        return _stdio(key, command[0], command[1:], entry.get('environment'), entry.get('cwd'))
    if kind == 'remote':
        return _remote(key, 'http', entry.get('url'), entry.get('headers'))
    raise _invalid(f'Server {key}: unsupported type {kind!r}')


# ---- name assignment -------------------------------------------------------

def _finish(pairs):
    if not pairs:
        raise McpError(400, 'import_unrecognized', 'No MCP servers found')
    if len(pairs) > MAX_SERVERS:
        raise _invalid(f'Too many servers (max {MAX_SERVERS})')
    used, drafts = set(), []
    for key, draft in pairs:
        base = slugify(key)
        name, n = base, 1
        while name in used:
            n += 1
            suffix = f'-{n}'
            name = base[:32 - len(suffix)].strip('-') + suffix
        used.add(name)
        draft.name = name
        draft.label = key if key != name else ''
        drafts.append(draft)
    return drafts


# ---- structured formats ----------------------------------------------------

def _table(value):
    return value if isinstance(value, dict) else None


def _from_json(data, hint):
    h = (hint or '').lower().replace('\\', '/')
    if not isinstance(data, dict):
        return None
    servers = _table(data.get('mcpServers'))
    projects = _table(data.get('projects'))
    if servers is not None or (projects and any(isinstance(p, dict) and isinstance(p.get('mcpServers'), dict) for p in projects.values())):
        raw = dict(servers or {})
        for project in (projects or {}).values():
            if isinstance(project, dict) and isinstance(project.get('mcpServers'), dict):
                for key, entry in project['mcpServers'].items():
                    raw.setdefault(key, entry)
        fmt = 'cursor' if 'cursor' in h else 'claude-desktop' if 'desktop' in h else 'vscode' if 'vscode' in h else 'claude'
        return fmt, raw, _claude_entry
    if _table(data.get('servers')) is not None:
        return 'vscode', data['servers'], _claude_entry
    mcp = _table(data.get('mcp'))
    if mcp is not None:
        inner = _table(mcp.get('servers'))
        if inner is not None and inner.get('type') not in ('local', 'remote'):
            return 'vscode', inner, _claude_entry
        return 'opencode', mcp, _opencode_entry
    return None


def _structured(text, hint):
    try:
        data = _jsonc(text)
    except ValueError:
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError:
            return None
        servers = _table(data.get('mcp_servers'))
        return None if servers is None else ('codex', servers, _codex_entry)
    return _from_json(data, hint)


# ---- CLI -------------------------------------------------------------------

CLAUDE_OPTIONS = {'--transport': 'transport', '-t': 'transport', '--scope': 'scope', '-s': 'scope',
                  '--header': 'header', '-H': 'header', '--env': 'env', '-e': 'env'}
CODEX_OPTIONS = {'--env': 'env', '--url': 'url', '--bearer-token-env-var': 'bearer'}


MAX_TOKENS = 512
MAX_TOKEN_CHARS = 16384


def _tokenize(text, pos):
    """Tokens of one shell command starting at `pos`, in a single linear pass; returns `(tokens, next position)`.
    An unquoted newline ends the command, a backslash before a newline continues it, unbalanced quotes are refused."""
    tokens, current, started, quote, i, n = [], [], False, None, pos, len(text)

    def push():
        nonlocal started
        if started:
            tokens.append(''.join(current))
            current.clear()
            started = False
            if len(tokens) > MAX_TOKENS:
                raise _invalid('Command has too many words')
    while i < n:
        c = text[i]
        i += 1
        if quote == "'":
            if c == "'":
                quote = None
            else:
                current.append(c)
        elif quote == '"':
            if c == '"':
                quote = None
            elif c == '\\' and i < n and text[i] in '"\\$`\n':
                if text[i] != '\n':
                    current.append(text[i])
                i += 1
            else:
                current.append(c)
        elif c == '\n':
            push()
            return tokens, i
        elif c in ' \t':
            push()
        elif c in '\'"':
            quote, started = c, True
        elif c == '\\':
            if i < n:
                if text[i] != '\n':
                    current.append(text[i])
                    started = True
                i += 1
        else:
            current.append(c)
            started = True
        if len(current) > MAX_TOKEN_CHARS:
            raise _invalid('Command word is too long')
    if quote:
        raise _invalid('Unbalanced quotes in command')
    push()
    return tokens, n


def _cli_split(text):
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    commands, pos, n = [], 0, len(text)
    while pos < n:
        eol = text.find('\n', pos)
        end = n if eol < 0 else eol
        match = CLI_START_RE.match(text[pos:end])
        if not match:
            pos = end + 1
            continue
        tokens, pos = _tokenize(text, pos)
        start = next((k for k, t in enumerate(tokens) if t in ('claude', 'codex')), None)
        if start is None or len(tokens) < start + 3:
            raise _invalid('Incomplete command')
        commands.append((match.group(1), match.group(2), tokens[start + 3:]))
        if len(commands) > MAX_SERVERS:
            raise _invalid(f'Too many servers (max {MAX_SERVERS})')
    return commands


def _cli_options(tool, tokens):
    table = CLAUDE_OPTIONS if tool == 'claude' else CODEX_OPTIONS
    opts = {'env': [], 'header': []}
    positional, rest, i, n = [], None, 0, len(tokens)
    while i < n:
        token = tokens[i]
        i += 1
        if token == '--':
            rest = tokens[i:]
            break
        if token.startswith('-') and len(token) > 1:
            flag, eq, value = token.partition('=') if token.startswith('--') else (token, '', '')
            option = table.get(flag)
            if option is None:
                raise _invalid(f'Unsupported option {flag}')
            if not eq:
                if i >= n:
                    raise _invalid(f'Option {flag} needs a value')
                value = tokens[i]
                i += 1
            if option in ('env', 'header'):
                opts[option].append(value)
                while option == 'env' and i < n and ENV_ASSIGN_RE.match(tokens[i]):
                    opts['env'].append(tokens[i])
                    i += 1
            else:
                opts[option] = value
            continue
        positional.append(token)
        if len(positional) == 2:
            transport = opts.get('transport')
            stdio = transport == 'stdio' or (transport is None and 'url' not in opts and not re.match(r'https?://', token, re.I))
            if stdio and tool == 'claude' or tool == 'codex' and 'url' not in opts:
                rest = tokens[i - 1:]
                positional.pop()
                break
    return opts, positional, rest


def _cli_env(opts):
    env = {}
    for item in opts['env']:
        name, eq, value = item.partition('=')
        if not eq:
            raise _invalid(f'Environment value {item!r} must be KEY=VALUE')
        env[name] = value
    return env


def _cli_claude(tokens):
    opts, positional, rest = _cli_options('claude', tokens)
    if not positional:
        raise _invalid('Missing server name')
    key = positional[0]
    transport = opts.get('transport')
    if transport not in (None, 'stdio', 'http', 'sse'):
        raise _invalid(f'Server {key}: unsupported transport {transport!r}')
    if rest is not None:
        if len(positional) > 1 or transport in ('http', 'sse') or not rest:
            raise _invalid(f'Server {key}: invalid command')
        return key, {'type': 'stdio', 'command': rest[0], 'args': rest[1:], 'env': _cli_env(opts)}
    if len(positional) != 2:
        raise _invalid(f'Server {key}: needs a command or a url')
    headers = {}
    for item in opts['header']:
        name, colon, value = item.partition(':')
        if not colon:
            raise _invalid(f'Server {key}: header {item!r} must be "Name: value"')
        headers[name.strip()] = value.strip()
    return key, {'type': transport or 'http', 'url': positional[1], 'headers': headers}


def _cli_codex(tokens):
    opts, positional, rest = _cli_options('codex', tokens)
    if not positional:
        raise _invalid('Missing server name')
    key = positional[0]
    if rest is not None:
        if len(positional) > 1 or not rest:
            raise _invalid(f'Server {key}: invalid command')
        return key, {'command': rest[0], 'args': rest[1:], 'env': _cli_env(opts)}
    if len(positional) != 1 or 'url' not in opts:
        raise _invalid(f'Server {key}: needs a command or --url')
    entry = {'url': opts['url']}
    if 'bearer' in opts:
        entry['bearer_token_env_var'] = opts['bearer']
    return key, entry


def _cli_json(tokens):
    positional, i = [], 0
    while i < len(tokens):
        if tokens[i] in ('-s', '--scope'):
            i += 2
            continue
        if tokens[i].startswith('--scope='):
            i += 1
            continue
        positional.append(tokens[i])
        i += 1
    if len(positional) != 2:
        raise _invalid('add-json needs a name and a JSON object')
    try:
        entry = _jsonc(positional[1])
    except ValueError:
        raise _invalid(f'Server {positional[0]}: invalid JSON')
    return positional[0], entry


def _cli(text):
    commands = _cli_split(text)
    pairs = []
    for tool, verb, tokens in commands:
        if verb == 'add-json':
            key, entry = _cli_json(tokens)
            draft = _claude_entry(key, entry)
        elif tool == 'claude':
            key, entry = _cli_claude(tokens)
            draft = _claude_entry(key, entry)
        else:
            key, entry = _cli_codex(tokens)
            draft = _codex_entry(key, entry)
        pairs.append((key, draft))
    return ('claude-cli' if commands[0][0] == 'claude' else 'codex-cli'), pairs


def parse(text: str, hint: str | None = None) -> tuple[str, list[Draft]]:
    try:
        return _parse(text, hint)
    except RecursionError:
        raise _invalid('Configuration is nested too deeply') from None


def _parse(text, hint):
    if len(text.encode('utf-8', 'replace')) > MAX_TEXT:
        raise _invalid('Configuration is too large')
    first = next((line for line in text.splitlines() if line.strip()), '')
    if CLI_START_RE.match(first):
        fmt, pairs = _cli(text)
        return fmt, _finish(pairs)
    found = _structured(text, hint)
    if found is None:
        raise McpError(400, 'import_unrecognized', 'No MCP server configuration recognized')
    fmt, raw, build = found
    if len(raw) > MAX_SERVERS:
        raise _invalid(f'Too many servers (max {MAX_SERVERS})')
    return fmt, _finish([(str(key), build(str(key), entry)) for key, entry in raw.items()])


# ---- workspace -------------------------------------------------------------

def _read_pinned(root, rel):
    """Read a regular workspace file through pinned descriptors; raises OSError/HTTPException/ValueError."""
    fd = open_workspace(root, rel)
    with os.fdopen(fd, 'rb') as handle:
        data = handle.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ValueError('too large')
    return data.decode('utf-8')


def _subdirs(root):
    try:
        fd = open_workspace(root, '.', directory=True)
    except (OSError, HTTPException):
        return []
    try:
        with os.scandir(fd) as entries:
            return sorted(e.name for e in entries
                          if e.is_dir(follow_symlinks=False) and e.name != 'node_modules' and not e.name.startswith('.'))[:200]
    except OSError:
        return []
    finally:
        os.close(fd)


SCAN_FILE_LIMIT = 300
SCAN_BYTE_LIMIT = 4 * 1024 * 1024
PARSE_TIMEOUT = 10


def detect(root: Path) -> list[dict]:
    """Known config files at the workspace root and one level below, within fixed file-count and byte budgets."""
    found, opened, budget = [], 0, SCAN_BYTE_LIMIT
    try:
        for base in ('', *_subdirs(root)):
            for name in WORKSPACE_FILES:
                if len(found) >= MAX_DETECTED or opened >= SCAN_FILE_LIMIT or budget <= 0:
                    return sorted(found, key=lambda item: item['path'])
                rel = f'{base}/{name}' if base else name
                try:
                    text = _read_pinned(root, rel)
                    opened += 1
                    budget -= len(text)
                    fmt, drafts = parse(text, rel)
                except (OSError, HTTPException, ValueError, UnicodeDecodeError):
                    continue
                found.append({'path': f'/workspace/{rel}', 'format': fmt, 'servers': [d.name for d in drafts]})
    except Exception:
        pass
    return sorted(found, key=lambda item: item['path'])


async def aparse(text, hint=None):
    """`parse` off the event loop with a deadline (the work is also bounded by size limits)."""
    try:
        return await asyncio.wait_for(asyncio.to_thread(parse, text, hint), PARSE_TIMEOUT)
    except asyncio.TimeoutError:
        raise _invalid('Configuration took too long to read') from None


async def adetect(root):
    try:
        return await asyncio.wait_for(asyncio.to_thread(detect, root), PARSE_TIMEOUT * 3)
    except asyncio.TimeoutError:
        return []


async def aread(root, rel_path):
    return await asyncio.to_thread(read_workspace_file, root, rel_path)


def read_workspace_file(root: Path, rel_path: str) -> str:
    rel = (rel_path or '').strip()
    if rel == '/workspace' or rel.startswith('/workspace/'):
        rel = rel[len('/workspace/'):]
    if not rel or rel.startswith('/'):
        raise _invalid('Path must be inside /workspace')
    try:
        return _read_pinned(root, rel)
    except HTTPException:
        raise _invalid('Not a readable workspace file')
    except OSError:
        raise McpError(404, 'import_not_found', 'File not found')
    except ValueError:
        raise _invalid('File is too large or not valid UTF-8')


# ---- legacy migration ------------------------------------------------------

def _legacy_server(key, entry):
    """(command, args, cwd, env) for a valid legacy server, else None."""
    if not isinstance(key, str) or not LEGACY_KEY_RE.fullmatch(key) or not isinstance(entry, dict):
        return None
    command, args, env, cwd = entry.get('command'), entry.get('args', []), entry.get('env', {}), entry.get('cwd', '')
    if not isinstance(command, str) or not command.strip() or not isinstance(cwd, str):
        return None
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        return None
    if not isinstance(env, dict) or not all(isinstance(k, str) and ENV_KEY_RE.fullmatch(k) and isinstance(v, str) for k, v in env.items()):
        return None
    return command.strip(), args, cwd, env


def import_legacy_workspaces(conn, data_dir: Path) -> int:
    workspaces = Path(data_dir) / 'workspaces'
    try:
        names = sorted(os.listdir(workspaces))
    except OSError:
        return 0
    now, created = int(time.time()), 0
    for dirname in names:
        match = re.fullmatch(r'user-(\d+)', dirname)
        if not match or not conn.execute('SELECT 1 FROM users WHERE id=?', (int(match.group(1)),)).fetchone():
            continue
        user_id = int(match.group(1))
        try:
            data = json.loads(_read_pinned(workspaces / dirname, '.agent-platform/mcp.json'))
        except (OSError, HTTPException, ValueError):
            continue
        servers = data.get('mcpServers') if isinstance(data, dict) and set(data) == {'mcpServers'} else None
        if not isinstance(servers, dict) or len(servers) > MAX_LEGACY_SERVERS:
            continue
        for key, entry in servers.items():
            server = _legacy_server(key, entry)
            if server is None:
                continue
            command, args, cwd, env = server
            name = slugify(key)
            if conn.execute("SELECT 1 FROM mcp_connectors WHERE scope='personal' AND owner_user_id=? AND name=?", (user_id, name)).fetchone():
                continue
            cursor = conn.execute(
                """INSERT INTO mcp_connectors(scope, owner_user_id, name, label, transport, command, args_json, cwd,
                   env_keys_json, auth, credential_mode, enabled, source_json, timeout_s, created_by, created_at, updated_at)
                   VALUES ('personal', ?, ?, ?, 'stdio', ?, ?, ?, ?, 'none', 'shared', 1, '{"kind":"legacy"}', 120, ?, ?, ?)""",
                (user_id, name, key if key != name else '', command, json.dumps(args), cwd, json.dumps(list(env)), user_id, now, now))
            for env_key, value in env.items():
                if value:
                    conn.execute("INSERT INTO mcp_secrets(connector_id, user_id, kind, name, value, issuer, updated_at) "
                                 "VALUES (?, ?, 'env', ?, ?, '', ?)", (cursor.lastrowid, user_id, env_key, value, now))
            created += 1
    return created
