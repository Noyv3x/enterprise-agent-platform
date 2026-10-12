"""OAuth for remote MCP connectors: the SDK `OAuthClientProvider` driven by Platform-owned storage and flows.

Tokens and registrations live in `mcp_secrets`, bound to (connector, owner, issuer); nothing here is ever returned by an
API, logged, or sent to Runtime. Normal calls use a non-interactive provider that only refreshes (once more after a 401);
a person connects through `begin` -> browser -> `callback`, which drives the SDK's authorization-code + PKCE flow from a
background task. Registration follows the contract order: stored pre-registered client, CIMD (https only), advertised
DCR, otherwise `oauth_registration_required`. Authorization servers that do not advertise S256 are refused.
"""
import asyncio
import html
import ipaddress
import json
import logging
import secrets
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx2
from mcp.client.auth.exceptions import OAuthFlowError, OAuthRegistrationError, OAuthTokenError
from mcp.client.auth.oauth2 import OAuthClientProvider
from mcp.client.auth.utils import extract_field_from_www_auth, issuers_match
from mcp.shared.auth import AuthorizationCodeResult, OAuthClientInformationFull, OAuthClientMetadata, OAuthMetadata, OAuthToken
from mcp.shared.inbound import MCP_PROTOCOL_VERSION_HEADER
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from ..auth import current_user
from .models import McpError, jloads
from .net import find_blocked

log = logging.getLogger(__name__)

CALLBACK_PATH = '/api/mcp/oauth/callback'
CLIENT_DOC_PATH = '/api/mcp/oauth/client.json'
FLOW_SECONDS = 600
BEGIN_SECONDS = 60
EXCHANGE_SECONDS = 30
PROBE_PROTOCOL = '2025-11-25'
CLIENT_NAME = 'Enterprise Agent Platform'

clock = time.monotonic  # Tests move this to age pending flows.


def loopback(host):
    if host == 'localhost' or host.endswith('.localhost'):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def safe_authorize_url(url):
    """The user's browser is sent here: https, or plain http on a loopback host only; no userinfo."""
    parts = urlsplit(url)
    try:
        parts.port
    except ValueError:
        return False
    if not parts.hostname or parts.username is not None or parts.password is not None:
        return False
    return parts.scheme == 'https' or (parts.scheme == 'http' and loopback(parts.hostname))


class Flow:
    """One pending interactive authorization, keyed by its `state` until the callback or expiry."""

    def __init__(self, connector, owner, actor):
        self.connector_id, self.owner, self.actor = connector['id'], owner, actor
        self.label = connector.get('label') or connector.get('name') or ''
        self.expires = clock() + FLOW_SECONDS
        loop = asyncio.get_running_loop()
        self.url = loop.create_future()       # the authorize URL, or the typed failure that prevented it
        self.callback = loop.create_future()  # AuthorizationCodeResult from the callback route, or an exception
        self.saved = asyncio.Event()          # tokens were persisted
        self.state = None
        self.task = None
        self.error = None


