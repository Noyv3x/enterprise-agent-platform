from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from enterprise_agent_platform import hermes as hermes_module
from enterprise_agent_platform.deployment import (
    DeploymentError,
    DeploymentManager,
    DeploymentPaths,
)
from enterprise_agent_platform.hermes import HermesAgentClient
from enterprise_agent_platform.internal_config import (
    REDACTED_PLACEHOLDER,
    is_sensitive_key,
    redact_sensitive,
    restore_redacted_secrets,
)

from test_deployment import make_deploy_root
from test_platform import make_config


class SecretRedactionRegressionTests(unittest.TestCase):
    def test_is_sensitive_key_flags_real_credential_keys(self):
        for key in (
            "api_key",
            "access_token",
            "auth_token",
            "refresh_token",
            "client_secret",
            "password",
            "token",
        ):
            self.assertTrue(is_sensitive_key(key), f"{key!r} should be sensitive")

    def test_is_sensitive_key_does_not_flag_token_lookalikes(self):
        for key in (
            "max_tokens",
            "tokens",
            "tokenizer",
            "token_count",
            "num_tokens",
        ):
            self.assertFalse(is_sensitive_key(key), f"{key!r} should NOT be sensitive")

    def test_redact_sensitive_preserves_non_secret_but_masks_api_key(self):
        value = {"max_tokens": 1024, "api_key": "sk-real-secret"}
        redacted = redact_sensitive(value, REDACTED_PLACEHOLDER)
        self.assertEqual(redacted["max_tokens"], 1024)
        self.assertEqual(redacted["api_key"], REDACTED_PLACEHOLDER)

    def test_restore_fails_closed_when_secret_has_no_saved_value(self):
        # The provider key was renamed on disk, so the placeholder has no real
        # backing scalar. Restoring must raise rather than silently writing "".
        incoming = {"providers": {"new_name": {"api_key": REDACTED_PLACEHOLDER}}}
        original = {"providers": {"old_name": {"api_key": "KEY_OLD"}}}
        with self.assertRaises(ValueError):
            restore_redacted_secrets(incoming, original)

    def test_restore_matches_list_elements_by_identity_not_index(self):
        incoming = [
            {"name": "b", "api_key": REDACTED_PLACEHOLDER},
            {"name": "a", "api_key": REDACTED_PLACEHOLDER},
        ]
        original = [
            {"name": "a", "api_key": "KEY_A"},
            {"name": "b", "api_key": "KEY_B"},
        ]
        restored = restore_redacted_secrets(incoming, original)
        # Position 0 is name=b, so it must recover KEY_B (not KEY_A by index).
        self.assertEqual(restored[0], {"name": "b", "api_key": "KEY_B"})
        self.assertEqual(restored[1], {"name": "a", "api_key": "KEY_A"})

    def test_restore_round_trips_a_normal_matched_secret(self):
        incoming = {"providers": {"openai": {"api_key": REDACTED_PLACEHOLDER, "model": "gpt"}}}
        original = {"providers": {"openai": {"api_key": "sk-live", "model": "gpt"}}}
        restored = restore_redacted_secrets(incoming, original)
        self.assertEqual(restored["providers"]["openai"]["api_key"], "sk-live")
        self.assertEqual(restored["providers"]["openai"]["model"], "gpt")


