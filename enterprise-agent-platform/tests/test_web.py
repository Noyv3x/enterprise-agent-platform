"""web_fetch and web_search: failure classification against a real local HTTP server, the real-browser fallback against a
fake Camofox, its identity cleanup and limits, and the SearXNG request and empty-result note."""
import asyncio
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

import httpx
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from enterprise_agent_platform import tools
from enterprise_agent_platform.tools import Browser, PageBrowser, WebFailure, fetch

ARTICLE = ('<html><head><title>Rates held steady</title></head><body><h1>Rates held steady</h1><img src="https://cdn.example/a.png" alt="chart">'
           + '<p>The central bank kept its policy rate unchanged. ' * 60 + '</p><script>track()</script></body></html>')
SPA = '<html><head><title>App</title></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>'
PAGES = {
    '/article': (200, {'Content-Type': 'text/html; charset=utf-8', 'cf-ray': '8a1-LAX'}, ARTICLE),
    '/datadome': (401, {'Content-Type': 'text/html', 'x-datadome': 'protected', 'Server': 'DataDome'},
                  '<html><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe></body></html>'),
    '/cloudflare': (403, {'Content-Type': 'text/html', 'cf-ray': '8a1-LAX', 'Server': 'cloudflare'},
                    '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'),
    '/perimeterx': (403, {'Content-Type': 'text/html'}, '<html><head><title>Are you a robot?</title></head><body><div id="px-captcha"></div></body></html>'),
    '/akamai': (403, {'Content-Type': 'text/html', 'Server': 'AkamaiGHost'},
                '<html><head><title>Access Denied</title></head><body>You don\'t have permission to access this. Reference #18.1</body></html>'),
    '/captcha-cn': (200, {'Content-Type': 'text/html; charset=utf-8'}, '<html><head><title>安全验证</title></head><body>请完成安全验证后继续访问</body></html>'),
    '/challenge-503': (503, {'Content-Type': 'text/html', 'cf-mitigated': 'challenge'}, '<html><body>Checking your browser</body></html>'),
    '/long-captcha-mention': (200, {'Content-Type': 'text/html'}, '<html><body>' + '<p>How a captcha works, explained. </p>' * 200 + '</body></html>'),
    '/gbk': (200, {'Content-Type': 'text/html'}, '<html><head><meta charset="gbk"><title>新闻</title></head><body><p>新华社北京电</p></body></html>'),
    '/spa': (200, {'Content-Type': 'text/html'}, SPA),
    '/missing': (404, {'Content-Type': 'text/html'}, '<html><body>Not here</body></html>'),
    '/broken': (500, {'Content-Type': 'text/html', 'cf-ray': '1'}, '<html><body>Internal error</body></html>'),
    '/pdf': (200, {'Content-Type': 'application/pdf'}, '%PDF-1.7'),
    '/json': (200, {'Content-Type': 'application/json'}, '{"ok": true}'),
    # A home page whose inline JSON alone exceeds the 2 MiB conversion budget.
    '/heavy': (200, {'Content-Type': 'text/html'}, '<html><head><title>Heavy</title><script>window.__DATA__="' + 'x' * (3 * 1024 * 1024)
               + '"</script></head><body><p>Headline story of the day</p></body></html>'),
    '/x-gbk': (200, {'Content-Type': 'text/html; charset=x-gbk'}, '<html><head><meta charset="gbk"><title>新闻</title></head><body><p>新华社北京电</p></body></html>'),
    '/x-text': (200, {'Content-Type': 'text/plain; charset=x-unknown'}, 'plain words'),
    '/long-title': (200, {'Content-Type': 'text/html'}, '<html><head><title>' + 'T' * 1000 + '</title></head><body><p>Body</p></body></html>'),
    '/turnstile': (200, {'Content-Type': 'text/html', 'cf-ray': '1'},
                   '<html><head><title>Sign in</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></head>'
                   '<body><form><div class="cf-turnstile"></div><input type="hidden" id="cf-chl-widget-a1b2_response"><p>Sign in to continue</p></form></body></html>'),
    '/plain-spaces': (200, {'Content-Type': 'text/plain'}, 'start' + ' ' * 1_000_000 + '\n' + ' \n' * 200_000 + '![' * 200_000),
}