class Storage:
    """SDK `TokenStorage` for one (connector, owner). Registrations are per connector, tokens per owner and issuer."""

    def __init__(self, manager, connector_id, owner, flow=None):
        self.manager, self.cid, self.owner, self.flow = manager, connector_id, owner, flow
        self.provider = None
        self.expires_at = None
        self.preregistered_id = None

    @property
    def secrets(self):
        return self.manager.p.mcp.secrets

    # -- authorization-server metadata, kept so a refresh in a fresh process hits the verified token endpoint ----------
    def meta(self):
        row = self.secrets.get(self.cid, None, 'oauth_client', 'meta')
        if not row:
            return None
        try:
            return OAuthMetadata.model_validate_json(row[0])
        except ValueError:
            return None

    def forget_tokens(self):
        self.secrets.delete(self.cid, self.owner, 'oauth_tokens', 'tokens')

    def has_preregistered(self):
        return self.secrets.get(self.cid, None, 'oauth_client', 'client') is not None

    def bind_preregistered(self, issuer):
        row = self.secrets.get(self.cid, None, 'oauth_client', 'client')
        if row and not row[1]:
            self.secrets.put(self.cid, None, 'oauth_client', 'client', row[0], issuer)

    def usable(self, info):
        """A stored registration made for another public address (or CIMD document URL) is not ours."""
        redirects = {str(item) for item in info.redirect_uris or ()}
        if redirects and self.manager.redirect_uri() not in redirects:
            return False
        return not (info.client_id.endswith(CLIENT_DOC_PATH) and info.client_id != self.manager.client_doc_url())

    async def get_client_info(self):
        row = self.secrets.get(self.cid, None, 'oauth_client', 'client')
        if row:
            try:
                value = json.loads(row[0])
                client_id, secret = value['client_id'], value.get('client_secret') or None
            except (ValueError, KeyError, TypeError):
                return None
            self.preregistered_id = client_id
            return OAuthClientInformationFull(
                client_id=client_id, client_secret=secret, redirect_uris=[self.manager.redirect_uri()], issuer=row[1] or None,
                token_endpoint_auth_method='client_secret_basic' if secret else 'none')
        row = self.secrets.get(self.cid, None, 'oauth_client', 'dcr')
        if not row:
            return None
        try:
            info = OAuthClientInformationFull.model_validate_json(row[0])
        except ValueError:
            return None
        return info if self.usable(info) else None

    async def set_client_info(self, client_info):
        self.secrets.put(self.cid, None, 'oauth_client', 'dcr', client_info.model_dump_json(exclude_none=True), client_info.issuer or '')

    async def get_tokens(self):
        if self.flow is not None:
            return None  # An interactive connect always starts from a challenge, whatever was stored.
        row = self.secrets.get(self.cid, self.owner, 'oauth_tokens', 'tokens')
        meta = self.meta()
        if not row or meta is None or not issuers_match(row[1], str(meta.issuer)):
            return None  # Tokens issued under another issuer are never presented.
        try:
            value = json.loads(row[0])
            self.expires_at = value.get('expires_at')
            return OAuthToken.model_validate(value['tokens'])
        except (ValueError, KeyError, TypeError, AttributeError):
            return None

    async def set_tokens(self, tokens):
        metadata = self.provider.context.oauth_metadata
        if metadata is None:
            raise McpError(502, 'oauth_failed', 'Authorization server metadata is missing')
        issuer = str(metadata.issuer)
        expires_at = self.provider.context.token_expiry_time
        self.secrets.put(self.cid, self.owner, 'oauth_tokens', 'tokens', json.dumps({'tokens': tokens.model_dump(mode='json', exclude_none=True), 'expires_at': expires_at}), issuer)
        if self.flow is not None:
            self.secrets.put(self.cid, None, 'oauth_client', 'meta', metadata.model_dump_json(exclude_none=True), issuer)
            self.flow.saved.set()


