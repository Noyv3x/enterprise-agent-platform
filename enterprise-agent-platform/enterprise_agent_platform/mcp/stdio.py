"""A custom SDK transport that carries newline-delimited JSON-RPC to a stdio MCP server in the owner's personal sandbox.

Manager supervises the process and keeps stdout frames in memory until acknowledged; this module only drives its
executor routes: `mcp/start`, `mcp/send`, `mcp/stop` (receipt-bound) and `mcp/recv` (owner-checked long poll)."""
from __future__ import annotations

import asyncio
import logging
import uuid

import anyio
import mcp_types as types
from mcp.shared.message import SessionMessage

from ..gates import ManagerClientError, ManagerResponseUncertainError, manager_request
from .models import McpError

log = logging.getLogger(__name__)

RECV_WAIT_MS = 25_000
RECV_MAX_BYTES = 4 * 1024 * 1024
RECV_RETRIES = 4
MAX_MESSAGE_BYTES = 1024 * 1024


class ManagerChannel:
    """Receipt-bound start/send/stop and acknowledged recv against Manager's executor API."""

    def __init__(self, platform):
        self.p = platform

    def _call(self, user_id, connector_id, action, arguments):
        sandbox = self.p.tasks.scope(user_id)['sandbox']
        return {'run_id': f'platform-mcp-{connector_id}', 'scope_id': f'private:{user_id}',
                'lifecycle_id': sandbox['lifecycle_id'], 'tool_call_id': str(uuid.uuid4()),
                'execution_context': {'sandbox_id': sandbox['sandbox_id'], 'workspace_id': sandbox['workspace_id'], 'profile': sandbox['profile']},
                'target': 'sandbox', 'action': action, 'arguments': arguments}

    async def _executor(self, path, body, timeout=10):
        return await manager_request(self.p, 'POST', '/v1/executor/' + path, body, executor=True, timeout=timeout)

    async def _receipt(self, user_id, connector_id, action, arguments, timeout=30):
        """One audited operation; an uncertain outcome is raised, never retried."""
        call = self._call(user_id, connector_id, action, arguments)
        receipt = await self._executor('audit', {**call, 'audit_id': str(uuid.uuid4()), 'operation': 'mcp', 'details': {}})
        return await self._executor(f'mcp/{action}', {**call, 'audit_id': receipt['audit_id'], 'executor_id': receipt['executor_id']}, timeout=timeout)

    async def start(self, user_id, connector_id, command, args, cwd, env):
        result = await self._receipt(user_id, connector_id, 'start',
                                     {'connector_id': str(connector_id), 'command': command, 'args': args, 'cwd': cwd, 'env': env}, timeout=60)
        connection_id = result.get('connection_id')
        if not isinstance(connection_id, str) or not connection_id:
            raise ManagerResponseUncertainError('manager returned no connection id; outcome is uncertain')
        return connection_id

    async def send(self, user_id, connector_id, connection_id, message):
        return await self._receipt(user_id, connector_id, 'send', {'connection_id': connection_id, 'message': message})

    async def stop(self, user_id, connector_id, connection_id):
        return await self._receipt(user_id, connector_id, 'stop', {'connection_id': connection_id}, timeout=40)

    async def recv(self, user_id, connection_id, ack, wait_ms=RECV_WAIT_MS):
        try:
            return await self._executor('mcp/recv', {'connection_id': connection_id, 'owner': f'private:{user_id}', 'ack': ack,
                                                     'wait_ms': wait_ms, 'max_bytes': RECV_MAX_BYTES}, timeout=int(wait_ms / 1000) + 15)
        except ManagerClientError as exc:
            if exc.upstream_status == 404:
                # Unknown, foreign or forgotten (a Manager restart keeps no state): the server is gone.
                return {'messages': [], 'next': ack, 'state': 'exited', 'reason': 'manager_restarted'}
            raise


