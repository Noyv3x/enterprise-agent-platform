"""Authenticated web tools and scope-owned Camofox sessions."""
import asyncio
from contextlib import asynccontextmanager, nullcontext
import base64
from dataclasses import dataclass
import fcntl
import ipaddress
import json
import logging
import os
import socket
import struct
import sys
import time
import uuid
import weakref
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

import httpx
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import webpage
from .auth import body_json, require_permission, require_internal, session_identity

log = logging.getLogger(__name__)


class WebFailure(HTTPException):
    """A web request that failed for an expected reason; `code` is the `web_fetch` failure `error`."""

    def __init__(self, status_code, detail, code):
        super().__init__(status_code, detail)
        self.code = code


async def public_url(url):
    if not isinstance(url, str):
        raise WebFailure(400, 'URL must be a string', 'invalid_url')
    try:
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == 'https' else 80)
    except ValueError as exc:
        raise WebFailure(400, 'A public HTTP(S) URL is required', 'invalid_url') from exc
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise WebFailure(400, 'A public HTTP(S) URL is required', 'invalid_url')
    try:
        addresses = await asyncio.get_running_loop().getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise WebFailure(400, 'URL host cannot be resolved', 'unreachable') from exc
    if not addresses:
        raise WebFailure(400, 'URL host cannot be resolved', 'unreachable')
    if any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise WebFailure(400, 'Private and reserved network addresses are forbidden', 'forbidden')
    return parts, addresses[0][4][0]


def interface_networks():
    """Linux container interface addresses; no deployment subnet configuration."""
    networks = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        for _, name in socket.if_nameindex():
            packed = struct.pack('256s', name.encode()[:15])
            try:
                address = socket.inet_ntoa(fcntl.ioctl(sock.fileno(), 0x8915, packed)[20:24])
                mask = socket.inet_ntoa(fcntl.ioctl(sock.fileno(), 0x891B, packed)[20:24])
            except OSError:
                continue  # IPv6-only interfaces have no SIOCGIFADDR record.
            networks.append(ipaddress.ip_network(f'{address}/{mask}', strict=False))
    ipv6 = Path('/proc/net/if_inet6')
    if ipv6.exists():
        for line in ipv6.read_text().splitlines():
            address, _, prefix, *_ = line.split()
            networks.append(ipaddress.ip_network(f'{ipaddress.IPv6Address(int(address, 16))}/{int(prefix, 16)}', strict=False))
    return networks


async def browser_url(url):
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise HTTPException(400, 'Browser navigation requires an HTTP(S) URL without credentials')
    hostname = parts.hostname.rstrip('.').lower()
    blocked = {'platform', 'agent-runtime', 'camofox', 'searxng', 'metadata', 'instance-data.ec2.internal',
               'metadata.azure.internal', 'metadata.google.internal', 'metadata.oraclecloud.com'}
    if hostname in blocked or hostname.endswith('.metadata.google.internal'):
        raise HTTPException(400, 'Browser destination is a protected service')
    try:
        answers = await asyncio.get_running_loop().getaddrinfo(hostname, parts.port or 443, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as exc:
        raise HTTPException(400, 'Browser host cannot be resolved') from exc
    networks = interface_networks()
    if not answers:
        raise HTTPException(400, 'Browser host cannot be resolved')
    for answer in answers:
        address = ipaddress.ip_address(answer[4][0])
        address = address.ipv4_mapped or address if address.version == 6 else address
        if (address.is_link_local or address.is_multicast or address.is_reserved or address.is_unspecified
                or str(address) in {'100.100.100.200', 'fd00:ec2::254'}
                or any(address.version == network.version and address in network for network in networks)):
            raise HTTPException(400, 'Browser destination is a protected network')


@asynccontextmanager
async def pinned_get(client, url, headers=None):
    """The final response of a GET pinned to each checked address, following at most 5 redirects, each revalidated:
    yields `(final_url, response)` with the body unread. Host and TLS SNI keep the origin while TCP uses the checked IP."""
    for _ in range(6):
        parts, address = await public_url(url)
        pinned = httpx.URL(url).copy_with(host=address)
        authority = ('[' + parts.hostname + ']' if ':' in parts.hostname else parts.hostname) + (f':{parts.port}' if parts.port else '')
        async with client.stream('GET', pinned, headers={**(headers or {}), 'Host': authority}, extensions={'sni_hostname': parts.hostname},
                                 follow_redirects=False) as response:
            if response.is_redirect:
                location = response.headers.get('location')
                if not location:
                    raise WebFailure(502, 'Redirect has no destination', 'http_error')
                url = urljoin(url, location)
                continue
            yield url, response
            return
    raise WebFailure(400, 'Too many redirects', 'http_error')


async def read_capped(response, limit, message):
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > limit:
            raise WebFailure(413, message, 'too_large')
    return bytes(body)


async def download(url, limit, message, deadline=30):
    """Pinned GET with every redirect revalidated, streamed under a size cap: `(final_url, body, content_type, encoding)`."""
    async with asyncio.timeout(deadline), httpx.AsyncClient(trust_env=False, timeout=10) as client:
        async with pinned_get(client, url) as (url, response):
            response.raise_for_status()
            return url, await read_capped(response, limit, message), response.headers.get('content-type', ''), response.encoding


async def camofox(p, method, path, fields=None, binary=False, limit=8 * 1024 * 1024, timeout=60, read_timeout=30):
    """One authenticated Camofox call, JSON (or raw bytes) under a size cap; an HTTP error status is a 502."""
    options = {} if fields is None else {'params': fields} if method == 'GET' else {'json': fields}
    async with asyncio.timeout(timeout), p.http.stream(method, p.settings.camofox_url.rstrip('/') + path,
                                                       headers={'Authorization': 'Bearer ' + p.settings.camofox_access_key},
                                                       timeout=read_timeout, **options) as response:
        if response.status_code >= 400:
            raise HTTPException(502, 'Browser service rejected the request')
        data = await read_capped(response, limit, f'Browser response exceeds {limit // (1024 * 1024)} MiB')
    return data if binary else json.loads(data)


# -- web_fetch ------------------------------------------------------------------------------------------------------
# A current desktop browser's request headers: many sites refuse the default client identity outright.
WEB_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}
READ_BYTES = 8 * 1024 * 1024  # a larger response is `too_large`
MARKER_BYTES = 256 * 1024  # challenge and refusal pages are small: their markers lie in the first part
DIRECT_SECONDS = 20
FETCH_SECONDS = 90  # plain fetch and fallback; with the fallback's session cleanup (FORGET_SECONDS) at most 100 s; Runtime waits 120 s
PARSE_SECONDS = 10  # one page conversion in the worker process, which is killed when it overruns
PARSE_QUEUE_SECONDS = 20
PARSES = 3  # conversions running at once across Platform
EXCERPT_CHARS = 4000
TITLE_CHARS = 300
JS_ONLY_CHARS = 600
CHALLENGE_CHARS = 2000
TEXT_TYPES = ('application/json', 'application/xml', 'application/javascript', 'application/x-javascript', 'application/rss+xml', 'application/atom+xml')
# Not bare 验证码: Chinese sign-in pages offer 验证码登录 (log in with an SMS code), which is no challenge.
CAPTCHA_MARKERS = ('captcha', 'geetest', 'verify you are human', 'checking your browser', 'are you a robot',
                   '安全验证', '人机验证', '滑动验证', '访问验证', '请完成验证', '输入验证码')