class Site(BaseHTTPRequestHandler):
    seen = []

    def do_GET(self):
        Site.seen.append({'path': self.path, 'headers': dict(self.headers)})
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', '/article')
            self.end_headers()
            return
        if self.path == '/slow':
            time.sleep(1.5)
        if self.path == '/big':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            try:
                self.wfile.write(b'a' * (8 * 1024 * 1024 + 10))
            except (BrokenPipeError, ConnectionResetError):
                pass  # the client stops reading at the cap
            return
        status, headers, body = PAGES.get(self.path, (200, {'Content-Type': 'text/html'}, ARTICLE))
        data = body.encode('gbk' if self.path in ('/gbk', '/x-gbk') else 'utf-8')
        try:
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # a client that already gave up (the timeout case)

    def log_message(self, *args):
        pass


class FakeCamofox:
    """The Camofox HTTP API as the fallback uses it; `page` is what the tab shows after navigation."""

    def __init__(self):
        self.calls = []
        self.page = {'href': None, 'title': 'Rates held steady', 'html': ARTICLE, 'challenge': False}
        self.fail = set()
        self.url = 'about:blank'
        self.delay = 0
        self.active = 0
        self.peak = 0
        self.app = Starlette(routes=[
            Route('/tabs', self.tabs, methods=['POST']), Route('/tabs/{tab}/navigate', self.navigate, methods=['POST']),
            Route('/tabs/{tab}/evaluate', self.evaluate, methods=['POST']), Route('/sessions/{user:path}', self.session, methods=['DELETE'])])

    def names(self, identity=None):
        return [call['name'] for call in self.calls if identity is None or call['user'] == identity]

    async def record(self, request, name):
        body = await request.json() if request.method == 'POST' else {}
        self.calls.append({'name': name, 'body': body, 'user': body.get('userId') or request.path_params.get('user'),
                           'auth': request.headers.get('authorization')})
        if name in self.fail:
            return JSONResponse({'error': 'boom'}, 500)

    async def tabs(self, request):
        return await self.record(request, 'create') or JSONResponse({'tabId': 'tab1'})

    async def navigate(self, request):
        failed = await self.record(request, 'navigate')
        if failed:
            return failed
        self.url = self.calls[-1]['body']['url']
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(self.delay)
        finally:
            self.active -= 1
        return JSONResponse({'ok': True})

    async def evaluate(self, request):
        expression = (await request.json())['expression']
        name = 'read' if 'outerHTML' in expression else 'state'
        failed = await self.record(request, name)
        if failed:
            return failed
        page = self.page
        if name == 'state':
            return self.answer(['complete', page['title'], 3000, page['challenge']])
        return self.answer([page['href'] or self.url, page['title'], page['html']])

    @staticmethod
    def answer(result):
        # Node's JSON escapes lone surrogates (`"\ud83d"`), which Python then decodes back into lone surrogates.
        return Response(json.dumps({'ok': True, 'result': result}), media_type='application/json')

    async def session(self, request):
        return await self.record(request, 'delete') or JSONResponse({'ok': True})


class WebFetchTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Site)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        real = tools.public_url

        async def resolve(url):
            parts = urlsplit(url) if isinstance(url, str) else None
            if parts and (parts.hostname or '').endswith('.test') and not parts.username and parts.scheme in ('http', 'https'):
                return parts, '127.0.0.1'
            return await real(url)
        self.patches = [patch.object(tools, 'public_url', resolve), patch.object(tools, 'SETTLE_POLL', 0.01), patch.object(tools, 'SETTLE_SECONDS', 1)]
        for item in self.patches:
            item.start()
        self.camofox = FakeCamofox()
        self.p = SimpleNamespace(settings=SimpleNamespace(camofox_url='http://camofox', camofox_access_key='key'),
                                 http=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.camofox.app)))
        self.pages = PageBrowser(self.p)

    async def asyncTearDown(self):
        await self.p.http.aclose()
        for item in self.patches:
            item.stop()

    def url(self, path, host='news.test'):
        return f'http://{host}:{self.port}{path}'

    def render(self, user_id=1):
        return lambda url: self.pages.render(user_id, url)

    async def test_plain_fetch_sends_browser_headers_and_returns_page_details(self):
        Site.seen.clear()
        outcome = await fetch(self.url('/redirect'), 100000, self.render())
        self.assertFalse(outcome['is_error'])
        data = outcome['data']
        self.assertEqual((data['url'], data['requested_url'], data['title'], data['via']), (self.url('/article'), self.url('/redirect'), 'Rates held steady', 'direct'))
        self.assertFalse(data['truncated'])
        self.assertIn('central bank', data['excerpt'])
        self.assertNotIn('cdn.example', data['excerpt'])
        self.assertLessEqual(len(data['excerpt']), 4000)
        content = json.loads(outcome['content'])
        self.assertEqual((content['url'], content['title']), (data['url'], 'Rates held steady'))
        self.assertIn('![chart]', content['content'])
        self.assertNotIn('track()', content['content'])
        self.assertEqual(data['chars'], len(content['content']))
        headers = Site.seen[-1]['headers']
        self.assertIn('Chrome/', headers['User-Agent'])
        self.assertEqual(headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8')
        self.assertIn('text/html', headers['Accept'])
        self.assertEqual(headers['Host'], f'news.test:{self.port}')
        self.assertEqual(self.camofox.calls, [], 'a page that opened needs no browser')
        cut = await fetch(self.url('/article'), 100)
        self.assertEqual((cut['data']['chars'], cut['data']['truncated']), (100, True))
        self.assertNotIn('requested_url', cut['data'])

    async def test_every_failure_is_classified_with_protection(self):
        cases = {
            '/datadome': ('blocked', 401, 'DataDome'), '/cloudflare': ('blocked', 403, 'Cloudflare'),
            '/perimeterx': ('blocked', 403, 'PerimeterX'), '/akamai': ('blocked', 403, 'Akamai'),
            '/captcha-cn': ('blocked', 200, 'captcha'), '/challenge-503': ('blocked', 503, 'Cloudflare'),
            '/missing': ('not_found', 404, None), '/broken': ('http_error', 500, None),
            '/pdf': ('unsupported', 200, None), '/big': ('too_large', None, None),
        }
        for path, (error, status, protection) in cases.items():
            with self.subTest(path=path):
                outcome = await fetch(self.url(path))
                self.assertTrue(outcome['is_error'])
                data = outcome['data']
                self.assertEqual((data['error'], data.get('status'), data.get('protection'), data['tried_browser']), (error, status, protection, False))
                self.assertEqual((data['url'], data['host']), (self.url(path), 'news.test'))
                self.assertIn('news.test', outcome['content'])
                if status and status >= 400:
                    self.assertIn(f'HTTP {status}', outcome['content'])
                if protection and protection != 'captcha':
                    self.assertIn(protection, outcome['content'])
        blocked = await fetch(self.url('/datadome'))
        self.assertIn('another source', blocked['content'])

    async def test_ordinary_pages_are_not_mistaken_for_challenges(self):
        for path in ('/article', '/long-captcha-mention', '/json'):
            with self.subTest(path=path):
                self.assertFalse((await fetch(self.url(path)))['is_error'])
        heavy = await fetch(self.url('/heavy'))
        self.assertIn('Headline story of the day', json.loads(heavy['content'])['content'])
        gbk = await fetch(self.url('/gbk'))
        self.assertEqual(gbk['data']['title'], '新闻')
        self.assertIn('新华社北京电', json.loads(gbk['content'])['content'])

    async def test_address_and_transport_failures(self):
        self.assertEqual((await fetch('ftp://news.test/x'))['data']['error'], 'invalid_url')
        self.assertEqual((await fetch('http://user:pw@news.test/'))['data']['error'], 'invalid_url')
        self.assertEqual((await fetch(f'http://127.0.0.1:{self.port}/article'))['data']['error'], 'forbidden')
        self.assertEqual((await fetch('http://nothing-here.invalid/'))['data']['error'], 'unreachable')
        closed = await fetch('http://closed.test:1/')
        self.assertEqual((closed['data']['error'], closed['data']['host']), ('unreachable', 'closed.test'))
        with patch.object(tools, 'DIRECT_SECONDS', 0.3):
            self.assertEqual((await fetch(self.url('/slow')))['data']['error'], 'timeout')

    async def test_blocked_page_opens_in_a_throwaway_browser_identity(self):
        outcome = await fetch(self.url('/cloudflare'), 100000, self.render())
        self.assertFalse(outcome['is_error'])
        self.assertEqual((outcome['data']['via'], outcome['data']['title']), ('browser', 'Rates held steady'))
        self.assertIn('central bank', json.loads(outcome['content'])['content'])
        identities = {call['user'] for call in self.camofox.calls}
        self.assertEqual(len(identities), 1)
        identity = identities.pop()
        self.assertTrue(identity.startswith('web-fetch:'))
        self.assertEqual(self.camofox.names()[:2], ['create', 'navigate'])
        self.assertEqual(self.camofox.names()[-2:], ['read', 'delete'])
        self.assertEqual(self.camofox.calls[1]['body']['url'], self.url('/cloudflare'))
        self.assertTrue(all(call['auth'] == 'Bearer key' for call in self.camofox.calls))
        self.assertEqual(self.pages.slots._value, 2)

    async def test_javascript_only_page_is_rendered(self):
        outcome = await fetch(self.url('/spa'), 100000, self.render())
        self.assertEqual(outcome['data']['via'], 'browser')
        self.camofox.fail = {'create'}
        fallback = await fetch(self.url('/spa'), 100000, self.render())
        self.assertFalse(fallback['is_error'], 'without a browser the plain text is still returned')
        self.assertEqual(fallback['data']['via'], 'direct')

    async def test_still_challenged_in_the_browser_is_blocked_after_trying(self):
        self.camofox.page = {'href': None, 'title': 'Just a moment...', 'challenge': True,
                             'html': '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'}
        outcome = await fetch(self.url('/datadome'), 100000, self.render())
        self.assertTrue(outcome['is_error'])
        data = outcome['data']
        self.assertEqual((data['error'], data['status'], data['tried_browser']), ('blocked', 401, True))
        self.assertEqual(data['protection'], 'Cloudflare')
        self.assertIn('real browser', outcome['content'])
        self.assertEqual(self.camofox.names()[-1], 'delete')

    async def test_identity_is_deleted_whatever_fails(self):
        for failing in ({'navigate'}, {'read'}, {'state', 'read'}, {'create'}):
            with self.subTest(failing=failing):
                self.camofox.calls.clear()
                self.camofox.fail = failing
                outcome = await fetch(self.url('/akamai'), 100000, self.render())
                self.assertTrue(outcome['is_error'])
                self.assertEqual(outcome['data']['protection'], 'Akamai')
                self.assertEqual(outcome['data']['tried_browser'], failing != {'create'})
                self.assertEqual(self.camofox.names()[-1], 'delete')
                self.assertEqual({call['user'] for call in self.camofox.calls}.__len__(), 1)
        self.camofox.calls.clear()
        self.camofox.fail = set()
        self.camofox.delay = 5
        with patch.object(tools, 'FETCH_SECONDS', 1):
            outcome = await fetch(self.url('/akamai'), 100000, self.render())
        self.assertEqual((outcome['data']['error'], outcome['data']['tried_browser']), ('blocked', True))
        self.assertIn('in time', outcome['content'])
        await asyncio.sleep(0.05)
        self.assertEqual(self.camofox.names()[-1], 'delete')
        self.assertEqual(self.pages.slots._value, 2)

    async def test_browser_concurrency_and_per_user_rate(self):
        self.camofox.delay = 0.2
        outcomes = await asyncio.gather(*(fetch(self.url('/cloudflare'), 1000, self.render(user)) for user in (1, 2, 3, 4, 5)))
        self.assertEqual(self.camofox.peak, 2)
        self.assertTrue(all(outcome['data']['via'] == 'browser' for outcome in outcomes))
        self.camofox.delay = 0
        for _ in range(tools.BROWSER_RATE - 1):
            self.assertFalse((await fetch(self.url('/cloudflare'), 1000, self.render(1)))['is_error'])
        limited = await fetch(self.url('/cloudflare'), 1000, self.render(1))
        self.assertTrue(limited['is_error'])
        self.assertFalse(limited['data']['tried_browser'])
        self.assertIn('last minute', limited['content'])
        self.assertFalse((await fetch(self.url('/cloudflare'), 1000, self.render(2)))['is_error'], 'other users keep their own budget')
        with patch.object(tools, 'BROWSER_QUEUE_SECONDS', 0.1):
            self.camofox.delay = 1
            busy = await asyncio.gather(*(fetch(self.url('/cloudflare'), 1000, self.render(user)) for user in (6, 7, 8)))
        refused = [outcome for outcome in busy if outcome['is_error']]
        self.assertEqual(len(refused), 1)
        self.assertIn('busy', refused[0]['content'])

    async def test_one_browser_fetch_per_user_at_a_time(self):
        self.camofox.delay = 0.2
        outcomes = await asyncio.gather(*(fetch(self.url('/cloudflare'), 1000, self.render(1)) for _ in range(2)))
        self.assertEqual(self.camofox.peak, 1, "a user's second fallback waits for the first")
        self.assertTrue(all(outcome['data']['via'] == 'browser' for outcome in outcomes))

    async def test_browser_pages_with_challenge_words_or_widgets_are_content(self):
        self.camofox.page = {'href': None, 'title': 'Security check: a guide for small businesses', 'challenge': True, 'html': ARTICLE}
        outcome = await fetch(self.url('/cloudflare'), 100000, self.render())
        self.assertFalse(outcome['is_error'], 'a long page is content even when the settle poll flagged its title')
        widget = ('<html><head><title>Sign in</title></head><body><form><input type="hidden" id="cf-chl-widget-a1b2_response">'
                  '<p>Sign in to continue</p></form></body></html>')
        self.camofox.page = {'href': None, 'title': 'Sign in', 'challenge': False, 'html': widget}
        self.assertFalse((await fetch(self.url('/cloudflare'), 100000, self.render(2)))['is_error'], 'an embedded Turnstile widget is no challenge')
        self.assertFalse((await fetch(self.url('/turnstile')))['is_error'])

    async def test_lone_surrogates_from_the_browser_are_replaced(self):
        self.camofox.page = {'href': None, 'title': 'Broken \ud83d title', 'challenge': False,
                             'html': ARTICLE.replace('</h1>', '</h1><p>cut pair \ud83d</p>') + '\ud83d'}
        outcome = await fetch(self.url('/cloudflare'), 100000, self.render())
        self.assertFalse(outcome['is_error'])
        json.loads(outcome['content'])
        outcome['content'].encode('utf-8')
        self.assertEqual(outcome['data']['title'], 'Broken \ufffd title')
        self.assertIn('cut pair \ufffd', json.loads(outcome['content'])['content'])

    async def test_unknown_charset_labels_and_long_titles(self):
        gbk = await fetch(self.url('/x-gbk'))
        self.assertFalse(gbk['is_error'])
        self.assertIn('新华社北京电', json.loads(gbk['content'])['content'], 'an unknown label falls back to the <meta> charset')
        plain = await fetch(self.url('/x-text'))
        self.assertEqual(json.loads(plain['content'])['content'], 'plain words')
        titled = await fetch(self.url('/long-title'))
        self.assertEqual(len(titled['data']['title']), 300)
        self.assertEqual(len(json.loads(titled['content'])['title']), 300)

    async def test_malformed_urls_are_classified(self):
        for url in ('http://news.test:99999/', 'http://[::1/', 'http://exa mple.test/'):
            with self.subTest(url=url):
                outcome = await fetch(url)
                self.assertTrue(outcome['is_error'])
                self.assertIn(outcome['data']['error'], ('invalid_url', 'unreachable'))

    async def test_a_conversion_that_overruns_is_killed_and_classified(self):
        children, environments = [], []
        spawn = asyncio.create_subprocess_exec

        async def recorded(*args, **kwargs):
            environments.append(kwargs.get('env'))
            children.append(await spawn(*args, **kwargs))
            return children[-1]
        with patch.object(tools, 'PARSE_SECONDS', 0.001), patch.object(asyncio, 'create_subprocess_exec', recorded):
            outcome = await fetch(self.url('/article'))
        self.assertEqual((outcome['data']['error'], outcome['data']['status']), ('unsupported', 200))
        self.assertIn('converted', outcome['content'])
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0].returncode, -9, 'the child was killed and reaped')
        self.assertEqual(list(environments[0]), ['PYTHONPATH'], 'the child gets no Platform environment (secrets)')
        with patch.object(tools, 'PARSE_SECONDS', 0.001):
            blocked = await fetch(self.url('/datadome'))
        self.assertEqual((blocked['data']['error'], blocked['data']['protection']), ('blocked', 'DataDome'), 'status rules still apply')

    async def test_hostile_pages_convert_quickly_without_blocking_the_loop(self):
        n = 200_000
        hostile = {
            'styles': '<html><body>' + '<style>' * n,
            'open scripts': '<html><body>' + '<script ' * n,
            'spaces': '<html><body><p>a' + ' ' * (2 * n) + 'b</p><p>' + ' \n' * n + 'c</p></body></html>',
            'pre spaces': '<html><body><pre>' + ' ' * (2 * n) + 'x' + ' ' * n + '\n</pre></body></html>',
            'image starts': '<html><body><p>' + '![' * n + '</p></body></html>',
            'nested': '<html><body>' + '<div>' * 5000 + 'deep text' + '</div>' * 5000 + '</body></html>',
        }
        gaps, running = [], True

        async def ticker():
            last = time.monotonic()
            while running:
                await asyncio.sleep(0.01)
                now = time.monotonic()
                gaps.append(now - last)
                last = now
        ticking = asyncio.create_task(ticker())
        try:
            for name, markup in hostile.items():
                with self.subTest(name=name):
                    started = time.monotonic()
                    converted = await tools.convert_page(markup.encode(), None)
                    self.assertLess(time.monotonic() - started, 5, name)
                    self.assertIsNotNone(converted, name)
                    self.assertLess(len(tools.webpage.excerpt(converted['text'], 4000)), 4001)
            self.assertIn('deep text', converted['text'])
        finally:
            running = False
            await ticking
        self.assertLess(max(gaps), 0.5, 'the event loop kept running during conversions')
        started = time.monotonic()
        for text in ('![' * n, ' ' * (4 * n) + 'x', '\n' + ' ' * (4 * n), '![' * n + '](' * n):
            tools.webpage.excerpt(text, 4000)
            tools.webpage.tidy(text)
            tools.webpage.drop_images(text)
            tools.webpage.strip_blocks(text)
        self.assertLess(time.monotonic() - started, 2, 'the linear helpers stay linear')
        spaces = await fetch(self.url('/plain-spaces'))
        self.assertFalse(spaces['is_error'])


