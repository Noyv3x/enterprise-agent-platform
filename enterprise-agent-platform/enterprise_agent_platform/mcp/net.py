"""Guarded outbound HTTP for MCP, protected-resource metadata, authorization-server metadata, registration and token traffic.

The SDK speaks httpx2, so this is a second guarded client next to `tools.download` (httpx). The rules:
- http(s) only, no userinfo;
- every resolved address must be public. The administrator setting `mcp_private_networks_v1` (CIDRs, host names,
  `*.suffix`) relaxes that for organization connectors only (`allow_private=True`); personal connectors stay public-only;
- loopback, link-local, multicast, reserved and unspecified addresses, cloud metadata addresses and names, Platform's
  own service names and its own interface subnets are refused even when allowlisted. A host name entry only waives the
  "public" requirement for its addresses; it never skips the address checks;
- the TCP connection is pinned to a checked address while Host and TLS SNI keep the original name, and every redirect
  hop opens its own checked connection;
- connect timeout 10 s; responses are refused when they carry a `Content-Encoding` (identity is requested, so the bytes
  counted are the bytes delivered) and are capped at 4 MiB with a body deadline. Only a request to the connector's MCP
  endpoint (`endpoint=`) may answer with an event stream: it is capped per event (1 MiB) and per idle period, not in total.
"""
import asyncio
import ipaddress
import json
import re
import socket
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpcore2
import httpx2
from httpcore2 import AsyncNetworkBackend
from httpcore2._backends.auto import AutoBackend

from .models import McpError

SETTING = 'mcp_private_networks_v1'
CONNECT_TIMEOUT = 10.0
READ_TIMEOUT = 300.0
RESPONSE_CAP = 4 * 1024 * 1024
SSE_EVENT_CAP = 1024 * 1024
BODY_DEADLINE = 60.0  # A non-streaming body must finish within a minute of its headers.
MAX_REDIRECTS = 5
# Never reachable by a connector whatever the allowlist says (the browser guard's names, plus the Manager).
PROTECTED_NAMES = frozenset({'platform', 'agent-runtime', 'camofox', 'searxng', 'manager', 'agent-platform-manager', 'metadata',
                             'instance-data.ec2.internal', 'metadata.azure.internal', 'metadata.google.internal', 'metadata.oraclecloud.com'})
METADATA_ADDRESSES = frozenset(ipaddress.ip_address(item) for item in ('169.254.169.254', '169.254.170.2', '100.100.100.200', '100.100.200.200', 'fd00:ec2::254'))
EVENT_BREAK = re.compile(rb'(?>\r\n|\r|\n)(?>\r\n|\r|\n)')  # A blank line ends an SSE event.


class NetworkBlocked(httpx2.ConnectError):
    """The destination is not allowed by the network policy; raised before any packet is sent."""


class ResponseTooLarge(httpx2.ReadError):
    """A response body exceeded a cap or its delivery deadline."""


class UnsupportedEncoding(httpx2.ReadError):
    """The response is content-encoded; MCP peers are asked for identity, so a size cap cannot be trusted."""


class StreamIdle(httpx2.ReadTimeout):
    """An event stream sent nothing for too long."""


def private_networks(db):
    """The admin allowlist: a list of CIDR and hostname strings."""
    with db.connect() as conn:
        row = conn.execute('SELECT value FROM settings WHERE key=?', (SETTING,)).fetchone()
    try:
        value = json.loads(row['value']) if row else []
    except ValueError:
        return []
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def interface_networks():
    """Platform's own interface subnets; imported late because `tools` imports the MCP package."""
    from ..tools import interface_networks as networks
    try:
        return networks()
    except OSError:
        return []


def host_name(host):
    return host.rstrip('.').lower()