# Not bare `cf-chl`: an embedded Turnstile widget (a login form) carries `cf-chl-widget-…` ids; the challenge page has `_cf_chl_opt`.
CHALLENGE_MARKERS = ('captcha-delivery.com', 'px-captcha', '_cf_chl_opt', '/challenge-platform/h/', 'errors.edgesuite.net')
CHALLENGE_TITLES = ('just a moment', 'attention required', 'access denied', 'are you a robot', 'security check', *CAPTCHA_MARKERS)
JS_MARKERS = ('enable javascript', 'javascript is required', 'javascript is disabled', 'requires javascript', 'turn on javascript',
              '启用javascript', '启用 javascript', '开启javascript', '开启 javascript')
FAILURES = {
    'blocked': '{host} refused automated access{status}{protection}',
    'not_found': '{host} answered{status}: the page does not exist',
    'http_error': '{host} answered with an error{status}',
    'timeout': '{host} did not answer in time',
    'unreachable': '{host} could not be reached (the name did not resolve, or the connection or TLS handshake failed)',
    'too_large': 'the page from {host} is larger than 8 MiB',
    'unsupported': '{host} serves {detail} there, which web_fetch cannot read as a web page',
    'invalid_url': 'it is not a public http(s) URL',
    'forbidden': '{host} resolves to a private or reserved network address, which web_fetch may not reach',
}
ADVICE = {
    'blocked': 'Do not retry this page or open it with the browser tool; use another source for the same information.',
    'not_found': 'Check the address, or search for the page instead.',
    'invalid_url': 'Pass a complete http:// or https:// address.',
    'forbidden': 'Only public internet pages can be fetched.',
    'unsupported': 'Use another source for the same information.',
    'too_large': 'Use another source for the same information.',
}
UNCONVERTIBLE = 'a page that could not be converted to text in time'


@dataclass
class Fetched:
    """One attempt at a page: the content on success, or a failure `error` code."""
    url: str
    via: str
    title: str = ''
    text: str = ''
    error: str | None = None
    status: int | None = None
    protection: str | None = None
    js_only: bool = False
    detail: str = ''


class BrowserUnavailable(Exception):
    """The real-browser fallback did not run; the message says why, for the model."""


def hostname(url):
    try:
        return (urlsplit(url).hostname or '') if isinstance(url, str) else ''
    except ValueError:
        return ''


_parse_slots = weakref.WeakKeyDictionary()  # event loop → semaphore (a semaphore is bound to the loop that first waits on it)