class Provider(OAuthClientProvider):
    """Non-interactive when `flow` is None: only refreshes, otherwise raises `needs_auth`."""

    def __init__(self, manager, connector, owner, flow=None):
        self.manager, self.connector, self.flow = manager, connector, flow
        self.storage = Storage(manager, connector['id'], owner, flow)
        doc = manager.client_doc_url() if manager.https() else None
        super().__init__(connector['url'], manager.client_metadata(connector), self.storage,
                         redirect_handler=self._redirect if flow else None, callback_handler=self._callback if flow else None,
                         client_metadata_url=doc)
        self.storage.provider = self

    # -- interactive handlers ---------------------------------------------------------------------------------------
    async def _redirect(self, url):
        self._check_metadata(self.context.oauth_metadata)
        parts = urlsplit(url)
        query = parse_qsl(parts.query)
        scope = self.manager.scope(self.connector)
        if scope:  # Administrator-chosen scopes win over the SDK's challenge-derived selection.
            query = [(key, value) for key, value in query if key != 'scope'] + [('scope', scope)]
        state = dict(query).get('state')
        if not state:
            raise McpError(502, 'oauth_failed', 'Authorization request has no state')
        authorize_url = urlunsplit(parts._replace(query=urlencode(query)))
        if not safe_authorize_url(authorize_url):
            raise McpError(502, 'oauth_failed', 'The authorization endpoint must be https')
        self.flow.state = state
        self.manager.flows[state] = self.flow
        self.flow.url.set_result(authorize_url)

    async def _callback(self):
        remaining = max(0.0, self.flow.expires - clock())
        try:
            return await asyncio.wait_for(self.flow.callback, remaining)
        except TimeoutError:
            raise McpError(408, 'oauth_state_invalid', 'The authorization expired; connect again') from None

    # -- policy gates -----------------------------------------------------------------------------------------------
    def _check_metadata(self, metadata):
        if metadata is None or 'S256' not in (metadata.code_challenge_methods_supported or ()):
            raise McpError(400, 'oauth_pkce_unsupported', 'The authorization server does not advertise S256 PKCE support')
        info = self.context.client_info
        if info is not None and info.client_id == self.storage.preregistered_id:
            if info.issuer is None:  # Bind the administrator's client to the first issuer it is used with.
                info.issuer = str(metadata.issuer)
                self.storage.bind_preregistered(info.issuer)
            if info.client_secret:
                supported = metadata.token_endpoint_auth_methods_supported
                if supported and 'client_secret_basic' not in supported and 'client_secret_post' in supported:
                    info.token_endpoint_auth_method = 'client_secret_post'

    def _gate(self, request, outgoing):
        if self.context.oauth_metadata is not None:
            self._check_metadata(self.context.oauth_metadata)
        if outgoing is request:
            return
        if self.context.client_info is None and self.storage.has_preregistered():
            raise McpError(409, 'oauth_failed', 'The authorization server changed; the pre-registered client is bound to another issuer')
        if outgoing.method == 'GET':
            return  # Metadata discovery.
        metadata = self.context.oauth_metadata
        if metadata is None:
            raise McpError(400, 'oauth_pkce_unsupported', 'The authorization server published no metadata advertising S256 PKCE support')
        url = str(outgoing.url)
        if url == str(metadata.token_endpoint) or (metadata.registration_endpoint and url == str(metadata.registration_endpoint)):
            return
        raise McpError(409, 'oauth_registration_required', 'The authorization server offers no dynamic registration; enter a client id and secret')

    def _watch(self, outgoing, response):
        """A refresh the server rejected for good removes the stored tokens."""
        if outgoing.method == 'POST' and b'grant_type=refresh_token' in outgoing.content and response.status_code in (400, 401):
            self.storage.forget_tokens()

    def _can_refresh(self):
        info, metadata = self.context.client_info, self.context.oauth_metadata
        return (self.context.can_refresh_token() and metadata is not None
                and (info.issuer is None or issuers_match(info.issuer, str(metadata.issuer))))

    async def _initialize(self):
        await super()._initialize()
        self.context.token_expiry_time = self.storage.expires_at if self.context.current_tokens else None
        if self.flow is None:
            metadata = self.storage.meta()
            if metadata is not None:
                self.context.oauth_metadata, self.context.auth_server_url = metadata, str(metadata.issuer)

    async def _refreshed(self, outgoing, response):
        self._watch(outgoing, response)
        if await self._handle_refresh_response(response):
            return True
        self._initialized = False  # Reload from storage next time (it was removed if the grant is gone).
        return False

    # -- the flows --------------------------------------------------------------------------------------------------
    async def _auth_flow(self, request):
        inner = self._silent(request) if self.flow is None else super()._auth_flow(request)
        try:
            outgoing = await inner.__anext__()
            while True:
                if self.flow is not None:
                    self._gate(request, outgoing)
                response = yield outgoing
                if self.flow is not None:
                    self._watch(outgoing, response)
                outgoing = await inner.asend(response)
        except StopAsyncIteration:
            return
        finally:
            await inner.aclose()

    async def _silent(self, request):
        context = self.context
        async with context.lock:
            if not self._initialized:
                await self._initialize()
            context.protocol_version = request.headers.get(MCP_PROTOCOL_VERSION_HEADER)
            if not context.is_token_valid() and self._can_refresh():
                refresh = await self._refresh_token()
                await self._refreshed(refresh, (yield refresh))
            used = context.is_token_valid()
            if used:
                self._add_auth_header(request)
            response = yield request
            if response.status_code == 401 and used and self._can_refresh():  # Revoked or expired early: refresh once and retry once.
                refresh = await self._refresh_token()
                if await self._refreshed(refresh, (yield refresh)):
                    self._add_auth_header(request)
                    response = yield request
            if response.status_code == 401 or (response.status_code == 403 and extract_field_from_www_auth(response, 'error') == 'insufficient_scope'):
                raise McpError(409, 'needs_auth', 'Authorization is required; connect the connector')  # Never 401: the frontend signs the user out on that.