class ManagerStdioTransport:
    """The SDK `Transport`: an async context manager yielding `(read_stream, write_stream)`.

    A frame is acknowledged to Manager only after the session accepted it, so delivery is lossless across retries.
    `reason` explains why the connection ended; `closed` is set once the server is gone."""

    def __init__(self, channel, *, user_id, connector_id, command, args, cwd, env):
        self.channel, self.user_id, self.connector_id = channel, user_id, connector_id
        self.launch = (command, list(args), cwd, dict(env))
        self.connection_id = None
        self.reason = ''
        self.closed = asyncio.Event()
        self._stack = None

    async def __aenter__(self):
        command, args, cwd, env = self.launch
        try:
            self.connection_id = await self.channel.start(self.user_id, self.connector_id, command, args, cwd, env)
        except ManagerClientError as exc:
            self.closed.set()
            raise McpError(502, 'stdio_start_failed', 'Could not start the local server' + (f' (Manager HTTP {exc.upstream_status})' if exc.upstream_status else '')) from exc
        self._reader_out, read_stream = anyio.create_memory_object_stream[SessionMessage | Exception](0)
        write_stream, self._writer_in = anyio.create_memory_object_stream[SessionMessage](0)
        self._tg = anyio.create_task_group()
        await self._tg.__aenter__()
        self._tg.start_soon(self._reader)
        self._tg.start_soon(self._writer)
        self._streams = (read_stream, write_stream)
        return read_stream, write_stream

    async def _reader(self):
        ack = 0
        failures = 0
        try:
            async with self._reader_out:
                while True:
                    try:
                        batch = await self.channel.recv(self.user_id, self.connection_id, ack)
                        failures = 0
                    except (ManagerClientError, OSError) as exc:
                        # recv with the same ack is idempotent, so a transient failure is retried.
                        failures += 1
                        if failures > RECV_RETRIES:
                            self.reason = 'channel_failed'
                            log.warning('MCP recv failed for connector %s: %s', self.connector_id, type(exc).__name__)
                            return
                        await asyncio.sleep(min(2 ** failures * 0.25, 4))
                        continue
                    for item in batch.get('messages', []):
                        try:
                            message = types.jsonrpc_message_adapter.validate_json(item['data'], by_name=False)
                            await self._reader_out.send(SessionMessage(message))
                        except ValueError as exc:
                            await self._reader_out.send(exc)
                        except (anyio.ClosedResourceError, anyio.BrokenResourceError):
                            return
                        ack = item['seq']
                    if batch.get('state', 'running') != 'running':
                        self.reason = batch.get('reason') or batch['state']
                        return
        except (anyio.ClosedResourceError, anyio.BrokenResourceError):
            pass
        finally:
            self.closed.set()

    async def _writer(self):
        try:
            async with self._writer_in:
                async for session_message in self._writer_in:
                    data = session_message.message.model_dump_json(by_alias=True, exclude_unset=True)
                    if len(data.encode()) > MAX_MESSAGE_BYTES:
                        raise McpError(413, 'message_too_large', 'MCP message exceeds 1 MiB')
                    await self.channel.send(self.user_id, self.connector_id, self.connection_id, data)
        except (anyio.ClosedResourceError, anyio.BrokenResourceError):
            pass
        except (ManagerClientError, McpError) as exc:
            # A send that may have been delivered is never replayed: the connection ends instead.
            self.reason = 'send_uncertain' if isinstance(exc, ManagerResponseUncertainError) else 'send_failed'
            self.closed.set()
            await self._reader_out.aclose()

    async def __aexit__(self, *exc):
        with anyio.CancelScope(shield=True):
            self._streams[0].close()
            self._streams[1].close()
            try:
                await asyncio.wait_for(self.channel.stop(self.user_id, self.connector_id, self.connection_id), 45)
            except (ManagerClientError, OSError, TimeoutError):
                log.warning('MCP stop was not confirmed for connector %s', self.connector_id)
            self._tg.cancel_scope.cancel()
            self.closed.set()
        # The task group was entered by this task and must be exited outside the shield.
        await self._tg.__aexit__(None, None, None)
        return None