async def convert_page(markup, charset=None):
    """`{title, text, noscript}` of HTML (bytes, or text from the browser) converted in a child process killed after
    PARSE_SECONDS; None when the page could not be converted in time (or Platform was busy converting other pages for
    PARSE_QUEUE_SECONDS). Parsers are not linear on every hostile input and hold the GIL, so neither the event loop nor a
    thread may run them. The child is a fresh `python -m enterprise_agent_platform.webpage` (about 50 ms to start) with
    an empty environment apart from the import path, not a multiprocessing child, which would re-import Platform's main
    module."""
    if isinstance(markup, str):
        markup, charset = markup.encode('utf-8'), 'utf-8'
    slots = _parse_slots.setdefault(asyncio.get_running_loop(), asyncio.Semaphore(PARSES))
    try:
        async with asyncio.timeout(PARSE_QUEUE_SECONDS):
            await slots.acquire()
    except TimeoutError:
        return None
    child = None
    try:
        child = await asyncio.create_subprocess_exec(
            sys.executable, '-m', 'enterprise_agent_platform.webpage', *([charset] if charset else []),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={'PYTHONPATH': os.pathsep.join(path for path in sys.path if path)}, close_fds=True)
        async with asyncio.timeout(PARSE_SECONDS):
            output, _ = await child.communicate(markup)
        outcome = json.loads(output) if child.returncode == 0 else {'error': f'exit {child.returncode}'}
    except (TimeoutError, OSError, ValueError) as exc:
        outcome = {'error': type(exc).__name__}
    finally:
        if child is not None and child.returncode is None:
            child.kill()
            await child.wait()
        slots.release()
    if not isinstance(outcome, dict) or 'error' in outcome or not isinstance(outcome.get('text'), str):
        log.info('web_fetch could not convert a page: %s', outcome.get('error') if isinstance(outcome, dict) else 'garbage')
        return None
    return outcome


def marker_text(body, charset):
    """Lower-cased head of a response, where challenge and refusal markers are looked for."""
    head = body[:MARKER_BYTES]
    return (head.decode(charset or 'utf-8', errors='replace') if isinstance(head, bytes) else head).lower()


def vendor(headers, raw):
    """The bot protection a refusal names, from headers and lower-cased markup; `captcha` when only a challenge shows."""
    server = headers.get('server', '').lower()
    if 'x-datadome' in headers or 'datadome' in server or 'captcha-delivery.com' in raw:
        return 'DataDome'
    if 'px-captcha' in raw or 'perimeterx' in raw or 'are you a robot' in raw:
        return 'PerimeterX'
    if 'cf-mitigated' in headers or 'cf-chl' in raw or 'just a moment' in raw or '/cdn-cgi/challenge-platform/' in raw or 'cf-ray' in headers or server == 'cloudflare':
        return 'Cloudflare'
    if 'akamaighost' in server or 'errors.edgesuite.net' in raw or ('access denied' in raw and 'reference #' in raw):
        return 'Akamai'
    if any(marker in raw for marker in CAPTCHA_MARKERS):
        return 'captcha'
    return None


def challenge_title(title):
    lowered = title.lower()
    return any(marker in lowered for marker in CHALLENGE_TITLES)


def is_challenge(raw, title, text):
    """A short page that is a bot challenge rather than content."""
    if len(text) > CHALLENGE_CHARS:
        return False
    lowered = text.lower()
    return any(marker in raw for marker in CHALLENGE_MARKERS) or challenge_title(title) or any(marker in lowered for marker in CAPTCHA_MARKERS)


def content_charset(content_type):
    """The raw `charset=` label of a Content-Type header, validated later (httpx raises on a label Python does not know)."""
    for parameter in content_type.split(';')[1:]:
        key, _, value = parameter.partition('=')
        if key.strip().lower() == 'charset':
            return value.strip().strip('"\'') or None
    return None


async def classify(url, status, headers, body, content_type, charset):
    """The `Fetched` outcome of a plain response. An unknown charset label is ignored: HTML is then sniffed from its
    `<meta>` declaration, other text is read as UTF-8."""
    charset = webpage.charset_name(charset)
    html = 'html' in content_type or (not content_type and body.lstrip()[:15].lower().startswith((b'<!doctype html', b'<html')))
    textual = html or content_type.startswith('text/') or content_type in TEXT_TYPES or content_type.endswith(('+json', '+xml'))
    raw = marker_text(body, charset) if textual else ''
    page = Fetched(url, 'direct', status=status)
    converted = None
    if html:
        converted = await convert_page(body, charset)
        if converted:
            page.title, page.text = converted['title'], converted['text']
    elif textual:
        page.text = await asyncio.to_thread(lambda: webpage.tidy(body.decode(charset or 'utf-8', errors='replace')))
    if status in (404, 410):
        page.error = 'not_found'
    elif status in (401, 403, 429):
        page.error, page.protection = 'blocked', vendor(headers, raw)
    elif status >= 400:
        challenged = is_challenge(raw, page.title, page.text) or 'x-datadome' in headers or 'cf-mitigated' in headers
        page.error, page.protection = ('blocked', vendor(headers, raw)) if challenged else ('http_error', None)
    elif status >= 300:
        page.error = 'http_error'
    elif not textual:
        page.error, page.detail = 'unsupported', content_type or 'a file of unknown type'
    elif html and converted is None:
        page.error, page.detail = 'unsupported', UNCONVERTIBLE
    elif html and is_challenge(raw, page.title, page.text):
        page.error, page.protection = 'blocked', vendor(headers, raw)
    elif html:
        page.js_only = len(page.text) < JS_ONLY_CHARS and (converted['noscript'] or any(marker in raw for marker in JS_MARKERS))
    return page


