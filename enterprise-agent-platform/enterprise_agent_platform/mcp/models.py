"""Shared MCP constants, typed failures and pure helpers."""
from __future__ import annotations

import hashlib
import json
import re

from starlette.exceptions import HTTPException

INSTALL = 'install_extensions'
NAME_RE = re.compile(r'[a-z0-9][a-z0-9-]{0,31}')
SOURCES = ('manual', 'ai', 'legacy')
TRANSPORTS = ('http', 'sse', 'stdio')
AUTHS = ('none', 'headers', 'oauth')
CREDENTIAL_MODES = ('shared', 'per_user')
SECRET_KINDS = ('header', 'env', 'oauth_tokens', 'oauth_client')
CALL_STATUSES = ('ok', 'error', 'cancelled', 'timeout')

IDLE_SECONDS = 600
CATALOG_TTL_SECONDS = 600
DEFAULT_TIMEOUT_S = 120
MAX_TIMEOUT_S = 600
ELICITATION_SECONDS = 600
MAX_TEXT_BYTES = 200 * 1024
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 2 * 1024 * 1024
DEFERRED_TOOLS = 40
DEFERRED_SCHEMA_BYTES = 64 * 1024
AUDIT_RETAIN = 10_000
SETTINGS_PRIVATE_NETWORKS = 'mcp_private_networks_v1'
TOOL_NAME_LIMIT = 64
TOOL_NAME_RE = re.compile(r'[A-Za-z0-9_.-]{1,128}')
CONTROL_RE = re.compile(r'[\x00-\x1f\x7f-\x9f\u2028\u2029]')
ENV_KEY_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,127}')
HEADER_KEY_RE = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}")


class McpError(HTTPException):
    """A typed MCP failure. `payload` entries are merged into the API error body and the tool's error data."""

    def __init__(self, status, code, detail, **payload):
        super().__init__(status, detail)
        self.code = code
        self.payload = payload


def jloads(value, default):
    try:
        return json.loads(value) if value else default
    except (TypeError, ValueError):
        return default


def source_kind(row):
    return jloads(row['source_json'], {}).get('kind', 'manual')


def connector_dict(row):
    """A connector row with its JSON columns parsed; secrets are never part of it."""
    item = dict(row)
    item['args'] = jloads(item.pop('args_json'), [])
    item['env_keys'] = jloads(item.pop('env_keys_json'), [])
    item['header_keys'] = jloads(item.pop('header_keys_json'), [])
    item['disabled_tools'] = jloads(item.pop('disabled_tools_json'), [])
    item['groups'] = jloads(item.pop('groups_json'), ['*'])
    item['oauth'] = jloads(item.pop('oauth_json'), {})
    meta = jloads(row['source_json'], {})
    item['source'] = meta.get('kind', 'manual')
    item['confirmed'] = meta.get('confirmed', True) is not False
    item.pop('source_json')
    item['enabled'] = bool(item['enabled'])
    return item


def validate_name(value):
    if not isinstance(value, str) or not NAME_RE.fullmatch(value):
        raise McpError(400, 'invalid_name', 'Connector name must match [a-z0-9][a-z0-9-]{0,31}')
    return value


def slugify(value, fallback='server'):
    """A valid connector name derived from a foreign config key."""
    slug = re.sub(r'[^a-z0-9]+', '-', str(value).lower()).strip('-')[:32].strip('-')
    return slug if slug and NAME_RE.fullmatch(slug) else fallback


def _sanitize(value):
    return re.sub(r'[^a-zA-Z0-9_-]', '_', value)


def _hash(connector, tool):
    return hashlib.sha256(f'{connector}\x00{tool}'.encode()).hexdigest()[:6]


def tool_names(pairs):
    """`{(connector, tool): 'mcp__<connector>__<tool>'}` for every pair.

    Names are sanitized to `[a-zA-Z0-9_-]` and at most 64 characters. A name that is truncated, or that several
    pairs sanitize to, gets a stable hash suffix computed from the original pair, independent of listing order."""
    wanted = {pair: _sanitize(f'mcp__{pair[0]}__{pair[1]}') for pair in pairs}
    groups = {}
    for pair, name in wanted.items():
        groups.setdefault(name, []).append(pair)
    result = {}
    for name, members in groups.items():
        for pair in members:
            if len(members) == 1 and len(name) <= TOOL_NAME_LIMIT:
                result[pair] = name
            else:
                result[pair] = name[:TOOL_NAME_LIMIT - 7] + '_' + _hash(*pair)
    # A suffixed name can still equal another plain name; resolve by appending the hash to that plain name too.
    seen = {}
    for pair, name in sorted(result.items()):
        seen.setdefault(name, []).append(pair)
    for name, members in seen.items():
        if len(members) > 1:
            for pair in members:
                result[pair] = name[:TOOL_NAME_LIMIT - 7] + '_' + _hash(*pair)
    return result


def clean_line(value, limit=200):
    """One line of untrusted text: control and line-separator characters become spaces, runs of spaces collapse."""
    return re.sub(r' +', ' ', CONTROL_RE.sub(' ', str(value))).strip()[:limit]


def clean_text(value):
    """Untrusted multi-line text without control characters other than newline and tab."""
    return re.sub(r'[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]', ' ', str(value))


def clip_bytes(text, limit):
    """`text` cut to at most `limit` UTF-8 bytes on a character boundary."""
    raw = text.encode('utf-8')
    return text if len(raw) <= limit else raw[:limit].decode('utf-8', 'ignore')


def clean_secret(value):
    """A header or environment value: surrounding whitespace trimmed, control characters (CR, LF, ...) refused."""
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 16384:
        raise McpError(400, 'invalid_connector', 'Secret values must be strings of at most 16384 characters')
    value = value.strip()
    if CONTROL_RE.search(value):
        raise McpError(400, 'invalid_connector', 'Secret values must not contain control characters or line breaks')
    return value
