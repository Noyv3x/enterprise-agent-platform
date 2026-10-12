"""Official-SDK fake MCP servers (modern 2026-07-28, legacy session, legacy HTTP+SSE) and a fake Manager stdio channel."""
import asyncio
import base64
import json
import socket
from contextlib import asynccontextmanager

import anyio
import httpx2
import mcp_types as t
import uvicorn
from mcp.server import Server
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.utilities.types import Image
from pydantic import BaseModel

PNG = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'0' * 64).decode()
FORM = {'type': 'object', 'properties': {'who': {'type': 'string'}, 'count': {'type': 'integer'}}, 'required': ['who']}


class Who(BaseModel):
    who: str


class Recorder:
    """What the fake servers observed."""

    def __init__(self):
        self.calls = []
        self.cancelled = asyncio.Event()
        self.headers = []
        self.slow_started = asyncio.Event()


def modern_server(rec):
    """A modern server (lowlevel): input_required elicitation, every result shape, prompts and resources."""
    tools = {
        'echo': t.Tool(name='echo', description='Echo the text', input_schema={'type': 'object', 'properties': {'text': {'type': 'string'}}},
                       annotations=t.ToolAnnotations(read_only_hint=True)),
        'write': t.Tool(name='write', description='Write something', input_schema={'type': 'object'}),
        'image': t.Tool(name='image', input_schema={'type': 'object'}),
        'many_images': t.Tool(name='many_images', input_schema={'type': 'object'}),
        'structured': t.Tool(name='structured', input_schema={'type': 'object'}),
        'big': t.Tool(name='big', input_schema={'type': 'object'}),
        'fail': t.Tool(name='fail', input_schema={'type': 'object'}),
        'slow': t.Tool(name='slow', input_schema={'type': 'object'}),
        'ask': t.Tool(name='ask', input_schema={'type': 'object'}),
        'ask_url': t.Tool(name='ask_url', input_schema={'type': 'object'}),
        'link': t.Tool(name='link', input_schema={'type': 'object'}),
    }

    async def list_tools(ctx, params):
        return t.ListToolsResult(tools=list(tools.values()))

    def text(value, **extra):
        return t.CallToolResult(content=[t.TextContent(text=value)], **extra)

    async def call_tool(ctx, params):
        rec.calls.append((params.name, params.arguments))
        name, answers = params.name, params.input_responses or {}
        if name == 'echo':
            return text(str((params.arguments or {}).get('text', '')))
        if name == 'write':
            return text('written')
        if name == 'image':
            return t.CallToolResult(content=[t.ImageContent(data=PNG, mime_type='image/png'), t.TextContent(text='a picture')])
        if name == 'many_images':
            return t.CallToolResult(content=[t.ImageContent(data=PNG, mime_type='image/png') for _ in range(6)])
        if name == 'structured':
            return t.CallToolResult(content=[t.TextContent(text='see data')], structured_content={'a': 1})
        if name == 'big':
            return text('x' * 300_000)
        if name == 'fail':
            return text('it broke', is_error=True)
        if name == 'link':
            return t.CallToolResult(content=[t.ResourceLink(uri='file:///x.txt', name='x'),
                                             t.EmbeddedResource(resource=t.TextResourceContents(uri='res://a', text='embedded text'))])
        if name == 'slow':
            rec.slow_started.set()
            try:
                await anyio.sleep(30)
            except BaseException:
                rec.cancelled.set()
                raise
            return text('late')
        if name == 'ask':
            if 'who' in answers:
                answer = answers['who']
                return text(f'{answer.action}:{json.dumps(answer.content)}')
            return t.InputRequiredResult(input_requests={'who': t.ElicitRequest(params=t.ElicitRequestFormParams(message='Who?', requested_schema=FORM))})
        if name == 'ask_url':
            if 'go' in answers:
                return text(f'url:{answers["go"].action}')
            return t.InputRequiredResult(input_requests={'go': t.ElicitRequest(params=t.ElicitRequestURLParams(message='Authorize', url='https://auth.example/x'))})
        raise ValueError(name)

    async def list_prompts(ctx, params):
        return t.ListPromptsResult(prompts=[t.Prompt(name='greet', description='Greet someone', arguments=[t.PromptArgument(name='name', required=True)])])

    async def get_prompt(ctx, params):
        who = (params.arguments or {}).get('name', '?')
        return t.GetPromptResult(messages=[t.PromptMessage(role='user', content=t.TextContent(text=f'Hello {who}')),
                                           t.PromptMessage(role='assistant', content=t.TextContent(text='Hi!'))])

    async def list_resources(ctx, params):
        return t.ListResourcesResult(resources=[t.Resource(uri='res://hello', name='hello', mime_type='text/plain')])

    async def read_resource(ctx, params):
        if params.uri != 'res://hello':
            raise ValueError('unknown resource')
        return t.ReadResourceResult(contents=[t.TextResourceContents(uri=params.uri, text='hello world')])

    return Server('modern', version='9', instructions='be nice', on_list_tools=list_tools, on_call_tool=call_tool, on_list_prompts=list_prompts,
                  on_get_prompt=get_prompt, on_list_resources=list_resources, on_read_resource=read_resource), tools


