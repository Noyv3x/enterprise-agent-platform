from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.deployment import (
    DeploymentError,
    DeploymentManager,
    DeploymentPaths,
)
from enterprise_agent_platform.internal_config import is_sensitive_key, mask_value

from test_deployment import make_deploy_root


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
        for key in ("max_tokens", "tokens", "tokenizer", "token_count", "num_tokens"):
            self.assertFalse(is_sensitive_key(key), f"{key!r} should not be sensitive")

    def test_mask_value_never_returns_short_or_long_secret_verbatim(self):
        self.assertEqual(mask_value("tiny"), "********")
        self.assertEqual(mask_value("sk-live-secret-value"), "...alue")
        self.assertNotIn("sk-live-secret", mask_value("sk-live-secret-value"))


class _ServeExitRunner:
    def __init__(self, serve_returncode: int):
        self.serve_returncode = serve_returncode
        self.calls = []

    def run(self, cmd, *, cwd=None, env=None, timeout=None, check=True):
        self.calls.append({"cmd": cmd, "cwd": cwd, "env": env, "timeout": timeout, "check": check})
        if len(cmd) >= 2 and cmd[1] == "gateway":
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
            self.assertTrue(any(call["cmd"][1] == "gateway" for call in runner.calls))

    def test_run_foreground_succeeds_on_clean_exit(self):
        with tempfile.TemporaryDirectory() as td:
            runner = _ServeExitRunner(serve_returncode=0)
            manager = self._make_manager(Path(td), runner)
            manager.run_foreground(host="127.0.0.1", port=8765)

    def test_run_foreground_succeeds_on_sigint_exit(self):
        with tempfile.TemporaryDirectory() as td:
            runner = _ServeExitRunner(serve_returncode=130)
            manager = self._make_manager(Path(td), runner)
            manager.run_foreground(host="127.0.0.1", port=8765)


if __name__ == "__main__":
    unittest.main()