@dataclass(frozen=True)
class Policy:
    allow_networks: tuple = ()
    allow_hosts: frozenset = frozenset()
    allow_suffixes: tuple = ()
    own_networks: tuple = ()
    endpoint: tuple = ()  # (scheme, host, port, path) of the MCP endpoint, the only URL that may stream events

    @classmethod
    def build(cls, entries, own_networks=(), endpoint=None):
        networks, hosts, suffixes = [], set(), []
        for entry in entries or ():
            entry = entry.strip().lower().rstrip('.')
            if not entry:
                continue
            try:
                networks.append(ipaddress.ip_network(entry, strict=False))
                continue
            except ValueError:
                pass
            if entry.startswith('*.'):
                suffixes.append(entry[1:])
            else:
                hosts.add(entry)
        return cls(tuple(networks), frozenset(hosts), tuple(suffixes), tuple(own_networks), endpoint_key(endpoint) if endpoint else ())

    def host_allowed(self, host):
        host = host_name(host)
        return host in self.allow_hosts or any(host.endswith(suffix) for suffix in self.allow_suffixes)

    def host_denied(self, host):
        host = host_name(host)
        return host in PROTECTED_NAMES or host.endswith('.metadata.google.internal')

    def address_allowed(self, host, address):
        ip = ipaddress.ip_address(address)
        ip = ip.ipv4_mapped or ip if ip.version == 6 else ip
        if (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified or ip in METADATA_ADDRESSES
                or any(ip.version == net.version and ip in net for net in self.own_networks)):
            return False
        return ip.is_global or self.host_allowed(host) or any(ip.version == net.version and ip in net for net in self.allow_networks)


def endpoint_key(url):
    parts = urlsplit(str(url))
    return parts.scheme, (parts.hostname or '').lower(), parts.port or (443 if parts.scheme == 'https' else 80), parts.path or '/'


async def resolve(host, port):
    """Resolve once; tests patch this to simulate DNS answers."""
    answers = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen = []
    for answer in answers:
        if answer[4][0] not in seen:
            seen.append(answer[4][0])
    return seen


async def checked_addresses(policy, host, port):
    """Every address of `host` must be allowed, otherwise nothing is connected."""
    if policy.host_denied(host):
        raise NetworkBlocked('This destination is a protected service')
    try:
        addresses = await resolve(host, port)
    except (OSError, ValueError) as exc:
        raise NetworkBlocked('Host cannot be resolved') from exc
    if not addresses:
        raise NetworkBlocked('Host cannot be resolved')
    for address in addresses:
        if not policy.address_allowed(host, address):
            raise NetworkBlocked('Private and reserved network addresses are not allowed for this connector')
    return addresses


def check_scheme(url):
    parts = urlsplit(str(url))
    try:
        parts.port
    except ValueError:
        raise NetworkBlocked('Invalid URL') from None
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None or parts.password is not None:
        raise NetworkBlocked('An http(s) URL without credentials is required')
    return parts


class _Backend(AsyncNetworkBackend):
    def __init__(self, policy):
        self.policy = policy
        self.inner = AutoBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        last = None
        for address in await checked_addresses(self.policy, host, port):
            try:
                # TCP goes to the checked address; the pool still carries the original host for Host and SNI.
                return await self.inner.connect_tcp(address, port, timeout=timeout, local_address=local_address, socket_options=socket_options)
            except (httpcore2.ConnectError, httpcore2.ConnectTimeout) as exc:
                last = exc
        raise last

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise NetworkBlocked('Unix sockets are not allowed')

    async def sleep(self, seconds):
        await self.inner.sleep(seconds)


class _Capped(httpx2.AsyncByteStream):
    """A plain body: at most `RESPONSE_CAP` bytes, delivered within `BODY_DEADLINE`."""

    def __init__(self, stream):
        self.stream = stream

    async def __aiter__(self):
        seen, deadline = 0, time.monotonic() + BODY_DEADLINE
        async for chunk in self.stream:
            seen += len(chunk)
            if seen > RESPONSE_CAP:
                raise ResponseTooLarge('Response exceeds 4 MiB')
            if time.monotonic() > deadline:
                raise ResponseTooLarge('Response body is too slow')
            yield chunk

    async def aclose(self):
        await self.stream.aclose()


