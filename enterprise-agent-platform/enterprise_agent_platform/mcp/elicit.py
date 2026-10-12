"""Pending elicitations: server requests for user input, shown as forms or links in the conversation.

The registry is in memory; a Platform restart ends the call that waited, so nothing is answered later. A timeout is a
cancel and nothing is ever accepted automatically. Only the user who triggered the run may answer."""
from __future__ import annotations

import asyncio
import contextvars
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlsplit

import jsonschema
import mcp_types as types

from .models import ELICITATION_SECONDS, McpError

CURRENT_CALL = contextvars.ContextVar('mcp_call', default=None)


@dataclass
class CallContext:
    """One in-flight tool call: who triggered it and which conversation scope shows its prompts."""
    user_id: int
    scope_key: str
    connector: dict
    tool: str
    run_id: str = ''
    started: float = field(default_factory=time.monotonic)
    paused: float = 0.0
    waiting_since: float | None = None
    interactive: bool = True

    def pause_total(self):
        """Seconds spent waiting for the user; they do not count against the call timeout."""
        return self.paused + (time.monotonic() - self.waiting_since if self.waiting_since is not None else 0.0)


@dataclass
class Pending:
    id: str
    user_id: int
    scope_key: str
    mode: str
    schema: dict | None
    future: asyncio.Future
    call: CallContext


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def _public_url(url):
    parts = urlsplit(url)
    return parts.scheme in ('http', 'https') and bool(parts.hostname) and not parts.username and not parts.password


class Elicitations:
    def __init__(self, service):
        self.svc = service
        self.pending = {}
        self.timeout = ELICITATION_SECONDS

    def _emit(self, scope_key, event):
        self.svc.p.queue.emit(scope_key, event)

    def callback_for(self, connection):
        """The SDK elicitation callback of one connection (legacy requests and modern `input_required` rounds)."""
        async def callback(context, params):
            call = self.current(connection)
            if call is None or not call.interactive:
                return types.ErrorData(code=types.INVALID_REQUEST, message='Elicitation is only supported during a tool call')
            return await self.ask(call, params)
        return callback

    @staticmethod
    def current(connection):
        call = CURRENT_CALL.get()
        if call is not None and call in connection.active:
            return call
        # The transport's reader task has no caller context. Attribute the request only when it is unambiguous.
        if connection.active and len({item.user_id for item in connection.active}) == 1:
            return connection.active[0]
        return None

    async def ask(self, call, params):
        mode = 'url' if isinstance(params, types.ElicitRequestURLParams) else 'form'
        if mode == 'url' and not _public_url(params.url):
            return types.ErrorData(code=types.INVALID_PARAMS, message='Elicitation URL must be http(s)')
        pending = Pending(secrets.token_urlsafe(16), call.user_id, call.scope_key, mode,
                          params.requested_schema if mode == 'form' else None, asyncio.get_running_loop().create_future(), call)
        self.pending[pending.id] = pending
        connector = call.connector
        event = {'type': 'mcp_elicitation', 'id': pending.id, 'user_id': call.user_id,
                 'connector': {'id': connector['id'], 'name': connector['name'], 'label': connector['label'] or connector['name']},
                 'mode': mode, 'message': params.message, 'expires_at': _iso(time.time() + self.timeout)}
        if mode == 'form':
            event['schema'] = pending.schema
        else:
            event['url'] = params.url
        self._emit(call.scope_key, event)
        begun, reason, action, content = time.monotonic(), None, 'cancel', None
        call.waiting_since = begun
        try:
            action, content = await asyncio.wait_for(asyncio.shield(pending.future), self.timeout)
        except asyncio.TimeoutError:
            action, content, reason = 'cancel', None, 'timeout'
        except asyncio.CancelledError:
            action, content, reason = 'cancel', None, 'cancelled'
            raise
        finally:
            call.paused += time.monotonic() - begun
            call.waiting_since = None
            self.pending.pop(pending.id, None)
            self._emit(call.scope_key, {'type': 'mcp_elicitation_resolved', 'id': pending.id, 'action': action if reason != 'cancelled' else 'cancel',
                                        **({'reason': reason} if reason else {})})
        return types.ElicitResult(action=action, content=content if action == 'accept' and mode == 'form' else None)

    def answer(self, user, elicitation_id, action, content):
        pending = self.pending.get(elicitation_id)
        if pending is None or pending.future.done():
            raise McpError(404, 'elicitation_gone', 'This request has expired or was already answered')
        if pending.user_id != user['id']:
            raise McpError(403, 'elicitation_forbidden', 'Only the user who started this run can answer')
        if action not in ('accept', 'decline', 'cancel'):
            raise McpError(400, 'elicitation_invalid', 'action must be accept, decline or cancel')
        if action == 'accept' and pending.mode == 'form':
            if not isinstance(content, dict):
                raise McpError(400, 'elicitation_invalid', 'content must be an object')
            try:
                jsonschema.validate(content, pending.schema)
            except jsonschema.ValidationError as exc:
                raise McpError(400, 'elicitation_invalid', f'Invalid answer: {exc.message[:200]}') from None
            except jsonschema.SchemaError:
                pass
        else:
            content = None
        pending.future.set_result((action, content))

    def cancel_call(self, call):
        """A finished or abandoned call leaves no card waiting."""
        for pending in list(self.pending.values()):
            if pending.call is call and not pending.future.done():
                pending.future.set_result(('cancel', None))