async def direct(url):
    """The plain fetch: pinned, browser-like headers, at most DIRECT_SECONDS and READ_BYTES."""
    try:
        async with asyncio.timeout(DIRECT_SECONDS), httpx.AsyncClient(trust_env=False, timeout=10) as client:
            async with pinned_get(client, url, WEB_HEADERS) as (final, response):
                body = await read_capped(response, READ_BYTES, 'The page is larger than 8 MiB')
                header = response.headers.get('content-type', '')
                status, headers = response.status_code, response.headers
    except WebFailure as exc:
        return Fetched(url, 'direct', error=exc.code)
    except httpx.InvalidURL:
        return Fetched(url, 'direct', error='invalid_url')
    except (TimeoutError, httpx.TimeoutException):
        return Fetched(url, 'direct', error='timeout')
    except (httpx.HTTPError, OSError, ValueError):
        return Fetched(url, 'direct', error='unreachable')
    return await classify(final, status, headers, body, header.split(';')[0].strip().lower(), content_charset(header))


def fetched(requested, page, max_chars):
    content = page.text[:max_chars]
    title = page.title[:TITLE_CHARS]
    data = {'url': page.url, **({'requested_url': requested} if requested != page.url else {}), 'title': title, 'via': page.via,
            'chars': len(content), 'truncated': len(page.text) > max_chars, 'excerpt': webpage.excerpt(content, EXCERPT_CHARS)}
    return {'content': json.dumps({'url': page.url, 'title': title, 'content': content}, ensure_ascii=False), 'data': data, 'is_error': False}


def failed(requested, page, tried, browser=''):
    """`browser` is the sentence saying how the real-browser retry went, if one was considered."""
    host = hostname(page.url) or hostname(requested)
    data = {'error': page.error, 'url': requested if isinstance(requested, str) else '', 'host': host,
            **({'status': page.status} if page.status else {}), **({'protection': page.protection} if page.protection else {}), 'tried_browser': tried}
    protection = ('' if not page.protection else '; the page is a CAPTCHA or verification check' if page.protection == 'captcha'
                  else f'; the site is protected by {page.protection} bot protection')
    reason = FAILURES[page.error].format(host=host or 'the site', status=f' with HTTP {page.status}' if page.status else '',
                                         protection=protection, detail=page.detail)
    advice = ADVICE.get(page.error, 'Try again later, or use another source for the same information.')
    text = f'Could not open {data["url"] or "the page"}: {reason}.{(" " + browser) if browser else ""} {advice}'
    return {'content': text, 'data': data, 'is_error': True}


async def fetch(url, max_chars=100000, render=None):
    """The `web` gateway result for one page: a plain fetch, then, for a blocked or JavaScript-only page, one attempt in a
    real browser (`render(url)` → `Fetched`, raising `BrowserUnavailable` when it could not run), all within FETCH_SECONDS
    (plus the browser session's cleanup)."""
    loop = asyncio.get_running_loop()
    started = loop.time()
    plain = await direct(url)
    if render is None or not (plain.error == 'blocked' or plain.js_only):
        return fetched(url, plain, max_chars) if plain.error is None else failed(url, plain, False)
    try:
        async with asyncio.timeout(max(1, FETCH_SECONDS - (loop.time() - started))):
            page = await render(plain.url)
    except BrowserUnavailable as exc:
        page, tried, browser = None, False, f'A real-browser retry did not run: {exc}.'
    except TimeoutError:
        page, tried, browser = None, True, 'It was also opened in a real browser, which did not finish loading it in time.'
    else:
        tried = True
        browser = ('It was also opened in a real browser, which was blocked too.' if page.error == 'blocked' else
                   'It was also opened in a real browser, which could not load it either.')
    if page is not None and page.error is None:
        return fetched(url, page, max_chars)
    if plain.error is None:
        return fetched(url, plain, max_chars)  # a JavaScript-only page: its plain text is still better than nothing
    if page is not None and page.error == 'blocked':
        plain.protection = page.protection or plain.protection
    return failed(url, plain, tried, browser)


# The fallback's trusted expressions run in the page's own realm, so they are synchronous and return plain arrays (Firefox
# forbids Promises across realms); waiting happens on the Platform side by polling, and results are parsed defensively.
# Challenge elements only: no `[id^='cf-chl']`, which an embedded Turnstile widget on an ordinary page also matches.
CHALLENGE_SELECTOR = ("iframe[src*='captcha-delivery.com'], #px-captcha, #challenge-form, #challenge-running, #challenge-stage, "
                      "#cf-challenge-running, script[src*='/challenge-platform/h/']")
SETTLE_STATE = ('[document.readyState, document.title, document.body ? document.body.innerText.length : 0, '
                f'!!document.querySelector("{CHALLENGE_SELECTOR}")]')
READ_PAGE = "[location.href, document.title, document.documentElement ? document.documentElement.outerHTML.slice(0, 2097152) : '']"
BROWSER_FETCHES = 2
BROWSER_QUEUE_SECONDS = 20
BROWSER_RATE = 6
BROWSER_RATE_WINDOW = 60
NAVIGATE_SECONDS = 35
SETTLE_SECONDS = 20
SETTLE_POLL = 0.5
FORGET_SECONDS = 10
CAMOFOX_ERRORS = (HTTPException, httpx.HTTPError, TimeoutError, ValueError, OSError)