class FakeSearx:
    def __init__(self):
        self.params = []
        self.reply = {'results': [], 'unresponsive_engines': []}
        self.status = 200
        self.app = Starlette(routes=[Route('/search', self.search)])

    async def search(self, request):
        self.params.append(dict(request.query_params))
        return JSONResponse(self.reply, self.status)


class WebSearchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.searx = FakeSearx()
        self.p = SimpleNamespace(settings=SimpleNamespace(searxng_url='http://searxng:8080', searxng_engines=('google cse', 'bing', 'sogou'),
                                                          camofox_url='http://camofox', camofox_access_key='key'),
                                 http=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.searx.app)))
        self.browser = Browser(self.p)

        async def resolve(url):
            if 'private' in url:
                raise WebFailure(400, 'Private and reserved network addresses are forbidden', 'forbidden')
            if 'slow' in url:
                await asyncio.sleep(10)
            return urlsplit(url), '93.184.216.34'
        self.patch = patch.object(tools, 'public_url', resolve)
        self.patch.start()

    async def asyncTearDown(self):
        self.patch.stop()
        await self.p.http.aclose()

    async def test_engines_are_requested_explicitly_and_results_bounded(self):
        self.searx.reply = {'results': [{'url': 'https://private.example/a', 'title': 'internal', 'content': 'x'},
                                        {'url': 'https://slow.example/', 'title': 'slow', 'content': 'x'},
                                        *({'url': f'https://site{i}.example/', 'title': 'T' * 400, 'content': 'D' * 2000} for i in range(8))],
                            'unresponsive_engines': [['sogou', 'unexpected crash']]}
        with patch.object(tools, 'LOOKUP_SECONDS', 0.2):
            outcome = await self.browser.web('search', {'query': '美联储 降息', 'limit': 3}, 1)
        params = self.searx.params[-1]
        self.assertEqual((params['q'], params['format'], params['engines']), ('美联储 降息', 'json', 'google cse,bing,sogou'))
        self.assertNotIn('categories', params)
        self.assertEqual(float(params['timeout_limit']), tools.SEARCH_ENGINE_SECONDS)
        self.assertEqual(params['safesearch'], '2')
        data = outcome['data']
        self.assertFalse(outcome['is_error'])
        self.assertEqual([row['url'] for row in data['web']], ['https://site0.example/', 'https://site1.example/', 'https://site2.example/'])
        self.assertEqual([row['position'] for row in data['web']], [1, 2, 3])
        self.assertEqual((len(data['web'][0]['title']), len(data['web'][0]['description'])), (300, 1000))
        self.assertEqual((data['query'], data['source'], data['unresponsive']), ('美联储 降息', 'managed_search', [{'engine': 'sogou', 'reason': 'unexpected crash'}]))
        self.assertEqual(json.loads(outcome['content']), {'web': data['web'], 'source': 'managed_search'})

    async def test_empty_results_are_explained(self):
        self.searx.reply = {'results': [], 'unresponsive_engines': [['google cse', 'timeout'], ['bing', 'CAPTCHA']]}
        outcome = await self.browser.web('search', {'query': 'nothing'}, 1)
        self.assertFalse(outcome['is_error'])
        self.assertEqual(outcome['data']['web'], [])
        self.assertIn('No search results came back', outcome['content'])
        self.assertIn('google cse (timeout)', outcome['content'])
        self.assertIn('bing (CAPTCHA)', outcome['content'])
        self.searx.reply = {'results': []}
        self.assertIn('No search results came back', (await self.browser.web('search', {'query': 'nothing'}, 1))['content'])

    async def test_search_service_failure_is_an_explained_error(self):
        self.searx.status = 500
        outcome = await self.browser.web('search', {'query': 'q'}, 1)
        self.assertTrue(outcome['is_error'])
        self.assertEqual(outcome['data'], {'query': 'q', 'web': [], 'source': 'managed_search', 'unresponsive': []})
        self.assertIn('unavailable', outcome['content'])

    async def test_without_configured_engines_searxng_chooses(self):
        self.p.settings.searxng_engines = ()
        await self.browser.web('search', {'query': 'q'}, 1)
        self.assertEqual(self.searx.params[-1]['categories'], 'general')
        self.assertNotIn('engines', self.searx.params[-1])


if __name__ == '__main__':
    unittest.main()
