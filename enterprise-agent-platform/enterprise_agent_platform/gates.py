"""Manager's idle boundary and single-attempt Unix socket client."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import re
import secrets

import httpx
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route

MAX_MANAGER_RESPONSE_BYTES = 8 * 1024 * 1024


class ManagerClientError(HTTPException):
    def __init__(self, detail):
        super().__init__(502, detail)


class ManagerResponseUncertainError(ManagerClientError):
    """The request may have taken effect; never automatically replay it."""


def _token(platform):
    try:
        token = platform.settings.manager_token_file.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as exc:
        raise ManagerClientError("manager token is unavailable") from exc
    if not token or any(c in token for c in "\r\n\x00"):
        raise ManagerClientError("manager token file is empty or invalid")
    return token


class Gate:
    def __init__(self, platform):
        self.platform = platform
        self.reserved: str | None = None
        self.last_committed: str | None = None
        self.admissions = 0
        self.closing = False
        self.lock = asyncio.Lock()

    async def restore(self):
        """Recover the Manager's authoritative boundary before starting workers."""
        status = await manager_request(self.platform, "GET", "/v1/status")
        async with self.lock:
            if type(status.get("maintenance")) is not bool or "gate_settlement" not in status:
                raise ManagerClientError("manager status is missing maintenance or Gate settlement")
            ids = []
            for field in ("active_operation_id", "finalize_pending_operation_id", "operation_id"):
                value = status.get(field, "")
                if value is None:
                    value = ""
                if not isinstance(value, str) or any(c in value for c in "\r\n\x00"):
                    raise ManagerClientError("manager operation identity is invalid")
                ids.append(value.strip())
            active, finalize, public = ids
            if (active and finalize) or (finalize and not status["maintenance"]):
                raise ManagerClientError("manager operation slots are inconsistent")
            settlement = status["gate_settlement"]
            if settlement is not None:
                current = status.get("current")
                if (
                    not isinstance(settlement, dict)
                    or set(settlement) != {"schema_version", "operation_id", "action"}
                    or type(settlement.get("schema_version")) is not int
                    or settlement["schema_version"] != 1
                    or not isinstance(settlement.get("operation_id"), str)
                    or not re.fullmatch(r"op_[0-9a-f]{32}", settlement["operation_id"])
                    or settlement.get("action") not in ("commit", "abort")
                    or not status["maintenance"] or status.get("public_state") != "updating"
                    or active or finalize != settlement["operation_id"] or public != finalize
                    or status.get("target") is not None or not isinstance(current, dict)
                    or not isinstance(current.get("id"), str)
                    or not re.fullmatch(r"[0-9a-f]{40}", current["id"])
                    or current.get("source_commit") != current["id"]
                ):
                    raise ManagerClientError("manager Gate settlement is inconsistent")
                self.reserved = None
                self.last_committed = finalize if settlement["action"] == "commit" else None
            elif status["maintenance"]:
                if not (active or finalize) or public != (active or finalize):
                    raise ManagerClientError("manager maintenance operation identity is inconsistent")
                self.reserved = active or finalize
                self.last_committed = None
            else:
                self.reserved = None

    @asynccontextmanager
    async def admit(self):
        async with self.lock:
            if self.reserved or self.closing:
                raise HTTPException(503, "platform is reserved for maintenance")
            self.admissions += 1
        try:
            yield
        finally:
            # No suspension: cancellation must not leak an admission count.
            self.admissions -= 1

    def _blockers(self):
        with self.platform.db.connect() as conn:
            counts = dict(conn.execute(
                "SELECT status, COUNT(*) FROM durable_jobs "
                "WHERE kind = 'agent' AND status IN ('queued', 'running') GROUP BY status"
            ).fetchall())
        return {
            "reserved": False,
            "active_agent_tasks": self.platform.queue.active,
            "active_learning_reviews": 0,
            "queued_agent_jobs": counts.get("queued", 0),
            "running_agent_jobs": counts.get("running", 0),
            "admissions_in_progress": self.admissions,
            "blocker_error": "",
        }

    async def readiness(self, operation_id):
        operation_id = operation_id.strip()
        if not operation_id:
            raise HTTPException(400, "update_id is required")
        async with self.lock:
            result = self._blockers()
            if self.reserved:
                result["reserved"] = self.reserved == operation_id
                if not result["reserved"]:
                    result["blocker_error"] = "another update already owns the platform"
            elif self.closing:
                result["blocker_error"] = "service is shutting down"
            elif not any(result[key] for key in (
                "active_agent_tasks", "queued_agent_jobs", "running_agent_jobs",
                "admissions_in_progress",
            )):
                self.reserved = operation_id
                self.last_committed = None
                result["reserved"] = True
            return result

    async def health(self):
        async with self.lock:
            return {
                "status": "ok",
                "schema_version": self.platform.db.schema_version(),
                "update_reserved": bool(self.reserved),
                **self._blockers(),
            }

    async def release(self, operation_id, *, commit):
        operation_id = operation_id.strip()
        async with self.lock:
            if operation_id and not self.reserved:
                if not commit or operation_id == self.last_committed:
                    return {"released": True}
            if not operation_id or self.reserved != operation_id:
                raise HTTPException(409, "maintenance reservation does not match the Manager operation")
            if commit:
                # Publish before admitting work. A failed migration leaves ownership held.
                self.platform.db.migrate(self.platform.settings.data_dir)
                self.last_committed = operation_id
            self.reserved = None
            self.platform.queue.resume()
            return {"released": True}


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


