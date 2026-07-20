from __future__ import annotations

import base64
import http.client
import hashlib
import hmac
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from enterprise_agent_platform.agent_runtime_client import (
    AgentResult,
    AgentRuntimeHTTPError,
    AgentRuntimeRunError,
)
from enterprise_agent_platform.auto_update import AutoUpdateManager
from enterprise_agent_platform.update_state import clear_state
from enterprise_agent_platform.config import PlatformConfig
from enterprise_agent_platform.oauth_flows import OAuthHTTPResponse
from enterprise_agent_platform.runtimes import (
    AGENT_SETTING_COMPACTION_THRESHOLD,
    AGENT_SETTING_MAX_CONCURRENCY,
    AGENT_SETTING_MODEL,
    AGENT_SETTING_PROVIDER,
    AGENT_SETTING_TIMEOUT,
)
from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import (
    BOOTSTRAP_ADMIN_PASSWORD_FILE,
    MAX_LOGIN_FAILURES,
    EnterpriseService,
    ServiceError,
    UploadedFile,
    _ResizableConcurrencyGate,
)
from enterprise_agent_platform.telegram_gateway import TelegramGateway


class RecordingAgent:
    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class NeedsReviewAgent:
    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        raise AgentRuntimeRunError(
            "run-uncertain",
            "needs_review",
            "tool side effects may have completed",
            partial_content="partial output must not be committed",
            session_id=kwargs["session_id"],
            raw={"terminal_event": "run.needs_review"},
        )


class ApprovalRecordingAgent(RecordingAgent):
    def __init__(self):
        super().__init__()
        self.approvals = []

    def respond_approval(self, *, run_id, choice, approval_id=None):
        payload = {
            "run_id": run_id,
            "choice": choice,
            "approval_id": approval_id,
        }
        self.approvals.append(payload)
        return {**payload, "resolved": 1}


class UsageReportingAgent:
    def __init__(self, usages):
        self.usages = list(usages)
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        usage = self.usages[min(len(self.calls) - 1, len(self.usages) - 1)]
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"model": kwargs.get("model"), "usage": usage},
        )


class RotatingSessionAgent:
    def __init__(self, first_returned_session_id: str):
        self.first_returned_session_id = first_returned_session_id
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        session_id = self.first_returned_session_id if len(self.calls) == 1 else kwargs["session_id"]
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=session_id,
            raw={"ok": True},
        )


class MediaReturningAgent:
    def __init__(self, media_path: Path):
        self.media_path = media_path
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return AgentResult(
            content=f"created file\nMEDIA:{self.media_path}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class BlockingAgent:
    def __init__(self):
        self.calls = []
        self.started = threading.Event()
        self.release = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("run_started_callback"):
            kwargs["run_started_callback"]("fake-run")
        self.started.set()
        self.release.wait(timeout=5)
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class SteeringBlockingAgent:
    def __init__(self):
        self.calls = []
        self.steers = []
        self.started = threading.Event()
        self.release = threading.Event()
        self._progress_callback = None

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        self._progress_callback = kwargs.get("progress_callback")
        if kwargs.get("run_started_callback"):
            kwargs["run_started_callback"]("fake-steering-run")
        self.started.set()
        self.release.wait(timeout=5)
        return AgentResult(
            content="one consolidated response",
            session_id=kwargs["session_id"],
            raw={
                "input_message_ids": [item["message_id"] for item in self.steers],
                "unconsumed_input_message_ids": [],
            },
        )

    def steer_run(self, **kwargs):
        self.steers.append(dict(kwargs))
        if self._progress_callback:
            self._progress_callback(
                {
                    "event": "input.accepted",
                    "runtime_event_type": "input.accepted",
                    "run_id": kwargs["run_id"],
                    "message_id": kwargs["message_id"],
                }
            )
            self._progress_callback(
                {
                    "event": "input.injected",
                    "runtime_event_type": "input.injected",
                    "run_id": kwargs["run_id"],
                    "message_id": kwargs["message_id"],
                    "turn_id": f"{kwargs['run_id']}:2",
                    "turn_index": 2,
                }
            )
        return {
            "run_id": kwargs["run_id"],
            "message_id": kwargs["message_id"],
            "state": "injected",
        }


class OrderedSteeringAgent(SteeringBlockingAgent):
    def __init__(self):
        super().__init__()
        self.first_steer_started = threading.Event()
        self.release_first_steer = threading.Event()

    def steer_run(self, **kwargs):
        if kwargs["user_message"] == "second":
            self.first_steer_started.set()
            self.release_first_steer.wait(timeout=5)
        return super().steer_run(**kwargs)


class TerminalRacingRejectAgent:
    def __init__(self):
        self.calls = []
        self.started = threading.Event()
        self.release_run = threading.Event()
        self.steer_started = threading.Event()
        self.release_steer = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        if len(self.calls) == 1:
            if kwargs.get("run_started_callback"):
                kwargs["run_started_callback"]("rejecting-run")
            self.started.set()
            self.release_run.wait(timeout=5)
            return AgentResult(
                content="first response",
                session_id=kwargs["session_id"],
                raw={
                    "input_message_ids": [],
                    "unconsumed_input_message_ids": [],
                },
            )
        return AgentResult(
            content=f"fallback response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )

    def steer_run(self, **_kwargs):
        self.steer_started.set()
        self.release_steer.wait(timeout=5)
        raise AgentRuntimeHTTPError(409, "run already completed")


class RegistrationFailureAgent:
    def __init__(self):
        self.calls = []
        self.steers = []
        self.before_first_callback = threading.Event()
        self.allow_first_callback = threading.Event()
        self.first_callback_returned = threading.Event()
        self.release_first_run = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        call_number = len(self.calls)
        callback = kwargs.get("run_started_callback")
        if call_number == 1:
            self.before_first_callback.set()
            self.allow_first_callback.wait(timeout=5)
        if callback:
            callback(f"registration-run-{call_number}")
        if call_number == 1:
            self.first_callback_returned.set()
            self.release_first_run.wait(timeout=5)
        return AgentResult(
            content=f"observed response {call_number}",
            session_id=kwargs["session_id"],
            raw={
                "input_message_ids": [],
                "unconsumed_input_message_ids": [],
            },
        )

    def steer_run(self, **kwargs):
        self.steers.append(dict(kwargs))
        return {
            "run_id": kwargs["run_id"],
            "message_id": kwargs["message_id"],
            "state": "accepted",
        }


class ProgressAgent:
    def __init__(self):
        self.calls = []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        progress_callback = kwargs.get("progress_callback")
        if progress_callback:
            progress_callback(
                {
                    "event": "tool.arguments.delta",
                    "delta": '{"query":"VPN access policy"}',
                }
            )
            progress_callback(
                {
                    "event": "approval.request",
                    "approval_id": "approval-1",
                    "description": "Use the knowledge search tool",
                }
            )
            progress_callback(
                {
                    "event": "approval.responded",
                    "approval_id": "approval-1",
                    "choice": "once",
                }
            )
            progress_callback(
                {
                    "event": "tool.started",
                    "tool": "knowledge",
                    "emoji": "🔍",
                    "label": "VPN access policy",
                    "toolCallId": "call-1",
                    "status": "running",
                }
            )
            progress_callback(
                {
                    "event": "tool.completed",
                    "tool": "knowledge",
                    "toolCallId": "call-1",
                    "status": "completed",
                }
            )
        return AgentResult(
            content=f"agent response to {kwargs['user_message']}",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class FakeTelegramBot:
    def __init__(self):
        self.sent = []
        self.files_sent = []
        self.files = {}

    def send_message(self, **kwargs):
        self.sent.append(kwargs)

    def send_file(self, **kwargs):
        self.files_sent.append(kwargs)

    def get_file(self, file_id):
        return {"file_id": file_id, "file_path": self.files[file_id][0]}

    def download_file(self, file_path):
        for path, data in self.files.values():
            if path == file_path:
                return data
        raise KeyError(file_path)


class StreamingAgent:
    def __init__(self):
        self.calls = []
        self.first_delta = threading.Event()
        self.release = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        content_callback = kwargs.get("content_callback")
        if content_callback:
            content_callback("Hello ")
            self.first_delta.set()
            self.release.wait(timeout=5)
            content_callback("world")
        return AgentResult(
            content="Hello world",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class TurnAwareStreamingAgent:
    def __init__(self):
        self.new_turn_delta = threading.Event()
        self.release = threading.Event()

    def generate(self, **kwargs):
        content_callback = kwargs.get("content_callback")
        if content_callback:
            content_callback("obsolete", turn_id="stream-run:1", turn_index=1)
            content_callback(None, turn_id="stream-run:2", turn_index=2)
            content_callback("current", turn_id="stream-run:2", turn_index=2)
            self.new_turn_delta.set()
            self.release.wait(timeout=5)
        return AgentResult(
            content="current answer",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class ToolBoundaryStreamingAgent:
    def __init__(self):
        self.calls = []
        self.first_delta = threading.Event()
        self.release_tool = threading.Event()
        self.tool_started = threading.Event()
        self.release_final = threading.Event()

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        content_callback = kwargs.get("content_callback")
        progress_callback = kwargs.get("progress_callback")
        if content_callback:
            content_callback("Now browser_vision call.\n\n")
            self.first_delta.set()
        self.release_tool.wait(timeout=5)
        if progress_callback:
            progress_callback(
                {
                    "event": "tool.started",
                    "tool": "browser_vision",
                    "toolCallId": "call-1",
                    "status": "running",
                }
            )
            self.tool_started.set()
        self.release_final.wait(timeout=5)
        if content_callback:
            content_callback("好了，这次成功了。")
        return AgentResult(
            content="好了，这次成功了。",
            session_id=kwargs["session_id"],
            raw={"ok": True},
        )


class FakeProcess:
    pid = 43210

    def __init__(self):
        self.running = True

    def poll(self):
        return None if self.running else 0

    def terminate(self):
        self.running = False

    def wait(self, timeout=None):
        self.running = False
        return 0

    def kill(self):
        self.running = False


class RecordingLauncher:
    def __init__(self):
        self.calls = []
        self.processes = []

    def start(self, cmd, *, cwd, env, log_path):
        process = FakeProcess()
        self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "log_path": log_path})
        self.processes.append(process)
        return process


class RecordingCommandRunner:
    def __init__(self):
        self.calls = []

    def run(self, cmd, *, cwd, env, log_path, timeout):
        self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "log_path": log_path, "timeout": timeout})
        if len(cmd) >= 4 and cmd[1:3] == ["-m", "venv"]:
            venv_dir = Path(cmd[3])
            python = venv_dir / ("Scripts" if os.name == "nt" else "bin") / ("python.exe" if os.name == "nt" else "python")
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0)








class FakeOAuthHTTPClient:
    def __init__(self):
        self.calls = []

    def get_json(self, url, *, timeout=20.0):
        self.calls.append(("get_json", url, {}))
        return OAuthHTTPResponse(
            200,
            {
                "authorization_endpoint": "https://xai.example/authorize",
                "token_endpoint": "https://xai.example/token",
            },
        )

    def post_json(self, url, body, *, timeout=20.0):
        self.calls.append(("post_json", url, dict(body)))
        if url.endswith("/usercode"):
            return OAuthHTTPResponse(
                200,
                {
                    "user_code": "CODE-1234",
                    "device_auth_id": "device-1",
                    "interval": 1,
                    "expires_in": 900,
                },
            )
        if url.endswith("/token"):
            return OAuthHTTPResponse(200, {"authorization_code": "codex-code", "code_verifier": "codex-verifier"})
        return OAuthHTTPResponse(404, {}, "not found")

    def post_form(self, url, body, *, timeout=20.0):
        self.calls.append(("post_form", url, dict(body)))
        if url == "https://auth.openai.com/oauth/token":
            return OAuthHTTPResponse(200, {"access_token": "codex-access", "refresh_token": "codex-refresh"})
        if url == "https://xai.example/token":
            return OAuthHTTPResponse(
                200,
                {
                    "access_token": "grok-access",
                    "refresh_token": "grok-refresh",
                    "id_token": "grok-id",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
            )
        return OAuthHTTPResponse(404, {}, "not found")




def make_config(tmp: Path) -> PlatformConfig:
    return PlatformConfig(
        data_dir=tmp,
        host="127.0.0.1",
        port=0,
        public_base_url="http://127.0.0.1:0",
        token_secret="test-secret",
        token_ttl_seconds=3600,
        agent_tool_token="agent-token",
        knowledge_backend="local",
        cognee_dataset="enterprise_knowledge",
        cognee_ingest_background=True,
        cognee_repo=tmp / "cognee",
        manage_searxng=False,
        firecrawl_repo=tmp / "firecrawl",
        camofox_url="http://127.0.0.1:19377",
        firecrawl_api_url="http://127.0.0.1:13002",
        runtime_startup_wait_seconds=0,
        manage_agent_runtime=False,
        agent_runtime_url="http://127.0.0.1:8766",
        agent_runtime_token="runtime-token",
        agent_runtime_home=tmp / "runtimes" / "agent",
        agent_runtime_model="gpt-5.5",
        agent_runtime_provider="openai-codex",
        agent_runtime_timeout_seconds=2,
        allow_insecure_bootstrap_password=True,
    )




def make_fake_cognee_repo(path: Path) -> None:
    (path / "cognee").mkdir(parents=True, exist_ok=True)
    (path / "cognee" / "__init__.py").write_text(
        "class SearchType:\n    CHUNKS = 'chunks'\n",
        encoding="utf-8",
    )


def make_fake_firecrawl_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "docker-compose.yml").write_text("services:\n  api:\n    image: firecrawl\n", encoding="utf-8")


def git_run(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=True,
    )


def git_commit_all(cwd: Path, message: str) -> None:
    git_run(cwd, "add", ".")
    subprocess.run(
        ["git", "-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-m", message],
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=True,
    )


class FakeAutoUpdateConfig:
    def __init__(self, *, enabled=True, interval=30, remote="origin", branch="main"):
        self.enabled = enabled
        self.interval = interval
        self.remote = remote
        self.branch = branch

    def auto_update_enabled(self):
        return self.enabled

    def auto_update_interval_seconds(self):
        return self.interval

    def auto_update_remote(self):
        return self.remote

    def auto_update_branch(self):
        return self.branch


class FakeAutoUpdater:
    def __init__(self):
        self.triggers = []

    def status(self):
        return {"trigger_count": len(self.triggers)}

    def trigger(self, reason):
        self.triggers.append(reason)
        return self.status()

    def stop(self):
        pass