def legacy_server(rec):
    """A legacy (handshake-era) server: elicitation arrives as a server-to-client request."""
    server = MCPServer('legacy')

    @server.tool(annotations=t.ToolAnnotations(read_only_hint=True))
    def echo(text: str) -> str:
        rec.calls.append(('echo', {'text': text}))
        return text

    @server.tool()
    def write() -> str:
        return 'written'

    @server.tool()
    def image() -> Image:
        return Image(data=base64.b64decode(PNG), format='png')

    @server.tool()
    def structured() -> dict:
        return {'a': 1}

    @server.tool()
    def fail() -> str:
        raise ValueError('it broke')

    @server.tool()
    async def slow() -> str:
        rec.slow_started.set()
        try:
            await anyio.sleep(30)
        except BaseException:
            rec.cancelled.set()
            raise
        return 'late'

    @server.tool()
    async def ask(ctx: Context) -> str:
        answer = await ctx.elicit('Who?', Who)
        return f'{answer.action}:{getattr(answer, "data", None) and answer.data.who}'

    @server.tool()
    async def ask_url(ctx: Context) -> str:
        answer = await ctx.elicit_url('Authorize', 'https://auth.example/x', 'e1')
        return f'url:{answer.action}'

    @server.tool()
    async def changer(ctx: Context) -> str:
        await ctx.session.send_tool_list_changed()
        return 'changed'

    @server.prompt()
    def greet(name: str) -> str:
        return f'Hello {name}'

    @server.resource('res://hello')
    def hello() -> str:
        return 'hello world'

    return server