async def _manager_endpoint(request):
    platform = request.app.state.platform
    try:
        expected = _token(platform)
    except ManagerClientError:
        expected = ""
    supplied = request.headers.get("authorization", "")
    if not expected or not secrets.compare_digest(
        supplied.encode("utf-8"), f"Bearer {expected}".encode("utf-8")
    ):
        raise HTTPException(401, "invalid manager token")
    if request.method == "GET":
        return JSONResponse(await platform.gate.health())
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 65536:
            raise HTTPException(413, "manager request is too large")
    try:
        body = json.loads(raw, object_pairs_hook=_unique_object)
        if not isinstance(body, dict) or set(body) != {"operation_id"}:
            raise ValueError("expected operation_id")
        operation_id = body["operation_id"]
        if not isinstance(operation_id, str) or not operation_id.strip():
            raise ValueError("operation_id is required")
    except (ValueError, UnicodeError) as exc:
        raise HTTPException(400, "invalid manager request") from exc
    if request.url.path.endswith("/readiness"):
        result = await platform.gate.readiness(operation_id)
    else:
        result = await platform.gate.release(
            operation_id, commit=request.url.path.endswith("/commit-release")
        )
    return JSONResponse(result)


def routes():
    return [Route("/internal/manager/health", _manager_endpoint, methods=["GET"])] + [
        Route(f"/internal/manager/update/{action}", _manager_endpoint, methods=["POST"])
        for action in ("readiness", "commit-release", "abort-release")
    ]


async def manager_request(platform, method, path, body=None):
    if not path.startswith("/") or path.startswith("//") or any(c in path for c in "\r\n\x00"):
        raise ValueError("manager API path is invalid")
    token = _token(platform)
    transport = httpx.AsyncHTTPTransport(uds=str(platform.settings.manager_socket), retries=0)
    status = None
    try:
        async with httpx.AsyncClient(transport=transport, timeout=10, trust_env=False) as client:
            async with client.stream(
                method, "http://localhost" + path, json=body,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            ) as response:
                status = response.status_code
                successful = 200 <= status < 300
                error = ManagerResponseUncertainError if successful else ManagerClientError
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(raw) + len(chunk) > MAX_MANAGER_RESPONSE_BYTES:
                        raise error("manager response exceeded size limit; outcome is uncertain" if successful
                                    else "manager error response exceeded size limit")
                    raw.extend(chunk)
                try:
                    decoded = json.loads(raw, object_pairs_hook=_unique_object)
                    if not isinstance(decoded, dict):
                        raise ValueError("expected object")
                except (ValueError, UnicodeError) as exc:
                    raise error("manager returned invalid JSON; outcome is uncertain" if successful
                                else "manager returned invalid error JSON") from exc
                if not successful:
                    raise ManagerClientError(f"manager HTTP {status}: {str(decoded.get('error') or 'request failed')[:1024]}")
                return decoded
    except (httpx.HTTPError, OSError) as exc:
        error = ManagerClientError if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)) else ManagerResponseUncertainError
        raise error("manager request failed; outcome is uncertain" if error is ManagerResponseUncertainError
                    else "manager connection failed") from exc