class AutoUpdateLaunchTests(unittest.TestCase):
    @staticmethod
    def _manager(root: Path, runner) -> AutoUpdateManager:
        deploy = root / "deploy.sh"
        deploy.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        deploy.chmod(0o755)
        service = FakeAutoUpdateConfig()
        service.config = SimpleNamespace(
            data_dir=root / "custom-state",
            host="0.0.0.0",
            port=9123,
        )
        return AutoUpdateManager(service, repo_root=root, runner=runner)

    def test_systemd_handoff_uses_independent_unit_and_propagates_deployment_context(self):
        calls = []

        def runner(command, **kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manager = self._manager(root, runner)
            with mock.patch(
                "enterprise_agent_platform.auto_update.shutil.which",
                side_effect=lambda name: f"/usr/bin/{name}",
            ), mock.patch.dict(
                os.environ,
                {"ENTERPRISE_SERVICE_NAME": "ubitech-custom.service", "INVOCATION_ID": "invocation"},
                clear=False,
            ):
                command = manager._launch_update_command("poll")

            self.assertEqual(command[0:3], ["systemd-run", "--user", "--collect"])
            self.assertIn("--setenv=ENTERPRISE_PLATFORM_DATA=" + str(root / "custom-state"), command)
            self.assertIn("--setenv=ENTERPRISE_SERVICE_NAME=ubitech-custom.service", command)
            self.assertIn("--setenv=ENTERPRISE_PLATFORM_HOST=0.0.0.0", command)
            self.assertIn("--setenv=ENTERPRISE_PLATFORM_PORT=9123", command)
            self.assertIn(
                f"--setenv=ENTERPRISE_AUTO_UPDATE_SOURCE_PID={os.getpid()}",
                command,
            )
            self.assertIn(
                "--setenv=ENTERPRISE_AUTO_UPDATE_SOURCE_MODE=service",
                command,
            )
            self.assertEqual(command[-10:], [
                str(root / "deploy.sh"),
                "update",
                "--data",
                str(root / "custom-state"),
                "--service-name",
                "ubitech-custom.service",
                "--host",
                "0.0.0.0",
                "--port",
                "9123",
            ])
            self.assertTrue(any(call[:3] == ["systemctl", "--user", "show-environment"] for call in calls))

    def test_systemd_handoff_failure_never_falls_back_to_service_cgroup_child(self):
        def runner(command, **kwargs):
            if command[0] == "systemd-run":
                return subprocess.CompletedProcess(command, 1, stderr="transient launch failed")
            return subprocess.CompletedProcess(command, 0)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manager = self._manager(root, runner)
            with mock.patch(
                "enterprise_agent_platform.auto_update.shutil.which",
                side_effect=lambda name: f"/usr/bin/{name}",
            ), mock.patch.dict(os.environ, {"INVOCATION_ID": "invocation"}, clear=False), mock.patch(
                "enterprise_agent_platform.auto_update.subprocess.Popen"
            ) as popen:
                with self.assertRaisesRegex(RuntimeError, "independent systemd unit"):
                    manager._launch_update_command("webhook")
            popen.assert_not_called()

    def test_systemd_handoff_requires_transient_unit_tools(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manager = self._manager(root, lambda command, **kwargs: subprocess.CompletedProcess(command, 1))
            with mock.patch(
                "enterprise_agent_platform.auto_update.shutil.which",
                return_value=None,
            ), mock.patch.dict(os.environ, {"JOURNAL_STREAM": "8:123"}, clear=False), mock.patch(
                "enterprise_agent_platform.auto_update.subprocess.Popen"
            ) as popen:
                with self.assertRaisesRegex(RuntimeError, "transient unit is unavailable"):
                    manager._launch_update_command("poll")
            popen.assert_not_called()

    def test_standalone_handoff_may_use_detached_child_with_custom_data_log(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            manager = self._manager(root, lambda command, **kwargs: subprocess.CompletedProcess(command, 1))
            clean_env = {
                key: value
                for key, value in os.environ.items()
                if key not in {"INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "ENTERPRISE_SERVICE_NAME"}
            }
            with mock.patch(
                "enterprise_agent_platform.auto_update.shutil.which",
                return_value=None,
            ), mock.patch.dict(os.environ, clean_env, clear=True), mock.patch(
                "enterprise_agent_platform.auto_update.subprocess.Popen"
            ) as popen:
                command = manager._launch_update_command("manual")

            self.assertEqual(command[:2], [str(root / "deploy.sh"), "update"])
            popen.assert_called_once()
            child_env = popen.call_args.kwargs["env"]
            self.assertEqual(
                child_env["ENTERPRISE_AUTO_UPDATE_SOURCE_PID"],
                str(os.getpid()),
            )
            self.assertEqual(
                child_env["ENTERPRISE_AUTO_UPDATE_SOURCE_MODE"],
                "foreground",
            )
            self.assertTrue((root / "custom-state" / "logs" / "auto-update.log").exists())




class PlatformServiceTests(unittest.TestCase):
    @staticmethod
    def _complete_telegram_link(
        service: EnterpriseService,
        actor: dict,
        telegram_id: str,
        username: str,
    ) -> dict:
        # Tests that exercise outbox delivery explicitly opt into the same
        # enabled state required by the production worker.
        service.set_setting("telegram_enabled", "1")
        challenge = service.update_telegram_private_config(actor, {})
        code = challenge["pending"]["code"]
        return service.complete_telegram_link(
            code,
            {"id": telegram_id, "username": username, "first_name": username},
        )

    def test_auto_update_manager_detects_remote_commit_and_skips_dirty_tree(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            remote = root / "remote.git"
            downstream = root / "downstream"
            upstream = root / "upstream"
            git_run(root, "init", "--bare", str(remote))
            downstream.mkdir()
            git_run(downstream, "init")
            git_run(downstream, "checkout", "-b", "main")
            (downstream / "README.md").write_text("initial\n", encoding="utf-8")
            deploy = downstream / "deploy.sh"
            deploy.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            deploy.chmod(0o755)
            git_commit_all(downstream, "initial")
            git_run(downstream, "remote", "add", "origin", str(remote))
            git_run(downstream, "push", "-u", "origin", "main")

            git_run(root, "clone", str(remote), str(upstream))
            git_run(upstream, "checkout", "main")
            (upstream / "README.md").write_text("updated\n", encoding="utf-8")
            git_commit_all(upstream, "updated")
            git_run(upstream, "push", "origin", "main")

            launched = []
            manager = AutoUpdateManager(
                FakeAutoUpdateConfig(branch="main"),
                repo_root=downstream,
                launcher=lambda reason: launched.append(reason) or [str(deploy), "update"],
            )
            status = manager.check_once("webhook")
            self.assertTrue(status["update_available"])
            self.assertTrue(status["update_started"])
            self.assertEqual(launched, ["webhook"])
            self.assertEqual(status["branch"], "main")
            # A successful deploy/rollback owns the durable maintenance marker;
            # emulate that handoff completion before checking the next poll.
            clear_state(manager._data_dir, update_id=status["update_id"])

            (downstream / "local-change.txt").write_text("dirty\n", encoding="utf-8")
            dirty = manager.check_once("poll")
            self.assertTrue(dirty["dirty"])
            self.assertFalse(dirty["update_started"])
            self.assertEqual(launched, ["webhook"])

    def test_token_usage_report_tracks_account_scope_provider_and_model(self):
        with tempfile.TemporaryDirectory() as td:
            agent = UsageReportingAgent(
                [
                    {"input_tokens": 10, "output_tokens": 4, "total_tokens": 14},
                    {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
                ]
            )
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=agent,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="token-user",
                    password="member-pass",
                    display_name="Token User",
                    role="member",
                    actor=admin,
                )
                _, member_actor = service.authenticate("token-user", "member-pass")

                service.send_channel_message(admin, 1, "@agent channel usage")
                service.wait_for_agent_idle("channel", "1")
                service.send_private_message(member_actor, "private usage")
                service.wait_for_agent_idle("private", str(member["id"]))

                report = service.token_usage_report(admin, days=30)
                self.assertEqual(report["summary"]["event_count"], 2)
                self.assertEqual(report["summary"]["input_tokens"], 15)
                self.assertEqual(report["summary"]["output_tokens"], 7)
                self.assertEqual(report["summary"]["total_tokens"], 22)
                self.assertEqual(report["today"]["total_tokens"], 22)
                self.assertEqual(report["last_7_days"]["total_tokens"], 22)
                self.assertEqual(len(report["daily_usage"]), 7)
                self.assertEqual(sum(day["total_tokens"] for day in report["daily_usage"]), 22)
                self.assertEqual(report["daily_usage"][-1]["total_tokens"], 22)

                by_account = {row["username"]: row for row in report["by_account"]}
                self.assertEqual(by_account["admin"]["total_tokens"], 14)
                self.assertEqual(by_account["token-user"]["total_tokens"], 8)

                detail_keys = {
                    (row["username"], row["scope_type"], row["scope_name"], row["provider"], row["model"]): row
                    for row in report["details"]
                }
                self.assertIn(("admin", "channel", "#general", "openai-codex", "gpt-5.5"), detail_keys)
                self.assertIn(("token-user", "private", "Token User", "openai-codex", "gpt-5.5"), detail_keys)

                channel_messages = service.list_messages(admin, "channel", "1")
                agent_message = next(message for message in channel_messages if message["author_type"] == "agent")
                self.assertEqual(agent_message["metadata"]["token_usage"]["total_tokens"], 14)
                self.assertEqual(agent_message["metadata"]["token_usage"]["provider"], "openai-codex")
            finally:
                service.close()

    def test_token_usage_report_exposes_today_and_last_7_day_consumption(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                now = int(time.time())
                today_start = service._token_usage_day_start(now)
                two_days_ago = service._token_usage_day_start(now, offset_days=-2) + 60
                eight_days_ago = service._token_usage_day_start(now, offset_days=-8) + 60

                for created_at, total_tokens in (
                    (today_start, 100),
                    (two_days_ago, 70),
                    (eight_days_ago, 9),
                ):
                    service.db.insert(
                        """
                        INSERT INTO token_usage_events(
                            user_id, username, display_name, scope_type, scope_id, scope_name,
                            request_message_id, response_message_id, provider, model,
                            input_tokens, output_tokens, total_tokens, raw_usage_json, degraded, created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            int(admin["id"]),
                            "admin",
                            "Administrator",
                            "channel",
                            "1",
                            "#general",
                            1,
                            2,
                            "openai-codex",
                            "gpt-5.5",
                            total_tokens // 2,
                            total_tokens - (total_tokens // 2),
                            total_tokens,
                            "{}",
                            0,
                            created_at,
                        ),
                    )

                report = service.token_usage_report(admin, days=30)
                daily = {row["date"]: row for row in report["daily_usage"]}

                self.assertEqual(report["summary"]["total_tokens"], 179)
                self.assertEqual(report["today"]["total_tokens"], 100)
                self.assertEqual(report["last_7_days"]["total_tokens"], 170)
                self.assertEqual(len(report["daily_usage"]), 7)
                self.assertEqual(sum(row["total_tokens"] for row in report["daily_usage"]), 170)
                self.assertEqual(report["daily_usage"][-1]["start_at"], today_start)
                self.assertEqual(report["daily_usage"][-1]["total_tokens"], 100)
                self.assertEqual(
                    daily[time.strftime("%Y-%m-%d", time.localtime(two_days_ago))]["total_tokens"],
                    70,
                )
                self.assertNotIn(time.strftime("%Y-%m-%d", time.localtime(eight_days_ago)), daily)
            finally:
                service.close()

    def test_agent_approval_status_can_be_responded_from_channel_scope(self):
        with tempfile.TemporaryDirectory() as td:
            agent = ApprovalRecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "approval.request",
                        "run_id": "run_42",
                        "approval_id": "approval_42",
                        "command": "rm -rf build",
                        "description": "recursive delete",
                        "choices": ["once", "session", "always", "deny"],
                    },
                )

                status = service.agent_status(admin, "channel", "1")
                self.assertEqual(status["state"], "approval")
                self.assertEqual(status["approval"]["run_id"], "run_42")
                self.assertEqual(status["approval"]["command"], "rm -rf build")

                result = service.respond_agent_approval(admin, "channel", "1", "session")

                self.assertEqual(
                    agent.approvals,
                    [{
                        "run_id": "run_42",
                        "choice": "session",
                        "approval_id": "approval_42",
                    }],
                )
                self.assertTrue(result["ok"])
                self.assertEqual(result["agent_status"]["state"], "replying")
                self.assertIsNone(result["agent_status"]["approval"])
                self.assertEqual(result["agent_status"]["current_step"], "权限审批已处理")

                # The HTTP response and the runtime SSE acknowledgement race in
                # production. Both carry the same approval ID and must converge
                # on one visible response row.
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "approval.responded",
                        "approval_id": "approval_42",
                        "choice": "session",
                    },
                )
                status = service.agent_status(admin, "channel", "1")
                responded = [
                    item
                    for item in status["activity"]
                    if item.get("stage") == "approval.responded"
                ]
                self.assertEqual(len(responded), 1)
                self.assertEqual(responded[0]["approval_id"], "approval_42")
                self.assertEqual(responded[0]["approval_responder"], "Administrator")

                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "approval.request",
                        "run_id": "run_42",
                        "approval_id": "approval_43",
                        "description": "second command",
                    },
                )
                service._mark_agent_approval_responded(
                    "channel",
                    "1",
                    "once",
                    responder="",
                    approval_result={"approval_id": "approval_43"},
                )
                service._mark_agent_approval_responded(
                    "channel",
                    "1",
                    "once",
                    responder="Administrator",
                    approval_result={"approval_id": "approval_43"},
                )
                status = service.agent_status(admin, "channel", "1")
                reverse_race = [
                    item
                    for item in status["activity"]
                    if item.get("stage") == "approval.responded"
                    and item.get("approval_id") == "approval_43"
                ]
                self.assertEqual(len(reverse_race), 1)
                self.assertEqual(reverse_race[0]["approval_responder"], "Administrator")

                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "approval.request",
                        "run_id": "run_42",
                        "approval_id": "approval_44",
                        "description": "current command",
                    },
                )
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "approval.responded",
                        "approval_id": "approval_43",
                        "choice": "once",
                    },
                )
                status = service.agent_status(admin, "channel", "1")
                self.assertEqual(status["state"], "approval")
                self.assertEqual(status["approval"]["approval_id"], "approval_44")
                self.assertIn("current command", status["current_step"])
            finally:
                service.close()

    def test_agent_progress_ignores_argument_deltas_and_upserts_tool_lifecycle(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service._record_agent_progress(
                    "channel",
                    "1",
                    {"event": "tool.arguments.delta", "delta": '{"command":"pwd"}'},
                )
                self.assertEqual(service.agent_status(admin, "channel", "1")["activity"], [])

                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "tool.started",
                        "tool_name": "terminal",
                        "tool_call_id": "tool-1",
                        "arguments": {
                            "command": (
                                "pwd && TOKEN=super-secret && "
                                "cat /home/ubitech/platform/data/workspaces/user-1/secret.txt"
                            )
                        },
                    },
                )
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "approval.request",
                        "run_id": "run-1",
                        "approval_id": "approval-1",
                        "description": "Run a command on the host",
                    },
                )
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "tool.updated",
                        "tool_name": "terminal",
                        "tool_call_id": "tool-1",
                    },
                )
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "tool.completed",
                        "tool_name": "terminal",
                        "tool_call_id": "tool-1",
                    },
                )

                status = service.agent_status(admin, "channel", "1")
                tools = [item for item in status["activity"] if item.get("stage") == "tool"]
                self.assertEqual(len(tools), 1)
                self.assertEqual(tools[0]["tool"], "terminal")
                self.assertEqual(tools[0]["tool_status"], "completed")
                self.assertEqual(status["activity"][-1]["tool_call_id"], "tool-1")
                self.assertNotIn("super-secret", tools[0]["detail"])
                self.assertNotIn("/home/ubitech", tools[0]["detail"])
                self.assertEqual(tools[0]["detail"], "pwd · cat")

                secret_query = (
                    "AWS_SECRET_ACCESS_KEY=aws-value "
                    "client_secret=client-value access_token=access-value "
                    "session_token=session-value X-Amz-Signature=sig-value "
                    "Cookie: cookie-value Authorization: Basic header-value "
                    "postgresql://dbuser:dbpass@db.internal/app "
                    "curl -u basic-user:basic-pass "
                    "eyJabcdefgh.abcdefghijk.abcdefghijk"
                )
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "tool.started",
                        "tool_name": "web",
                        "tool_call_id": "tool-secret-query",
                        "arguments": {
                            "action": "search",
                            "arguments": {"query": secret_query},
                        },
                    },
                )
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "tool.started",
                        "tool_name": "browser",
                        "tool_call_id": "tool-secret-url",
                        "arguments": {
                            "action": "navigate",
                            "arguments": {
                                "url": (
                                    "https://url-user:url-pass@example.com/private"
                                    "?access_token=url-secret"
                                )
                            },
                        },
                    },
                )
                status = service.agent_status(admin, "channel", "1")
                secret_tool = next(
                    item
                    for item in status["activity"]
                    if item.get("tool_call_id") == "tool-secret-query"
                )
                for secret in (
                    "aws-value",
                    "client-value",
                    "access-value",
                    "session-value",
                    "sig-value",
                    "cookie-value",
                    "header-value",
                    "dbuser",
                    "dbpass",
                    "basic-user",
                    "basic-pass",
                    "eyJabcdefgh",
                ):
                    self.assertNotIn(secret, secret_tool["detail"])
                browser_tool = next(
                    item
                    for item in status["activity"]
                    if item.get("tool_call_id") == "tool-secret-url"
                )
                self.assertEqual(browser_tool["detail"], "navigate · example.com")
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "tool.started",
                        "tool_name": "browser",
                        "tool_call_id": "tool-schemeless-url",
                        "arguments": {
                            "action": "navigate",
                            "arguments": {
                                "url": "example.net/private/path?foo=short-secret"
                            },
                        },
                    },
                )
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "tool.started",
                        "tool_name": "browser",
                        "tool_call_id": "tool-path-only-url",
                        "arguments": {
                            "action": "navigate",
                            "arguments": {"url": "/private/path?foo=path-secret"},
                        },
                    },
                )
                status = service.agent_status(admin, "channel", "1")
                schemeless = next(
                    item
                    for item in status["activity"]
                    if item.get("tool_call_id") == "tool-schemeless-url"
                )
                path_only = next(
                    item
                    for item in status["activity"]
                    if item.get("tool_call_id") == "tool-path-only-url"
                )
                self.assertEqual(schemeless["detail"], "navigate · example.net")
                self.assertEqual(path_only["detail"], "navigate")
                self.assertNotIn("short-secret", schemeless["detail"])
                self.assertNotIn("path-secret", path_only["detail"])

                # A terminal event can still be rendered if a previous start
                # was lost (for example from an old capped activity snapshot).
                service._record_agent_progress(
                    "channel",
                    "1",
                    {
                        "event": "tool.failed",
                        "tool_name": "read_file",
                        "tool_call_id": "tool-missing-start",
                    },
                )
                status = service.agent_status(admin, "channel", "1")
                failed = [
                    item
                    for item in status["activity"]
                    if item.get("tool_call_id") == "tool-missing-start"
                ]
                self.assertEqual(len(failed), 1)
                self.assertEqual(failed[0]["tool_status"], "failed")
            finally:
                service.close()














    def test_existing_admin_rows_migrate_to_admin_permission_group(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            conn = sqlite3.connect(tmp / "platform.db")
            try:
                conn.execute(
                    """
                    CREATE TABLE users (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        username TEXT NOT NULL UNIQUE,
                        display_name TEXT NOT NULL,
                        password_hash TEXT NOT NULL,
                        role TEXT NOT NULL DEFAULT 'member',
                        active INTEGER NOT NULL DEFAULT 1,
                        created_at INTEGER NOT NULL,
                        last_login_at INTEGER
                    )
                    """
                )
                conn.execute(
                    """
                    INSERT INTO users(username, display_name, password_hash, role, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    ("admin", "Administrator", "legacy", "admin", 1),
                )
                conn.commit()
            finally:
                conn.close()
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
            try:
                user = service.get_user(1)
                self.assertEqual(user["role"], "admin")
                self.assertEqual(user["permission_group"], "admin")
                self.assertIn("system_settings", user["permissions"])
            finally:
                service.close()




    def test_channel_uses_shared_agent_session_and_passive_kb_suggestions(self):
        with tempfile.TemporaryDirectory() as td:
            agent = ProgressAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            _, user = service.authenticate("admin", "admin")
            service.add_knowledge_document(
                user,
                {
                    "title": "VPN Access Policy",
                    "summary": "Employees must use SSO for VPN.",
                    "content": "VPN access requires SSO, device posture checks, and quarterly access review.",
                    "source": "policy",
                },
            )
            alice = service.create_user(
                username="alice",
                password="alice-pass",
                display_name="Alice",
                permission_group="member",
                actor=user,
            )
            service.send_channel_message(user, 1, "VPN onboarding starts in the general channel.")
            service.send_channel_message(alice, 1, "I need device posture details before Friday.")

            result = service.send_channel_message(user, 1, "@agent What is the VPN access policy?")
            self.assertIsNone(result["agent_message"])
            self.assertEqual(result["user_message"]["content"], "@agent What is the VPN access policy?")
            service.wait_for_agent_idle("channel", "1")
            messages = service.list_messages(user, "channel", "1")
            agent_message = messages[-1]

            self.assertEqual(agent_message["username"], "Main Agent")
            self.assertEqual(agent.calls[-1]["session_id"], "ubitech-channel-1-main-agent")
            self.assertEqual(agent.calls[-1]["session_key"], "channel:1:main-agent")
            self.assertEqual(agent.calls[-1]["user_message"], "Administrator: What is the VPN access policy?")
            self.assertEqual(
                agent.calls[-1]["history"],
                [
                    {
                        "role": "user",
                        "content": "VPN onboarding starts in the general channel.",
                    },
                    {
                        "role": "user",
                        "content": "I need device posture details before Friday.",
                    },
                ],
            )
            self.assertIn("知识库已通过 knowledge 工具提供", agent.calls[-1]["system_prompt"])
            self.assertIn("使用 search 操作检索", agent.calls[-1]["system_prompt"])
            self.assertIn("使用 read 操作读取完整条目", agent.calls[-1]["system_prompt"])
            self.assertTrue(agent.calls[-1]["metadata"]["knowledge_suggestions"])
            workspace = Path(agent.calls[-1]["metadata"]["workspace"]["path"])
            self.assertTrue(workspace.is_dir())
            self.assertEqual(agent.calls[-1]["metadata"]["workspace"]["scope"], "channel")
            self.assertEqual(workspace.name, "channel-1")
            work = agent_message["metadata"]["agent_work"]
            self.assertEqual(work["state"], "complete")
            self.assertEqual(work["run_id"], f"channel:1:{result['user_message']['id']}")
            agent_activity = [item for item in work["activity"] if item.get("source") == "agent"]
            self.assertEqual(len(agent_activity), 1)
            self.assertEqual(agent_activity[0]["line"], '🔍 knowledge: "VPN access policy"')
            self.assertEqual(agent_activity[0]["tool_status"], "completed")
            self.assertEqual(
                [(item.get("source"), item.get("stage"), item.get("tool")) for item in work["activity"]],
                [("agent", "tool", "knowledge")],
            )
            service.close()

    def test_channel_reuses_runtime_returned_session_after_rotation(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RotatingSessionAgent("compacted-channel-session")
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_channel_message(user, 1, "@agent first")
                service.wait_for_agent_idle("channel", "1")
                service.send_channel_message(user, 1, "@agent second")
                service.wait_for_agent_idle("channel", "1")

                self.assertEqual(agent.calls[0]["session_id"], "ubitech-channel-1-main-agent")
                self.assertEqual(agent.calls[1]["session_id"], "compacted-channel-session")
                self.assertEqual(agent.calls[0]["history"], [])
                self.assertEqual(
                    agent.calls[1]["history"],
                    [
                        {"role": "user", "content": "@agent first"},
                        {
                            "role": "assistant",
                            "content": "agent response to Administrator: first",
                        },
                    ],
                )
                self.assertEqual(agent.calls[1]["session_key"], "channel:1:main-agent")
                self.assertEqual(
                    service.agent_scopes.get_scope("channel:1:main-agent").session_id,
                    "compacted-channel-session",
                )
            finally:
                service.close()


    def test_channel_agent_reply_exposes_streaming_content_while_running(self):
        with tempfile.TemporaryDirectory() as td:
            agent = StreamingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                result = service.send_channel_message(user, 1, "@agent stream a reply")
                self.assertIsNone(result["agent_message"])
                self.assertTrue(agent.first_delta.wait(timeout=1))

                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["state"], "replying")
                self.assertEqual(status["stream_message"]["content"], "Hello ")
                self.assertEqual(status["stream_message"]["username"], "Main Agent")

                agent.release.set()
                service.wait_for_agent_idle("channel", "1")
                messages = service.list_messages(user, "channel", "1")
                self.assertEqual(messages[-1]["content"], "Hello world")
                self.assertIsNone(service.agent_status(user, "channel", "1").get("stream_message"))
            finally:
                agent.release.set()
                service.close()

    def test_stream_status_keeps_only_latest_runtime_turn_identity(self):
        with tempfile.TemporaryDirectory() as td:
            agent = TurnAwareStreamingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "stream with a correction")
                self.assertTrue(agent.new_turn_delta.wait(timeout=2))

                status = service.private_status(user)["agent_status"]
                self.assertEqual(status["stream_message"]["content"], "current")
                self.assertEqual(
                    status["stream_message"]["turn_id"],
                    "stream-run:2",
                )
                self.assertEqual(status["stream_message"]["turn_index"], 2)
                self.assertEqual(status["stream_messages"], [])
                self.assertFalse(
                    any(item.get("source") == "agent" for item in status["activity"])
                )
            finally:
                agent.release.set()
                service.close()

    def test_channel_agent_reply_clears_pre_tool_stream_on_substantive_tool(self):
        with tempfile.TemporaryDirectory() as td:
            agent = ToolBoundaryStreamingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_channel_message(user, 1, "@agent screenshot the browser")
                self.assertTrue(agent.first_delta.wait(timeout=1))
                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["stream_message"]["content"], "Now browser_vision call.\n\n")

                agent.release_tool.set()
                self.assertTrue(agent.tool_started.wait(timeout=1))
                status = service.agent_status(user, "channel", "1")
                self.assertIsNone(status.get("stream_message"))
                self.assertEqual(status["stream_messages"][-1]["content"], "Now browser_vision call.\n\n")
                self.assertFalse(status["stream_messages"][-1]["active"])
                self.assertEqual(status["activity"][-1]["tool"], "browser_vision")

                agent.release_final.set()
                service.wait_for_agent_idle("channel", "1")
                messages = service.list_messages(user, "channel", "1")
                self.assertEqual(messages[-1]["content"], "好了，这次成功了。")
            finally:
                agent.release_tool.set()
                agent.release_final.set()
                service.close()

    def test_channel_message_without_agent_mention_does_not_trigger_agent(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                result = service.send_channel_message(user, 1, "normal channel message")
                status = service.wait_for_agent_idle("channel", "1")
                messages = service.list_messages(user, "channel", "1")

                self.assertEqual(result["user_message"]["content"], "normal channel message")
                self.assertIsNone(result["agent_message"])
                self.assertEqual(status["state"], "idle")
                self.assertEqual(messages[-1]["content"], "normal channel message")
                self.assertEqual(agent.calls, [])
            finally:
                service.close()

    def test_telegram_private_message_routes_through_platform_private_agent(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                self._complete_telegram_link(service, user, "12345", "alice_tg")
                result = gateway.process_update(
                    {
                        "update_id": 1,
                        "message": {
                            "message_id": 10,
                            "chat": {"id": 12345, "type": "private"},
                            "from": {"id": 12345, "username": "alice_tg", "first_name": "Alice"},
                            "text": "private request",
                        },
                    }
                )

                self.assertTrue(result["ok"])
                self.assertEqual(result["scope_type"], "private")
                self.assertEqual(len(agent.calls), 1)
                self.assertEqual(agent.calls[0]["session_key"], f"private:{user['id']}")
                self.assertEqual(agent.calls[0]["metadata"]["workspace"]["scope"], "private")
                self.assertEqual(
                    agent.calls[0]["metadata"]["workspace"]["path"],
                    agent.calls[0]["metadata"]["execution"]["workspace_path"],
                )
                self.assertNotIn("container", agent.calls[0]["metadata"])
                self.assertEqual(result["scope_id"], str(user["id"]))
                self.assertEqual(len(bot.sent), 1)
                self.assertEqual(bot.sent[0]["chat_id"], 12345)
                self.assertEqual(bot.sent[0]["reply_to_message_id"], 10)
                self.assertIn("agent response to private request", bot.sent[0]["text"])
                identity = service.db.query_one(
                    "SELECT user_id FROM external_identities WHERE provider = 'telegram' AND external_id = '12345'"
                )
                self.assertIsNotNone(identity)
            finally:
                service.close()

    def test_stale_telegram_update_cannot_restore_identity_after_unlink_and_relink(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            entered = threading.Event()
            release = threading.Event()
            worker: threading.Thread | None = None
            try:
                _, admin = service.authenticate("admin", "admin")
                self._complete_telegram_link(service, admin, "12345", "old_tg")
                old_update = {
                    "update_id": 2,
                    "message": {
                        "message_id": 20,
                        "chat": {"id": 12345, "type": "private"},
                        "from": {"id": 12345, "username": "old_tg", "first_name": "Old"},
                        "text": "stale private request",
                    },
                }
                results: list[dict] = []
                errors: list[BaseException] = []
                original_refresh = service._refresh_telegram_identity

                def delayed_refresh(*args, **kwargs):
                    entered.set()
                    self.assertTrue(release.wait(timeout=3))
                    return original_refresh(*args, **kwargs)

                def process_old_update():
                    try:
                        results.append(gateway.process_update(old_update))
                    except BaseException as exc:
                        errors.append(exc)

                with mock.patch.object(
                    service,
                    "_refresh_telegram_identity",
                    side_effect=delayed_refresh,
                ):
                    worker = threading.Thread(
                        target=process_old_update,
                        name="stale-telegram-update",
                    )
                    worker.start()
                    self.assertTrue(entered.wait(timeout=2))

                    service.unlink_telegram_private_config(admin)
                    challenge = service.update_telegram_private_config(admin, {})
                    service.complete_telegram_link(
                        challenge["pending"]["code"],
                        {"id": "54321", "username": "new_tg", "first_name": "New"},
                        chat_id=54321,
                    )
                    release.set()
                    worker.join(timeout=5)
                    self.assertFalse(worker.is_alive())

                self.assertEqual(errors, [])
                self.assertEqual(results[0]["ignored"], "unlinked telegram user")
                self.assertEqual(agent.calls, [])
                identities = service.db.query(
                    """
                    SELECT external_id, user_id FROM external_identities
                    WHERE provider = 'telegram' ORDER BY external_id
                    """
                )
                self.assertEqual(
                    identities,
                    [{"external_id": "54321", "user_id": int(admin["id"])}],
                )
            finally:
                release.set()
                if worker is not None:
                    worker.join(timeout=5)
                service.close()

    def test_telegram_link_command_is_one_time_and_updates_are_deduplicated(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                service.set_setting("telegram_enabled", "1")
                _, user = service.authenticate("admin", "admin")
                challenge = service.update_telegram_private_config(user, {})
                command = challenge["pending"]["command"]
                update = {
                    "update_id": 77,
                    "message": {
                        "message_id": 70,
                        "chat": {"id": 77777, "type": "private"},
                        "from": {"id": 77777, "username": "proof_tg", "first_name": "Proof"},
                        "text": command,
                    },
                }

                linked = gateway.process_update(update)
                duplicate = gateway.process_update(update)

                self.assertTrue(linked["linked"])
                self.assertEqual(duplicate["ignored"], "duplicate update")
                self.assertEqual(len(bot.sent), 1)
                config = service.telegram_private_config(user)
                self.assertEqual(config["link"]["telegram_user_id"], "77777")
                self.assertIsNone(config["pending"])
                replay = gateway.process_update({**update, "update_id": 78})
                self.assertFalse(replay["linked"])
                self.assertIn("绑定失败", bot.sent[-1]["text"])
                statuses = service.db.query(
                    "SELECT update_id, status FROM telegram_updates ORDER BY update_id"
                )
                self.assertEqual(statuses, [
                    {"update_id": 77, "status": "succeeded"},
                    {"update_id": 78, "status": "succeeded"},
                ])
            finally:
                service.close()

    def test_concurrent_telegram_turns_deliver_only_their_exact_agent_reply(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                self._complete_telegram_link(service, user, "88881", "concurrent_tg")
                updates = [
                    {
                        "update_id": 801,
                        "message": {
                            "message_id": 101,
                            "chat": {"id": 88881, "type": "private"},
                            "from": {"id": 88881, "username": "concurrent_tg"},
                            "text": "request-one",
                        },
                    },
                    {
                        "update_id": 802,
                        "message": {
                            "message_id": 102,
                            "chat": {"id": 88881, "type": "private"},
                            "from": {"id": 88881, "username": "concurrent_tg"},
                            "text": "request-two",
                        },
                    },
                ]
                results: list[dict] = []
                threads = [
                    threading.Thread(target=lambda item=item: results.append(gateway.process_update(item)))
                    for item in updates
                ]
                threads[0].start()
                self.assertTrue(agent.started.wait(2))
                threads[1].start()
                time.sleep(0.05)
                agent.release.set()
                for thread in threads:
                    thread.join(5)

                self.assertEqual(len(results), 2)
                delivered = {int(item["reply_to_message_id"]): item["text"] for item in bot.sent}
                self.assertIn("request-one", delivered[101])
                self.assertIn("request-two", delivered[102])
                self.assertNotIn("request-two", delivered[101])
                self.assertNotIn("request-one", delivered[102])
                self.assertEqual(service.jobs.counts(kind="telegram_delivery")["succeeded"], 2)
                self.assertFalse(any(thread.name.startswith("telegram-response-") for thread in threading.enumerate()))
            finally:
                agent.release.set()
                service.close()

    def test_rapid_telegram_turns_join_and_deliver_one_reply_to_the_latest_message(self):
        with tempfile.TemporaryDirectory() as td:
            agent = SteeringBlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                self._complete_telegram_link(service, user, "88882", "joined_tg")
                updates = [
                    {
                        "update_id": 811,
                        "message": {
                            "message_id": 111,
                            "chat": {"id": 88882, "type": "private"},
                            "from": {"id": 88882, "username": "joined_tg"},
                            "text": "prepare the report",
                        },
                    },
                    {
                        "update_id": 812,
                        "message": {
                            "message_id": 112,
                            "chat": {"id": 88882, "type": "private"},
                            "from": {"id": 88882, "username": "joined_tg"},
                            "text": "include the risks",
                        },
                    },
                ]
                results: list[dict] = []
                threads = [
                    threading.Thread(
                        target=lambda item=item: results.append(gateway.process_update(item))
                    )
                    for item in updates
                ]
                threads[0].start()
                self.assertTrue(agent.started.wait(2))
                threads[1].start()
                deadline = time.time() + 2
                while len(agent.steers) < 1 and time.time() < deadline:
                    time.sleep(0.01)
                self.assertEqual(len(agent.steers), 1)
                agent.release.set()
                for thread in threads:
                    thread.join(5)

                self.assertEqual(len(results), 2)
                self.assertEqual(len(bot.sent), 1)
                self.assertEqual(bot.sent[0]["reply_to_message_id"], 112)
                self.assertEqual(bot.sent[0]["text"], "one consolidated response")
                self.assertEqual(len(agent.calls), 1)
                self.assertEqual(
                    service.jobs.counts(kind="telegram_delivery")["succeeded"],
                    2,
                )
            finally:
                agent.release.set()
                service.close()

    def test_queued_telegram_delivery_recovers_and_succeeded_job_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                _, user = first.authenticate("admin", "admin")
                self._complete_telegram_link(first, user, "88882", "recovery_tg")
                sent = first.send_private_message(user, "persist this delivery")
                first.wait_for_agent_idle("private", str(user["id"]), timeout=5)
                user_message_id = int(sent["user_message"]["id"])
                job = first.enqueue_telegram_delivery(
                    actor=user,
                    update_id=901,
                    user_message_id=user_message_id,
                    chat_id=88882,
                    reply_to_message_id=201,
                    message_thread_id=None,
                )
                self.assertEqual(job.status, "queued")
            finally:
                first.close()

            second = EnterpriseService(config, agent_client=RecordingAgent())
            second_bot = FakeTelegramBot()
            TelegramGateway(second, bot=second_bot, autostart=False)
            try:
                completed = second.wait_for_telegram_delivery(job.id, timeout=5)
                self.assertIsNotNone(completed)
                self.assertEqual(completed.status, "succeeded")
                self.assertEqual(completed.attempts, 1)
                self.assertEqual(len(second_bot.sent), 1)
                self.assertEqual(second_bot.sent[0]["reply_to_message_id"], 201)
                self.assertIn("persist this delivery", second_bot.sent[0]["text"])
            finally:
                second.close()

            third = EnterpriseService(config, agent_client=RecordingAgent())
            third_bot = FakeTelegramBot()
            TelegramGateway(third, bot=third_bot, autostart=False)
            try:
                time.sleep(0.4)
                self.assertEqual(third.jobs.get(job.id).status, "succeeded")
                self.assertEqual(third_bot.sent, [])
            finally:
                third.close()

    def test_interrupted_telegram_update_replay_reuses_message_agent_job_and_outbox(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first_agent = RecordingAgent()
            first = EnterpriseService(config, agent_client=first_agent)
            first_bot = FakeTelegramBot()
            first_gateway = TelegramGateway(first, bot=first_bot, autostart=False)
            update = {
                "update_id": 911,
                "message": {
                    "message_id": 211,
                    "chat": {"id": 88891, "type": "private"},
                    "from": {"id": 88891, "username": "replay_tg"},
                    "text": "persist exactly once",
                },
            }
            try:
                _, user = first.authenticate("admin", "admin")
                self._complete_telegram_link(first, user, "88891", "replay_tg")

                # Model a crash after the complete route (message, Agent job and
                # outbox all committed) but before process_update acknowledges
                # the update with finish_telegram_update.
                self.assertTrue(first.claim_telegram_update(911))
                initial = first_gateway._process_claimed_update(update)
                self.assertEqual(initial["delivery_status"], "succeeded")
                self.assertEqual(
                    first.db.scalar("SELECT status FROM telegram_updates WHERE update_id = 911"),
                    "processing",
                )
                original_message_id = int(initial["user_message_id"])
                original_agent_job_id = first.jobs.get_by_key(
                    "agent", f"message:{original_message_id}"
                ).id
                original_delivery_job_id = int(initial["delivery_job_id"])
                self.assertEqual(len(first_bot.sent), 1)
            finally:
                first.close()

            second_agent = RecordingAgent()
            second = EnterpriseService(config, agent_client=second_agent)
            second_bot = FakeTelegramBot()
            second_gateway = TelegramGateway(second, bot=second_bot, autostart=False)
            try:
                replay = second_gateway.process_update(update)

                self.assertEqual(int(replay["user_message_id"]), original_message_id)
                self.assertEqual(int(replay["delivery_job_id"]), original_delivery_job_id)
                self.assertEqual(
                    second.jobs.get_by_key("agent", f"message:{original_message_id}").id,
                    original_agent_job_id,
                )
                self.assertEqual(
                    second.db.scalar(
                        """
                        SELECT COUNT(*) FROM messages
                        WHERE scope_type = 'private' AND scope_id = ? AND author_type = 'user'
                        """,
                        (str(user["id"]),),
                    ),
                    1,
                )
                self.assertEqual(second.jobs.counts(kind="agent")["succeeded"], 1)
                self.assertEqual(second.jobs.counts(kind="telegram_delivery")["succeeded"], 1)
                self.assertEqual(second_agent.calls, [])
                self.assertEqual(second_bot.sent, [])
                stored = second._messages_for_scope("private", str(user["id"]))[0]
                self.assertEqual(stored["metadata"]["telegram_update_id"], 911)
                self.assertEqual(
                    second.db.scalar("SELECT status FROM telegram_updates WHERE update_id = 911"),
                    "succeeded",
                )
            finally:
                second.close()

    def test_telegram_help_reply_is_not_sent_twice_after_pre_ack_crash(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            update = {
                "update_id": 913,
                "message": {
                    "message_id": 213,
                    "chat": {"id": 88913, "type": "private"},
                    "from": {"id": 88913, "username": "help_tg"},
                    "text": "/help",
                },
            }
            first = EnterpriseService(config, agent_client=RecordingAgent())
            first.set_setting("telegram_enabled", "1")
            first_bot = FakeTelegramBot()
            first_gateway = TelegramGateway(first, bot=first_bot, autostart=False)
            try:
                self.assertTrue(first.claim_telegram_update(913))
                initial = first_gateway._process_claimed_update(update)
                self.assertEqual(initial["delivery_status"], "succeeded")
                self.assertEqual(len(first_bot.sent), 1)
                original_job_id = int(initial["delivery_job_id"])
                self.assertEqual(
                    first.db.scalar("SELECT status FROM telegram_updates WHERE update_id = 913"),
                    "processing",
                )
            finally:
                first.close()

            second = EnterpriseService(config, agent_client=RecordingAgent())
            second_bot = FakeTelegramBot()
            second_gateway = TelegramGateway(second, bot=second_bot, autostart=False)
            try:
                replay = second_gateway.process_update(update)
                self.assertEqual(replay["delivery_job_id"], original_job_id)
                self.assertEqual(replay["delivery_status"], "succeeded")
                self.assertEqual(second_bot.sent, [])
            finally:
                second.close()

    def test_telegram_link_replay_recovers_crash_before_outbox_enqueue(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = EnterpriseService(config, agent_client=RecordingAgent())
            first.set_setting("telegram_enabled", "1")
            first_bot = FakeTelegramBot()
            first_gateway = TelegramGateway(first, bot=first_bot, autostart=False)
            try:
                _, user = first.authenticate("admin", "admin")
                command = first.update_telegram_private_config(user, {})["pending"]["command"]
                update = {
                    "update_id": 914,
                    "message": {
                        "message_id": 214,
                        "chat": {"id": 88914, "type": "private"},
                        "from": {"id": 88914, "username": "link_replay"},
                        "text": command,
                    },
                }
                self.assertTrue(first.claim_telegram_update(914))
                with mock.patch.object(
                    first,
                    "enqueue_telegram_text_delivery",
                    side_effect=SystemExit("simulated kill before outbox enqueue"),
                ):
                    with self.assertRaises(SystemExit):
                        first_gateway._process_claimed_update(update)
                self.assertEqual(first_bot.sent, [])
                self.assertTrue(first.telegram_update_result(914).get("linked"))
            finally:
                first.close()

            second = EnterpriseService(config, agent_client=RecordingAgent())
            second_bot = FakeTelegramBot()
            second_gateway = TelegramGateway(second, bot=second_bot, autostart=False)
            try:
                replay = second_gateway.process_update(update)
                self.assertTrue(replay["linked"])
                self.assertEqual(replay["delivery_status"], "succeeded")
                self.assertEqual(len(second_bot.sent), 1)
                self.assertIn("绑定成功", second_bot.sent[0]["text"])
                self.assertNotIn("绑定失败", second_bot.sent[0]["text"])
            finally:
                second.close()

    def test_disabled_telegram_outbox_waits_for_new_handler_after_reenable(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            old_bot = FakeTelegramBot()
            old_gateway = TelegramGateway(service, bot=old_bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                challenge = service.update_telegram_private_config(user, {})
                service.complete_telegram_link(
                    challenge["pending"]["code"],
                    {"id": "88892", "username": "disabled_tg"},
                )
                sent = service.send_private_message(user, "hold while disabled")
                service.wait_for_agent_idle("private", str(user["id"]), timeout=5)
                delivery = service.enqueue_telegram_delivery(
                    actor=user,
                    update_id=912,
                    user_message_id=int(sent["user_message"]["id"]),
                    chat_id=88892,
                    reply_to_message_id=212,
                    message_thread_id=None,
                )

                time.sleep(0.4)
                self.assertEqual(service.jobs.get(delivery.id).status, "queued")
                self.assertEqual(old_bot.sent, [])

                # Rotation disables the old registration before enabling and
                # installing the replacement. Stopping the stale gateway after
                # that must not unregister the newer generation.
                service.unregister_telegram_delivery_handler()
                service.set_setting("telegram_enabled", "1")
                new_bot = FakeTelegramBot()
                TelegramGateway(service, bot=new_bot, autostart=False)
                old_gateway.stop()

                completed = service.wait_for_telegram_delivery(delivery.id, timeout=5)
                self.assertIsNotNone(completed)
                self.assertEqual(completed.status, "succeeded")
                self.assertEqual(old_bot.sent, [])
                self.assertEqual(len(new_bot.sent), 1)
                self.assertEqual(new_bot.sent[0]["reply_to_message_id"], 212)
            finally:
                service.close()

    def test_ambiguous_telegram_send_failure_is_quarantined_not_repeated(self):
        class FailingBot(FakeTelegramBot):
            def __init__(self):
                super().__init__()
                self.attempts = 0

            def send_message(self, **kwargs):
                self.attempts += 1
                raise RuntimeError("connection dropped after send")

        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            failing = FailingBot()
            gateway = TelegramGateway(service, bot=failing, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                self._complete_telegram_link(service, user, "88883", "ambiguous_tg")
                result = gateway.process_update(
                    {
                        "update_id": 902,
                        "message": {
                            "message_id": 202,
                            "chat": {"id": 88883, "type": "private"},
                            "from": {"id": 88883, "username": "ambiguous_tg"},
                            "text": "possibly delivered",
                        },
                    }
                )
                self.assertEqual(result["delivery_status"], "needs_review")
                self.assertEqual(failing.attempts, 1)

                replacement = FakeTelegramBot()
                TelegramGateway(service, bot=replacement, autostart=False)
                time.sleep(0.4)
                self.assertEqual(replacement.sent, [])
                self.assertEqual(service.jobs.get(result["delivery_job_id"]).status, "needs_review")
            finally:
                service.close()

    def test_telegram_document_is_stored_as_platform_attachment(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            bot.files["file-1"] = ("documents/report.txt", b"hello from telegram")
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                self._complete_telegram_link(service, user, "45678", "doc_tg")
                result = gateway.process_update(
                    {
                        "update_id": 4,
                        "message": {
                            "message_id": 40,
                            "chat": {"id": 45678, "type": "private"},
                            "from": {"id": 45678, "username": "doc_tg", "first_name": "Doc"},
                            "caption": "please inspect",
                            "document": {
                                "file_id": "file-1",
                                "file_unique_id": "unique-1",
                                "file_name": "report.txt",
                                "mime_type": "text/plain",
                                "file_size": 19,
                            },
                        },
                    }
                )

                self.assertEqual(result["attachment_count"], 1)
                self.assertEqual(len(agent.calls), 1)
                self.assertEqual(agent.calls[0]["attachments"][0]["filename"], "report.txt")
                self.assertEqual(agent.calls[0]["attachments"][0]["mime_type"], "text/plain")
                messages = service._messages_for_scope("private", result["scope_id"])
                self.assertEqual(messages[0]["attachments"][0]["filename"], "report.txt")
            finally:
                service.close()

    def test_telegram_private_agent_generated_attachment_is_sent_back(self):
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as media_td:
            media_path = Path(media_td) / "result.csv"
            media_path.write_text("a,b\n1,2\n", encoding="utf-8")
            agent = MediaReturningAgent(media_path)
            previous_roots = os.environ.get("ENTERPRISE_MEDIA_ROOTS")
            os.environ["ENTERPRISE_MEDIA_ROOTS"] = media_td
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                _, user = service.authenticate("admin", "admin")
                self._complete_telegram_link(service, user, "56789", "media_tg")
                result = gateway.process_update(
                    {
                        "update_id": 5,
                        "message": {
                            "message_id": 50,
                            "chat": {"id": 56789, "type": "private"},
                            "from": {"id": 56789, "username": "media_tg", "first_name": "Media"},
                            "text": "make a csv",
                        },
                    }
                )

                self.assertIsNotNone(result["agent_message_id"])
                self.assertEqual(len(bot.sent), 1)
                self.assertEqual(bot.sent[0]["text"], "created file")
                self.assertEqual(len(bot.files_sent), 1)
                self.assertEqual(bot.files_sent[0]["filename"], "result.csv")
                self.assertEqual(bot.files_sent[0]["content_type"], "text/csv")
            finally:
                service.close()
                if previous_roots is None:
                    os.environ.pop("ENTERPRISE_MEDIA_ROOTS", None)
                else:
                    os.environ["ENTERPRISE_MEDIA_ROOTS"] = previous_roots

    def test_telegram_unlinked_private_message_replies_with_binding_hint(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                service.set_setting("telegram_enabled", "1")
                result = gateway.process_update(
                    {
                        "update_id": 6,
                        "message": {
                            "message_id": 60,
                            "chat": {"id": 67890, "type": "private"},
                            "from": {"id": 67890, "username": "unlinked_tg", "first_name": "Unlinked"},
                            "text": "hello",
                        },
                    }
                )

                self.assertEqual(result["ignored"], "unlinked telegram user")
                self.assertEqual(agent.calls, [])
                self.assertEqual(len(bot.sent), 1)
                self.assertIn("/link", bot.sent[0]["text"])
                self.assertNotIn("67890", bot.sent[0]["text"])
            finally:
                service.close()

    def test_telegram_group_messages_are_ignored_without_platform_channel_records(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            bot = FakeTelegramBot()
            gateway = TelegramGateway(service, bot=bot, autostart=False)
            try:
                result = gateway.process_update(
                    {
                        "update_id": 3,
                        "message": {
                            "message_id": 30,
                            "chat": {"id": -1002, "type": "group", "title": "General"},
                            "from": {"id": 34567, "username": "carol_tg", "first_name": "Carol"},
                            "text": "normal group note",
                        },
                    }
                )

                self.assertEqual(result["ignored"], "non-private chat")
                self.assertEqual(agent.calls, [])
                self.assertEqual(bot.sent, [])
                self.assertEqual(service._messages_for_scope("channel", "1"), [])
            finally:
                service.close()

    def test_telegram_settings_and_per_user_link_conflict(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="tg-member",
                    password="member-password",
                    display_name="Telegram Member",
                    actor=admin,
                    permission_group="member",
                )

                config = service.update_telegram_admin_config(
                    admin,
                    {
                        "enabled": True,
                        "polling": False,
                        "bot_username": "enterprise_private_bot",
                        "bot_token": "123456:token",
                        "webhook_secret": "secret-token",
                    },
                )
                self.assertTrue(config["config"]["enabled"])
                self.assertFalse(config["config"]["polling"])
                self.assertTrue(config["config"]["bot_token_configured"])
                self.assertIn("/api/telegram/webhook/secret-token", config["config"]["webhook_url"])

                challenge = service.update_telegram_private_config(admin, {})
                self.assertEqual(challenge["pending"]["status"], "pending")
                self.assertIn("code", challenge["pending"])
                pending_get = service.telegram_private_config(admin)
                self.assertNotIn("code", pending_get["pending"])
                service.complete_telegram_link(
                    challenge["pending"]["code"],
                    {"id": "123456789", "username": "admin_tg", "first_name": "Admin"},
                )
                mine = service.telegram_private_config(admin)
                self.assertEqual(mine["link"]["telegram_user_id"], "123456789")
                member_challenge = service.update_telegram_private_config(member, {})
                with self.assertRaises(ServiceError) as ctx:
                    service.complete_telegram_link(
                        member_challenge["pending"]["code"],
                        {"id": "123456789", "username": "admin_tg"},
                    )
                self.assertEqual(ctx.exception.status, 409)
                with self.assertRaises(ServiceError) as raw_ctx:
                    service.update_telegram_private_config(member, {"telegram_user_id": "999"})
                self.assertEqual(raw_ctx.exception.status, 400)
            finally:
                service.close()

    def test_channel_image_attachment_is_stored_and_passed_to_agent(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                result = service.send_channel_message(
                    user,
                    1,
                    "@agent inspect this",
                    [UploadedFile("diagram.png", "image/png", b"\x89PNG\r\n\x1a\nimage")],
                )
                self.assertEqual(result["user_message"]["attachments"][0]["filename"], "diagram.png")
                self.assertTrue(result["user_message"]["attachments"][0]["is_image"])
                service.wait_for_agent_idle("channel", "1")

                call = agent.calls[-1]
                self.assertEqual(len(call["attachments"]), 1)
                self.assertTrue(Path(call["attachments"][0]["local_path"]).exists())
                self.assertIn("[User attached image: diagram.png", call["user_message"])
                messages = service.list_messages(user, "channel", "1")
                self.assertEqual(messages[0]["attachments"][0]["download_url"], f"/api/attachments/{messages[0]['attachments'][0]['id']}?download=1")
            finally:
                service.close()

    def test_channel_message_returns_before_agent_finishes_and_reports_reply_target(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=user,
                )

                started_at = time.monotonic()
                result = service.send_channel_message(user, 1, "@agent slow question")
                elapsed = time.monotonic() - started_at

                self.assertLess(elapsed, 0.5)
                self.assertEqual(result["user_message"]["content"], "@agent slow question")
                self.assertIsNone(result["agent_message"])
                self.assertTrue(agent.started.wait(timeout=1))
                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["state"], "replying")
                self.assertEqual(status["replying_to"]["username"], "Administrator")
                self.assertEqual(status["current_step"], "等待 Agent 运行过程")
                self.assertIn("replying", [item["stage"] for item in status["activity"]])
                self.assertEqual(service.list_messages(user, "channel", "1")[-1]["content"], "@agent slow question")

                second_started_at = time.monotonic()
                second = service.send_channel_message(member, 1, "second normal message")
                self.assertLess(time.monotonic() - second_started_at, 0.5)
                self.assertEqual(second["user_message"]["content"], "second normal message")
                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["state"], "replying")
                self.assertEqual(status["replying_to"]["username"], "Administrator")
                self.assertEqual(status["queued_count"], 0)
                self.assertEqual(service.list_messages(user, "channel", "1")[-1]["content"], "second normal message")

                third = service.send_channel_message(member, 1, "@agent second question")
                self.assertEqual(third["user_message"]["content"], "@agent second question")
                status = service.agent_status(user, "channel", "1")
                self.assertEqual(status["queued_count"], 1)
                self.assertEqual(service.list_messages(user, "channel", "1")[-1]["content"], "@agent second question")

                agent.release.set()
                status = service.wait_for_agent_idle("channel", "1")
                self.assertEqual(status["state"], "idle")
                self.assertEqual([call["user_message"] for call in agent.calls], ["Administrator: slow question", "Alice: second question"])
                final_message = service.list_messages(user, "channel", "1")[-1]
                self.assertEqual(final_message["content"], "agent response to Alice: second question")
                self.assertEqual(final_message["metadata"]["agent_work"]["state"], "complete")
                self.assertEqual(final_message["metadata"]["agent_work"]["activity"], [])
            finally:
                agent.release.set()
                service.close()

    def test_channel_mention_targets_include_agent_and_active_users(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Designer",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("alice", "alice-pass")

                targets = service.mention_targets(alice)
                self.assertEqual(targets[0]["handle"], "agent")
                self.assertIn(
                    {"kind": "user", "id": alice["id"], "handle": "alice", "label": "Alice", "description": "Designer"},
                    targets,
                )
            finally:
                service.close()

    def test_channel_typing_presence_excludes_current_user(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=admin,
                )

                self.assertEqual(service.update_typing(member, "channel", "1", True)["typing"], [])
                typing = service.typing_users(admin, "channel", "1")
                self.assertEqual(typing[0]["username"], "Alice")
                self.assertEqual(service.update_typing(member, "channel", "1", False)["typing"], [])
                self.assertEqual(service.typing_users(admin, "channel", "1"), [])
            finally:
                service.close()

    def test_private_agent_creates_local_workspace_and_independent_session(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            _, user = service.authenticate("admin", "admin")

            result = service.send_private_message(user, "Create a project plan")
            self.assertIsNone(result["agent_message"])
            service.wait_for_agent_idle("private", str(user["id"]))

            status = service.private_status(user)
            execution = status["execution"]
            self.assertEqual(execution["backend"], "host")
            self.assertEqual(execution["isolation"], "logical")
            self.assertEqual(execution["scope_key"], "private:1")
            self.assertTrue(Path(execution["workspace_path"]).exists())
            self.assertNotIn("container", status)
            self.assertEqual(agent.calls[-1]["session_id"], "ubitech-private-u1")
            self.assertEqual(agent.calls[-1]["session_key"], "private:1")
            self.assertNotIn("container", agent.calls[-1]["metadata"])
            service.close()

    def test_private_agent_joins_rapid_messages_into_one_active_run(self):
        with tempfile.TemporaryDirectory() as td:
            agent = SteeringBlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                first = service.send_private_message(user, "prepare the report")
                self.assertEqual(first["processing_mode"], "started")
                self.assertTrue(agent.started.wait(timeout=2))

                second = service.send_private_message(user, "include the risks")
                third = service.send_private_message(user, "add a short checklist")
                self.assertEqual(second["processing_mode"], "joined")
                self.assertEqual(third["processing_mode"], "joined")
                self.assertEqual(first["input_group_id"], second["input_group_id"])
                self.assertEqual(second["input_group_id"], third["input_group_id"])
                self.assertEqual(
                    third["agent_status"]["active_input_group"]["message_count"],
                    3,
                )
                self.assertEqual(len(agent.calls), 1)
                self.assertEqual(
                    [item["user_message"] for item in agent.steers],
                    ["include the risks", "add a short checklist"],
                )

                agent.release.set()
                self.assertEqual(
                    service.wait_for_agent_idle("private", str(user["id"]), timeout=3)["state"],
                    "idle",
                )
                messages = service.list_messages(
                    user,
                    "private",
                    str(user["id"]),
                    limit=20,
                )
                agent_messages = [
                    message for message in messages if message["author_type"] == "agent"
                ]
                self.assertEqual(len(agent_messages), 1)
                response = agent_messages[0]
                self.assertEqual(response["content"], "one consolidated response")
                self.assertEqual(
                    response["metadata"]["reply_to_message_ids"],
                    [
                        first["user_message"]["id"],
                        second["user_message"]["id"],
                        third["user_message"]["id"],
                    ],
                )
                self.assertEqual(len(response["metadata"]["durable_job_ids"]), 3)
                for sent in (first, second, third):
                    job = service.jobs.get_by_key(
                        "agent",
                        f"message:{sent['user_message']['id']}",
                    )
                    self.assertIsNotNone(job)
                    self.assertEqual(job.status, "succeeded")
                    self.assertEqual(
                        service.agent_message_replying_to(
                            "private",
                            str(user["id"]),
                            sent["user_message"]["id"],
                        )["id"],
                        response["id"],
                    )
            finally:
                agent.release.set()
                service.close()

    def test_private_agent_accepts_join_before_queue_head_worker_claims_root(self):
        with tempfile.TemporaryDirectory() as td:
            agent = SteeringBlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            worker_entered = threading.Event()
            release_worker = threading.Event()
            original_worker = service._agent_worker

            def delayed_worker(key):
                worker_entered.set()
                release_worker.wait(timeout=5)
                original_worker(key)

            service._agent_worker = delayed_worker
            try:
                _, user = service.authenticate("admin", "admin")
                first = service.send_private_message(user, "prepare the report")
                self.assertTrue(worker_entered.wait(timeout=2))
                self.assertFalse(agent.started.is_set())

                second = service.send_private_message(user, "include the risks")
                self.assertEqual(second["processing_mode"], "joined")
                self.assertEqual(first["input_group_id"], second["input_group_id"])
                self.assertEqual(
                    second["agent_status"]["active_input_group"]["message_count"],
                    2,
                )
                second_job = service.jobs.get_by_key(
                    "agent",
                    f"message:{second['user_message']['id']}",
                )
                self.assertEqual(second_job.status, "queued")
                self.assertIsNone(
                    service.agent_inputs.get_by_message(second["user_message"]["id"])
                )

                release_worker.set()
                self.assertTrue(agent.started.wait(timeout=2))
                deadline = time.time() + 2
                while len(agent.steers) < 1 and time.time() < deadline:
                    time.sleep(0.01)
                self.assertEqual(
                    [item["user_message"] for item in agent.steers],
                    ["include the risks"],
                )
                agent.release.set()
                self.assertEqual(
                    service.wait_for_agent_idle(
                        "private",
                        str(user["id"]),
                        timeout=3,
                    )["state"],
                    "idle",
                )
                messages = service.list_messages(
                    user,
                    "private",
                    str(user["id"]),
                    limit=20,
                )
                replies = [
                    message for message in messages if message["author_type"] == "agent"
                ]
                self.assertEqual(len(agent.calls), 1)
                self.assertEqual(len(replies), 1)
                self.assertEqual(
                    replies[0]["metadata"]["reply_to_message_ids"],
                    [
                        first["user_message"]["id"],
                        second["user_message"]["id"],
                    ],
                )
            finally:
                release_worker.set()
                agent.release.set()
                service.close()

    def test_runtime_registration_failure_does_not_orphan_accepted_run(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RegistrationFailureAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            original_set_runtime_run = service.agent_inputs.set_runtime_run
            failed_once = False

            def fail_registration_once(input_group_id, run_id):
                nonlocal failed_once
                if not failed_once:
                    failed_once = True
                    raise OSError("simulated input-ledger write failure")
                return original_set_runtime_run(input_group_id, run_id)

            service.agent_inputs.set_runtime_run = fail_registration_once
            try:
                _, user = service.authenticate("admin", "admin")
                first = service.send_private_message(user, "first request")
                self.assertTrue(agent.before_first_callback.wait(timeout=2))
                second = service.send_private_message(user, "late correction")
                self.assertEqual(second["processing_mode"], "joined")

                agent.allow_first_callback.set()
                self.assertTrue(agent.first_callback_returned.wait(timeout=2))
                # The accepted parent is still being observed, while the child
                # that never reached the runtime has safely returned to FIFO.
                parent_job = service.jobs.get_by_key(
                    "agent",
                    f"message:{first['user_message']['id']}",
                )
                child_job = service.jobs.get_by_key(
                    "agent",
                    f"message:{second['user_message']['id']}",
                )
                self.assertEqual(parent_job.status, "running")
                self.assertEqual(child_job.status, "queued")

                agent.release_first_run.set()
                self.assertEqual(
                    service.wait_for_agent_idle(
                        "private",
                        str(user["id"]),
                        timeout=4,
                    )["state"],
                    "idle",
                )
                messages = service.list_messages(
                    user,
                    "private",
                    str(user["id"]),
                    limit=20,
                )
                replies = [
                    message for message in messages if message["author_type"] == "agent"
                ]
                self.assertEqual([message["content"] for message in replies], [
                    "observed response 1",
                    "observed response 2",
                ])
                self.assertEqual(len(agent.calls), 2)
                self.assertEqual(agent.steers, [])
                for sent in (first, second):
                    job = service.jobs.get_by_key(
                        "agent",
                        f"message:{sent['user_message']['id']}",
                    )
                    association = service.agent_inputs.get_by_message(
                        sent["user_message"]["id"]
                    )
                    self.assertEqual(job.status, "succeeded")
                    self.assertEqual(association.state, "succeeded")
                status = service.private_status(user)["agent_status"]
                self.assertEqual(status["state"], "idle")
                self.assertIsNone(status["active_input_group"])
            finally:
                agent.allow_first_callback.set()
                agent.release_first_run.set()
                service.close()

    def test_joined_private_inputs_are_submitted_in_user_order(self):
        with tempfile.TemporaryDirectory() as td:
            agent = OrderedSteeringAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            threads = []
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "first")
                self.assertTrue(agent.started.wait(timeout=2))
                results = {}

                def send(label):
                    results[label] = service.send_private_message(user, label)

                second_thread = threading.Thread(target=send, args=("second",))
                third_thread = threading.Thread(target=send, args=("third",))
                threads.extend((second_thread, third_thread))
                second_thread.start()
                self.assertTrue(agent.first_steer_started.wait(timeout=2))
                third_thread.start()
                time.sleep(0.1)
                self.assertEqual(agent.steers, [])

                agent.release_first_steer.set()
                second_thread.join(timeout=2)
                third_thread.join(timeout=2)
                self.assertFalse(second_thread.is_alive())
                self.assertFalse(third_thread.is_alive())
                self.assertEqual(
                    [item["user_message"] for item in agent.steers],
                    ["second", "third"],
                )
                self.assertEqual(results["second"]["processing_mode"], "joined")
                self.assertEqual(results["third"]["processing_mode"], "joined")
            finally:
                agent.release_first_steer.set()
                agent.release.set()
                for thread in threads:
                    thread.join(timeout=1)
                service.close()

    def test_pre_runtime_failure_requeues_a_late_join_instead_of_stranding_it(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            entered = threading.Event()
            release = threading.Event()
            calls = 0
            original_suggest = service.knowledge.suggest

            def flaky_suggest(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    entered.set()
                    release.wait(timeout=5)
                    raise RuntimeError("knowledge lookup failed before runtime start")
                return original_suggest(*args, **kwargs)

            service.knowledge.suggest = flaky_suggest
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "first")
                self.assertTrue(entered.wait(timeout=2))
                second = service.send_private_message(user, "second")
                self.assertEqual(second["processing_mode"], "joined")

                release.set()
                self.assertEqual(
                    service.wait_for_agent_idle("private", str(user["id"]), timeout=4)["state"],
                    "idle",
                )
                job = service.jobs.get_by_key(
                    "agent",
                    f"message:{second['user_message']['id']}",
                )
                association = service.agent_inputs.get_by_message(
                    second["user_message"]["id"]
                )
                self.assertIsNotNone(job)
                self.assertEqual(job.status, "succeeded")
                self.assertIsNotNone(association)
                self.assertEqual(association.state, "succeeded")
                self.assertEqual(
                    [call["user_message"] for call in agent.calls],
                    ["second"],
                )
            finally:
                release.set()
                service.close()

    def test_terminal_run_waits_for_definite_steer_rejection_then_falls_back(self):
        with tempfile.TemporaryDirectory() as td:
            agent = TerminalRacingRejectAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            second_thread = None
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "first")
                self.assertTrue(agent.started.wait(timeout=2))
                result = {}

                def send_second():
                    result["value"] = service.send_private_message(user, "second")

                second_thread = threading.Thread(target=send_second)
                second_thread.start()
                self.assertTrue(agent.steer_started.wait(timeout=2))
                agent.release_run.set()
                time.sleep(0.1)
                child_row = service.db.query_one(
                    """
                    SELECT id FROM durable_jobs
                    WHERE kind = 'agent' AND scope_type = 'private'
                    ORDER BY id DESC LIMIT 1
                    """
                )
                child = service.jobs.get(int(child_row["id"]))
                self.assertIsNotNone(child)
                self.assertEqual(child.status, "running")

                agent.release_steer.set()
                second_thread.join(timeout=3)
                self.assertFalse(second_thread.is_alive())
                self.assertEqual(result["value"]["processing_mode"], "queued")
                self.assertEqual(
                    service.wait_for_agent_idle("private", str(user["id"]), timeout=4)["state"],
                    "idle",
                )
                second_message_id = result["value"]["user_message"]["id"]
                child = service.jobs.get_by_key(
                    "agent",
                    f"message:{second_message_id}",
                )
                association = service.agent_inputs.get_by_message(second_message_id)
                self.assertEqual(child.status, "succeeded")
                self.assertEqual(association.state, "succeeded")
                self.assertEqual(len(agent.calls), 2)
                self.assertEqual(agent.calls[1]["user_message"], "second")
            finally:
                agent.release_run.set()
                agent.release_steer.set()
                if second_thread is not None:
                    second_thread.join(timeout=1)
                service.close()

    def test_private_reuses_runtime_returned_session_after_rotation(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RotatingSessionAgent("compacted-private-session")
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "first")
                service.wait_for_agent_idle("private", str(user["id"]))
                service.send_private_message(user, "second")
                service.wait_for_agent_idle("private", str(user["id"]))

                self.assertEqual(agent.calls[0]["session_id"], "ubitech-private-u1")
                self.assertEqual(agent.calls[1]["session_id"], "compacted-private-session")
                self.assertEqual(agent.calls[0]["history"], [])
                self.assertEqual(
                    agent.calls[1]["history"],
                    [
                        {"role": "user", "content": "first"},
                        {"role": "assistant", "content": "agent response to first"},
                    ],
                )
                self.assertEqual(
                    service.private_status(user)["execution"]["session_id"],
                    "compacted-private-session",
                )
            finally:
                service.close()

    def test_private_agent_accepts_file_only_message_and_passes_file_path(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                result = service.send_private_message(
                    user,
                    "",
                    [UploadedFile("brief.txt", "text/plain", b"project brief")],
                )
                self.assertEqual(result["user_message"]["content"], "")
                self.assertEqual(result["user_message"]["attachments"][0]["filename"], "brief.txt")
                service.wait_for_agent_idle("private", str(user["id"]))

                call = agent.calls[-1]
                self.assertIn("brief.txt", call["user_message"])
                self.assertIn("local path:", call["user_message"])
                self.assertTrue(Path(call["attachments"][0]["local_path"]).exists())
            finally:
                service.close()

    def test_agent_prompt_uses_ubitech_identity_and_includes_user_position(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Product Manager",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("alice", "alice-pass")

                service.send_private_message(alice, "draft a roadmap")
                service.wait_for_agent_idle("private", str(alice["id"]))
                private_prompt = agent.calls[-1]["system_prompt"]
                identity_prompt = "你是 ubitech agent。对外介绍自己时，只说自己是 ubitech agent；"
                self.assertIn(identity_prompt, private_prompt)
                self.assertIn("不要提及底层框架", private_prompt)
                self.assertIn("当前用户: Alice (@alice)，职位: Product Manager", private_prompt)

                service.send_channel_message(alice, 1, "@agent summarize status")
                service.wait_for_agent_idle("channel", "1")
                self.assertEqual(agent.calls[-1]["user_message"], "Alice，职位: Product Manager: summarize status")
                self.assertIn(identity_prompt, agent.calls[-1]["system_prompt"])
            finally:
                service.close()

    def test_agent_memory_clear_removes_only_the_disposable_child_scope(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                parent = service.agent_scopes.ensure_private_scope(admin["id"])
                child_scope = f"{parent.scope_key}/delegate/test-child"
                service.agent_memory_mutate({
                    "scope_key": parent.scope_key,
                    "action": "add",
                    "content": "keep parent memory",
                })
                service.agent_memory_mutate({
                    "scope_key": child_scope,
                    "action": "add",
                    "content": "discard child memory",
                })

                cleared = service.agent_memory_mutate({
                    "scope_key": child_scope,
                    "action": "clear",
                })

                self.assertEqual(cleared["changed"], [{"action": "clear", "deleted": 1}])
                self.assertEqual(cleared["memories"], [])
                parent_memories = service.agent_memory_search({"scope_key": parent.scope_key})
                self.assertEqual(
                    [memory["content"] for memory in parent_memories["memories"]],
                    ["keep parent memory"],
                )
            finally:
                service.close()

    def test_agent_media_tags_are_saved_as_returned_attachments(self):
        with tempfile.TemporaryDirectory() as td, tempfile.TemporaryDirectory() as media_td:
            tmp = Path(td)
            # The broad system temp dir is no longer an implicit media root (it is
            # shared host state, so trusting it would let a prompt-injected agent
            # exfiltrate arbitrary readable temp files via MEDIA: tags). An
            # operator allow-lists this generated-media directory explicitly via
            # ENTERPRISE_MEDIA_ROOTS, the documented escape hatch alongside the
            # managed Agent runtime directories that are trusted by default.
            media_path = Path(media_td) / "result.csv"
            media_path.write_text("a,b\n1,2\n", encoding="utf-8")
            agent = MediaReturningAgent(media_path)
            previous_roots = os.environ.get("ENTERPRISE_MEDIA_ROOTS")
            os.environ["ENTERPRISE_MEDIA_ROOTS"] = media_td
            service = EnterpriseService(make_config(tmp), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")

                service.send_private_message(user, "make a csv")
                service.wait_for_agent_idle("private", str(user["id"]))
                agent_message = service.list_messages(user, "private", str(user["id"]))[-1]

                self.assertEqual(agent_message["content"], "created file")
                self.assertEqual(agent_message["attachments"][0]["filename"], "result.csv")
                attachment, stored_path = service.get_attachment_file(user, agent_message["attachments"][0]["id"])
                self.assertEqual(attachment["mime_type"], "text/csv")
                source = service.db.query_one(
                    "SELECT source FROM attachments WHERE id = ?",
                    (agent_message["attachments"][0]["id"],),
                )
                self.assertEqual(source["source"], "agent_generated")
                self.assertEqual(stored_path.read_text(encoding="utf-8"), "a,b\n1,2\n")
            finally:
                service.close()
                if previous_roots is None:
                    os.environ.pop("ENTERPRISE_MEDIA_ROOTS", None)
                else:
                    os.environ["ENTERPRISE_MEDIA_ROOTS"] = previous_roots

    def test_agent_media_tags_outside_allowed_roots_are_refused(self):
        # A path that exists but lives outside the temp dir and the workspace
        # tree (here: next to the test file in the repo) must never be read and
        # surfaced as an attachment, even though the file is present.
        probe = Path(__file__).resolve().parent / "_media_denied_probe.csv"
        if str(probe).startswith(tempfile.gettempdir()):
            self.skipTest("repository tree is under the temp dir; cannot test refusal deterministically")
        probe.write_text("secret,value\n1,2\n", encoding="utf-8")
        try:
            with tempfile.TemporaryDirectory() as td:
                tmp = Path(td)
                agent = MediaReturningAgent(probe)
                service = EnterpriseService(make_config(tmp), agent_client=agent)
                try:
                    _, user = service.authenticate("admin", "admin")
                    service.send_private_message(user, "exfiltrate please")
                    service.wait_for_agent_idle("private", str(user["id"]))
                    agent_message = service.list_messages(user, "private", str(user["id"]))[-1]
                    self.assertEqual(agent_message["attachments"], [])
                    self.assertIn("outside the allowed media directories", agent_message["content"])
                finally:
                    service.close()
        finally:
            probe.unlink(missing_ok=True)

    def test_generated_media_enforces_aggregate_limit_as_one_batch(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                workspace = Path(service.agent_scopes.ensure_private_scope(1).workspace_path)
                first = workspace / "first.txt"
                second = workspace / "second.txt"
                first.write_bytes(b"abc")
                second.write_bytes(b"def")
                with mock.patch("enterprise_agent_platform.service.MAX_ATTACHMENTS_TOTAL_BYTES", 5):
                    content, attachments = service._extract_generated_attachments(
                        f"files\nMEDIA:{first}\nMEDIA:{second}",
                        owner_id=1,
                    )
                self.assertEqual(attachments, [])
                self.assertIn("exceeded attachment limits", content)
            finally:
                service.close()

    def test_channel_generated_media_cannot_read_another_channel_workspace(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                first_scope = service.agent_scopes.ensure_channel_scope(1)
                second_scope = service.agent_scopes.ensure_channel_scope(2)
                foreign = Path(second_scope.workspace_path) / "foreign.txt"
                foreign.write_text("other channel", encoding="utf-8")
                content, attachments = service._extract_generated_attachments(
                    f"result\nMEDIA:{foreign}",
                    workspace_path=Path(first_scope.workspace_path),
                )
                self.assertEqual(attachments, [])
                self.assertIn("outside the allowed media directories", content)
            finally:
                service.close()

    def test_agent_media_cannot_exfiltrate_data_dir_secrets(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            # A secret-like file under the data dir (which the test harness puts
            # under the temp dir) must be refused even though the temp dir is an
            # allowed media root, because it is not in a safe data subtree.
            secret = tmp / "secret-export.txt"
            secret.write_text("session_secret=topsecret\n", encoding="utf-8")
            agent = MediaReturningAgent(secret)
            service = EnterpriseService(make_config(tmp), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "exfiltrate secrets")
                service.wait_for_agent_idle("private", str(user["id"]))
                msg = service.list_messages(user, "private", str(user["id"]))[-1]
                self.assertEqual(msg["attachments"], [])
                self.assertIn("outside the allowed media directories", msg["content"])
            finally:
                service.close()

    def test_multiple_users_share_channel_main_agent_without_model_key_injection(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            _, admin = service.authenticate("admin", "admin")
            member = service.create_user(
                username="alice",
                password="alice-pass",
                display_name="Alice",
                role="member",
                actor=admin,
            )

            service.send_channel_message(admin, 1, "@agent admin asks")
            service.send_channel_message(member, 1, "@agent member asks")
            service.wait_for_agent_idle("channel", "1")
            channel_sessions = [call["session_id"] for call in agent.calls[-2:]]
            self.assertEqual(channel_sessions, ["ubitech-channel-1-main-agent", "ubitech-channel-1-main-agent"])

            service.send_private_message(member, "private task")
            service.wait_for_agent_idle("private", str(member["id"]))
            self.assertEqual(service.private_status(member)["execution"]["session_id"], "ubitech-private-u2")
            self.assertEqual(service.model_secret_env(), {})
            service.close()


    def test_admin_can_delete_channel_messages_by_id_before_time_and_clear(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=admin,
                )

                first = service.send_channel_message(admin, 1, "first")["user_message"]
                second = service.send_channel_message(member, 1, "second")["user_message"]
                third = service.send_channel_message(admin, 1, "third")["user_message"]
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (1000, first["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (2000, second["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (3000, third["id"]))

                audit = service.audit_channel_messages(admin, 1)
                self.assertEqual(audit["total"], 3)
                self.assertEqual([message["content"] for message in audit["messages"]], ["first", "second", "third"])

                with self.assertRaises(ServiceError) as member_error:
                    service.delete_channel_message(member, 1, first["id"])
                self.assertEqual(member_error.exception.status, 403)

                deleted = service.delete_channel_message(admin, 1, second["id"])
                self.assertEqual(deleted["deleted"], 1)
                self.assertEqual(deleted["message"]["content"], "second")
                self.assertEqual([message["content"] for message in service.audit_channel_messages(admin, 1)["messages"]], ["first", "third"])
                self.assertIsNotNone(
                    service.db.scalar("SELECT hidden_at FROM messages WHERE id = ?", (second["id"],))
                )

                before = service.delete_channel_messages_before(admin, 1, 2500)
                self.assertEqual(before["deleted"], 1)
                self.assertEqual([message["content"] for message in service.audit_channel_messages(admin, 1)["messages"]], ["third"])

                cleared = service.clear_channel_messages(admin, 1)
                self.assertEqual(cleared["deleted"], 1)
                self.assertEqual(service.audit_channel_messages(admin, 1)["total"], 0)
                self.assertEqual(
                    service.db.scalar(
                        "SELECT COUNT(*) FROM messages WHERE scope_type = 'channel' AND scope_id = '1'"
                    ),
                    3,
                )
            finally:
                service.close()

    def test_admin_can_audit_all_private_agent_conversations(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("alice", "alice-pass")

                service.send_private_message(alice, "alice private task")
                service.wait_for_agent_idle("private", str(alice["id"]))
                service.send_private_message(admin, "admin private task")
                service.wait_for_agent_idle("private", str(admin["id"]))

                conversations = service.list_private_conversation_audits(admin)
                by_user = {item["username"]: item for item in conversations}
                self.assertEqual(by_user["alice"]["message_count"], 2)
                self.assertEqual(by_user["alice"]["user_message_count"], 1)
                self.assertEqual(by_user["alice"]["agent_message_count"], 1)
                self.assertEqual(by_user["admin"]["message_count"], 2)

                audit = service.audit_private_messages(admin, alice["id"])
                self.assertEqual(audit["subject"]["username"], "alice")
                self.assertEqual(audit["total"], 2)
                self.assertEqual(audit["messages"][0]["content"], "alice private task")
                self.assertEqual(audit["messages"][1]["content"], "agent response to alice private task")

                with self.assertRaises(ServiceError) as member_error:
                    service.audit_private_messages(alice, admin["id"])
                self.assertEqual(member_error.exception.status, 403)

                service.deactivate_user(admin, alice["id"])
                retained = {item["username"]: item for item in service.list_private_conversation_audits(admin)}
                self.assertFalse(retained["alice"]["active"])
                self.assertEqual(retained["alice"]["message_count"], 2)
                self.assertEqual(service.audit_private_messages(admin, alice["id"])["total"], 2)
            finally:
                service.close()

    def test_admin_can_delete_private_agent_messages_by_id_before_time_and_clear(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("alice", "alice-pass")

                first = service.send_private_message(alice, "first")["user_message"]
                service.wait_for_agent_idle("private", str(alice["id"]))
                second = service.send_private_message(alice, "second")["user_message"]
                service.wait_for_agent_idle("private", str(alice["id"]))
                third = service.send_private_message(alice, "third")["user_message"]
                service.wait_for_agent_idle("private", str(alice["id"]))

                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (1000, first["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE content = ?", (1100, "agent response to first"))
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (2000, second["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE content = ?", (2100, "agent response to second"))
                service.db.execute("UPDATE messages SET created_at = ? WHERE id = ?", (3000, third["id"]))
                service.db.execute("UPDATE messages SET created_at = ? WHERE content = ?", (3100, "agent response to third"))

                audit = service.audit_private_messages(admin, alice["id"])
                self.assertEqual(audit["total"], 6)
                self.assertEqual(
                    [message["content"] for message in audit["messages"]],
                    ["first", "agent response to first", "second", "agent response to second", "third", "agent response to third"],
                )

                with self.assertRaises(ServiceError) as member_error:
                    service.delete_private_message(alice, alice["id"], first["id"])
                self.assertEqual(member_error.exception.status, 403)

                deleted = service.delete_private_message(admin, alice["id"], second["id"])
                self.assertEqual(deleted["deleted"], 1)
                self.assertEqual(deleted["message"]["content"], "second")
                self.assertEqual(
                    [message["content"] for message in service.audit_private_messages(admin, alice["id"])["messages"]],
                    ["first", "agent response to first", "agent response to second", "third", "agent response to third"],
                )

                with self.assertRaises(ServiceError) as wrong_scope_error:
                    service.delete_private_message(admin, admin["id"], third["id"])
                self.assertEqual(wrong_scope_error.exception.status, 404)

                before = service.delete_private_messages_before(admin, alice["id"], 2500)
                self.assertEqual(before["deleted"], 3)
                self.assertEqual(
                    [message["content"] for message in service.audit_private_messages(admin, alice["id"])["messages"]],
                    ["third", "agent response to third"],
                )

                cleared = service.clear_private_messages(admin, alice["id"])
                self.assertEqual(cleared["deleted"], 2)
                self.assertEqual(service.audit_private_messages(admin, alice["id"])["total"], 0)
                self.assertEqual(
                    service.db.scalar(
                        "SELECT COUNT(*) FROM messages WHERE scope_type = 'private' AND scope_id = ?",
                        (str(alice["id"]),),
                    ),
                    6,
                )
            finally:
                service.close()

    def test_clear_private_conversation_only_hides_current_rows(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            agent.cleanup_scope = mock.Mock(return_value={"cancelled": 1})
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                sent = service.send_private_message(admin, "do not restore this after clear")
                self.assertTrue(agent.started.wait(timeout=2))
                before = service.agent_scopes.get_private_scope(admin["id"])
                self.assertIsNotNone(before)

                cleared = service.clear_private_messages(admin, admin["id"])
                self.assertEqual(cleared["deleted"], 1)
                after = service.agent_scopes.get_private_scope(admin["id"])
                self.assertIsNotNone(after)
                self.assertEqual(after.session_id, before.session_id)
                self.assertEqual(after.workspace_path, before.workspace_path)
                agent.cleanup_scope.assert_not_called()

                agent.release.set()
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=3)
                visible = service.audit_private_messages(admin, admin["id"])["messages"]
                self.assertEqual([message["author_type"] for message in visible], ["agent"])
                job = service.jobs.get_by_key("agent", f"message:{sent['user_message']['id']}")
                self.assertIsNotNone(job)
                self.assertEqual(job.status, "succeeded")
                hidden = service.db.query_one(
                    "SELECT hidden_at FROM messages WHERE id = ?",
                    (sent["user_message"]["id"],),
                )
                self.assertIsNotNone(hidden["hidden_at"])
                self.assertEqual(
                    service.db.scalar(
                        "SELECT COUNT(*) FROM messages WHERE scope_type = 'private' AND scope_id = ?",
                        (str(admin["id"]),),
                    ),
                    2,
                )
            finally:
                agent.release.set()
                service.close()

    def test_clear_does_not_touch_session_or_runtime_cleanup(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                sent = service.send_private_message(admin, "keep this if rotation fails")
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=3)
                before = service.agent_scopes.get_private_scope(admin["id"])
                with mock.patch.object(
                    service.agent_scopes,
                    "rotate_session",
                    side_effect=OSError("disk full"),
                ) as rotate, mock.patch.object(service, "_cleanup_agent_scope") as cleanup:
                    cleared = service.clear_private_messages(admin, admin["id"])
                self.assertEqual(cleared["deleted"], 2)
                rotate.assert_not_called()
                cleanup.assert_not_called()

                after = service.agent_scopes.get_private_scope(admin["id"])
                self.assertEqual(after.session_id, before.session_id)
                messages = service.audit_private_messages(admin, admin["id"])["messages"]
                self.assertEqual(messages, [])
                retained = service.db.query(
                    "SELECT id, hidden_at FROM messages WHERE scope_type = 'private' AND scope_id = ?",
                    (str(admin["id"]),),
                )
                self.assertEqual(len(retained), 2)
                self.assertTrue(all(row["hidden_at"] is not None for row in retained))

                service.send_private_message(admin, "continue after hidden history")
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=3)
                seeded_history = service.agent_client.calls[-1]["history"]
                self.assertEqual(
                    [item["content"] for item in seeded_history[-2:]],
                    [
                        "keep this if rotation fails",
                        "agent response to keep this if rotation fails",
                    ],
                )
            finally:
                service.close()

    def test_deactivate_user_cancels_inflight_private_reply(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="cancelled-user",
                    password="cancelled-pass",
                    display_name="Cancelled User",
                    permission_group="member",
                    actor=admin,
                )
                _, user = service.authenticate("cancelled-user", "cancelled-pass")
                sent = service.send_private_message(user, "long private operation")
                self.assertTrue(agent.started.wait(timeout=2))

                service.deactivate_user(admin, user["id"])
                agent.release.set()
                service.wait_for_agent_idle("private", str(user["id"]), timeout=3)

                audit = service.audit_private_messages(admin, user["id"])
                self.assertEqual([message["author_type"] for message in audit["messages"]], ["user"])
                job = service.jobs.get_by_key("agent", f"message:{sent['user_message']['id']}")
                self.assertIsNotNone(job)
                self.assertEqual(job.status, "failed")
                association = service.agent_inputs.get_by_message(
                    sent["user_message"]["id"]
                )
                self.assertIsNotNone(association)
                self.assertEqual(association.state, "failed")
            finally:
                agent.release.set()
                service.close()

    def test_permission_revocation_before_runtime_submission_prevents_start(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            entered = threading.Event()
            release = threading.Event()
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="pre-submit-revoke",
                    password="pre-submit-revoke-pass",
                    display_name="Pre-submit Revoke",
                    permission_group="member",
                    actor=admin,
                )
                _, user = service.authenticate("pre-submit-revoke", "pre-submit-revoke-pass")
                original = service._runtime_submission_barrier

                def delayed_barrier(task, scope_key):
                    entered.set()
                    self.assertTrue(release.wait(timeout=3))
                    return original(task, scope_key)

                with mock.patch.object(
                    service,
                    "_runtime_submission_barrier",
                    side_effect=delayed_barrier,
                ):
                    sent = service.send_private_message(user, "must not start after revoke")
                    self.assertTrue(entered.wait(timeout=2))
                    service.update_user(admin, user["id"], {"permission_group": "viewer"})
                    release.set()
                    service.wait_for_agent_idle("private", str(user["id"]), timeout=5)

                self.assertEqual(agent.calls, [])
                job = service.jobs.get_by_key(
                    "agent", f"message:{sent['user_message']['id']}"
                )
                self.assertIsNotNone(job)
                self.assertEqual(job.status, "failed")
                self.assertIsNone(
                    service.agent_message_replying_to(
                        "private", str(user["id"]), sent["user_message"]["id"]
                    )
                )
            finally:
                release.set()
                service.close()

    def test_stale_authenticated_actor_cannot_write_after_deactivation(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="stale-writer",
                    password="stale-writer-pass",
                    display_name="Stale Writer",
                    permission_group="member",
                    actor=admin,
                )
                _, stale_actor = service.authenticate("stale-writer", "stale-writer-pass")
                service.deactivate_user(admin, stale_actor["id"])

                with self.assertRaises(ServiceError) as private_error:
                    service.send_private_message(stale_actor, "must not persist")
                self.assertEqual(private_error.exception.status, 401)
                with self.assertRaises(ServiceError) as channel_error:
                    service.send_channel_message(stale_actor, 1, "must not persist")
                self.assertEqual(channel_error.exception.status, 401)
                self.assertFalse(
                    service.db.scalar(
                        "SELECT 1 FROM messages WHERE user_id = ?",
                        (stale_actor["id"],),
                    )
                )
            finally:
                service.close()

    def test_hiding_source_message_does_not_cancel_inflight_agent_reply(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                sent = service.send_private_message(admin, "delete this active request")
                self.assertTrue(agent.started.wait(timeout=2))

                service.delete_private_message(admin, admin["id"], sent["user_message"]["id"])
                agent.release.set()
                service.wait_for_agent_idle("private", str(admin["id"]), timeout=3)

                visible = service.audit_private_messages(admin, admin["id"])["messages"]
                self.assertEqual(len(visible), 1)
                self.assertEqual(visible[0]["author_type"], "agent")
                job = service.jobs.get_by_key("agent", f"message:{sent['user_message']['id']}")
                self.assertIsNotNone(job)
                self.assertEqual(job.status, "succeeded")
                source = service.db.query_one(
                    "SELECT hidden_at FROM messages WHERE id = ?",
                    (sent["user_message"]["id"],),
                )
                self.assertIsNotNone(source["hidden_at"])
            finally:
                agent.release.set()
                service.close()

    def test_hiding_message_during_attachment_write_preserves_attachment(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            entered = threading.Event()
            release = threading.Event()
            append_errors = []
            try:
                _, admin = service.authenticate("admin", "admin")
                original_store = service._store_attachments

                def blocked_store(**kwargs):
                    entered.set()
                    self.assertTrue(release.wait(timeout=3))
                    return original_store(**kwargs)

                def append_message():
                    try:
                        service._append_message(
                            scope_type="private",
                            scope_id=str(admin["id"]),
                            author_type="user",
                            user_id=admin["id"],
                            username=admin["display_name"],
                            content="attachment race",
                            metadata={},
                            attachments=[UploadedFile("race.txt", "text/plain", b"race")],
                        )
                    except BaseException as exc:
                        append_errors.append(exc)

                with mock.patch.object(service, "_store_attachments", side_effect=blocked_store):
                    append_thread = threading.Thread(target=append_message)
                    append_thread.start()
                    self.assertTrue(entered.wait(timeout=2))
                    message_id = int(
                        service.db.scalar("SELECT id FROM messages WHERE content = 'attachment race'")
                    )
                    delete_thread = threading.Thread(
                        target=service.delete_private_message,
                        args=(admin, admin["id"], message_id),
                    )
                    delete_thread.start()
                    time.sleep(0.05)
                    self.assertFalse(delete_thread.is_alive())
                    release.set()
                    append_thread.join(timeout=3)
                    delete_thread.join(timeout=3)

                self.assertEqual(append_errors, [])
                self.assertFalse(append_thread.is_alive())
                self.assertFalse(delete_thread.is_alive())
                self.assertEqual(service.db.scalar("SELECT COUNT(*) FROM attachments"), 1)
                self.assertEqual(
                    len([path for path in service._attachment_root().rglob("*") if path.is_file()]),
                    1,
                )
                self.assertEqual(
                    service.audit_private_messages(admin, admin["id"])["messages"],
                    [],
                )
            finally:
                release.set()
                service.close()

    def test_startup_discards_message_interrupted_during_attachment_commit(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                _, admin = first.authenticate("admin", "admin")
                with mock.patch.object(first, "_store_attachments", side_effect=SystemExit("simulated kill")):
                    with self.assertRaises(SystemExit):
                        first._append_message(
                            scope_type="private",
                            scope_id=str(admin["id"]),
                            author_type="user",
                            user_id=admin["id"],
                            username=admin["display_name"],
                            content="must not run without its attachment",
                            metadata={"generation": first.account_generation_config(admin)},
                            attachments=[UploadedFile("required.txt", "text/plain", b"required")],
                        )
                pending = first.db.query_one(
                    "SELECT metadata_json FROM messages WHERE content = ?",
                    ("must not run without its attachment",),
                )
                self.assertIsNotNone(pending)
                self.assertEqual(json.loads(pending["metadata_json"])["_attachment_commit"], "pending")
            finally:
                first.close()

            agent = RecordingAgent()
            second = EnterpriseService(config, agent_client=agent)
            try:
                time.sleep(0.1)
                self.assertFalse(
                    second.db.scalar(
                        "SELECT 1 FROM messages WHERE content = ?",
                        ("must not run without its attachment",),
                    )
                )
                self.assertEqual(agent.calls, [])
                self.assertEqual(second.db.scalar("SELECT COUNT(*) FROM attachments"), 0)
                self.assertEqual(
                    [path for path in second._attachment_root().rglob("*") if path.is_file()],
                    [],
                )
            finally:
                second.close()

    def test_data_directory_allows_only_one_live_service_instance(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                with self.assertRaisesRegex(RuntimeError, "another ubitech agent instance"):
                    EnterpriseService(config, agent_client=RecordingAgent())
            finally:
                first.close()

            replacement = EnterpriseService(config, agent_client=RecordingAgent())
            replacement.close()

    def test_admin_can_manage_account_permissions_and_model_policy(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                user = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Analyst",
                    permission_group="viewer",
                    model_name="gpt-5.4",
                    thinking_depth="low",
                    actor=admin,
                )

                self.assertEqual(user["position"], "Analyst")
                self.assertEqual(user["permission_group"], "viewer")
                self.assertEqual(user["role"], "member")
                self.assertEqual(user["model_name"], "gpt-5.4")
                self.assertEqual(user["thinking_depth"], "low")
                self.assertNotIn("chat", user["permissions"])
                groups = {item["id"] for item in service.list_permission_groups(admin)}
                self.assertIn("admin", groups)
                self.assertIn("manager", groups)

                updated = service.update_user(
                    admin,
                    user["id"],
                    {
                        "position": "Engineering Manager",
                        "permission_group": "manager",
                        "model_name": "gpt-5.4",
                        "thinking_depth": "high",
                    },
                )
                self.assertEqual(updated["position"], "Engineering Manager")
                self.assertEqual(updated["permission_group"], "manager")
                self.assertIn("manage_knowledge", updated["permissions"])
                self.assertEqual(updated["model_name"], "gpt-5.4")
                self.assertEqual(updated["thinking_depth"], "high")

                with self.assertRaises(ServiceError) as model_error:
                    service.update_user(admin, user["id"], {"model_name": "not-in-catalog"})
                self.assertEqual(model_error.exception.status, 400)

                _, member_actor = service.authenticate("alice", "alice-pass")
                with self.assertRaises(ServiceError) as list_error:
                    service.list_users(member_actor)
                self.assertEqual(list_error.exception.status, 403)
                with self.assertRaises(ServiceError) as update_error:
                    service.update_user(member_actor, admin["id"], {"position": "Owner"})
                self.assertEqual(update_error.exception.status, 403)
            finally:
                service.close()

    def test_concurrent_admin_deactivation_preserves_one_active_admin(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, first = service.authenticate("admin", "admin")
                service.create_user(
                    username="second-admin",
                    password="second-admin-pass",
                    display_name="Second Admin",
                    permission_group="admin",
                    actor=first,
                )
                _, second = service.authenticate("second-admin", "second-admin-pass")
                barrier = threading.Barrier(3)
                outcomes: list[str] = []

                def deactivate(actor, target_id):
                    barrier.wait(timeout=5)
                    try:
                        service.update_user(actor, target_id, {"active": False})
                        outcomes.append("ok")
                    except ServiceError as exc:
                        outcomes.append(f"error:{exc.status}")

                threads = [
                    threading.Thread(target=deactivate, args=(first, second["id"])),
                    threading.Thread(target=deactivate, args=(second, first["id"])),
                ]
                for thread in threads:
                    thread.start()
                barrier.wait(timeout=5)
                for thread in threads:
                    thread.join(timeout=5)

                self.assertEqual(sorted(outcomes), ["error:400", "ok"])
                self.assertEqual(
                    service.db.scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1"),
                    1,
                )
            finally:
                service.close()

    def test_member_can_update_own_profile_and_change_password(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="alice",
                    password="alice-pass",
                    display_name="Alice",
                    position="Analyst",
                    permission_group="member",
                    actor=admin,
                )
                old_token, member_actor = service.authenticate("alice", "alice-pass")

                updated = service.update_current_user(
                    member_actor,
                    {
                        "display_name": "Alice B.",
                        "position": "Engineering",
                        "permission_group": "admin",
                        "active": False,
                    },
                )
                self.assertEqual(updated["display_name"], "Alice B.")
                self.assertEqual(updated["position"], "Engineering")
                self.assertEqual(updated["permission_group"], "member")
                self.assertTrue(updated["active"])

                with self.assertRaises(ServiceError) as wrong_password:
                    service.change_current_user_password(
                        member_actor,
                        {"current_password": "wrong-pass", "new_password": "new-alice-password"},
                    )
                self.assertEqual(wrong_password.exception.status, 400)
                self.assertIsNotNone(service.user_from_token(old_token))

                new_token, changed = service.change_current_user_password(
                    member_actor,
                    {"current_password": "alice-pass", "new_password": "new-alice-password"},
                )
                self.assertEqual(changed["id"], member["id"])
                self.assertIsNone(service.user_from_token(old_token))
                self.assertIsNotNone(service.user_from_token(new_token))
                with self.assertRaises(ServiceError) as old_login:
                    service.authenticate("alice", "alice-pass")
                self.assertEqual(old_login.exception.status, 401)
                _, fresh = service.authenticate("alice", "new-alice-password")
                self.assertEqual(fresh["display_name"], "Alice B.")
            finally:
                service.close()

    def test_account_model_and_thinking_depth_are_used_for_agent_calls(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="bob",
                    password="bob-pass",
                    display_name="Bob",
                    permission_group="member",
                    model_name="gpt-5.4",
                    thinking_depth="xhigh",
                    actor=admin,
                )
                _, bob = service.authenticate("bob", "bob-pass")

                result = service.send_private_message(bob, "draft a plan")
                self.assertIsNone(result["agent_message"])
                service.wait_for_agent_idle("private", str(bob["id"]))
                agent_message = service.list_messages(bob, "private", str(bob["id"]))[-1]

                self.assertEqual(agent.calls[-1]["model"], "gpt-5.4")
                self.assertEqual(agent.calls[-1]["thinking_depth"], "xhigh")
                self.assertEqual(agent.calls[-1]["reasoning_config"], {"enabled": True, "effort": "xhigh"})
                self.assertEqual(agent_message["metadata"]["generation"]["model"], "gpt-5.4")
                self.assertEqual(agent_message["metadata"]["generation"]["thinking_depth"], "xhigh")
            finally:
                service.close()

    def test_generation_falls_back_when_system_model_is_stale(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                service.set_setting(AGENT_SETTING_MODEL, "gpt-5.3-codex")

                result = service.send_private_message(admin, "draft a plan")
                self.assertIsNone(result["agent_message"])
                service.wait_for_agent_idle("private", str(admin["id"]))
                agent_message = service.list_messages(admin, "private", str(admin["id"]))[-1]

                self.assertEqual(agent.calls[-1]["model"], "gpt-5.5")
                self.assertEqual(agent_message["metadata"]["generation"]["model"], "gpt-5.5")
            finally:
                service.close()

    def test_admin_can_update_own_model_without_invalidating_session(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                token, admin = service.authenticate("admin", "admin")
                updated = service.update_user(
                    admin,
                    admin["id"],
                    {
                        "display_name": admin["display_name"],
                        "position": admin.get("position", ""),
                        "permission_group": "admin",
                        "model_name": "gpt-5.4",
                        "thinking_depth": admin.get("thinking_depth", "medium"),
                        "active": True,
                    },
                )
                self.assertEqual(updated["model_name"], "gpt-5.4")
                self.assertIsNotNone(service.user_from_token(token))
            finally:
                service.close()

    def test_viewer_permission_group_cannot_send_messages(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="viewer",
                    password="viewer-pass",
                    display_name="Viewer",
                    permission_group="viewer",
                    actor=admin,
                )
                _, viewer = service.authenticate("viewer", "viewer-pass")

                with self.assertRaises(ServiceError) as send_error:
                    service.send_channel_message(viewer, 1, "hello")
                self.assertEqual(send_error.exception.status, 403)
                with self.assertRaises(ServiceError) as private_error:
                    service.send_private_message(viewer, "hello")
                self.assertEqual(private_error.exception.status, 403)
            finally:
                service.close()

    def test_oauth_secret_keys_are_admin_configurable_but_not_model_env(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                keys = {item["key"] for item in service.list_secrets(admin)}

                self.assertIn("CODEX_OAUTH_ACCESS_TOKEN", keys)
                self.assertIn("CODEX_OAUTH_REFRESH_TOKEN", keys)
                self.assertIn("GROK_OAUTH_ACCESS_TOKEN", keys)
                self.assertIn("GROK_OAUTH_REFRESH_TOKEN", keys)
                self.assertIn("GROK_OAUTH_ID_TOKEN", keys)
                self.assertNotIn("OPENAI_API_KEY", keys)
                self.assertNotIn("XAI_API_KEY", keys)
                self.assertNotIn("XAI_OAUTH_REFRESH_TOKEN", keys)

                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access")
                self.assertNotIn("CODEX_OAUTH_ACCESS_TOKEN", service.model_secret_env())
                with self.assertRaises(ServiceError):
                    service.set_secret(admin, "OPENAI_API_KEY", "sk-test-value")
            finally:
                service.close()

    def test_agent_tool_token_protects_knowledge_endpoints(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            _, user = service.authenticate("admin", "admin")
            doc = service.add_knowledge_document(user, {"title": "Runbook", "content": "Restart service alpha."})

            self.assertFalse(service.validate_agent_tool_token("wrong"))
            self.assertTrue(service.validate_agent_tool_token("agent-token"))
            self.assertEqual(service.get_knowledge_document(doc["id"])["title"], "Runbook")
            service.close()



    def test_platform_manages_browser_and_firecrawl_process_lifecycle(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            config = replace(
                make_config(tmp),
                manage_agent_runtime=False,
                manage_searxng=True,
                runtime_startup_wait_seconds=0,
                camofox_command="managed-camofox-test",
            )
            launcher = RecordingLauncher()
            runner = RecordingCommandRunner()
            service = EnterpriseService(config, runtime_process_launcher=launcher, runtime_command_runner=runner)
            try:
                _, admin = service.authenticate("admin", "admin")
                status = service.runtime_status(admin)
                self.assertEqual(status["camofox"]["state"], "starting")
                self.assertEqual(status["searxng"]["state"], "starting")
                self.assertEqual(status["firecrawl"]["state"], "starting")
                commands = [call["cmd"] for call in launcher.calls]
                self.assertTrue(any(cmd == ["managed-camofox-test"] for cmd in commands))
                self.assertTrue(any(cmd[:2] == ["docker", "compose"] and "up" in cmd for cmd in commands))
                searxng_launch = next(
                    call
                    for call in launcher.calls
                    if call["cmd"][:2] == ["docker", "compose"]
                    and "ubitech-searxng-" in " ".join(call["cmd"])
                )
                firecrawl_launch = next(
                    call
                    for call in launcher.calls
                    if call["cmd"][:2] == ["docker", "compose"]
                    and "docker-compose.yml" in call["cmd"]
                )
                override_path = config.firecrawl_runtime_dir / "docker-compose.ubitech.yaml"
                self.assertIn(
                    str(
                        config.runtime_dir
                        / "searxng"
                        / "docker-compose.ubitech.yaml"
                    ),
                    searxng_launch["cmd"],
                )
                self.assertIn("docker-compose.yml", firecrawl_launch["cmd"])
                self.assertIn(str(override_path), firecrawl_launch["cmd"])
                self.assertIn("--no-build", firecrawl_launch["cmd"])
                self.assertIn("--pull", firecrawl_launch["cmd"])
                self.assertIn("missing", firecrawl_launch["cmd"])
                self.assertEqual(firecrawl_launch["env"]["DOCKER_BUILDKIT"], "1")
                self.assertEqual(firecrawl_launch["env"]["COMPOSE_DOCKER_CLI_BUILD"], "1")
                self.assertEqual(firecrawl_launch["env"]["PORT"], "127.0.0.1:13002")
                override_text = override_path.read_text(encoding="utf-8")
                self.assertIn("ghcr.io/firecrawl/firecrawl@sha256:", override_text)
                self.assertIn("ghcr.io/firecrawl/playwright-service@sha256:", override_text)
                self.assertIn("ghcr.io/firecrawl/nuq-postgres@sha256:", override_text)
                self.assertNotIn(":latest", override_text)

                service.restart_runtime(admin, "camofox")
                service.restart_runtime(admin, "searxng")
                service.restart_runtime(admin, "firecrawl")
                self.assertGreaterEqual(len([call for call in launcher.calls if call["cmd"] == ["managed-camofox-test"]]), 2)
                self.assertGreaterEqual(
                    len(
                        [
                            call
                            for call in launcher.calls
                            if "ubitech-searxng-" in " ".join(call["cmd"])
                            and "up" in call["cmd"]
                        ]
                    ),
                    2,
                )
                self.assertGreaterEqual(
                    len(
                        [
                            call
                            for call in launcher.calls
                            if "docker-compose.yml" in call["cmd"]
                            and "up" in call["cmd"]
                        ]
                    ),
                    2,
                )
            finally:
                service.close()

            self.assertTrue(all(not process.running for process in launcher.processes))

    def test_runtime_service_reads_cached_health_without_blocking_probes(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                cached_snapshot = {
                    name: {
                        "name": name,
                        "state": "cached",
                        "available": name == "agent",
                    }
                    for name in (
                        "agent",
                        "cognee",
                        "camofox",
                        "searxng",
                        "firecrawl",
                    )
                }
                cached_snapshot.update(
                    {"checked_at": 1_784_600_400, "stale": False}
                )
                with (
                    mock.patch.object(
                        service.runtimes,
                        "cached_status",
                        return_value=cached_snapshot,
                    ) as cached_status,
                    mock.patch.object(
                        service.runtimes,
                        "status",
                        side_effect=AssertionError("synchronous health probe"),
                    ),
                    mock.patch.object(
                        service.runtimes,
                        "agent_runtime_status",
                        side_effect=AssertionError("synchronous Agent health probe"),
                    ),
                ):
                    status = service.runtime_status(admin)
                    agent_config = service.agent_runtime_config(admin)

                self.assertEqual(
                    set(status),
                    {
                        "agent",
                        "cognee",
                        "camofox",
                        "searxng",
                        "firecrawl",
                    },
                )
                self.assertEqual(status["agent"]["state"], "cached")
                self.assertEqual(
                    {
                        key: value
                        for key, value in agent_config["runtime"].items()
                        if not key.startswith("status_")
                    },
                    cached_snapshot["agent"],
                )
                self.assertFalse(status["agent"]["status_stale"])
                self.assertEqual(
                    status["agent"]["status_checked_at"],
                    1_784_600_400,
                )
                self.assertEqual(cached_status.call_count, 2)
            finally:
                service.close()

    def test_searxng_runtime_actions_route_to_dedicated_lifecycle(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
            )
            runtime = SimpleNamespace(
                to_dict=lambda: {
                    "name": "searxng",
                    "state": "running",
                    "available": True,
                }
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                with (
                    mock.patch.object(
                        service.runtimes,
                        "restart_searxng",
                        return_value=runtime,
                    ) as restart,
                    mock.patch.object(
                        service.runtimes,
                        "ensure_searxng_ready",
                        return_value=runtime,
                    ) as ensure,
                ):
                    restarted = service.restart_runtime(admin, "searxng")
                    installed = service.install_runtime(admin, "searxng")

                restart.assert_called_once_with()
                ensure.assert_called_once_with(wait=True)
                self.assertEqual(restarted["runtime"]["name"], "searxng")
                self.assertEqual(installed["runtime"]["state"], "running")
            finally:
                service.close()

    def test_agent_tool_token_rotation_refreshes_owned_runtime_client(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                autostart_runtime=False,
            )
            try:
                _, admin = service.authenticate("admin", "admin")
                self.assertEqual(service.agent_client.gateway_token, "agent-token")

                service.set_secret(admin, "agent_tool_token", "rotated-agent-token")

                self.assertEqual(service.agent_client.gateway_token, "rotated-agent-token")
                self.assertFalse(service.validate_agent_tool_token("agent-token"))
                self.assertTrue(service.validate_agent_tool_token("rotated-agent-token"))
            finally:
                service.close()








    def test_cognee_internal_config_exposes_and_updates_managed_env(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_cognee_repo(tmp / "cognee")
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")

                current = service.cognee_config(admin)
                env_keys = {item["key"] for item in current["internal"]["env"]}
                self.assertIn("LLM_MODEL", env_keys)
                self.assertIn("VECTOR_DB_PROVIDER", env_keys)
                self.assertIn("DATA_ROOT_DIRECTORY", env_keys)

                updated = service.update_cognee_config(
                    admin,
                    {
                        "env": {
                            "LLM_MODEL": "openai/gpt-5-mini",
                            "VECTOR_DB_PROVIDER": "lancedb",
                            "LLM_API_KEY": "llm-secret",
                        }
                    },
                )
                env = {item["key"]: item for item in updated["internal"]["env"]}
                env_text = (tmp / "runtimes" / "cognee" / ".env").read_text(encoding="utf-8")

                self.assertEqual(env["LLM_MODEL"]["value"], "openai/gpt-5-mini")
                self.assertEqual(env["VECTOR_DB_PROVIDER"]["value"], "lancedb")
                self.assertEqual(env["LLM_API_KEY"]["value"], "")
                self.assertTrue(env["LLM_API_KEY"]["masked"])
                self.assertIn('LLM_MODEL="openai/gpt-5-mini"', env_text)
            finally:
                service.close()




    def test_api_providers_are_limited_to_codex_and_grok_oauth(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                status = service.oauth_provider_status(admin)
                self.assertEqual([item["id"] for item in status["providers"]], ["openai-codex", "xai-oauth"])
                self.assertEqual(status["active_provider"], "openai-codex")

                with self.assertRaises(ServiceError) as update_error:
                    service.update_agent_runtime_config(admin, {"provider": "openrouter"})
                self.assertEqual(update_error.exception.status, 400)

                with self.assertRaises(ServiceError) as key_error:
                    service.set_secret(admin, "XAI_API_KEY", "xai-key")
                self.assertEqual(key_error.exception.status, 400)
            finally:
                service.close()

    def test_agent_runtime_config_updates_and_validates_runtime_controls(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                updated = service.update_agent_runtime_config(
                    admin,
                    {
                        "provider": "grok-oauth",
                        "model": "grok-4.3",
                        "timeout_seconds": 321,
                        "max_concurrency": 4,
                        "compaction_threshold": 0.75,
                    },
                )["config"]

                self.assertEqual(updated["provider"], "xai-oauth")
                self.assertEqual(updated["model"], "grok-4.3")
                self.assertEqual(updated["timeout_seconds"], 321)
                self.assertEqual(updated["max_concurrency"], 4)
                self.assertEqual(updated["compaction_threshold"], 0.75)
                self.assertEqual(service.get_setting(AGENT_SETTING_PROVIDER), "xai-oauth")
                self.assertEqual(service.get_setting(AGENT_SETTING_MODEL), "grok-4.3")
                self.assertEqual(service.get_setting(AGENT_SETTING_TIMEOUT), "321.0")
                self.assertEqual(service.get_setting(AGENT_SETTING_MAX_CONCURRENCY), "4")
                self.assertEqual(service.get_setting(AGENT_SETTING_COMPACTION_THRESHOLD), "0.75")
                self.assertEqual(service._agent_run_gate.limit, 4)

                invalid_updates = (
                    {"provider": "openrouter"},
                    {"model": "not-in-catalog"},
                    {"timeout_seconds": 0},
                    {"timeout_seconds": 3601},
                    {"max_concurrency": 0},
                    {"max_concurrency": 65},
                    {"compaction_threshold": 0.49},
                    {"compaction_threshold": 0.96},
                )
                for body in invalid_updates:
                    with self.subTest(body=body), self.assertRaises(ServiceError) as ctx:
                        service.update_agent_runtime_config(admin, body)
                    self.assertEqual(ctx.exception.status, 400)

                before = {
                    key: service.get_setting(key)
                    for key in (
                        AGENT_SETTING_PROVIDER,
                        AGENT_SETTING_MODEL,
                        AGENT_SETTING_MAX_CONCURRENCY,
                    )
                }
                with self.assertRaises(ServiceError):
                    service.update_agent_runtime_config(
                        admin,
                        {
                            "provider": "openai-codex",
                            "model": "not-in-catalog",
                            "max_concurrency": 7,
                        },
                    )
                self.assertEqual(
                    {
                        key: service.get_setting(key)
                        for key in (
                            AGENT_SETTING_PROVIDER,
                            AGENT_SETTING_MODEL,
                            AGENT_SETTING_MAX_CONCURRENCY,
                        )
                    },
                    before,
                )
                self.assertEqual(service._agent_run_gate.limit, 4)
            finally:
                service.close()

    def test_agent_run_gate_resizes_up_and_down_without_interrupting_active_runs(self):
        gate = _ResizableConcurrencyGate(1)
        release_up = threading.Event()
        first_entered = threading.Event()
        second_entered = threading.Event()

        def hold(entered: threading.Event, release: threading.Event) -> None:
            with gate:
                entered.set()
                release.wait(2)

        first = threading.Thread(target=hold, args=(first_entered, release_up))
        second = threading.Thread(target=hold, args=(second_entered, release_up))
        first.start()
        self.assertTrue(first_entered.wait(1))
        second.start()
        self.assertFalse(second_entered.wait(0.05))
        gate.resize(2)
        self.assertTrue(second_entered.wait(1))
        release_up.set()
        first.join(1)
        second.join(1)

        gate.resize(2)
        releases = [threading.Event(), threading.Event(), threading.Event()]
        entered = [threading.Event(), threading.Event(), threading.Event()]
        workers = [
            threading.Thread(target=hold, args=(entered[index], releases[index]))
            for index in range(3)
        ]
        workers[0].start()
        workers[1].start()
        self.assertTrue(entered[0].wait(1))
        self.assertTrue(entered[1].wait(1))
        gate.resize(1)
        workers[2].start()
        self.assertFalse(entered[2].wait(0.05))
        releases[0].set()
        workers[0].join(1)
        self.assertFalse(entered[2].wait(0.05))
        releases[1].set()
        workers[1].join(1)
        self.assertTrue(entered[2].wait(1))
        releases[2].set()
        workers[2].join(1)
        self.assertTrue(all(not worker.is_alive() for worker in workers))

    def test_agent_run_gate_uses_persisted_and_canonical_fallback_limits(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                service.set_setting(AGENT_SETTING_MAX_CONCURRENCY, "12")
            finally:
                service.close()

            restarted = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                self.assertEqual(restarted._agent_run_gate.limit, 12)
                restarted.set_setting(AGENT_SETTING_MAX_CONCURRENCY, "invalid")
            finally:
                restarted.close()

            fallback = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                self.assertEqual(
                    fallback._agent_run_gate.limit,
                    fallback.runtimes.agent_runtime_config()["max_concurrency"],
                )
                self.assertEqual(fallback._agent_run_gate.limit, 8)
            finally:
                fallback.close()

    def test_agent_runtime_model_selection_uses_platform_catalog(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                config = service.agent_runtime_config(admin)["config"]
                self.assertEqual(
                    config["model_catalog"]["openai-codex"]["models"],
                    ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"],
                )

                with self.assertRaises(ServiceError) as ctx:
                    service.update_agent_runtime_config(admin, {"model": "not-in-catalog"})
                self.assertEqual(ctx.exception.status, 400)

                updated = service.update_agent_runtime_config(admin, {"model": "gpt-5.4"})
                self.assertEqual(updated["config"]["model"], "gpt-5.4")
            finally:
                service.close()

    def test_codex_guided_oauth_flow_stores_runtime_credentials(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
                oauth_http_client=FakeOAuthHTTPClient(),
            )
            try:
                _, admin = service.authenticate("admin", "admin")

                started = service.start_oauth_verification(admin, "openai-codex")
                flow = started["flow"]
                self.assertEqual(flow["kind"], "device_code")
                self.assertEqual(flow["user_code"], "CODE-1234")
                self.assertEqual(started["active_provider"], "openai-codex")

                completed = service.poll_oauth_verification(
                    admin,
                    "openai-codex",
                    {"flow_id": flow["flow_id"]},
                )
                self.assertTrue(completed["flow"]["complete"])
                self.assertEqual(service.get_secret("CODEX_OAUTH_ACCESS_TOKEN"), "codex-access")
                self.assertEqual(service.get_secret("CODEX_OAUTH_REFRESH_TOKEN"), "codex-refresh")
                self.assertEqual(service._active_oauth_provider(), "openai-codex")
                self.assertTrue(
                    next(
                        item
                        for item in completed["providers"]
                        if item["id"] == "openai-codex"
                    )["configured"]
                )
                self.assertFalse((service.config.managed_agent_runtime_home / "auth.json").exists())
            finally:
                service.close()



    def test_oauth_provider_status_uses_newer_settings_timestamp(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access")
                service.set_secret(admin, "CODEX_OAUTH_REFRESH_TOKEN", "codex-refresh")
                newer = 4_102_444_800
                service.db.execute(
                    "UPDATE settings SET updated_at = ? WHERE key = ?",
                    (newer, "CODEX_OAUTH_ACCESS_TOKEN"),
                )
                status = service.oauth_provider_status(admin)
                codex_status = next(item for item in status["providers"] if item["id"] == "openai-codex")
                self.assertEqual(codex_status["last_refresh"], newer)
            finally:
                service.close()

    def test_grok_guided_oauth_flow_accepts_pasted_callback_url(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            service = EnterpriseService(
                make_config(tmp),
                agent_client=RecordingAgent(),
                oauth_http_client=FakeOAuthHTTPClient(),
            )
            try:
                _, admin = service.authenticate("admin", "admin")

                started = service.start_oauth_verification(admin, "grok-oauth")
                flow = started["flow"]
                self.assertEqual(flow["kind"], "manual_callback")
                query = urllib.parse.parse_qs(urllib.parse.urlparse(flow["authorize_url"]).query)
                self.assertEqual(query["referrer"], ["ubitech-agent"])
                callback_url = f"{flow['redirect_uri']}?code=grok-code&state={query['state'][0]}"

                completed = service.complete_oauth_verification(
                    admin,
                    "xai-oauth",
                    {"flow_id": flow["flow_id"], "callback_url": callback_url},
                )
                self.assertTrue(completed["flow"]["complete"])
                self.assertEqual(service.get_secret("GROK_OAUTH_ACCESS_TOKEN"), "grok-access")
                self.assertEqual(service.get_secret("GROK_OAUTH_REFRESH_TOKEN"), "grok-refresh")
                self.assertEqual(service.get_secret("GROK_OAUTH_ID_TOKEN"), "grok-id")

                self.assertEqual(service._active_oauth_provider(), "xai-oauth")
                self.assertTrue(next(item for item in completed["providers"] if item["id"] == "xai-oauth")["configured"])
            finally:
                service.close()

    def test_oauth_credentials_export_import_roundtrip_restores_managed_state(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            source_dir = root / "source"
            target_dir = root / "target"
            source = EnterpriseService(
                make_config(source_dir),
                agent_client=RecordingAgent(),
                runtime_command_runner=RecordingCommandRunner(),
            )
            target = EnterpriseService(
                make_config(target_dir),
                agent_client=RecordingAgent(),
                runtime_command_runner=RecordingCommandRunner(),
            )
            try:
                _, source_admin = source.authenticate("admin", "admin")
                source.set_secret(source_admin, "CODEX_OAUTH_ACCESS_TOKEN", "codex-access")
                source.set_secret(source_admin, "CODEX_OAUTH_REFRESH_TOKEN", "codex-refresh")
                source.set_secret(source_admin, "GROK_OAUTH_ACCESS_TOKEN", "grok-access")
                source.set_secret(source_admin, "GROK_OAUTH_REFRESH_TOKEN", "grok-refresh")
                source.set_secret(source_admin, "GROK_OAUTH_ID_TOKEN", "grok-id")
                source.update_agent_runtime_config(source_admin, {"provider": "grok-oauth"})

                exported = source.export_oauth_credentials(source_admin)
                self.assertEqual(exported["kind"], "ubitech-agent.oauth-credentials")
                self.assertEqual(exported["version"], 1)
                self.assertEqual(exported["active_provider"], "xai-oauth")
                self.assertEqual(
                    exported["providers"]["openai-codex"]["credentials"]["CODEX_OAUTH_ACCESS_TOKEN"],
                    "codex-access",
                )
                self.assertEqual(
                    exported["providers"]["xai-oauth"]["credentials"]["GROK_OAUTH_ID_TOKEN"],
                    "grok-id",
                )
                self.assertNotIn("API_SERVER_KEY", json.dumps(exported))

                _, target_admin = target.authenticate("admin", "admin")
                imported = target.import_oauth_credentials(target_admin, {"credentials": exported})

                self.assertCountEqual(imported["imported"]["providers"], ["openai-codex", "xai-oauth"])
                self.assertEqual(imported["active_provider"], "xai-oauth")
                self.assertEqual(target.get_secret("CODEX_OAUTH_ACCESS_TOKEN"), "codex-access")
                self.assertEqual(target.get_secret("CODEX_OAUTH_REFRESH_TOKEN"), "codex-refresh")
                self.assertEqual(target.get_secret("GROK_OAUTH_ACCESS_TOKEN"), "grok-access")
                self.assertEqual(target.get_secret("GROK_OAUTH_REFRESH_TOKEN"), "grok-refresh")
                self.assertEqual(target.get_secret("GROK_OAUTH_ID_TOKEN"), "grok-id")

                self.assertEqual(target._active_oauth_provider(), "xai-oauth")
            finally:
                source.close()
                target.close()

    def test_oauth_credentials_import_rejects_incomplete_token_pairs(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                with self.assertRaises(ServiceError) as import_error:
                    service.import_oauth_credentials(
                        admin,
                        {
                            "credentials": {
                                "providers": {
                                    "openai-codex": {
                                        "credentials": {"CODEX_OAUTH_ACCESS_TOKEN": "codex-access"}
                                    }
                                }
                            }
                        },
                    )
                self.assertEqual(import_error.exception.status, 400)
            finally:
                service.close()

    def test_bootstrap_admin_password_is_generated_by_default(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(make_config(tmp), allow_insecure_bootstrap_password=False)
            service = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                password_path = tmp / BOOTSTRAP_ADMIN_PASSWORD_FILE
                self.assertTrue(password_path.exists())
                password = password_path.read_text(encoding="utf-8").strip()
                self.assertGreaterEqual(len(password), 24)
                with self.assertRaises(ServiceError) as login_error:
                    service.authenticate("admin", "admin")
                self.assertEqual(login_error.exception.status, 401)
                _, admin = service.authenticate("admin", password)
                self.assertEqual(admin["username"], "admin")
                if os.name != "nt":
                    self.assertEqual(password_path.stat().st_mode & 0o777, 0o600)
            finally:
                service.close()

    def test_login_failures_are_rate_limited_per_client(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                for _ in range(MAX_LOGIN_FAILURES):
                    with self.assertRaises(ServiceError) as login_error:
                        service.authenticate("admin", "wrong-password", client_id="198.51.100.10")
                    self.assertEqual(login_error.exception.status, 401)
                with self.assertRaises(ServiceError) as limited:
                    service.authenticate("admin", "admin", client_id="198.51.100.10")
                self.assertEqual(limited.exception.status, 429)

                _, admin = service.authenticate("admin", "admin", client_id="198.51.100.11")
                self.assertEqual(admin["username"], "admin")
            finally:
                service.close()

    def test_password_change_revokes_existing_sessions(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                token, admin = service.authenticate("admin", "admin")
                self.assertIsNotNone(service.user_from_token(token))
                service.update_user(admin, admin["id"], {"password": "new-strong-password"})
                # The previously issued token must no longer authenticate.
                self.assertIsNone(service.user_from_token(token))
                fresh_token, _ = service.authenticate("admin", "new-strong-password")
                self.assertIsNotNone(service.user_from_token(fresh_token))
            finally:
                service.close()

    def test_permission_change_and_explicit_revoke_invalidate_sessions(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                member = service.create_user(
                    username="member1", password="member-password", actor=admin, permission_group="member"
                )
                token, _ = service.authenticate("member1", "member-password")
                self.assertIsNotNone(service.user_from_token(token))
                # Downgrading the permission group invalidates the live token.
                service.update_user(admin, member["id"], {"permission_group": "viewer"})
                self.assertIsNone(service.user_from_token(token))
                # Explicit revoke also invalidates a fresh token.
                token2, _ = service.authenticate("member1", "member-password")
                self.assertIsNotNone(service.user_from_token(token2))
                service.revoke_user_sessions(member["id"])
                self.assertIsNone(service.user_from_token(token2))
            finally:
                service.close()

    def test_tampered_and_expired_tokens_are_rejected(self):
        from enterprise_agent_platform.auth import TokenSigner

        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                token, _ = service.authenticate("admin", "admin")
                self.assertIsNone(service.user_from_token(token + "tamper"))
                self.assertIsNone(service.user_from_token("not.a.valid.token"))
                self.assertIsNone(service.user_from_token(""))
                secret = service.get_secret("ENTERPRISE_SESSION_SECRET")
                self.assertTrue(secret)
                expired = TokenSigner(secret, ttl_seconds=-10).issue(1, 1)
                self.assertIsNone(service.user_from_token(expired))
            finally:
                service.close()

    def test_database_handles_concurrent_threads(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                errors: list[Exception] = []

                def worker(n: int) -> None:
                    try:
                        for i in range(20):
                            service.db.execute(
                                "INSERT INTO messages(scope_type, scope_id, author_type, user_id, "
                                "username, content, created_at) VALUES ('channel', ?, 'system', NULL, '', ?, ?)",
                                (f"t{n}", f"msg-{n}-{i}", 0),
                            )
                            service.db.query("SELECT COUNT(*) FROM messages")
                    except Exception as exc:  # noqa: BLE001 - recorded for assertion
                        errors.append(exc)

                workers = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
                for t in workers:
                    t.start()
                for t in workers:
                    t.join(timeout=30)
                self.assertEqual(errors, [])
                total = service.db.scalar("SELECT COUNT(*) FROM messages WHERE author_type = 'system'")
                self.assertEqual(total, 8 * 20)
            finally:
                service.close()

    def test_database_rejects_use_after_close(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            db = service.db
            service.close()
            # After close, a lingering caller gets a clean error, not an
            # AttributeError from a None connection.
            with self.assertRaises(sqlite3.ProgrammingError):
                db.query("SELECT 1")

    def test_agent_queue_depth_is_capped(self):
        from enterprise_agent_platform.service import MAX_AGENT_QUEUE_DEPTH

        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                service.send_private_message(user, "first")
                self.assertTrue(agent.started.wait(timeout=5))
                # The first task is now held in the worker; fill the queue to the
                # cap, then the next enqueue must be rejected rather than growing
                # memory without bound.
                for i in range(MAX_AGENT_QUEUE_DEPTH):
                    service.send_private_message(user, f"queued-{i}")
                with self.assertRaises(ServiceError) as ctx:
                    service.send_private_message(user, "overflow")
                self.assertEqual(ctx.exception.status, 429)
            finally:
                agent.release.set()
                service.close()

    def test_runtime_needs_review_does_not_mark_agent_job_succeeded(self):
        with tempfile.TemporaryDirectory() as td:
            agent = NeedsReviewAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, user = service.authenticate("admin", "admin")
                sent = service.send_private_message(user, "perform a side-effectful task")
                service.wait_for_agent_idle("private", str(user["id"]), timeout=5)

                job = service.jobs.get_by_key(
                    "agent", f"message:{sent['user_message']['id']}"
                )
                self.assertIsNotNone(job)
                self.assertEqual(job.status, "needs_review")
                self.assertNotEqual(job.status, "succeeded")

                messages = service.audit_private_messages(user, user["id"])["messages"]
                agent_messages = [message for message in messages if message["author_type"] == "agent"]
                self.assertEqual(len(agent_messages), 1)
                self.assertIn("Agent 回复失败", agent_messages[0]["content"])
                self.assertIn("needs_review", agent_messages[0]["metadata"]["error"])
                self.assertNotIn("partial output must not be committed", agent_messages[0]["content"])
                self.assertEqual(
                    service.jobs.counts(
                        kind="agent", scope_type="private", scope_id=str(user["id"])
                    )["needs_review"],
                    1,
                )
            finally:
                service.close()

    def test_durable_agent_jobs_recover_queued_and_quarantine_interrupted_work(self):
        from enterprise_agent_platform.db import Database
        from enterprise_agent_platform.jobs import DurableJobStore

        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            seed = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                _, user = seed.authenticate("admin", "admin")
                generation = seed.account_generation_config(user)
                messages = []
                for content in ("recover me", "do not repeat me"):
                    messages.append(
                        seed._append_message(
                            scope_type="private",
                            scope_id=str(user["id"]),
                            author_type="user",
                            user_id=user["id"],
                            username=user["display_name"],
                            content=content,
                            metadata={"generation": generation},
                        )
                    )
            finally:
                seed.close()

            db = Database(config.db_path)
            ledger = DurableJobStore(db)
            jobs = []
            for message in messages:
                job, _ = ledger.enqueue(
                    kind="agent",
                    dedupe_key=f"message:{message['id']}",
                    scope_type="private",
                    scope_id=str(user["id"]),
                    payload={
                        "scope_type": "private",
                        "scope_id": str(user["id"]),
                        "actor": user,
                        "content": message["content"],
                        "attachments": [],
                        "generation": generation,
                        "user_message": message,
                    },
                )
                jobs.append(job)
            ledger.mark_running(jobs[1].id, lease_seconds=3600)
            db.close()

            agent = RecordingAgent()
            recovered = EnterpriseService(config, agent_client=agent)
            try:
                recovered.wait_for_agent_idle("private", str(user["id"]), timeout=5)
                self.assertEqual([call["user_message"] for call in agent.calls], ["recover me"])
                self.assertEqual(recovered.jobs.get(jobs[0].id).status, "succeeded")
                self.assertEqual(recovered.jobs.get(jobs[1].id).status, "needs_review")
                status = recovered.private_status(user)
                self.assertEqual(status["jobs"]["succeeded"], 1)
                self.assertEqual(status["jobs"]["needs_review"], 1)
            finally:
                recovered.close()

    def test_startup_restores_failed_agent_error_message_after_transient_write_failure(self):
        class FailingAgent:
            def generate(self, **kwargs):
                raise RuntimeError("provider unavailable")

        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = EnterpriseService(config, agent_client=FailingAgent())
            try:
                _, user = first.authenticate("admin", "admin")
                with mock.patch.object(
                    first,
                    "_append_agent_error",
                    side_effect=OSError("simulated message write failure"),
                ):
                    sent = first.send_private_message(user, "show a durable failure")
                    first.wait_for_agent_idle("private", str(user["id"]), timeout=3)
                job = first.jobs.get_by_key("agent", f"message:{sent['user_message']['id']}")
                self.assertIsNotNone(job)
                self.assertEqual(job.status, "failed")
                self.assertIsNone(
                    first.agent_message_replying_to("private", str(user["id"]), sent["user_message"]["id"])
                )
            finally:
                first.close()

            agent = RecordingAgent()
            second = EnterpriseService(config, agent_client=agent)
            try:
                reply = second.agent_message_replying_to(
                    "private",
                    str(user["id"]),
                    sent["user_message"]["id"],
                )
                self.assertIsNotNone(reply)
                self.assertIn("provider unavailable", reply["content"])
                self.assertEqual(reply["metadata"]["durable_job_id"], job.id)
                self.assertEqual(agent.calls, [])
            finally:
                second.close()

    def test_startup_reconciles_committed_success_before_job_terminal_update(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            first = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                _, user = first.authenticate("admin", "admin")
                generation = first.account_generation_config(user)
                user_message = first._append_message(
                    scope_type="private",
                    scope_id=str(user["id"]),
                    author_type="user",
                    user_id=user["id"],
                    username=user["display_name"],
                    content="already completed",
                    metadata={"generation": generation},
                )
                task = {
                    "scope_type": "private",
                    "scope_id": str(user["id"]),
                    "actor": user,
                    "content": user_message["content"],
                    "attachments": [],
                    "generation": generation,
                    "user_message": user_message,
                }
                job, _ = first.jobs.enqueue(
                    kind="agent",
                    dedupe_key=f"message:{user_message['id']}",
                    payload=task,
                    scope_type="private",
                    scope_id=str(user["id"]),
                )
                self.assertIsNotNone(first.jobs.mark_running(job.id, lease_seconds=60))
                first._append_message(
                    scope_type="private",
                    scope_id=str(user["id"]),
                    author_type="agent",
                    user_id=None,
                    username="Private Agent",
                    content="committed response",
                    metadata={
                        "durable_job_id": job.id,
                        "reply_to": {"message_id": user_message["id"]},
                        "agent_work": {"state": "complete"},
                    },
                )
            finally:
                first.close()

            agent = RecordingAgent()
            second = EnterpriseService(config, agent_client=agent)
            try:
                self.assertEqual(second.jobs.get(job.id).status, "succeeded")
                replies = second.db.query(
                    "SELECT content FROM messages WHERE author_type = 'agent' ORDER BY id"
                )
                self.assertEqual(replies, [{"content": "committed response"}])
                self.assertEqual(agent.calls, [])
            finally:
                second.close()

    def test_startup_recovers_grouped_input_ledgers_and_one_interruption_reply(self):
        def seed_group(config, *, committed):
            first = EnterpriseService(config, agent_client=RecordingAgent())
            _, user = first.authenticate("admin", "admin")
            generation = first.account_generation_config(user)
            messages = []
            for index, content in enumerate(("root request", "joined correction"), start=101):
                messages.append(
                    first._append_message(
                        scope_type="private",
                        scope_id=str(user["id"]),
                        author_type="user",
                        user_id=user["id"],
                        username=user["display_name"],
                        content=content,
                        metadata={
                            "generation": generation,
                            "telegram_delivery": {
                                "chat_id": 999,
                                "reply_to_message_id": index,
                                "message_thread_id": None,
                            },
                        },
                    )
                )
            tasks = [
                {
                    "scope_type": "private",
                    "scope_id": str(user["id"]),
                    "actor": user,
                    "content": message["content"],
                    "attachments": [],
                    "generation": generation,
                    "user_message": message,
                }
                for message in messages
            ]
            jobs = []
            for task, message in zip(tasks, messages):
                job, _ = first.jobs.enqueue(
                    kind="agent",
                    dedupe_key=f"message:{message['id']}",
                    payload=task,
                    scope_type="private",
                    scope_id=str(user["id"]),
                )
                jobs.append(job)
            first.jobs.mark_running(jobs[0].id, lease_seconds=60)
            group_id = f"agent:{jobs[0].id}"
            first.agent_inputs.start_root(
                message_id=messages[0]["id"],
                job_id=jobs[0].id,
                input_group_id=group_id,
            )
            first.agent_inputs.reserve_and_claim(
                message_id=messages[1]["id"],
                job_id=jobs[1].id,
                parent_job_id=jobs[0].id,
                input_group_id=group_id,
                lease_seconds=60,
            )
            first.agent_inputs.transition(
                messages[1]["id"],
                "injected",
                allowed_from=("reserved",),
                runtime_run_id="interrupted-run",
            )
            if committed:
                first._append_message(
                    scope_type="private",
                    scope_id=str(user["id"]),
                    author_type="agent",
                    user_id=None,
                    username="Private Agent",
                    content="committed grouped response",
                    metadata={
                        "input_group_id": group_id,
                        "processing_mode": "started",
                        "reply_to_message_ids": [message["id"] for message in messages],
                        "durable_job_ids": [job.id for job in jobs],
                        "durable_job_id": jobs[0].id,
                        "reply_to": {"message_id": messages[0]["id"]},
                        "agent_work": {"state": "complete"},
                    },
                )
            first.close()
            return user, messages, jobs

        with tempfile.TemporaryDirectory() as committed_dir:
            config = make_config(Path(committed_dir))
            user, messages, jobs = seed_group(config, committed=True)
            recovered = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                self.assertEqual(
                    [recovered.jobs.get(job.id).status for job in jobs],
                    ["succeeded", "succeeded"],
                )
                self.assertEqual(
                    [
                        recovered.agent_inputs.get_by_message(message["id"]).state
                        for message in messages
                    ],
                    ["succeeded", "succeeded"],
                )
            finally:
                recovered.close()

        with tempfile.TemporaryDirectory() as interrupted_dir:
            config = make_config(Path(interrupted_dir))
            user, messages, jobs = seed_group(config, committed=False)
            recovered = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                replies = [
                    message
                    for message in recovered.audit_private_messages(
                        user,
                        user["id"],
                    )["messages"]
                    if message["author_type"] == "agent"
                ]
                self.assertEqual(len(replies), 1)
                self.assertEqual(
                    replies[0]["metadata"]["reply_to_message_ids"],
                    [message["id"] for message in messages],
                )
                owner_id, target = recovered._telegram_delivery_owner_for_agent_message(
                    replies[0]
                )
                self.assertEqual(owner_id, messages[1]["id"])
                self.assertEqual(target["reply_to_message_id"], 102)
                self.assertEqual(
                    [recovered.jobs.get(job.id).status for job in jobs],
                    ["needs_review", "needs_review"],
                )
                self.assertEqual(
                    [
                        recovered.agent_inputs.get_by_message(message["id"]).state
                        for message in messages
                    ],
                    ["needs_review", "needs_review"],
                )
            finally:
                recovered.close()

    def test_startup_repairs_user_message_committed_before_agent_job(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            seed = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                _, user = seed.authenticate("admin", "admin")
                generation = seed.account_generation_config(user)
                orphan = seed._append_message(
                    scope_type="private",
                    scope_id=str(user["id"]),
                    author_type="user",
                    user_id=user["id"],
                    username=user["display_name"],
                    content="recover the commit gap",
                    metadata={
                        "generation": generation,
                        "agent_request_content": "recover the commit gap",
                    },
                )
                self.assertIsNone(seed.jobs.get_by_key("agent", f"message:{orphan['id']}"))
            finally:
                seed.close()

            agent = RecordingAgent()
            recovered = EnterpriseService(config, agent_client=agent)
            try:
                recovered.wait_for_agent_idle("private", str(user["id"]), timeout=5)
                self.assertEqual([call["user_message"] for call in agent.calls], ["recover the commit gap"])
                job = recovered.jobs.get_by_key("agent", f"message:{orphan['id']}")
                self.assertIsNotNone(job)
                self.assertEqual(job.status, "succeeded")
                reply = recovered.agent_message_replying_to("private", str(user["id"]), orphan["id"])
                self.assertIsNotNone(reply)
            finally:
                recovered.close()

    def test_cognee_ingest_runs_in_background(self):
        from enterprise_agent_platform.cognee_bridge import CogneeStatus

        with tempfile.TemporaryDirectory() as td:
            config = replace(make_config(Path(td)), knowledge_backend="hybrid")
            service = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                done = threading.Event()
                calls: list[str] = []

                class FakeCognee:
                    def ingest_document(self, *, title, content, source=""):
                        calls.append(title)
                        done.set()
                        return {"attempted": True, "available": True, "dataset": "x"}

                    def search(self, query, limit=5):
                        return []

                    def status(self):
                        return CogneeStatus(True, "hybrid")

                service.cognee = FakeCognee()
                _, user = service.authenticate("admin", "admin")
                doc = service.add_knowledge_document(user, {"title": "Async Doc", "content": "body"})
                # The request returns immediately with a "queued" marker.
                self.assertTrue(doc["cognee"].get("queued"))
                # The heavy ingest happens on the background worker.
                self.assertTrue(done.wait(timeout=5))
                self.assertEqual(calls, ["Async Doc"])
                result = service.cognee_ingest_result(doc["id"])
                self.assertTrue(result and result.get("available"))
            finally:
                service.close()

    def test_cognee_bridge_waits_for_cognify_inside_platform_worker(self):
        from enterprise_agent_platform.cognee_bridge import CogneeBridge, CogneeStatus

        class FakeCognee:
            def __init__(self):
                self.background_flags = []

            async def add(self, payload, *, dataset_name, run_in_background):
                self.background_flags.append(("add", run_in_background))
                return {"added": True}

            async def cognify(self, *, datasets, run_in_background):
                self.background_flags.append(("cognify", run_in_background))
                return {"completed": True}

        with tempfile.TemporaryDirectory() as td:
            config = replace(make_config(Path(td)), knowledge_backend="hybrid", cognee_ingest_background=True)
            bridge = CogneeBridge(config, lambda key: "")
            fake = FakeCognee()
            bridge._module = fake
            bridge._status = CogneeStatus(True, "hybrid")
            bridge._status_checked_at = time.time()

            result = bridge.ingest_document(title="Policy", content="Body", source="test")

            self.assertNotIn("error", result)
            self.assertEqual(fake.background_flags, [("add", False), ("cognify", False)])

    def test_channel_and_private_reads_enforce_authorization(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                alice = service.create_user(
                    username="alice", password="alice-password", actor=admin, permission_group="member"
                )
                bob = service.create_user(
                    username="bob", password="bob-password", actor=admin, permission_group="member"
                )
                service.send_private_message(alice, "alice secret")
                # Bob must not be able to read Alice's private conversation.
                with self.assertRaises(ServiceError) as ctx:
                    service.list_messages(bob, "private", str(alice["id"]))
                self.assertEqual(ctx.exception.status, 403)
                # Alice can read her own private conversation.
                own = service.list_messages(alice, "private", str(alice["id"]))
                self.assertTrue(any(m["content"] == "alice secret" for m in own))
                # A permissionless actor cannot read channel history.
                with self.assertRaises(ServiceError) as ctx2:
                    service.list_messages({"id": 0}, "channel", "1")
                self.assertEqual(ctx2.exception.status, 403)
                # A member with read_workspace can read the channel.
                self.assertIsInstance(service.list_messages(alice, "channel", "1"), list)
            finally:
                service.close()

    def test_knowledge_reads_require_read_permission(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                doc = service.add_knowledge_document(admin, {"title": "Policy", "content": "secret policy"})
                for call in (
                    lambda: service.list_knowledge_documents({"id": 0}),
                    lambda: service.user_search_knowledge({"id": 0}, "policy"),
                    lambda: service.user_knowledge_document({"id": 0}, doc["id"]),
                ):
                    with self.assertRaises(ServiceError) as ctx:
                        call()
                    self.assertEqual(ctx.exception.status, 403)
                # The token-gated agent-tool path still resolves documents.
                self.assertEqual(service.get_knowledge_document(doc["id"])["title"], "Policy")
            finally:
                service.close()

    def test_knowledge_status_reports_fts_and_ingest_state(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                status = service.knowledge_status()
                self.assertTrue(status["local"]["available"])
                self.assertEqual(status["local"]["fts5"], service.db.fts_available)
                self.assertEqual(status["local"]["backend"], "sqlite-fts" if service.db.fts_available else "sqlite-like")
                self.assertIn("ingest_pending", status)
                self.assertEqual(status["mode"], "local")
            finally:
                service.close()

    def test_host_backend_never_provisions_agent_container(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
            )
            try:
                scope = service.agent_scopes.ensure_private_scope(1)
                self.assertEqual(scope.to_execution_dict()["backend"], "host")
            finally:
                service.close()

    def test_browser_tool_binds_every_tab_operation_to_the_agent_scope(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            calls: list[dict[str, object]] = []

            def record_request(url, body, *, headers, timeout, method="POST"):
                calls.append({
                    "url": url,
                    "body": body,
                    "headers": headers,
                    "timeout": timeout,
                    "method": method,
                })
                if url.endswith("/tabs") and method == "POST":
                    return {"tabId": "created-tab", "url": body.get("url", "about:blank")}
                if "/stats?" in url:
                    return {"ok": True, "url": "https://example.com"}
                if "/snapshot?" in url:
                    return {"url": "https://example.com", "snapshot": "- heading Example", "refsCount": 1}
                return {"ok": True}

            service._runtime_json_request = record_request
            service._validate_browser_url = lambda _value: None
            service.runtimes.ensure_camofox_ready = lambda **_kwargs: SimpleNamespace(
                available=True,
                error="",
            )
            try:
                scope = service.agent_scopes.ensure_private_scope(1)
                expected_user_id = "agent-" + hashlib.sha256(
                    scope.scope_key.encode("utf-8")
                ).hexdigest()[:24]

                service._agent_browser_tool(
                    scope.scope_key,
                    "navigate",
                    {"url": "https://example.com"},
                )
                create_call = next(call for call in calls if call["url"].endswith("/tabs"))
                self.assertEqual(
                    create_call["body"],
                    {
                        "userId": expected_user_id,
                        "sessionKey": "agent",
                        "url": "https://example.com",
                    },
                )

                service._agent_browser_tool(
                    scope.scope_key,
                    "click",
                    {"tab_id": "tab/one", "ref": "@e1", "userId": "attacker"},
                )
                click_call = next(call for call in calls if "/tabs/tab%2Fone/click" in call["url"])
                self.assertEqual(click_call["body"]["userId"], expected_user_id)
                self.assertEqual(click_call["body"]["ref"], "e1")
                self.assertNotIn("tab_id", click_call["body"])

                service._agent_browser_tool(
                    scope.scope_key,
                    "snapshot",
                    {"tab_id": "tab-1"},
                )
                self.assertEqual(calls[-1]["method"], "GET")
                self.assertIsNone(calls[-1]["body"])
                self.assertIn(
                    urllib.parse.urlencode({"userId": expected_user_id}),
                    calls[-1]["url"],
                )
            finally:
                service.close()

    def test_browser_tool_exposes_full_camoufox_actions_and_binary_vision(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            calls: list[dict[str, object]] = []
            binary_urls: list[str] = []

            def record_request(url, body, *, headers, timeout, method="POST"):
                calls.append({"url": url, "body": body, "method": method})
                if url.endswith("/tabs"):
                    return {"tabId": "created-tab", "url": "about:blank"}
                if "/snapshot?" in url:
                    return {"url": "http://127.0.0.1/page", "snapshot": "- heading Page", "refsCount": 1}
                return {"ok": True, "url": "http://127.0.0.1/page"}

            service._runtime_json_request = record_request

            def record_binary_request(url, **_kwargs):
                binary_urls.append(url)
                return b"\x89PNG\r\n\x1a\nfixture", "image/png"

            service._runtime_binary_request = record_binary_request
            service._validate_browser_url = lambda _value: None
            service.runtimes.ensure_camofox_ready = lambda **_kwargs: SimpleNamespace(
                available=True,
                error="",
            )
            try:
                scope = service.agent_scopes.ensure_private_scope(1)
                tab = {"tab_id": "tab/full"}
                service._agent_browser_tool(scope.scope_key, "new_tab", {"trace": True})
                for action, arguments in (
                    ("wait", {**tab, "timeout": 1000, "wait_for_network": False}),
                    ("forward", tab),
                    ("refresh", tab),
                    ("viewport", {**tab, "width": 1024, "height": 768}),
                    ("links", {**tab, "limit": 10}),
                    ("images", {**tab, "limit": 4}),
                    ("downloads", tab),
                    ("stats", tab),
                    ("extract", {**tab, "schema": {"type": "object"}}),
                ):
                    service._agent_browser_tool(scope.scope_key, action, arguments)

                vision = service._agent_browser_tool(
                    scope.scope_key,
                    "vision",
                    {
                        **tab,
                        "question": "What is visible?",
                        "full_page": True,
                        "fullPage": True,
                    },
                )
                console = service._agent_browser_tool(scope.scope_key, "console", tab)
                with self.assertRaises(ServiceError) as console_evaluate:
                    service._agent_browser_tool(
                        scope.scope_key,
                        "console",
                        {**tab, "expression": "document.title"},
                    )
                with self.assertRaises(ServiceError) as direct_evaluate:
                    service._agent_browser_tool(
                        scope.scope_key,
                        "evaluate",
                        {**tab, "expression": "document.title"},
                    )

                urls = [str(call["url"]) for call in calls]
                for route in (
                    "/wait", "/forward", "/refresh", "/viewport", "/links?",
                    "/images?", "/downloads?", "/stats?", "/extract",
                ):
                    self.assertTrue(any(route in url for url in urls), route)
                wait_call = next(call for call in calls if str(call["url"]).endswith("/wait"))
                self.assertFalse(wait_call["body"]["waitForNetwork"])
                self.assertNotIn("wait_for_network", wait_call["body"])
                downloads_call = next(call for call in calls if "/downloads?" in str(call["url"]))
                self.assertIn("consume=false", str(downloads_call["url"]))
                self.assertEqual(vision["screenshot"]["mimeType"], "image/png")
                self.assertEqual(base64.b64decode(vision["screenshot"]["data"]), b"\x89PNG\r\n\x1a\nfixture")
                self.assertEqual(len(binary_urls), 1)
                screenshot_query = urllib.parse.parse_qs(
                    urllib.parse.urlparse(binary_urls[0]).query
                )
                self.assertEqual(screenshot_query["fullPage"], ["false"])
                self.assertFalse(console["supported"])
                self.assertEqual(console_evaluate.exception.status, 400)
                self.assertEqual(direct_evaluate.exception.status, 400)
                self.assertFalse(any("trace" in (call.get("body") or {}) for call in calls))
            finally:
                service.close()

    def test_browser_navigate_without_tab_id_reuses_the_current_tab(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            calls: list[dict[str, object]] = []

            def record_request(url, body, *, headers, timeout, method="POST"):
                calls.append({"url": url, "body": body, "method": method})
                if "/tabs?" in url and method == "GET":
                    return {
                        "tabs": [
                            {"tabId": "existing/tab", "url": "http://127.0.0.1/old"},
                        ],
                    }
                if "/stats?" in url:
                    return {"url": "http://127.0.0.1/new"}
                if url.endswith("/navigate"):
                    return {"ok": True, "url": "http://127.0.0.1/new"}
                if "/snapshot?" in url:
                    return {
                        "url": "http://127.0.0.1/new",
                        "snapshot": "- heading New",
                        "refsCount": 1,
                    }
                return {"ok": True}

            service._runtime_json_request = record_request
            service.runtimes.ensure_camofox_ready = lambda **_kwargs: SimpleNamespace(
                available=True,
                error="",
            )
            try:
                scope = service.agent_scopes.ensure_private_scope(1)
                result = service._agent_browser_tool(
                    scope.scope_key,
                    "navigate",
                    {"url": "http://127.0.0.1/new"},
                )

                self.assertFalse(any(call["url"].endswith("/tabs") for call in calls))
                navigate = next(call for call in calls if str(call["url"]).endswith("/navigate"))
                self.assertIn("/tabs/existing%2Ftab/navigate", str(navigate["url"]))
                self.assertEqual(result["snapshot"], "- heading New")
            finally:
                service.close()

    def test_browser_current_tab_is_tracked_per_scope_and_falls_back_when_stale(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            calls: list[dict[str, object]] = []
            live_tabs: dict[str, list[dict[str, str]]] = {}

            def record_request(url, body, *, headers, timeout, method="POST"):
                calls.append({"url": url, "body": body, "method": method})
                parsed = urllib.parse.urlparse(url)
                if parsed.path.endswith("/tabs") and method == "GET":
                    user_id = urllib.parse.parse_qs(parsed.query)["userId"][0]
                    return {"tabs": list(live_tabs[user_id])}
                if "/stats?" in url:
                    return {"url": "http://127.0.0.1/current"}
                if "/snapshot?" in url:
                    return {
                        "url": "http://127.0.0.1/current",
                        "snapshot": "- heading Current",
                        "refsCount": 1,
                    }
                return {"ok": True}

            service._runtime_json_request = record_request
            service.runtimes.ensure_camofox_ready = lambda **_kwargs: SimpleNamespace(
                available=True,
                error="",
            )
            service.runtimes.camofox_status = lambda **_kwargs: SimpleNamespace(
                available=True,
            )
            try:
                first_scope = service.agent_scopes.ensure_private_scope(1)
                second_scope = service.agent_scopes.ensure_channel_scope(1)
                first_user_id = "agent-" + hashlib.sha256(
                    first_scope.scope_key.encode("utf-8")
                ).hexdigest()[:24]
                second_user_id = "agent-" + hashlib.sha256(
                    second_scope.scope_key.encode("utf-8")
                ).hexdigest()[:24]
                live_tabs[first_user_id] = [
                    {"tabId": "first-current"},
                    {"tabId": "first-newest"},
                ]
                live_tabs[second_user_id] = [
                    {"tabId": "second-current"},
                    {"tabId": "second-newest"},
                ]

                service._agent_browser_tool(
                    first_scope.scope_key,
                    "snapshot",
                    {"tab_id": "first-current"},
                )
                service._agent_browser_tool(
                    second_scope.scope_key,
                    "snapshot",
                    {"tab_id": "second-current"},
                )

                calls.clear()
                service._agent_browser_tool(first_scope.scope_key, "snapshot", {})
                service._agent_browser_tool(second_scope.scope_key, "snapshot", {})
                snapshot_urls = [
                    str(call["url"])
                    for call in calls
                    if "/snapshot?" in str(call["url"])
                ]
                self.assertTrue(any("/tabs/first-current/snapshot?" in url for url in snapshot_urls))
                self.assertTrue(any("/tabs/second-current/snapshot?" in url for url in snapshot_urls))
                self.assertFalse(any("newest/snapshot?" in url for url in snapshot_urls))

                live_tabs[first_user_id] = [
                    {"tabId": "first-older"},
                    {"tabId": "first-fallback"},
                ]
                calls.clear()
                service._agent_browser_tool(first_scope.scope_key, "snapshot", {})
                fallback_snapshot = next(
                    str(call["url"])
                    for call in calls
                    if "/snapshot?" in str(call["url"])
                )
                self.assertIn("/tabs/first-fallback/snapshot?", fallback_snapshot)

                service._agent_browser_tool(
                    first_scope.scope_key,
                    "close",
                    {"tab_id": "first-fallback"},
                )
                self.assertNotIn(
                    first_scope.scope_key,
                    service._agent_browser_current_tabs,
                )
                service._agent_browser_tool(second_scope.scope_key, "cleanup", {})
                self.assertNotIn(
                    second_scope.scope_key,
                    service._agent_browser_current_tabs,
                )
            finally:
                service.close()

    def test_browser_page_url_guard_runs_before_and_after_actions(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            calls: list[dict[str, object]] = []
            stats_urls: list[str] = []

            def record_request(url, body, *, headers, timeout, method="POST"):
                calls.append({"url": url, "body": body, "method": method})
                if "/stats?" in url:
                    return {"url": stats_urls.pop(0)}
                if url.endswith("/click"):
                    return {"ok": True}
                if "/snapshot?" in url:
                    return {
                        "url": "http://127.0.0.1/safe",
                        "snapshot": "- heading Safe",
                        "refsCount": 1,
                    }
                return {"ok": True}

            service._runtime_json_request = record_request
            service.runtimes.ensure_camofox_ready = lambda **_kwargs: SimpleNamespace(
                available=True,
                error="",
            )
            try:
                scope = service.agent_scopes.ensure_private_scope(1)
                metadata_url = "http://169.254.169.254/latest/meta-data"

                stats_urls[:] = [metadata_url]
                with self.assertRaises(ServiceError) as preflight:
                    service._agent_browser_tool(
                        scope.scope_key,
                        "snapshot",
                        {"tab_id": "guarded"},
                    )
                self.assertEqual(preflight.exception.status, 403)
                self.assertFalse(any("/snapshot?" in str(call["url"]) for call in calls))

                calls.clear()
                stats_urls[:] = ["http://127.0.0.1/safe", metadata_url]
                with self.assertRaises(ServiceError) as postflight:
                    service._agent_browser_tool(
                        scope.scope_key,
                        "click",
                        {"tab_id": "guarded", "ref": "e1"},
                    )
                self.assertEqual(postflight.exception.status, 403)
                self.assertTrue(any(str(call["url"]).endswith("/click") for call in calls))
                self.assertEqual(len([call for call in calls if "/stats?" in str(call["url"])]), 2)
            finally:
                service.close()

    def test_browser_gateway_content_does_not_duplicate_screenshot_base64(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                scope = service.agent_scopes.ensure_private_scope(1)
                encoded = base64.b64encode(b"unique browser image bytes").decode("ascii")
                service._agent_browser_tool = lambda *_args, **_kwargs: {
                    "url": "http://127.0.0.1/page",
                    "screenshot": {"data": encoded, "mimeType": "image/png"},
                }
                response = service.invoke_agent_runtime_tool({
                    "tool": "browser",
                    "action": "screenshot",
                    "arguments": {},
                    "context": {"scope_key": scope.scope_key},
                })

                self.assertEqual(response["data"]["screenshot"]["data"], encoded)
                self.assertNotIn(encoded, response["content"])
                self.assertIn("image/png", response["content"])
            finally:
                service.close()

    def test_browser_url_allows_signed_and_sso_query_parameters(self):
        addresses = [(2, 1, 6, "", ("127.0.0.1", 443))]
        with mock.patch("enterprise_agent_platform.service.socket.getaddrinfo", return_value=addresses):
            EnterpriseService._validate_browser_url(
                "https://internal.example/reset?token=signed-value&password=temporary"
            )

    def test_managed_cognee_environment_is_seeded_from_platform(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_cognee_repo(tmp / "cognee")
            old_env = {key: os.environ.get(key) for key in ("DATA_ROOT_DIRECTORY", "SYSTEM_ROOT_DIRECTORY", "CACHE_ROOT_DIRECTORY", "COGNEE_LOGS_DIR", "LLM_API_KEY")}
            for key in old_env:
                os.environ.pop(key, None)
            service = None
            try:
                service = EnterpriseService(make_config(tmp), agent_client=RecordingAgent())
                service.runtimes.ensure_cognee_ready()

                self.assertEqual(os.environ["DATA_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "data"))
                self.assertEqual(os.environ["SYSTEM_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "system"))
                self.assertEqual(os.environ["CACHE_ROOT_DIRECTORY"], str(tmp / "runtimes" / "cognee" / "cache"))
                self.assertEqual(os.environ["COGNEE_LOGS_DIR"], str(tmp / "runtimes" / "cognee" / "logs"))
                self.assertNotIn("LLM_API_KEY", os.environ)
            finally:
                if service is not None:
                    service.close()
                for key, value in old_env.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value


class PlatformHTTPTests(unittest.TestCase):
    def test_agent_approval_http_body_maps_choice_to_runtime(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            agent = ApprovalRecordingAgent()
            service = EnterpriseService(config, agent_client=agent)
            token, admin = service.authenticate("admin", "admin")
            scope_id = str(admin["id"])
            service._record_agent_progress(
                "private",
                scope_id,
                {
                    "event": "approval.request",
                    "run_id": "run-http-approval",
                    "approval_id": "approval-http-1",
                    "description": "Run a command on the host",
                },
            )
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/private-agent/agent-approval",
                    body=json.dumps({"choice": "session"}),
                    headers=headers,
                )
                response = conn.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                self.assertEqual(response.status, 200)
                self.assertTrue(payload["ok"])
                self.assertEqual(
                    agent.approvals,
                    [{
                        "run_id": "run-http-approval",
                        "choice": "session",
                        "approval_id": "approval-http-1",
                    }],
                )
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_telegram_webhook_uses_gateway_secret_instead_of_cookie_csrf(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(
                make_config(Path(td)),
                telegram_enabled=True,
                telegram_bot_token="123456:token",
                telegram_webhook_secret="telegram-secret",
            )
            service = EnterpriseService(config, agent_client=RecordingAgent())
            seen = []

            def fake_update(body):
                seen.append(body)
                return {"ok": True, "seen": body.get("update_id")}

            service.telegram_gateway_update = fake_update
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                body = json.dumps({"update_id": 99})
                conn.request(
                    "POST",
                    "/api/telegram/webhook/telegram-secret",
                    body=body,
                    headers={"Content-Type": "application/json"},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(payload, {"ok": True, "seen": 99})
                self.assertEqual(seen, [{"update_id": 99}])

                conn.request(
                    "POST",
                    "/api/telegram/webhook/wrong",
                    body=body,
                    headers={"Content-Type": "application/json"},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(payload["error"], "invalid Telegram webhook secret")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_auto_update_webhook_requires_secret_and_accepts_github_hmac(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            fake_updater = FakeAutoUpdater()
            service._auto_updater = fake_updater
            secret = "auto-update-secret-value"
            service.set_setting("auto_update_enabled", "1")
            service.set_setting("ENTERPRISE_AUTO_UPDATE_WEBHOOK_SECRET", secret, secret=True)
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                body = json.dumps({"ref": "refs/heads/main"}).encode("utf-8")
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auto-update/webhook/wrong",
                    body=body,
                    headers={"Content-Type": "application/json"},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(denied["error"], "invalid auto update webhook secret")

                signature = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
                conn.request(
                    "POST",
                    "/api/auto-update/webhook/wrong",
                    body=body,
                    headers={"Content-Type": "application/json", "X-Hub-Signature-256": signature},
                )
                res = conn.getresponse()
                accepted = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 202)
                self.assertTrue(accepted["accepted"])
                self.assertEqual(fake_updater.triggers, ["webhook"])
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_token_usage_api_is_admin_only(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            _, admin = service.authenticate("admin", "admin")
            service.create_user(
                username="usage-member",
                password="member-pass",
                display_name="Usage Member",
                role="member",
                actor=admin,
            )
            admin_token, _ = service.authenticate("admin", "admin")
            member_token, _ = service.authenticate("usage-member", "member-pass")
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/api/admin/token-usage", headers={"Authorization": f"Bearer {admin_token}"})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("summary", payload)

                conn.request("GET", "/api/admin/token-usage", headers={"Authorization": f"Bearer {member_token}"})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(payload["error"], "admin role required")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_http_current_user_settings_and_password_routes(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            _, admin = service.authenticate("admin", "admin")
            service.create_user(
                username="settings-member",
                password="member-pass",
                display_name="Settings Member",
                position="Designer",
                permission_group="member",
                actor=admin,
            )
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "settings-member", "password": "member-pass"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertEqual(payload["user"]["username"], "settings-member")
                self.assertTrue(cookie)

                conn.request(
                    "PUT",
                    "/api/auth/me",
                    body=json.dumps(
                        {
                            "display_name": "Self Service User",
                            "position": "Product Lead",
                            "permission_group": "admin",
                        }
                    ),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                updated = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 200)
                self.assertEqual(updated["display_name"], "Self Service User")
                self.assertEqual(updated["position"], "Product Lead")
                self.assertEqual(updated["permission_group"], "member")

                conn.request(
                    "PUT",
                    "/api/auth/password",
                    body=json.dumps(
                        {"current_password": "wrong-pass", "new_password": "new-member-password"}
                    ),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 400)
                self.assertEqual(denied["error"], "current password is incorrect")

                conn.request(
                    "PUT",
                    "/api/auth/password",
                    body=json.dumps(
                        {"current_password": "member-pass", "new_password": "new-member-password"}
                    ),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                changed = json.loads(res.read().decode("utf-8"))
                new_cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertEqual(changed["user"]["username"], "settings-member")
                self.assertTrue(new_cookie)

                conn.request("GET", "/api/auth/me", headers={"Cookie": cookie})
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 401)

                conn.request("GET", "/api/auth/me", headers={"Cookie": new_cookie})
                res = conn.getresponse()
                me = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 200)
                self.assertEqual(me["display_name"], "Self Service User")

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "settings-member", "password": "member-pass"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 401)

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "settings-member", "password": "new-member-password"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_http_admin_can_impersonate_active_user(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            _, admin = service.authenticate("admin", "admin")
            target = service.create_user(
                username="impersonated-member",
                password="member-pass",
                display_name="Impersonated Member",
                permission_group="member",
                actor=admin,
            )
            disabled = service.create_user(
                username="disabled-member",
                password="member-pass",
                display_name="Disabled Member",
                permission_group="member",
                actor=admin,
            )
            service.update_user(admin, int(disabled["id"]), {"active": False})
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                admin_cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertTrue(admin_cookie)

                conn.request(
                    "POST",
                    f"/api/users/{disabled['id']}/impersonate",
                    body="{}",
                    headers={"Content-Type": "application/json", "Cookie": admin_cookie, "Origin": origin},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 404)
                self.assertEqual(denied["error"], "user not found")

                conn.request(
                    "POST",
                    f"/api/users/{target['id']}/impersonate",
                    body="{}",
                    headers={"Content-Type": "application/json", "Cookie": admin_cookie, "Origin": origin},
                )
                res = conn.getresponse()
                body = json.loads(res.read().decode("utf-8"))
                member_cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertEqual(body["user"]["username"], "impersonated-member")
                self.assertTrue(member_cookie)
                self.assertNotEqual(member_cookie, admin_cookie)

                conn.request("GET", "/api/auth/me", headers={"Cookie": member_cookie})
                res = conn.getresponse()
                me = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 200)
                self.assertEqual(me["username"], "impersonated-member")
                self.assertEqual(me["permission_group"], "member")

                conn.request("GET", "/api/users", headers={"Cookie": member_cookie})
                res = conn.getresponse()
                forbidden = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(forbidden["error"], "admin role required")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_http_security_headers_secure_cookie_and_csrf_origin_check(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(make_config(Path(td)), public_base_url="https://agents.example")
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/")
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
                self.assertEqual(res.getheader("X-Frame-Options"), "DENY")
                self.assertEqual(res.getheader("X-Content-Type-Options"), "nosniff")
                self.assertIn("frame-ancestors 'none'", res.getheader("Content-Security-Policy"))

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(denied["error"], "cross-origin request denied")

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": "https://agents.example"},
                )
                res = conn.getresponse()
                res.read()
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertIn("HttpOnly", cookie)
                self.assertIn("SameSite=Lax", cookie)
                self.assertIn("Secure", cookie)

                conn.request(
                    "POST",
                    "/api/channels",
                    body=json.dumps({"name": "blocked"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": "https://evil.example"},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertEqual(denied["error"], "cross-origin request denied")

                conn.request(
                    "POST",
                    "/api/channels",
                    body=json.dumps({"name": "allowed"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": "https://agents.example"},
                )
                res = conn.getresponse()
                created = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(created["channel"]["name"], "allowed")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_security_config_can_enable_public_https_cookie_without_restart(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertNotIn("Secure", cookie)

                conn.request(
                    "PUT",
                    "/api/system/security/config",
                    body=json.dumps(
                        {
                            "public_base_url": "https://agents.example",
                            "trusted_proxy": True,
                            "host": "127.0.0.1",
                            "port": 8766,
                            "session_ttl_seconds": 7200,
                        }
                    ),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                updated = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                security = updated["config"]
                self.assertEqual(security["public_base_url"], "https://agents.example")
                self.assertTrue(security["secure_cookie_enabled"])
                self.assertTrue(security["trusted_proxy"])
                self.assertTrue(security["listen_restart_required"])
                self.assertEqual(security["session_ttl_seconds"], 7200)

                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": "https://agents.example"},
                )
                res = conn.getresponse()
                res.read()
                secure_cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertIn("Secure", secure_cookie)
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_security_config_rejects_invalid_public_settings(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                with self.assertRaises(ServiceError) as bad_url:
                    service.update_platform_security_config(admin, {"public_base_url": "javascript:alert(1)"})
                self.assertEqual(bad_url.exception.status, 400)
                with self.assertRaises(ServiceError) as bad_port:
                    service.update_platform_security_config(admin, {"port": 70000})
                self.assertEqual(bad_port.exception.status, 400)
                with self.assertRaises(ServiceError) as bad_secret:
                    service.update_platform_security_config(admin, {"session_secret": "short"})
                self.assertEqual(bad_secret.exception.status, 400)
            finally:
                service.close()

    def test_csrf_requires_origin_for_cookie_requests_but_exempts_bearer(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"
            try:
                token, _ = service.authenticate("admin", "admin")
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                res.read()
                cookie = res.getheader("Set-Cookie")

                # A cookie-authenticated state-changing request with no Origin
                # or Referer must be refused (closes the no-header CSRF bypass).
                conn.request(
                    "POST",
                    "/api/channels",
                    body=json.dumps({"name": "no-origin"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie},
                )
                res = conn.getresponse()
                denied = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 403)
                self.assertIn("Origin", denied["error"])

                # A bearer-token request is exempt (not forgeable cross-origin).
                conn.request(
                    "POST",
                    "/api/channels",
                    body=json.dumps({"name": "bearer-ok"}),
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
                )
                res = conn.getresponse()
                created = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(created["channel"]["name"], "bearer-ok")
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_scope_events_stream_emits_update(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            try:
                token, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="sse-typing-user",
                    password="sse-typing-pass",
                    display_name="SSE Alice",
                    permission_group="member",
                    actor=admin,
                )
                _, alice = service.authenticate("sse-typing-user", "sse-typing-pass")
                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", "/api/channels/1/events", headers={"Authorization": f"Bearer {token}"})
                res = conn.getresponse()
                self.assertEqual(res.status, 200)
                self.assertIn("text/event-stream", res.getheader("Content-Type"))
                buf = b""
                event_block = None
                deadline = time.time() + 5
                while time.time() < deadline:
                    chunk = res.read(1)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n\n" in buf:
                        block, buf = buf.split(b"\n\n", 1)
                        text = block.decode("utf-8")
                        if text.startswith("event: update"):
                            event_block = text
                            break
                    if event_block:
                        break
                self.assertIsNotNone(event_block)
                self.assertIn('"agent_status"', event_block)
                self.assertIn('"latest_message_id"', event_block)
                self.assertIn('"message_revision"', event_block)

                service.update_typing(alice, "channel", "1", True)
                next_update = None
                deadline = time.time() + 5
                while time.time() < deadline:
                    chunk = res.read(1)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n\n" in buf:
                        block, buf = buf.split(b"\n\n", 1)
                        text = block.decode("utf-8")
                        if text.startswith("event: update"):
                            next_update = text
                            break
                    if next_update:
                        break
                self.assertIsNotNone(next_update)
                self.assertIn('"typing": [{', next_update)
                self.assertIn("SSE Alice", next_update)
                conn.close()
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_attachment_inline_is_limited_to_safe_image_mime_types(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            server, thread = serve_in_thread(make_config(Path(td)), service)
            host, port = server.server_address
            try:
                token, admin = service.authenticate("admin", "admin")
                svg_message = service.send_channel_message(
                    admin,
                    1,
                    "svg",
                    [UploadedFile("diagram.svg", "image/svg+xml", b"<svg><script>alert(1)</script></svg>")],
                )["user_message"]
                png_message = service.send_channel_message(
                    admin,
                    1,
                    "png",
                    [UploadedFile("pixel.png", "image/png", b"\x89PNG\r\n\x1a\n")],
                )["user_message"]
                self.assertFalse(svg_message["attachments"][0]["is_image"])
                self.assertTrue(png_message["attachments"][0]["is_image"])

                conn = http.client.HTTPConnection(host, port, timeout=5)
                conn.request("GET", svg_message["attachments"][0]["url"], headers={"Authorization": f"Bearer {token}"})
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
                self.assertTrue(res.getheader("Content-Disposition").startswith("attachment;"))

                conn.request("GET", png_message["attachments"][0]["url"], headers={"Authorization": f"Bearer {token}"})
                res = conn.getresponse()
                res.read()
                self.assertEqual(res.status, 200)
                self.assertTrue(res.getheader("Content-Disposition").startswith("inline;"))
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_login_and_channel_message_over_http(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(
                make_config(Path(td)),
                agent_client=RecordingAgent(),
            )
            server, thread = serve_in_thread(make_config(Path(td)), service)
            host, port = server.server_address
            try:
                conn = http.client.HTTPConnection(host, port, timeout=5)
                origin = f"http://{host}:{port}"
                conn.request(
                    "POST",
                    "/api/auth/login",
                    body=json.dumps({"username": "admin", "password": "admin"}),
                    headers={"Content-Type": "application/json", "Origin": origin},
                )
                res = conn.getresponse()
                body = json.loads(res.read().decode("utf-8"))
                cookie = res.getheader("Set-Cookie")
                self.assertEqual(res.status, 200)
                self.assertEqual(body["user"]["username"], "admin")
                admin = body["user"]

                conn.request("GET", "/api/channels", headers={"Cookie": cookie})
                res = conn.getresponse()
                channels = json.loads(res.read().decode("utf-8"))["channels"]
                self.assertEqual(channels[0]["name"], "general")

                conn.request("GET", "/api/system/runtime", headers={"Cookie": cookie})
                res = conn.getresponse()
                runtime = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("agent", runtime)
                self.assertIn("cognee", runtime)

                conn.request("GET", "/api/system/agent-runtime/config", headers={"Cookie": cookie})
                res = conn.getresponse()
                agent_config = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("config", agent_config)
                self.assertIn("runtime_home", agent_config["config"])
                self.assertEqual(agent_config["config"]["provider"], "openai-codex")

                conn.request("GET", "/api/permission-groups", headers={"Cookie": cookie})
                res = conn.getresponse()
                groups = json.loads(res.read().decode("utf-8"))["permission_groups"]
                self.assertEqual(res.status, 200)
                self.assertIn("admin", {group["id"] for group in groups})

                conn.request(
                    "POST",
                    "/api/users",
                    body=json.dumps({
                        "username": "http-user",
                        "password": "http-pass",
                        "display_name": "HTTP User",
                        "position": "Designer",
                        "permission_group": "member",
                        "model_name": "gpt-5.4",
                        "thinking_depth": "minimal",
                    }),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                created_user = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 201)
                self.assertEqual(created_user["position"], "Designer")
                self.assertEqual(created_user["model_name"], "gpt-5.4")

                conn.request(
                    "PUT",
                    f"/api/users/{created_user['id']}",
                    body=json.dumps({"permission_group": "manager", "thinking_depth": "high"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                updated_user = json.loads(res.read().decode("utf-8"))["user"]
                self.assertEqual(res.status, 200)
                self.assertEqual(updated_user["permission_group"], "manager")
                self.assertEqual(updated_user["thinking_depth"], "high")

                conn.request(
                    "POST",
                    f"/api/channels/{channels[0]['id']}/messages",
                    body=json.dumps({"content": "hello"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(payload["user_message"]["content"], "hello")
                self.assertIsNone(payload["agent_message"])
                self.assertEqual(payload["agent_status"]["state"], "idle")
                service.wait_for_agent_idle("channel", str(channels[0]["id"]))

                boundary = "----enterprise-platform-test"
                multipart = (
                    f"--{boundary}\r\n"
                    'Content-Disposition: form-data; name="content"\r\n\r\n'
                    "file upload\r\n"
                    f"--{boundary}\r\n"
                    'Content-Disposition: form-data; name="files"; filename="note.txt"\r\n'
                    "Content-Type: text/plain\r\n\r\n"
                    "hello file\r\n"
                    f"--{boundary}--\r\n"
                ).encode("utf-8")
                conn.request(
                    "POST",
                    f"/api/channels/{channels[0]['id']}/messages",
                    body=multipart,
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(payload["user_message"]["attachments"][0]["filename"], "note.txt")

                conn.request("GET", payload["user_message"]["attachments"][0]["url"], headers={"Cookie": cookie})
                res = conn.getresponse()
                self.assertTrue(res.getheader("Content-Disposition").startswith("attachment;"))
                attachment_body = res.read()
                self.assertEqual(res.status, 200)
                self.assertEqual(attachment_body, b"hello file")

                conn.request("GET", "/api/mention-targets", headers={"Cookie": cookie})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(payload["targets"][0]["handle"], "agent")

                conn.request(
                    "POST",
                    f"/api/channels/{channels[0]['id']}/messages",
                    body=json.dumps({"content": "@agent hello"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(payload["user_message"]["content"], "@agent hello")
                self.assertIn(payload["agent_status"]["state"], {"queued", "replying", "idle"})
                service.wait_for_agent_idle("channel", str(channels[0]["id"]))

                conn.request("GET", f"/api/channels/{channels[0]['id']}/messages", headers={"Cookie": cookie})
                res = conn.getresponse()
                payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(payload["messages"][-1]["content"], "agent response to Administrator: hello")
                self.assertEqual(payload["messages"][-1]["metadata"]["agent_work"]["state"], "complete")
                self.assertEqual(payload["agent_status"]["state"], "idle")

                conn.request("GET", f"/api/admin/channels/{channels[0]['id']}/messages?limit=10", headers={"Cookie": cookie})
                res = conn.getresponse()
                audit_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertGreaterEqual(audit_payload["total"], 3)
                hello_message = next(message for message in audit_payload["messages"] if message["content"] == "hello")

                conn.request(
                    "DELETE",
                    f"/api/admin/channels/{channels[0]['id']}/messages/{hello_message['id']}",
                    body="{}",
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                delete_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(delete_payload["deleted"], 1)

                conn.request("GET", "/api/admin/private-agent/conversations", headers={"Cookie": cookie})
                res = conn.getresponse()
                private_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertIn("admin", {item["username"] for item in private_payload["conversations"]})

                conn.request(
                    "POST",
                    "/api/private-agent/messages",
                    body=json.dumps({"content": "private http"}),
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                private_message_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 201)
                self.assertEqual(private_message_payload["user_message"]["content"], "private http")
                service.wait_for_agent_idle("private", str(admin["id"]))

                conn.request(
                    "GET",
                    f"/api/admin/private-agent/conversations/{admin['id']}/messages?limit=10",
                    headers={"Cookie": cookie},
                )
                res = conn.getresponse()
                private_audit_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                private_http_message = next(
                    message for message in private_audit_payload["messages"] if message["content"] == "private http"
                )

                conn.request(
                    "DELETE",
                    f"/api/admin/private-agent/conversations/{admin['id']}/messages/{private_http_message['id']}",
                    body="{}",
                    headers={"Content-Type": "application/json", "Cookie": cookie, "Origin": origin},
                )
                res = conn.getresponse()
                private_delete_payload = json.loads(res.read().decode("utf-8"))
                self.assertEqual(res.status, 200)
                self.assertEqual(private_delete_payload["deleted"], 1)
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