class PageBrowser:
    """web_fetch's real-browser fallback: one throwaway Camofox identity `web-fetch:<uuid>` per page (strict public-only
    egress in Camofox), deleted afterwards whatever happens; BROWSER_FETCHES at once across Platform, one at a time per
    user (later ones queue), BROWSER_RATE per user a minute."""

    def __init__(self, platform):
        self.p = platform
        self.slots = None
        self.users = {}
        self.history = {}

    def throttle(self, user_id):
        now = time.monotonic()
        stamps = [stamp for stamp in self.history.get(user_id, ()) if stamp > now - BROWSER_RATE_WINDOW]
        if len(stamps) >= BROWSER_RATE:
            self.history[user_id] = stamps
            raise BrowserUnavailable(f'this account already opened {BROWSER_RATE} pages in the real browser in the last minute')
        self.history[user_id] = [*stamps, now]

    async def acquire(self, user_id):
        """The user's own lock, then a global slot, both within BROWSER_QUEUE_SECONDS."""
        if self.slots is None:
            self.slots = asyncio.Semaphore(BROWSER_FETCHES)
        self.throttle(user_id)
        lock = self.users.setdefault(user_id, asyncio.Lock())
        try:
            async with asyncio.timeout(BROWSER_QUEUE_SECONDS):
                await lock.acquire()
                try:
                    await self.slots.acquire()
                except BaseException:
                    lock.release()
                    raise
        except TimeoutError as exc:
            raise BrowserUnavailable('the real browser was busy with other pages') from exc
        return lock

    async def evaluate(self, base, identity, expression, timeout=3, limit=1024 * 1024):
        """The list a synchronous expression returned; anything else (garbage from a hostile page) is `[]`."""
        info = await camofox(self.p, 'POST', base + '/evaluate', {'userId': identity, 'expression': expression}, limit=limit,
                             timeout=timeout, read_timeout=timeout)
        value = info.get('result') if isinstance(info, dict) else None
        return value if isinstance(value, list) else []

    async def settle(self, base, identity):
        """Poll until the document is complete, shows no challenge and its text length held still (a second, or three for a
        nearly empty page), at most SETTLE_SECONDS; returns whether a challenge was still showing. A failed poll (the page
        reloading after a passed challenge) just polls again."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + SETTLE_SECONDS
        last, steady, flagged = None, 0, False
        while loop.time() < deadline:
            try:
                state = await self.evaluate(base, identity, SETTLE_STATE, min(3, max(0.1, deadline - loop.time())))
            except CAMOFOX_ERRORS:
                state = []
            if len(state) >= 4:
                flagged = state[3] is True or (isinstance(state[1], str) and challenge_title(state[1]))
                length = state[2] if isinstance(state[2], int) else -1
                if state[0] == 'complete' and not flagged:
                    steady = steady + 1 if length == last else 0
                    last = length
                    if steady >= (2 if length >= 200 else 6):
                        break
                else:
                    last, steady = None, 0
            await asyncio.sleep(SETTLE_POLL)
        return flagged

    async def forget(self, identity):
        try:
            await camofox(self.p, 'DELETE', '/sessions/' + quote(identity, safe=''), timeout=FORGET_SECONDS, read_timeout=FORGET_SECONDS)
        except Exception as exc:  # cleanup must never mask the fetch's own outcome
            log.warning('Could not delete web-fetch browser session %s: %s', identity, exc)

    async def render(self, user_id, url):
        lock = await self.acquire(user_id)
        identity = f'web-fetch:{uuid.uuid4()}'
        try:
            try:
                tab = await camofox(self.p, 'POST', '/tabs', {'userId': identity, 'sessionKey': 'fetch'}, timeout=20)
                tab_id = tab.get('tabId') if isinstance(tab, dict) else None
                if not isinstance(tab_id, str) or not tab_id:
                    raise ValueError('no tab')
            except CAMOFOX_ERRORS as exc:
                raise BrowserUnavailable('the real browser service was unavailable') from exc
            base = '/tabs/' + quote(tab_id, safe='')
            try:
                await camofox(self.p, 'POST', base + '/navigate', {'userId': identity, 'sessionKey': 'fetch', 'url': url},
                              timeout=NAVIGATE_SECONDS, read_timeout=NAVIGATE_SECONDS)
            except CAMOFOX_ERRORS as exc:
                log.info('web-fetch navigation did not complete: %s', exc)  # a page that never finished loading may still be readable
            flagged = await self.settle(base, identity)
            try:
                values = await self.evaluate(base, identity, READ_PAGE, timeout=15, limit=16 * 1024 * 1024)
            except CAMOFOX_ERRORS:
                values = []
        finally:
            try:
                await asyncio.shield(self.forget(identity))
            finally:
                self.slots.release()
                lock.release()
        href, title, markup = (values + [None, None, None])[:3]
        if not (isinstance(href, str) and href.startswith(('http://', 'https://')) and isinstance(markup, str) and markup):
            return Fetched(url, 'browser', error='unreachable')
        # Browser strings may hold lone surrogates (page JavaScript, or the 2,097,152-character slice cutting a pair).
        href, markup = webpage.clean(href), webpage.clean(markup)
        converted = await convert_page(markup)
        if converted is None:
            return Fetched(href, 'browser', error='unsupported', detail=UNCONVERTIBLE)
        page = Fetched(href, 'browser', title=webpage.clean(title) if isinstance(title, str) and title else converted['title'], text=converted['text'])
        raw = marker_text(markup, None)
        if (flagged and len(page.text) <= CHALLENGE_CHARS) or is_challenge(raw, page.title, page.text):
            page.error, page.protection = 'blocked', vendor({}, raw)
        return page


def result(data):
    preview = {key: value for key, value in data.items() if key != 'screenshot'} if isinstance(data, dict) else data
    return {'content': json.dumps(preview, ensure_ascii=False), 'data': data, 'is_error': False}


# -- web_search -----------------------------------------------------------------------------------------------------
SEARCH_SECONDS = 20
SEARCH_ENGINE_SECONDS = 10  # SearXNG's `timeout_limit`: one slow engine (360search allows itself 20 s) cannot stall a search
# Strict: an enterprise tool. Measured on six business queries (zh/en) it changed no result count except one flaky bing answer.
SAFE_SEARCH = 2
LOOKUP_SECONDS = 3


async def searchable(url):
    """Whether a search result points at public addresses only, decided within LOOKUP_SECONDS."""
    try:
        async with asyncio.timeout(LOOKUP_SECONDS):
            await public_url(url)
        return True
    except (HTTPException, TimeoutError):
        return False


class Browser:
    def __init__(self, platform):
        self.p = platform
        self.leases = {}
        self.locks = {}
        self.pages = PageBrowser(platform)

    def lock(self, uid):
        return self.locks.setdefault(uid, asyncio.Lock())

    def lease(self, uid):
        lease = self.leases.get(uid)
        if lease and lease['deadline'] <= time.monotonic():
            self.leases.pop(uid, None)
            lease = None
        return lease

    def public_lease(self, uid):
        lease = self.lease(uid)
        return {key: lease[key] for key in ('holder_user_id', 'expires_at')} if lease else None

    def acquire(self, uid, holder):
        old = self.lease(uid)
        if old and old['holder'] != holder:
            raise HTTPException(409, 'Browser is controlled by another session')
        self.leases[uid] = {'holder': holder, 'holder_user_id': uid, 'deadline': time.monotonic() + 60,
                            'expires_at': datetime.fromtimestamp(time.time() + 60, timezone.utc).isoformat()}
        return self.public_lease(uid)

    def check(self, uid, holder=None):
        lease = self.lease(uid)
        if lease and lease['holder'] != holder:
            raise HTTPException(409, 'Browser is busy: human takeover is active')
        if holder is not None and not lease:
            raise HTTPException(409, 'Acquire the browser lease first')

    async def request(self, uid, method, path, args=None, binary=False):
        return await camofox(self.p, method, path, {**(args or {}), 'userId': f'private:{uid}'}, binary)

    async def action(self, uid, action, args, holder=None):
        if not isinstance(args, dict) or not isinstance(action, str):
            raise HTTPException(400, 'action must be a string and arguments an object')
        async with self.lock(uid):
            self.check(uid, holder)
            if action == 'list':
                return await self.request(uid, 'GET', '/tabs')
            if action == 'cleanup':
                return await self.request(uid, 'DELETE', '/sessions/' + quote(f'private:{uid}', safe=''))
            if action == 'console':
                if args.get('expression'):
                    raise HTTPException(400, 'Browser console cannot evaluate JavaScript')
                return {'messages': [], 'supported': False, 'detail': 'Camofox does not expose console logs'}
            if action == 'new_tab':
                if args.get('url'):
                    await browser_url(args['url'])
                fields = {'sessionKey': 'agent'}
                if args.get('url'):
                    fields['url'] = args['url']
                return await self.request(uid, 'POST', '/tabs', fields)
            tab = args.get('tab_id')
            if not isinstance(tab, str) or not tab:
                raise HTTPException(400, 'tab_id is required')
            path = '/tabs/' + quote(tab, safe='')
            if action in {'screenshot', 'vision'}:
                data = await self.request(uid, 'GET', path + '/screenshot', {'fullPage': 'false'}, binary=True)
                image = {'tabId': tab, 'screenshot': {'data': base64.b64encode(data).decode(), 'mimeType': 'image/png', 'bytes': len(data)}}
                if action == 'vision':
                    image.update(await self.request(uid, 'GET', path + '/snapshot'))
                    image['question'] = args.get('question', 'Describe the current page')
                return image
            if action == 'close':
                return await self.request(uid, 'DELETE', path)
            allowed = {'navigate', 'click', 'type', 'scroll', 'back', 'forward', 'refresh', 'press', 'wait', 'viewport', 'snapshot', 'links', 'images', 'downloads', 'stats', 'extract'}
            if action not in allowed:
                raise HTTPException(400, 'Unsupported browser action')
            fields = {k: v for k, v in args.items() if k not in {'tab_id', 'userId', 'user_id', 'sessionKey'}}
            if action == 'extract' and not isinstance(fields.get('schema'), dict):
                raise HTTPException(400, 'extract requires a JSON schema object')
            if action == 'navigate':
                if fields.get('url'):
                    await browser_url(fields['url'])
                fields['sessionKey'] = 'agent'
            if isinstance(fields.get('ref'), str):
                fields['ref'] = fields['ref'].lstrip('@')
            for source, target in [('double_click', 'doubleClick'), ('press_enter', 'pressEnter'), ('wait_for_network', 'waitForNetwork')]:
                if source in fields:
                    fields[target] = fields.pop(source)
            readonly = action in {'snapshot', 'links', 'images', 'downloads', 'stats'}
            if action in {'images', 'downloads'}:
                fields.update(includeData='false', consume='false')
            return await self.request(uid, 'GET' if readonly else 'POST', path + '/' + action, fields)

    @staticmethod
    async def never():
        return False

    async def gateway(self, tool, action, args, context, disconnected=None):
        if not isinstance(args, dict) or not isinstance(context, dict):
            raise HTTPException(400, 'arguments and context must be objects')
        # A live subagent run has no conversation job of its own; it may use web tools only.
        if tool == 'web' and (owner := self.p.tasks.child_owner(context)):
            return await self.web(action, args, owner['id'])
        if tool == 'mcp' and (child := self.p.tasks.child_run(context)):
            user, agent_type = child
            return await self.p.mcp.gateway.handle(user, self.p.tasks.scope(user['id']), action, args, context, disconnected or self.never, agent_type)
        key = context.get('scope_key', '')
        with self.p.db.connect() as conn:
            session = conn.execute('SELECT scope_key FROM queue_sessions WHERE sid=?', (context.get('sid'),)).fetchone()
            jobs = conn.execute("SELECT id,payload_json FROM durable_jobs WHERE kind='agent' AND status='running' AND json_extract(payload_json,'$.parent_job_id') IS NULL").fetchall()
            payload, job_id = None, None
            for job in jobs:
                candidate = json.loads(job['payload_json'])
                name = candidate.get('scope', '')
                candidate_key = (f"private:{candidate.get('user_id')}" if name == 'private' else
                                 'channel:' + name[8:] + ':main-agent' if name.startswith('channel-') else name)
                if session and candidate_key == session['scope_key']:
                    payload, job_id = candidate, job['id']
                    break
            user = conn.execute('SELECT * FROM users WHERE id=? AND active=1', (payload['user_id'],)).fetchone() if payload else None
        if not user:
            raise HTTPException(403, 'Tool session has no active owning job')
        user = dict(user)
        uid = user['id']
        scope = self.p.queue.scope(user, payload['scope'])
        if scope['sandbox']['scope_key'] != key or scope['sid'] != context.get('sid'):
            raise HTTPException(403, 'Tool session does not own scope')
        active_run = getattr(self.p.queue, 'running', {}).get(scope['scope_key'])
        if not context.get('run_id') or (active_run and active_run != context['run_id']):
            raise HTTPException(403, 'Tool run is not active')
        if context.get('owner_user_id') not in (None, uid):
            raise HTTPException(403, 'Tool owner does not match active job')
        if tool in {'browser', 'schedule', 'tasks'} and (scope['kind'] != 'agent' or scope['scope_type'] != 'private'):
            raise HTTPException(403, 'This tool is available only to personal AI')
        if tool == 'mcp':
            return await self.p.mcp.gateway.handle(user, scope, action, args, context, disconnected or self.never)
        if tool == 'browser':
            return result(await self.action(uid, action, args))
        if tool == 'tasks':
            async def never():
                return False
            return await self.p.tasks.gateway(user, action, args, context, disconnected or never)
        if tool == 'schedule':
            from .schedules import dispatch
            return result(await dispatch(self.p, action, args, user))
        if tool == 'artifacts':
            return await self.p.artifacts.gateway(user, scope, action, args, job_id)
        if tool == 'skills':
            if scope['kind'] != 'agent':
                raise HTTPException(403, 'This tool is available only to personal and channel AI')
            return await self.p.skills.gateway(user, scope, action, args)
        if tool != 'web':
            raise HTTPException(404, 'Unknown tool')
        return await self.web(action, args, uid)

    async def web(self, action, args, user_id):
        if action == 'search':
            return await self.search(args)
        if action == 'fetch':
            try:
                max_chars = max(1, min(int(args.get('max_chars', 100000)), 500000))
            except (TypeError, ValueError) as exc:
                raise HTTPException(400, 'max_chars must be an integer') from exc
            return await fetch(args.get('url', ''), max_chars, lambda url: self.pages.render(user_id, url))
        raise HTTPException(400, 'Unsupported web action')

    async def search(self, args):
        query = args.get('query', '')
        if not isinstance(query, str) or not query.strip() or len(query) > 4096:
            raise HTTPException(400, 'Search query must contain 1–4096 characters')
        try:
            limit = max(1, min(int(args.get('limit', 5)), 100))
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, 'limit must be an integer') from exc
        data = {'query': query, 'web': [], 'source': 'managed_search', 'unresponsive': []}
        engines = self.p.settings.searxng_engines
        params = {'q': query, 'format': 'json', 'timeout_limit': SEARCH_ENGINE_SECONDS, 'safesearch': SAFE_SEARCH,
                  **({'engines': ','.join(engines)} if engines else {'categories': 'general'})}
        try:
            async with asyncio.timeout(SEARCH_SECONDS), self.p.http.stream('GET', self.p.settings.searxng_url.rstrip('/') + '/search',
                                                                           params=params, timeout=SEARCH_SECONDS) as response:
                if response.status_code >= 400:
                    raise WebFailure(502, f'SearXNG answered HTTP {response.status_code}', 'http_error')
                body = await read_capped(response, 2 * 1024 * 1024, 'Search response exceeds 2 MiB')
            search = json.loads(body)
            if not isinstance(search, dict):
                raise ValueError('SearXNG answered an unexpected value')
        except (httpx.HTTPError, TimeoutError, ValueError, WebFailure) as exc:
            log.warning('Web search failed: %r', exc)
            return {'content': 'Web search is unavailable right now: the search service did not answer. Try again in a moment, '
                               'or open known sources directly with web_fetch.', 'data': data, 'is_error': True}
        for entry in search.get('unresponsive_engines') or []:
            if isinstance(entry, (list, tuple)) and len(entry) >= 2 and len(data['unresponsive']) < 20:
                data['unresponsive'].append({'engine': str(entry[0])[:100], 'reason': str(entry[1])[:200]})
        found = search.get('results')
        candidates = [item for item in (found if isinstance(found, list) else [])[:100] if isinstance(item, dict) and isinstance(item.get('url'), str)]
        rows = data['web']
        batch = max(limit, 10)
        # Every result must point at a public address; the lookups run a batch at a time, each bounded.
        for start in range(0, len(candidates), batch):
            group = candidates[start:start + batch]
            for item, public in zip(group, await asyncio.gather(*(searchable(item['url']) for item in group))):
                if public and len(rows) < limit:
                    rows.append({'title': str(item.get('title') or '')[:300], 'url': item['url'],
                                 'description': str(item.get('content') or '')[:1000], 'position': len(rows) + 1})
            if len(rows) >= limit:
                break
        content = json.dumps({'web': rows, 'source': 'managed_search'}, ensure_ascii=False)
        if not rows:
            unavailable = ', '.join(f"{entry['engine']} ({entry['reason']})" for entry in data['unresponsive'])
            content += ('\n\nNo search results came back for this query.' + (f' Unavailable search engines: {unavailable}.' if unavailable else '')
                        + ' Try a shorter query, different keywords or another language rather than repeating it.')
        return {'content': content, 'data': data, 'is_error': False}


def holder(request, body):
    value = body.get('holder_id')
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise HTTPException(400, 'holder_id is required')
    return session_identity(request) + ':' + value


async def internal(request):
    require_internal(request)
    body = await body_json(request)
    try:
        platform = request.app.state.platform
        tool, action = request.path_params['tool'], body.get('action')
        # `wait` is a long poll inside an active run, which already blocks maintenance; it holds no admission.
        admission = nullcontext() if tool == 'tasks' and action == 'wait' else platform.gate.admit()
        async with admission:
            return JSONResponse(await platform.browser.gateway(tool, action, body.get('arguments', {}), body.get('context', {}), request.is_disconnected))
    except httpx.HTTPError as exc:
        raise HTTPException(502, 'Tool upstream request failed') from exc
    except TimeoutError as exc:
        raise HTTPException(504, 'Tool request timed out') from exc


async def browser_ui(request):
    user = require_permission(request, 'private_agent')
    browser = request.app.state.platform.browser
    uid = user['id']
    if request.url.path.endswith('/lease'):
        body = await body_json(request)
        identity = holder(request, body)
        async with browser.lock(uid):
            if request.method == 'DELETE':
                browser.check(uid, identity)
                browser.leases.pop(uid, None)
                return JSONResponse({'ok': True})
            return JSONResponse({'lease': browser.acquire(uid, identity)})
    if request.url.path.endswith('/action'):
        body = await body_json(request)
        data = await browser.action(uid, body.get('action'), body.get('arguments', {}), holder(request, body))
        return JSONResponse(result(data))
    if request.url.path.endswith('/screenshot'):
        tab = request.query_params.get('tab_id', '')
        if not tab:
            raise HTTPException(400, 'tab_id is required')
        data = await browser.request(uid, 'GET', '/tabs/' + quote(tab, safe='') + '/screenshot', {'fullPage': 'false'}, binary=True)
        return Response(data, media_type='image/png', headers={'Cache-Control': 'no-store'})
    data = await browser.request(uid, 'GET', '/tabs')
    return JSONResponse({'tabs': data.get('tabs', []) if isinstance(data, dict) else data, 'lease': browser.public_lease(uid)})


def routes():
    return [Route('/internal/agent/tools/{tool}', internal, methods=['POST']),
            Route('/api/browser', browser_ui), Route('/api/browser/action', browser_ui, methods=['POST']),
            Route('/api/browser/lease', browser_ui, methods=['POST', 'DELETE']), Route('/api/browser/screenshot', browser_ui)]
