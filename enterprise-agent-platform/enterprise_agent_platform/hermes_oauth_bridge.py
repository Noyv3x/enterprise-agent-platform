from __future__ import annotations

import json
import subprocess
from typing import Any

from .oauth_flows import OAuthFlowError


_HELPER_SCRIPT = r"""
import json
import sys


def main():
    action = sys.argv[1]
    payload = json.loads(sys.stdin.read() or "{}")
    from hermes_cli import auth as hauth

    timeout = float(payload.get("timeout_seconds") or 20.0)
    if action == "codex_start":
        result = hauth.start_codex_oauth_device_flow(timeout_seconds=timeout)
    elif action == "codex_poll":
        result = hauth.poll_codex_oauth_device_flow(
            device_auth_id=payload.get("device_auth_id", ""),
            user_code=payload.get("user_code", ""),
            timeout_seconds=timeout,
            persist=True,
        )
    elif action == "xai_start":
        result = hauth.start_xai_oauth_manual_flow(timeout_seconds=timeout)
    elif action == "xai_complete":
        result = hauth.complete_xai_oauth_manual_flow(
            callback_url=payload.get("callback_url", ""),
            flow_state=payload.get("flow_state") or {},
            timeout_seconds=timeout,
            persist=True,
        )
    elif action == "model_catalog":
        from hermes_cli.models import cached_provider_model_ids, get_default_model_for_provider, normalize_provider

        provider = normalize_provider(str(payload.get("provider") or ""))
        models = cached_provider_model_ids(provider, force_refresh=bool(payload.get("force_refresh")))
        default_model = get_default_model_for_provider(provider)
        if default_model not in models:
            default_model = models[0] if models else ""
        result = {
            "provider": provider,
            "models": models,
            "default_model": default_model,
        }
    else:
        raise RuntimeError(f"unknown Hermes OAuth bridge action: {action}")
    print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))


try:
    main()
except Exception as exc:
    print(json.dumps({
        "ok": False,
        "type": type(exc).__name__,
        "error": str(exc),
        "provider": getattr(exc, "provider", ""),
        "code": getattr(exc, "code", ""),
        "relogin_required": bool(getattr(exc, "relogin_required", False)),
    }, separators=(",", ":")))
"""


class HermesOAuthBridge:
    """Call managed Hermes's auth module from its own virtualenv.

    The platform process intentionally has a small dependency surface. Hermes
    auth uses Hermes's dependencies (notably httpx), so the bridge runs a tiny
    JSON subprocess inside the managed Hermes venv with HERMES_HOME pointed at
    the managed runtime home.
    """

    def __init__(self, runtimes: Any, *, timeout_seconds: float = 45.0):
        self.runtimes = runtimes
        self.timeout_seconds = timeout_seconds

    def available(self) -> bool:
        try:
            python = self.runtimes._hermes_venv_python()
            repo = self.runtimes._effective_hermes_repo()
        except Exception:
            return False
        return bool(python.exists() and repo.exists())

    def auth_helpers_available(self) -> bool:
        if not self.available():
            return False
        try:
            python = self.runtimes._hermes_venv_python()
            repo = self.runtimes._effective_hermes_repo()
            env = self.runtimes._hermes_process_env()
            completed = subprocess.run(
                [
                    str(python),
                    "-c",
                    (
                        "from hermes_cli import auth as a; "
                        "required = ("
                        "'start_codex_oauth_device_flow',"
                        "'poll_codex_oauth_device_flow',"
                        "'start_xai_oauth_manual_flow',"
                        "'complete_xai_oauth_manual_flow'"
                        "); "
                        "raise SystemExit(0 if all(hasattr(a, name) for name in required) else 1)"
                    ),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd=str(repo) if repo.exists() else None,
                env=env,
                timeout=5.0,
                check=False,
            )
        except Exception:
            return False
        return completed.returncode == 0

    def start(self, provider: str) -> dict[str, Any]:
        if provider == "openai-codex":
            return self._run("codex_start", {"timeout_seconds": 20.0})
        if provider == "xai-oauth":
            return self._run("xai_start", {"timeout_seconds": 20.0})
        raise OAuthFlowError(400, f"unsupported Hermes OAuth provider: {provider}")

    def poll_codex(self, session: dict[str, Any]) -> dict[str, Any]:
        return self._run(
            "codex_poll",
            {
                "device_auth_id": session.get("device_auth_id", ""),
                "user_code": session.get("user_code", ""),
                "timeout_seconds": 20.0,
            },
        )

    def complete_xai(self, session: dict[str, Any], callback_url: str) -> dict[str, Any]:
        return self._run(
            "xai_complete",
            {
                "callback_url": callback_url,
                "flow_state": session,
                "timeout_seconds": 30.0,
            },
        )

    def model_catalog(self, provider: str, *, force_refresh: bool = False) -> dict[str, Any]:
        return self._run(
            "model_catalog",
            {
                "provider": provider,
                "force_refresh": bool(force_refresh),
                "timeout_seconds": 30.0,
            },
        )

    def _run(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.available():
            raise OAuthFlowError(503, "Hermes OAuth bridge is not available")
        self.runtimes.prepare_hermes()
        python = self.runtimes._hermes_venv_python()
        repo = self.runtimes._effective_hermes_repo()
        env = self.runtimes._hermes_process_env()
        env["PYTHONUNBUFFERED"] = "1"
        try:
            completed = subprocess.run(
                [str(python), "-c", _HELPER_SCRIPT, action],
                input=json.dumps(payload),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(repo) if repo.exists() else None,
                env=env,
                timeout=self.timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise OAuthFlowError(504, f"Hermes OAuth bridge timed out during {action}") from exc
        except OSError as exc:
            raise OAuthFlowError(503, f"Hermes OAuth bridge could not start: {exc}") from exc

        stdout_lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
        if completed.returncode != 0:
            detail = completed.stderr.strip() or completed.stdout.strip() or f"exit code {completed.returncode}"
            raise OAuthFlowError(502, f"Hermes OAuth bridge failed during {action}: {detail}")
        if not stdout_lines:
            detail = completed.stderr.strip()
            raise OAuthFlowError(502, f"Hermes OAuth bridge returned no output during {action}" + (f": {detail}" if detail else ""))
        try:
            envelope = json.loads(stdout_lines[-1])
        except json.JSONDecodeError as exc:
            raise OAuthFlowError(502, f"Hermes OAuth bridge returned invalid JSON during {action}") from exc

        if envelope.get("ok"):
            result = envelope.get("result")
            if isinstance(result, dict):
                result["auth_source"] = "hermes"
                return result
            raise OAuthFlowError(502, f"Hermes OAuth bridge returned invalid result during {action}")

        message = str(envelope.get("error") or "Hermes OAuth bridge failed").strip()
        code = str(envelope.get("code") or "").strip()
        status = 400 if code in {"xai_authorization_failed", "xai_state_mismatch", "xai_code_missing"} else 502
        raise OAuthFlowError(status, message)