class NoDiscover:
    """Makes a dual-era app behave like a handshake-only server: `server/discover` is method-not-found."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http' and scope['method'] == 'POST':
            body, more = b'', True
            while more:
                message = await receive()
                body += message.get('body', b'')
                more = message.get('more_body', False)
            if b'server/discover' in body:
                payload = json.dumps({'jsonrpc': '2.0', 'id': json.loads(body)['id'], 'error': {'code': -32601, 'message': 'Method not found'}}).encode()
                await send({'type': 'http.response.start', 'status': 200, 'headers': [(b'content-type', b'application/json')]})
                await send({'type': 'http.response.body', 'body': payload})
                return
            replayed = False

            async def again():
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {'type': 'http.request', 'body': body, 'more_body': False}
                return await receive()
            return await self.app(scope, again, send)
        return await self.app(scope, receive, send)


class HeaderSpy:
    """Records request headers of every HTTP request (to prove credentials reach the server only from Platform)."""

    def __init__(self, app, rec):
        self.app, self.rec = app, rec

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http':
            self.rec.headers.append({k.decode(): v.decode() for k, v in scope['headers']})
        return await self.app(scope, receive, send)


@asynccontextmanager
async def serve(app):
    """Run an ASGI app on a free loopback port; yields its base URL."""
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level='critical', lifespan='on'))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        await asyncio.sleep(0.01)
    try:
        yield f'http://127.0.0.1:{sock.getsockname()[1]}'
    finally:
        server.should_exit = True
        await task


def plain_client(platform, *, auth=None, headers=None, timeout=None, follow_redirects=False, **_policy):
    """Stands in for the guarded outbound client in tests (the real one refuses loopback)."""
    return httpx2.AsyncClient(auth=auth, headers=headers, timeout=timeout if timeout is not None else httpx2.Timeout(30))


class FakeChannel:
    """A fake Manager stdio channel with an in-memory newline-delimited JSON-RPC server and Manager's ack semantics."""

    def __init__(self):
        self.starts, self.sends, self.stops, self.recvs = [], [], [], []
        self.connections = {}
        self.counter = 0
        self.fail_send = None
        self.tools = {'echo': {'name': 'echo', 'description': 'Echo', 'inputSchema': {'type': 'object'}, 'annotations': {'readOnlyHint': True}}}

    async def start(self, user_id, connector_id, command, args, cwd, env):
        self.counter += 1
        connection_id = f'mcp_{self.counter}'
        self.starts.append({'user_id': user_id, 'connector_id': connector_id, 'command': command, 'args': args, 'cwd': cwd, 'env': env})
        self.connections[connection_id] = {'seq': 0, 'queue': [], 'state': 'running', 'reason': None, 'event': asyncio.Event()}
        return connection_id

    def _push(self, connection, message):
        connection['seq'] += 1
        connection['queue'].append({'seq': connection['seq'], 'data': json.dumps(message)})
        connection['event'].set()

    async def send(self, user_id, connector_id, connection_id, message):
        if self.fail_send:
            raise self.fail_send
        self.sends.append(json.loads(message))
        connection = self.connections[connection_id]
        request = json.loads(message)
        method, ident = request.get('method'), request.get('id')
        if ident is None:
            return {'connection_id': connection_id, 'bytes': len(message)}
        if method == 'initialize':
            result = {'protocolVersion': '2025-11-25', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'stdio-fake', 'version': '1'}}
        elif method == 'tools/list':
            result = {'tools': list(self.tools.values())}
        elif method == 'tools/call':
            args = request['params'].get('arguments') or {}
            result = {'content': [{'type': 'text', 'text': f"echo:{args.get('text', '')}"}]}
        else:
            self._push(connection, {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32601, 'message': 'Method not found'}})
            return {'connection_id': connection_id, 'bytes': len(message)}
        self._push(connection, {'jsonrpc': '2.0', 'id': ident, 'result': result})
        return {'connection_id': connection_id, 'bytes': len(message)}

    async def stop(self, user_id, connector_id, connection_id):
        self.stops.append(connection_id)
        connection = self.connections[connection_id]
        connection['state'], connection['reason'] = 'exited', 'stopped'
        connection['event'].set()
        return {'connection_id': connection_id, 'state': 'exited', 'reason': 'stopped'}

    def kill(self, connection_id, reason='sandbox_stopped'):
        connection = self.connections[connection_id]
        connection['state'], connection['reason'] = 'exited', reason
        connection['event'].set()

    async def recv(self, user_id, connection_id, ack, wait_ms=25_000):
        connection = self.connections[connection_id]
        self.recvs.append(ack)
        connection['queue'] = [item for item in connection['queue'] if item['seq'] > ack]
        if not connection['queue'] and connection['state'] == 'running':
            connection['event'].clear()
            try:
                await asyncio.wait_for(connection['event'].wait(), 0.2)
            except asyncio.TimeoutError:
                pass
        messages = [item for item in connection['queue']]
        return {'messages': messages, 'next': connection['seq'] + 1, 'state': connection['state'], **({'reason': connection['reason']} if connection['reason'] else {})}
