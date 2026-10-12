import asyncio
import gzip
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import httpx2
from httpcore2._backends.auto import AutoBackend
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Route

from enterprise_agent_platform.mcp import net
from enterprise_agent_platform.mcp.models import McpError
from mcp_oauth_support import PUBLIC, Served, allow, fake_network, platform


async def drain(client, url, **kwargs):
    async with client.stream('GET', url, **kwargs) as response:
        return response.status_code, b''.join([chunk async for chunk in response.aiter_bytes()])


class NetworkGuardTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.p = platform(Path(self.temp.name))
        self.hosts = []
        self.own = []
        patcher = patch.object(net, 'interface_networks', lambda: self.own)
        patcher.start()
        self.addCleanup(patcher.stop)

        async def ok(request):
            self.hosts.append(request.headers['host'])
            return PlainTextResponse('hello')

        async def redirect(request):
            return RedirectResponse(request.query_params['to'], status_code=302)

        async def big(request):
            return Response(b'x' * (5 * 1024 * 1024))

        async def bomb(request):
            return Response(gzip.compress(b'\0' * (64 * 1024 * 1024)), headers={'content-encoding': 'gzip'})

        async def deflate(request):
            return Response(zlib.compress(b'tiny'), headers={'content-encoding': 'deflate'})

        def stream(size, count):
            async def endpoint(request):
                async def body():
                    for _ in range(count):
                        yield b'data: ' + b'y' * size + b'\n\n'
                return StreamingResponse(body(), media_type='text/event-stream')
            return endpoint

        async def one_event(request):
            async def body():
                yield b'data: '
                for _ in range(1100):
                    yield b'z' * 1024  # One event of 1.1 MiB, in small chunks and never terminated before the cap.
                yield b'\n\n'
            return StreamingResponse(body(), media_type='text/event-stream')

        async def silent(request):
            async def body():
                yield b'data: hi\n\n'
                await asyncio.sleep(30)
            return StreamingResponse(body(), media_type='text/event-stream')

        self.app = Starlette(routes=[Route('/ok', ok), Route('/redirect', redirect), Route('/big', big), Route('/bomb', bomb), Route('/deflate', deflate),
                                     Route('/events', stream(1000, 5 * 1024)), Route('/event-one', one_event), Route('/silent', silent),
                                     Route('/token', stream(1000, 5 * 1024)), Route('/mcp', stream(1000, 5 * 1024))])

    def tearDown(self):
        self.temp.cleanup()

    def client(self, **kwargs):
        return net.guarded_client(self.p, **kwargs)

    async def blocked(self, url, **kwargs):
        async with self.client(**kwargs) as client:
            with self.assertRaises(httpx2.HTTPError) as caught:
                await client.get(url)
        self.assertIsNotNone(net.find_blocked(caught.exception), caught.exception)

    async def test_private_and_special_addresses_are_refused_by_default(self):
        async with Served(self.app) as server:
            for url in (f'http://127.0.0.1:{server.port}/ok', f'http://localhost:{server.port}/ok', 'http://169.254.169.254/latest', 'http://[::1]/',
                        'http://[::ffff:10.0.0.1]/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://100.64.0.1/', 'http://0.0.0.0/'):
                with self.subTest(url=url):
                    await self.blocked(url)
        self.assertEqual(self.hosts, [])

    async def test_scheme_and_userinfo_are_refused(self):
        for url in ('ftp://example.com/', 'http://user:pw@example.com/', 'http://:pw@example.com/'):
            with self.subTest(url=url):
                async with self.client() as client:
                    with self.assertRaises((httpx2.HTTPError, httpx2.UnsupportedProtocol, httpx2.InvalidURL)):
                        await client.get(url)

    async def test_public_hosts_are_reached_pinned_with_the_original_host_header(self):
        async with Served(self.app) as server, fake_network(), self.client() as client:
            self.assertEqual(await drain(client, f'{server.base}/ok'), (200, b'hello'))
        self.assertEqual(self.hosts, [f'mcp.test:{server.port}'])

    async def test_the_allowlist_applies_only_to_organization_connectors(self):
        allow(self.p.db, '10.0.0.0/8')
        async with Served(self.app) as server, fake_network({'mcp.test': ['10.1.2.3']}):
            for private in (False, True):
                async with self.client(allow_private=private) as client:
                    if private:
                        self.assertEqual(await drain(client, f'{server.base}/ok'), (200, b'hello'))
                    else:
                        with self.assertRaises(httpx2.HTTPError) as caught:
                            await client.get(f'{server.base}/ok')
                        self.assertIsNotNone(net.find_blocked(caught.exception))
            with self.assertRaises(McpError):
                await net.check_url(self.p, f'{server.base}/ok')
            await net.check_url(self.p, f'{server.base}/ok', allow_private=True)

    async def test_allowlist_covers_only_what_it_names(self):
        allow(self.p.db, '10.0.0.0/8', 'internal.test')
        async with Served(self.app) as server, fake_network({'mcp.test': ['192.168.1.1']}):
            await self.blocked(f'{server.base}/ok', allow_private=True)

    async def test_allowlisted_hostname_waives_only_the_public_requirement(self):
        allow(self.p.db, 'mcp.test')
        async with Served(self.app) as server:
            with fake_network({'mcp.test': ['10.4.4.4']}):
                async with self.client(allow_private=True) as client:
                    self.assertEqual(await drain(client, f'{server.base}/ok'), (200, b'hello'))
            for address in ('127.0.0.1', '127.9.9.9', '::1', '169.254.169.254', '169.254.1.1', 'fd00:ec2::254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '::ffff:127.0.0.1', '240.0.0.1'):
                with self.subTest(address=address), fake_network({'mcp.test': [address]}):
                    await self.blocked(f'{server.base}/ok', allow_private=True)
            with fake_network({'mcp.test': ['10.4.4.4', '127.0.0.1']}):  # One bad answer refuses the lot.
                await self.blocked(f'{server.base}/ok', allow_private=True)

    async def test_allowlisted_cidrs_never_reach_loopback_link_local_or_metadata(self):
        allow(self.p.db, '0.0.0.0/0', '::/0', '127.0.0.0/8', '169.254.0.0/16')
        for url in ('http://127.0.0.1:9/', 'http://[::1]:9/', 'http://169.254.169.254/latest/meta-data', 'http://169.254.170.2/', 'http://[fd00:ec2::254]/'):
            with self.subTest(url=url):
                await self.blocked(url, allow_private=True)

    async def test_platform_service_names_and_own_subnets_are_never_reachable(self):
        allow(self.p.db, 'platform', 'agent-runtime', 'camofox', 'searxng', 'manager', 'metadata.google.internal', '10.0.0.0/8')
        self.own.append(__import__('ipaddress').ip_network('10.9.0.0/16'))
        async with Served(self.app) as server:
            for name in ('platform', 'agent-runtime', 'camofox', 'searxng', 'manager', 'metadata', 'metadata.google.internal', 'x.metadata.google.internal', 'Platform.'):
                with self.subTest(name=name), fake_network({name: ['10.1.1.1']}):
                    async with self.client(allow_private=True) as client:
                        with self.assertRaises(httpx2.HTTPError) as caught:
                            await client.get(f'http://{name}:{server.port}/ok')
                    self.assertIsNotNone(net.find_blocked(caught.exception))
            with fake_network({'mcp.test': ['10.9.1.1']}):  # Platform's own subnet, though allowlisted.
                await self.blocked(f'{server.base}/ok', allow_private=True)
            with fake_network({'mcp.test': ['10.8.1.1']}):
                async with self.client(allow_private=True) as client:
                    self.assertEqual(await drain(client, f'{server.base}/ok'), (200, b'hello'))
        self.assertEqual(self.hosts, [f'mcp.test:{server.port}'])

    async def test_wildcard_hostname_entry(self):
        policy = net.Policy.build(['*.corp.test'])
        self.assertTrue(policy.host_allowed('a.corp.test'))
        self.assertFalse(policy.host_allowed('corp.test.evil.example'))

    async def test_redirect_to_a_private_address_is_refused(self):
        allow(self.p.db, 'mcp.test')
        async with Served(self.app) as server, fake_network({'mcp.test': ['10.4.4.4']}):
            async with self.client(allow_private=True, follow_redirects=True) as client:
                with self.assertRaises(httpx2.HTTPError) as caught:
                    # The first hop is allowlisted by name; the second names an address that is never allowed.
                    await client.get(f'{server.base}/redirect?to=http://127.0.0.1:{server.port}/ok')
            self.assertIsNotNone(net.find_blocked(caught.exception))
            async with self.client(follow_redirects=True) as client:
                with self.assertRaises(httpx2.HTTPError) as caught:  # And a public first hop cannot be steered to an internal name.
                    await client.get(f'{server.base}/redirect?to=http://10.0.0.5:{server.port}/ok')
            self.assertIsNotNone(net.find_blocked(caught.exception))
        self.assertEqual(self.hosts, [])

    async def test_redirect_to_a_public_address_is_followed_and_revalidated(self):
        async with Served(self.app) as server, fake_network({'other.test': [PUBLIC]}):
            async with self.client(follow_redirects=True) as client:
                response = await client.get(f'{server.base}/redirect?to=http://other.test:{server.port}/ok')
        self.assertEqual((response.status_code, response.text), (200, 'hello'))
        self.assertEqual(self.hosts, [f'other.test:{server.port}'])

    async def test_dns_rebinding_is_pinned_to_the_checked_address(self):
        answers = [['93.184.216.34'], ['127.0.0.1']]
        resolved, connected = [], []

        async def resolve(host, port):
            resolved.append(host)
            return answers.pop(0)

        async def connect(self, host, port, timeout=None, local_address=None, socket_options=None):
            connected.append(host)
            raise httpx2.ConnectError('stop here')

        with patch.object(net, 'resolve', resolve), patch.object(AutoBackend, 'connect_tcp', connect):
            async with self.client() as client:
                with self.assertRaises(httpx2.ConnectError):
                    await client.get('http://rebind.example/ok')
        self.assertEqual((resolved, connected), (['rebind.example'], ['93.184.216.34']))

    async def test_mixed_answers_are_refused_whole(self):
        async def resolve(host, port):
            return ['93.184.216.34', '10.0.0.5']
        with patch.object(net, 'resolve', resolve):
            await self.blocked('http://mixed.example/')

    async def test_tls_keeps_the_original_server_name(self):
        seen = []

        class Stream:
            async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
                seen.append(server_hostname)
                raise httpx2.ConnectError('stop here')

            async def aclose(self):
                pass

        async def connect(self, host, port, timeout=None, local_address=None, socket_options=None):
            seen.append(host)
            return Stream()

        async def resolve(host, port):
            return ['93.184.216.34']

        with patch.object(net, 'resolve', resolve), patch.object(AutoBackend, 'connect_tcp', connect):
            async with self.client() as client:
                with self.assertRaises(httpx2.ConnectError):
                    await client.get('https://mcp.example.com/mcp')
        self.assertEqual(seen, ['93.184.216.34', 'mcp.example.com'])

    async def test_plain_responses_are_capped_at_4_mib(self):
        async with Served(self.app) as server, fake_network(), self.client(endpoint=f'{server.base}/mcp') as client:
            with self.assertRaises(net.ResponseTooLarge):
                await drain(client, f'{server.base}/big')

    async def test_compressed_responses_are_refused_so_a_bomb_cannot_expand(self):
        async with Served(self.app) as server, fake_network(), self.client() as client:
            for path in ('/bomb', '/deflate'):
                with self.subTest(path=path), self.assertRaises(net.UnsupportedEncoding):
                    await drain(client, f'{server.base}{path}')
            self.assertEqual((await client.get(f'{server.base}/ok')).text, 'hello')  # The client survives.

    async def test_event_streams_are_capped_on_non_mcp_requests_whatever_the_content_type(self):
        async with Served(self.app) as server, fake_network():
            async with self.client() as client:  # An OAuth-only client has no streaming endpoint at all.
                with self.assertRaises(net.ResponseTooLarge):
                    await drain(client, f'{server.base}/token')
            async with self.client(endpoint=f'{server.base}/mcp') as client:  # The endpoint is /mcp; /token is another request.
                with self.assertRaises(net.ResponseTooLarge):
                    await drain(client, f'{server.base}/token')
                status, body = await drain(client, f'{server.base}/mcp')  # Many small events: unbounded in total.
                self.assertEqual((status, len(body) > net.RESPONSE_CAP), (200, True))

    async def test_an_oversized_event_is_refused(self):
        async with Served(self.app) as server, fake_network(), self.client(endpoint=f'{server.base}/event-one') as client:
            with self.assertRaises(net.ResponseTooLarge):
                await drain(client, f'{server.base}/event-one')

    async def test_event_size_counts_across_chunk_boundaries_and_resets_on_blank_lines(self):
        async def run(chunks):
            async def source():
                for chunk in chunks:
                    yield chunk

            class Wrapped(httpx2.AsyncByteStream):
                def __aiter__(self):
                    return source()
            return [chunk async for chunk in net._Events(Wrapped(), 5)]

        big = b'a' * (net.SSE_EVENT_CAP // 2 + 10)
        self.assertEqual(len(await run([big + b'\r\n\r\n', big + b'\n\n', big + b'\r\r', big + b'\r', b'\n\r', b'\n' + big])), 6)
        with self.assertRaises(net.ResponseTooLarge):
            await run([big, big])
        with self.assertRaises(net.ResponseTooLarge):
            await run([big + b'\r\n', big])  # A single line terminator does not end an event.

    async def test_a_silent_event_stream_times_out(self):
        async with Served(self.app) as server, fake_network():
            client = net.guarded_client(self.p, endpoint=f'{server.base}/silent', timeout=httpx2.Timeout(30.0, read=0.3))
            async with client:
                with self.assertRaises(httpx2.ReadTimeout):
                    await drain(client, f'{server.base}/silent')

    async def test_connect_timeout_is_capped(self):
        client = self.client(timeout=httpx2.Timeout(30.0, read=300.0))
        self.assertEqual((client.timeout.connect, client.timeout.read), (10.0, 300.0))
        await client.aclose()
        client = self.client()
        self.assertEqual(client.timeout.connect, 10.0)
        await client.aclose()

    async def test_check_url_raises_the_typed_error(self):
        with self.assertRaises(McpError) as caught:
            await net.check_url(self.p, 'http://127.0.0.1:9/mcp')
        self.assertEqual(caught.exception.code, 'mcp_network_blocked')
        allow(self.p.db, '127.0.0.1')  # Loopback stays refused even when allowlisted.
        with self.assertRaises(McpError):
            await net.check_url(self.p, 'http://127.0.0.1:9/mcp', allow_private=True)
        with self.assertRaises(McpError):
            await net.check_url(self.p, 'http://u:p@example.com/')
        self.assertEqual(net.private_networks(self.p.db), ['127.0.0.1'])