class _Events(httpx2.AsyncByteStream):
    """An MCP event stream: unbounded in total, but no event over `SSE_EVENT_CAP` and no silence over `idle` seconds."""

    def __init__(self, stream, idle):
        self.stream, self.idle = stream, idle

    async def __aiter__(self):
        pending, tail = 0, b''
        chunks = self.stream.__aiter__()
        while True:
            try:
                async with asyncio.timeout(self.idle):
                    chunk = await chunks.__anext__()
            except StopAsyncIteration:
                return
            except TimeoutError:
                raise StreamIdle('The event stream went silent') from None
            window = tail + chunk
            last = None
            for last in EVENT_BREAK.finditer(window):
                pass
            pending = len(window) - last.end() if last else pending + len(chunk)
            if pending > SSE_EVENT_CAP:
                raise ResponseTooLarge('An event exceeds 1 MiB')
            tail = window[-3:]
            yield chunk

    async def aclose(self):
        await self.stream.aclose()


def identity_only(headers):
    return all(item.strip().lower() in ('', 'identity') for item in headers.get('content-encoding', '').split(','))


class GuardedTransport(httpx2.AsyncBaseTransport):
    def __init__(self, policy, idle=READ_TIMEOUT):
        self.policy, self.idle = policy, idle
        self.inner = httpx2.AsyncHTTPTransport(trust_env=False, retries=0)
        # httpx2 exposes no backend parameter; its pool is the one place connections are opened.
        self.inner._pool._network_backend = _Backend(policy)

    async def handle_async_request(self, request):
        response = await self.inner.handle_async_request(request)
        try:
            if not identity_only(response.headers):
                raise UnsupportedEncoding('Compressed responses are not accepted')
            events = (response.headers.get('content-type', '').lower().startswith('text/event-stream')
                      and self.policy.endpoint and endpoint_key(request.url) == self.policy.endpoint)
            if not events:
                try:
                    length = int(response.headers.get('content-length', 0))
                except ValueError:
                    length = 0
                if length > RESPONSE_CAP:
                    raise ResponseTooLarge('Response exceeds 4 MiB')
        except httpx2.ReadError:
            await response.stream.aclose()
            raise
        response.stream = _Events(response.stream, self.idle) if events else _Capped(response.stream)
        return response

    async def aclose(self):
        await self.inner.aclose()


async def _check_request(request):
    check_scheme(request.url)


def guarded_client(platform, *, auth=None, headers=None, timeout=None, follow_redirects=False, allow_private=False, endpoint=None):
    """An httpx2 client whose every connection is policy-checked and pinned. The caller closes it.

    `allow_private` applies the administrator allowlist (organization connectors); `endpoint` is the connector's MCP
    URL, the only one whose responses may be event streams. `timeout` (an `httpx2.Timeout`) is kept as given except that
    connecting is never allowed more than 10 s; the SDK's long SSE read timeout is therefore not clipped."""
    if timeout is None:
        timeout = httpx2.Timeout(30.0, connect=CONNECT_TIMEOUT, read=READ_TIMEOUT)
    else:
        timeout = httpx2.Timeout(connect=min(timeout.connect or CONNECT_TIMEOUT, CONNECT_TIMEOUT), read=timeout.read, write=timeout.write, pool=timeout.pool)
    policy = Policy.build(private_networks(platform.db) if allow_private else (), interface_networks(), endpoint)
    return httpx2.AsyncClient(
        transport=GuardedTransport(policy, timeout.read or READ_TIMEOUT),
        auth=auth, headers={'Accept-Encoding': 'identity', **(headers or {})}, timeout=timeout,
        follow_redirects=follow_redirects, max_redirects=MAX_REDIRECTS, trust_env=False,
        event_hooks={'request': [_check_request]})


async def check_url(platform, url, allow_private=False):
    """Pre-flight for stored URLs: raises `McpError` when the URL could never be fetched under the policy."""
    try:
        parts = check_scheme(url)
        policy = Policy.build(private_networks(platform.db) if allow_private else (), interface_networks())
        await checked_addresses(policy, parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80))
    except NetworkBlocked as exc:
        raise McpError(400, 'mcp_network_blocked', str(exc)) from None


def find_blocked(exc):
    """The `NetworkBlocked` behind a raised error (through chains and exception groups), or None."""
    pending, seen = [exc], set()
    while pending:
        item = pending.pop()
        if item is None or id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, NetworkBlocked):
            return item
        pending += [item.__cause__, item.__context__, *getattr(item, 'exceptions', ())]
    return None