class HermesStreamingRetryRegressionTests(unittest.TestCase):
    def _make_client(self, tmp: Path) -> HermesAgentClient:
        config = replace(make_config(tmp), agent_mode="hermes")
        return HermesAgentClient(config, lambda key: "")

    def _patch_urlopen_counting_failure(self):
        """Replace hermes.urllib.request.urlopen with a counting stub that always
        raises a transient connect error. Returns (restore_callable, counter)."""

        calls = {"count": 0}
        original = hermes_module.urllib.request.urlopen

        def fake_urlopen(request, timeout=None):
            calls["count"] += 1
            raise hermes_module.urllib.error.URLError("boom")

        hermes_module.urllib.request.urlopen = fake_urlopen

        def restore():
            hermes_module.urllib.request.urlopen = original

        return restore, calls

    def _set_retry_env(self):
        previous = {
            "ENTERPRISE_HERMES_RETRY_ATTEMPTS": os.environ.get("ENTERPRISE_HERMES_RETRY_ATTEMPTS"),
            "ENTERPRISE_HERMES_RETRY_BASE_DELAY": os.environ.get("ENTERPRISE_HERMES_RETRY_BASE_DELAY"),
        }
        os.environ["ENTERPRISE_HERMES_RETRY_ATTEMPTS"] = "3"
        os.environ["ENTERPRISE_HERMES_RETRY_BASE_DELAY"] = "0"

        def restore():
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

        return restore

    def test_non_streaming_generate_retries_three_times(self):
        restore_env = self._set_retry_env()
        restore_urlopen, calls = self._patch_urlopen_counting_failure()
        try:
            with tempfile.TemporaryDirectory() as td:
                client = self._make_client(Path(td))
                with self.assertRaises(hermes_module.urllib.error.URLError):
                    client.generate(
                        system_prompt="system",
                        user_message="question",
                        history=[],
                        session_id="session-1",
                        session_key="private:1",
                    )
                self.assertEqual(calls["count"], 3)
        finally:
            restore_urlopen()
            restore_env()

    def test_streaming_generate_attempts_once_and_is_not_retried(self):
        restore_env = self._set_retry_env()
        restore_urlopen, calls = self._patch_urlopen_counting_failure()
        try:
            with tempfile.TemporaryDirectory() as td:
                client = self._make_client(Path(td))
                with self.assertRaises(hermes_module.urllib.error.URLError):
                    client.generate(
                        system_prompt="system",
                        user_message="question",
                        history=[],
                        session_id="session-1",
                        session_key="private:1",
                        content_callback=lambda chunk: None,
                    )
                # A streaming request must NOT be retried (double-run prevention).
                self.assertEqual(calls["count"], 1)
        finally:
            restore_urlopen()
            restore_env()

    def test_open_with_retry_honors_allow_retry_flag(self):
        # Direct seam: allow_retry=False attempts exactly once, allow_retry=True
        # exhausts the configured attempts (3) before re-raising.
        restore_env = self._set_retry_env()
        restore_urlopen, calls = self._patch_urlopen_counting_failure()
        try:
            with tempfile.TemporaryDirectory() as td:
                client = self._make_client(Path(td))
                request = hermes_module.urllib.request.Request("http://127.0.0.1:0/v1/chat/completions", method="POST")

                with self.assertRaises(hermes_module.urllib.error.URLError):
                    client._open_with_retry(request, allow_retry=False)
                self.assertEqual(calls["count"], 1)

                calls["count"] = 0
                with self.assertRaises(hermes_module.urllib.error.URLError):
                    client._open_with_retry(request, allow_retry=True)
                self.assertEqual(calls["count"], 3)
        finally:
            restore_urlopen()
            restore_env()


class _ServeExitRunner:
    """Returns a chosen exit code for the platform_cli 'serve' invocation and 0
    for everything else, with no real subprocess."""

    def __init__(self, serve_returncode: int):
        self.serve_returncode = serve_returncode
        self.calls = []

    def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
        self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "timeout": timeout, "check": check})
        if len(cmd) >= 2 and cmd[1] == "serve":
            return subprocess.CompletedProcess(cmd, self.serve_returncode)
        return subprocess.CompletedProcess(cmd, 0)


class RunForegroundRegressionTests(unittest.TestCase):
    def _make_manager(self, root: Path, runner: _ServeExitRunner) -> DeploymentManager:
        make_deploy_root(root)
        paths = DeploymentPaths.from_root(root)
        return DeploymentManager(paths, runner=runner)

    def test_run_foreground_raises_when_serve_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as td:
            runner = _ServeExitRunner(serve_returncode=1)
            manager = self._make_manager(Path(td), runner)
            with self.assertRaises(DeploymentError):
                manager.run_foreground(host="127.0.0.1", port=8765)
            self.assertTrue(any(call["cmd"][1] == "serve" for call in runner.calls))

    def test_run_foreground_succeeds_on_clean_exit(self):
        with tempfile.TemporaryDirectory() as td:
            runner = _ServeExitRunner(serve_returncode=0)
            manager = self._make_manager(Path(td), runner)
            # Must not raise on a clean (0) shutdown.
            manager.run_foreground(host="127.0.0.1", port=8765)

    def test_run_foreground_succeeds_on_sigint_exit(self):
        with tempfile.TemporaryDirectory() as td:
            runner = _ServeExitRunner(serve_returncode=130)
            manager = self._make_manager(Path(td), runner)
            # 130 (Ctrl-C / SIGINT) is a normal operator stop, not a failure.
            manager.run_foreground(host="127.0.0.1", port=8765)


if __name__ == "__main__":
    unittest.main()