def failure(exc):
    """The typed error for anything that went wrong inside a flow; never carries tokens."""
    if isinstance(exc, McpError):
        return exc
    if find_blocked(exc):
        return McpError(400, 'mcp_network_blocked', str(find_blocked(exc)))
    if isinstance(exc, (OAuthFlowError, OAuthTokenError, OAuthRegistrationError)):
        return McpError(502, 'oauth_failed', str(exc).split(':')[0][:120])  # The part before any server-supplied body or value.
    if isinstance(exc, httpx2.HTTPError):
        return McpError(502, 'oauth_failed', 'The authorization server could not be reached')
    log.warning('MCP OAuth flow failed: %s', type(exc).__name__)
    return McpError(502, 'oauth_failed', 'Authorization failed')


class OAuthManager:
    def __init__(self, platform):
        self.p = platform
        self.flows = {}    # state -> Flow, expires after 10 minutes
        self.active = {}   # (connector id, owner) -> Flow

    # -- addresses --------------------------------------------------------------------------------------------------
    def base(self):
        return self.p.settings.public_base_url.rstrip('/')

    def https(self):
        return urlsplit(self.base()).scheme == 'https'

    def redirect_uri(self):
        return self.base() + CALLBACK_PATH

    def client_doc_url(self):
        return self.base() + CLIENT_DOC_PATH

    def warning(self):
        parts = urlsplit(self.base())
        return None if parts.scheme == 'https' or loopback(parts.hostname or '') else 'https_required'

    def scope(self, connector):
        oauth = connector.get('oauth') if isinstance(connector.get('oauth'), dict) else jloads(connector.get('oauth_json'), {})
        scopes = oauth.get('scopes')
        return ' '.join(scopes) if isinstance(scopes, list) else (scopes or '')

    def client_metadata(self, connector):
        return OAuthClientMetadata(
            redirect_uris=[self.redirect_uri()], response_types=['code'], grant_types=['authorization_code', 'refresh_token'],
            application_type='web', client_name=CLIENT_NAME, scope=self.scope(connector) or None)

    # -- public interface -------------------------------------------------------------------------------------------
    def auth_for(self, connector, owner_user_id):
        return Provider(self, connector, owner_user_id)

    def connected(self, connector_id, owner_user_id):
        storage = Storage(self, connector_id, owner_user_id)
        row = self.p.mcp.secrets.get(connector_id, owner_user_id, 'oauth_tokens', 'tokens')
        meta = storage.meta()
        return bool(row and meta is not None and issuers_match(row[1], str(meta.issuer)))

    async def disconnect(self, connector_id, owner_user_id):
        flow = self.active.get((connector_id, owner_user_id))
        if flow:
            self._discard(flow)
        self.p.mcp.secrets.delete(connector_id, owner_user_id, 'oauth_tokens')

    async def begin(self, connector, owner_user_id, actor_user_id):
        if self.warning():
            raise McpError(400, 'oauth_https_required', 'OAuth needs the Platform public address to be https (or loopback)')
        if not connector.get('url'):
            raise McpError(400, 'oauth_failed', 'This connector has no URL')
        self._sweep()
        key = (connector['id'], owner_user_id)
        previous = self.active.get(key)
        if previous:
            self._discard(previous)
        flow = Flow(connector, owner_user_id, actor_user_id)
        self.active[key] = flow
        provider = Provider(self, connector, owner_user_id, flow)
        flow.task = asyncio.create_task(self._run(connector, flow, provider))
        try:
            return await asyncio.wait_for(asyncio.shield(flow.url), BEGIN_SECONDS)
        except TimeoutError:
            self._discard(flow)
            raise McpError(504, 'oauth_failed', 'The authorization server did not respond') from None
        except BaseException:
            self._discard(flow)
            raise

    def routes(self):
        return [Route(CALLBACK_PATH, self.callback, methods=['GET']), Route(CLIENT_DOC_PATH, self.client_document, methods=['GET'])]

    # -- internals --------------------------------------------------------------------------------------------------
    async def _run(self, connector, flow, provider):
        """Provoke the challenge: an unauthenticated request makes the provider discover, register and ask for consent."""
        sse = connector.get('transport') == 'sse'
        request = ('GET', {'Accept': 'text/event-stream'}, None) if sse else (
            'POST', {'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json'},
            json.dumps({'jsonrpc': '2.0', 'id': 0, 'method': 'ping'}))
        try:
            async with self.p.mcp.guarded_client(self.p, auth=provider, allow_private=connector.get('scope') == 'org', endpoint=connector['url']) as client:
                async with client.stream(request[0], connector['url'], headers={**request[1], MCP_PROTOCOL_VERSION_HEADER: PROBE_PROTOCOL}, content=request[2]):
                    pass
            if not flow.url.done():
                raise McpError(409, 'oauth_failed', 'The server did not ask for authorization')
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001 - reported to the waiting caller or the callback page
            flow.error = failure(exc)
            if not flow.url.done():
                flow.url.set_exception(flow.error)
        finally:
            self._forget(flow)

    def _forget(self, flow):
        if flow.state and self.flows.get(flow.state) is flow:
            del self.flows[flow.state]
        key = (flow.connector_id, flow.owner)
        if self.active.get(key) is flow:
            del self.active[key]

    def _discard(self, flow):
        self._forget(flow)
        if flow.task and not flow.task.done():
            flow.task.cancel()
        if flow.url.done() and not flow.url.cancelled():
            flow.url.exception()  # Mark retrieved.
        if not flow.callback.done():
            flow.callback.cancel()

    def _sweep(self):
        for flow in [item for item in self.flows.values() if item.expires <= clock()]:
            self._discard(flow)

    async def callback(self, request):
        query = request.query_params
        self._sweep()
        flow = self.flows.pop(query.get('state', ''), None)  # Single use: a replay finds nothing.
        invalid = McpError(400, 'oauth_state_invalid', 'The authorization is unknown or has expired; connect again')
        if flow is None:
            return self.page(None, '', invalid)
        try:
            if current_user(request)['id'] != flow.actor:
                raise McpError(403, 'oauth_state_invalid', 'This authorization belongs to another user')
        except HTTPException as exc:
            self._discard(flow)
            return self.page(flow, flow.label, exc if isinstance(exc, McpError) else McpError(401, 'oauth_state_invalid', 'Sign in again and retry'))
        if query.get('error') or not query.get('code'):
            self._discard(flow)
            return self.page(flow, flow.label, McpError(400, 'oauth_failed', 'Authorization was denied' if query.get('error') else 'No authorization code received'))
        flow.callback.set_result(AuthorizationCodeResult(code=query['code'], state=query['state'], iss=query.get('iss')))
        saved = asyncio.ensure_future(flow.saved.wait())
        try:
            await asyncio.wait({saved, flow.task}, timeout=EXCHANGE_SECONDS, return_when=asyncio.FIRST_COMPLETED)
        finally:
            saved.cancel()
        if not flow.saved.is_set():
            error = flow.error or McpError(504, 'oauth_failed', 'The authorization server did not answer the token request')
            self._discard(flow)
            return self.page(flow, flow.label, error)
        self._discard(flow)  # The post-authorization probe is not needed.
        await asyncio.gather(flow.task, return_exceptions=True)
        try:
            await self.p.mcp.connections.invalidate(flow.connector_id, flow.owner)
        except Exception:  # noqa: BLE001 - the connection is refreshed lazily anyway
            log.warning('MCP connection invalidation failed after authorization')
        return self.page(flow, flow.label, None)

    async def client_document(self, request):
        document = {'client_id': self.client_doc_url(), 'client_name': CLIENT_NAME, 'redirect_uris': [self.redirect_uri()],
                    'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code'],
                    'token_endpoint_auth_method': 'none', 'application_type': 'web'}
        return JSONResponse(document, headers={'Cache-Control': 'public, max-age=3600'})

    def page(self, flow, label, error):
        connector = flow.connector_id if flow else None
        if error is None:
            message, payload = f'已连接 {label}，可以关闭此页', {'type': 'mcp-connected', 'connector': connector, 'label': label}
            status = 200
        else:
            message = f'连接{(" " + label + " ") if label else ""}失败：{error.detail}，请关闭此页后重试'
            payload = {'type': 'mcp-connect-failed', 'connector': connector, 'error': str(error.detail), 'code': error.code}
            status = error.status_code if error.status_code >= 400 else 400
        nonce = secrets.token_urlsafe(16)
        script = ('const m=' + json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c') + ';'
                  'try{window.opener&&window.opener.postMessage(m,location.origin)}catch(e){}'
                  "try{const c=new BroadcastChannel('mcp-oauth');c.postMessage(m);c.close()}catch(e){}"
                  'setTimeout(()=>window.close(),600)')
        body = (f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                f'<title>{html.escape(message)}</title><body style="font:16px system-ui;margin:2rem;line-height:1.6">'
                f'<p>{html.escape(message)}</p><script nonce="{nonce}">{script}</script></body></html>')
        return Response(body, status_code=status, media_type='text/html', headers={
            'Content-Security-Policy': f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; base-uri 'none'",
            'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
