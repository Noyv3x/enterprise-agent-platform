from __future__ import annotations

import io
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
from dataclasses import replace
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.runtimes import (
    CAMOFOX_JS_VERSION,
    CAMOFOX_MANAGED_VERSION,
    CAMOFOX_PLAYWRIGHT_VERSION,
    FIRECRAWL_FOUNDATIONDB_IMAGE,
    FIRECRAWL_IMAGE,
    FIRECRAWL_PLAYWRIGHT_IMAGE,
    FIRECRAWL_POSTGRES_IMAGE,
    FIRECRAWL_RABBITMQ_IMAGE,
    FIRECRAWL_REDIS_IMAGE,
    FIRECRAWL_SERVICE_IMAGES,
    PlatformRuntimeManager,
)
import enterprise_agent_platform.runtimes as runtime_module

from test_platform import (
    RecordingCommandRunner,
    RecordingLauncher,
    make_config,
    make_fake_firecrawl_repo,
)


def _no_secret(_key: str) -> str:
    return ""


class _FakeHTTPResponse:
    def __init__(self, status: int, payload: object):
        self.status = int(status)
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit: int = -1) -> bytes:
        return self._body


class ManagedToolRuntimeSecurityTests(unittest.TestCase):
    def _manager(self, tmp: Path, *, config=None, launcher=None, secret_provider=None) -> PlatformRuntimeManager:
        return PlatformRuntimeManager(
            config or make_config(tmp),
            secret_provider or _no_secret,
            process_launcher=launcher or RecordingLauncher(),
        )

    def test_agent_runtime_health_probe_authenticates_with_runtime_token(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(make_config(tmp), agent_runtime_token="runtime-secret")
            manager = self._manager(tmp, config=config)
            captured = []

            def open_request(request, timeout):
                captured.append((request, timeout))
                return _FakeHTTPResponse(200, {"ok": True})

            with mock.patch(
                "enterprise_agent_platform.runtimes.urllib.request.urlopen",
                side_effect=open_request,
            ):
                self.assertTrue(manager._probe_agent_health())

            self.assertEqual(captured[0][0].full_url, "http://127.0.0.1:8766/health")
            self.assertEqual(captured[0][0].get_header("Authorization"), "Bearer runtime-secret")
            self.assertEqual(captured[0][1], 1.0)

    def test_agent_runtime_env_keeps_oauth_credentials_out_of_child(self):
        secrets = {
            "CODEX_OAUTH_ACCESS_TOKEN": "access",
            "CODEX_OAUTH_REFRESH_TOKEN": "refresh",
            "GROK_OAUTH_ACCESS_TOKEN": "grok-access",
            "GROK_OAUTH_REFRESH_TOKEN": "grok-refresh",
            "agent_tool_token": "internal-token",
            "agent_runtime_token": "runtime-bearer",
        }
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td), secret_provider=lambda key: secrets.get(key, ""))
            with mock.patch.dict(
                os.environ,
                {**secrets, "UNRELATED_PASSWORD": "must-not-leak"},
            ):
                env = manager._agent_runtime_process_env()

            self.assertEqual(env["AGENT_PLATFORM_INTERNAL_TOKEN"], "internal-token")
            self.assertEqual(env["AGENT_RUNTIME_TOKEN"], "runtime-token")
            self.assertNotEqual(env["AGENT_RUNTIME_TOKEN"], env["AGENT_PLATFORM_INTERNAL_TOKEN"])
            self.assertEqual(env["AGENT_RUNTIME_RUN_TIMEOUT_MS"], "2000")
            self.assertNotIn("CODEX_OAUTH_ACCESS_TOKEN", env)
            self.assertNotIn("CODEX_OAUTH_REFRESH_TOKEN", env)
            self.assertNotIn("GROK_OAUTH_ACCESS_TOKEN", env)
            self.assertNotIn("GROK_OAUTH_REFRESH_TOKEN", env)
            self.assertNotIn("UNRELATED_PASSWORD", env)

    def test_agent_runtime_internal_gateway_never_uses_public_base_url(self):
        with tempfile.TemporaryDirectory() as td:
            config = replace(
                make_config(Path(td)),
                host="0.0.0.0",
                port=8765,
                public_base_url="https://agents.example",
            )
            manager = self._manager(Path(td), config=config)

            env = manager._agent_runtime_process_env()

            self.assertEqual(env["AGENT_PLATFORM_INTERNAL_URL"], "http://127.0.0.1:8765")
            self.assertNotIn("agents.example", env["AGENT_PLATFORM_INTERNAL_URL"])

    def test_agent_runtime_installer_scrubs_parent_secrets_from_npm_environment(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            runner = RecordingCommandRunner()
            manager = PlatformRuntimeManager(
                replace(make_config(tmp), manage_agent_runtime=True),
                _no_secret,
                process_launcher=RecordingLauncher(),
                command_runner=runner,
            )
            with mock.patch.dict(
                os.environ,
                {
                    "DEPLOY_PASSWORD": "must-not-leak",
                    "CODEX_OAUTH_ACCESS_TOKEN": "must-not-leak",
                    "SAFE_BUILD_FLAG": "enabled",
                },
            ):
                status = manager.install_agent_runtime(force=True)

            self.assertFalse(status.available)
            self.assertTrue(runner.calls)
            install_env = runner.calls[0]["env"]
            self.assertNotIn("DEPLOY_PASSWORD", install_env)
            self.assertNotIn("CODEX_OAUTH_ACCESS_TOKEN", install_env)
            self.assertEqual(install_env["SAFE_BUILD_FLAG"], "enabled")

    def test_camofox_is_exactly_pinned_authenticated_and_state_scoped(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            launcher = RecordingLauncher()
            manager = self._manager(
                tmp,
                launcher=launcher,
                config=replace(make_config(tmp), camofox_command="camofox-test"),
            )
            lock = json.loads(manager._camofox_source_dir().joinpath("package-lock.json").read_text(encoding="utf-8"))
            packages = lock["packages"]
            self.assertEqual(packages["node_modules/@askjo/camofox-browser"]["version"], CAMOFOX_MANAGED_VERSION)
            self.assertEqual(packages["node_modules/camoufox-js"]["version"], CAMOFOX_JS_VERSION)
            self.assertEqual(packages["node_modules/playwright-core"]["version"], CAMOFOX_PLAYWRIGHT_VERSION)
            self.assertTrue(packages["node_modules/@askjo/camofox-browser"]["integrity"].startswith("sha512-"))
            manager._start_camofox()
            env = launcher.calls[-1]["env"]
            self.assertEqual(env["CAMOFOX_ACCESS_KEY"], env["CAMOFOX_API_KEY"])
            self.assertGreaterEqual(len(env["CAMOFOX_ACCESS_KEY"]), 32)
            self.assertEqual(env["HOST"], "127.0.0.1")
            self.assertEqual(env["CAMOFOX_CRASH_REPORT_ENABLED"], "false")
            self.assertEqual(env["NODE_ENV"], "production")
            self.assertNotIn("NODE_OPTIONS", env)
            for name in ("profiles", "cookies", "traces"):
                key = f"CAMOFOX_{name.upper() if name != 'profiles' else 'PROFILE'}_DIR"
                self.assertEqual(Path(env[key]).parent, tmp / "runtimes" / "camofox")
            self.assertEqual(
                stat.S_IMODE((tmp / "runtimes" / "camofox" / "access-key").stat().st_mode),
                0o600,
            )

    def test_disabled_camofox_skips_managed_install(self):
        with tempfile.TemporaryDirectory() as td:
            runner = RecordingCommandRunner()
            manager = PlatformRuntimeManager(
                replace(make_config(Path(td)), manage_camofox=False),
                _no_secret,
                process_launcher=RecordingLauncher(),
                command_runner=runner,
            )

            status = manager.install_camofox(force=True)

            self.assertFalse(status.managed)
            self.assertEqual(status.state, "external")
            self.assertEqual(runner.calls, [])
            self.assertFalse((Path(td) / "runtimes" / "camofox").exists())

    def test_camofox_install_validation_rejects_missing_entrypoint(self):
        with tempfile.TemporaryDirectory() as td:
            app = Path(td)
            versions = (
                ("@askjo/camofox-browser", CAMOFOX_MANAGED_VERSION),
                ("camoufox-js", CAMOFOX_JS_VERSION),
                ("playwright-core", CAMOFOX_PLAYWRIGHT_VERSION),
            )
            for package, version in versions:
                package_dir = app / "node_modules" / package
                package_dir.mkdir(parents=True)
                (package_dir / "package.json").write_text(
                    json.dumps({"version": version}), encoding="utf-8"
                )
            (app / "loopback-preload.cjs").write_text("// preload\n", encoding="utf-8")
            (app / "patch-runtime.cjs").write_text("// patch\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "server.js"):
                PlatformRuntimeManager._validate_camofox_install(app)

    @unittest.skipIf(runtime_module.fcntl is None, "POSIX flock is required")
    def test_camofox_install_lock_serializes_other_manager_instances(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            first = self._manager(tmp)
            second = self._manager(tmp)
            acquired = threading.Event()

            with first._camofox_install_lock():
                def take_lock() -> None:
                    with second._camofox_install_lock():
                        acquired.set()

                worker = threading.Thread(target=take_lock, daemon=True)
                worker.start()
                self.assertFalse(acquired.wait(0.15))
            self.assertTrue(acquired.wait(2.0))
            worker.join(timeout=2.0)

    def test_camofox_archive_validation_rejects_symlink_and_duplicate_targets(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            symlink_data = io.BytesIO()
            with zipfile.ZipFile(symlink_data, "w") as archive:
                item = zipfile.ZipInfo("linked")
                item.create_system = 3
                item.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(item, "target")
            symlink_data.seek(0)
            with zipfile.ZipFile(symlink_data) as archive, self.assertRaisesRegex(
                RuntimeError, "symbolic link"
            ):
                PlatformRuntimeManager._validated_camofox_archive_members(archive, root)

            duplicate_data = io.BytesIO()
            with zipfile.ZipFile(duplicate_data, "w") as archive:
                archive.writestr("same", "one")
                with self.assertWarns(UserWarning):
                    archive.writestr("same", "two")
            duplicate_data.seek(0)
            with zipfile.ZipFile(duplicate_data) as archive, self.assertRaisesRegex(
                RuntimeError, "duplicate target"
            ):
                PlatformRuntimeManager._validated_camofox_archive_members(archive, root)

    def test_camofox_health_requires_a_real_browser_capability_probe_once(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            responses = [
                {"ok": True, "engine": "camoufox", "browserConnected": False, "browserRunning": False},
                {"tabId": "health-tab", "url": "about:blank"},
                {"snapshot": "", "url": "about:blank"},
                {"ok": True},
                {"ok": True, "engine": "camoufox", "browserConnected": True, "browserRunning": True},
            ]
            with (
                mock.patch.object(manager, "_camofox_json_request", side_effect=responses) as request,
                mock.patch.object(manager, "_camofox_binary_request", return_value=b"\x89PNG\r\n\x1a\n"),
            ):
                self.assertTrue(manager._probe_camofox_health())
                self.assertTrue(manager._probe_camofox_health())

            self.assertTrue(manager._camofox_capability_verified)
            self.assertEqual(request.call_count, 5)
            self.assertEqual(request.call_args_list[1].args[0], "/tabs")
            expected_scope = hashlib.sha256(
                manager._effective_camofox_url().encode("utf-8")
            ).hexdigest()[:24]
            self.assertEqual(
                request.call_args_list[1].kwargs["body"]["userId"],
                f"ubitech-runtime-health-{expected_scope}",
            )
            self.assertIn("/snapshot?", request.call_args_list[2].args[0])
            self.assertIn("/sessions/", request.call_args_list[3].args[0])

    def test_camofox_health_rejects_api_shell_when_browser_probe_fails(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            with mock.patch.object(
                manager,
                "_camofox_json_request",
                side_effect=[
                    {"ok": True, "engine": "camoufox", "browserConnected": False},
                    None,
                    {"ok": True},
                ],
            ) as request:
                self.assertFalse(manager._probe_camofox_health())

            self.assertFalse(manager._camofox_capability_verified)
            self.assertIn("capability probe failed", manager._camofox_last_error)
            self.assertEqual(request.call_count, 3)
            self.assertTrue(request.call_args_list[-1].args[0].startswith("/sessions/"))

    def test_camofox_health_reprobes_a_persistently_disconnected_browser(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            manager._camofox_capability_verified = True
            manager._camofox_capability_verified_at = time.monotonic() - 60
            responses = [
                {"ok": True, "engine": "camoufox", "browserConnected": False, "browserRunning": False},
                {"tabId": "health-tab", "url": "about:blank"},
                {"snapshot": "", "url": "about:blank"},
                {"ok": True},
            ]
            with (
                mock.patch.object(manager, "_camofox_json_request", side_effect=responses) as request,
                mock.patch.object(manager, "_camofox_binary_request", return_value=b"\x89PNG\r\n\x1a\n"),
            ):
                self.assertTrue(manager._probe_camofox_health())

            self.assertEqual(request.call_count, 4)
            self.assertGreater(manager._camofox_capability_verified_at, 0)

    def test_camofox_capability_probe_is_serialized_for_status_callers(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))

            def complete_probe(_generation: int) -> bool:
                time.sleep(0.1)
                manager._camofox_capability_verified = True
                manager._camofox_capability_verified_at = time.monotonic()
                return True

            results: list[bool] = []
            with mock.patch.object(
                manager,
                "_probe_camofox_capability_unlocked",
                side_effect=complete_probe,
            ) as probe:
                threads = [
                    threading.Thread(
                        target=lambda: results.append(manager._probe_camofox_capability())
                    )
                    for _ in range(3)
                ]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(timeout=2.0)

            self.assertEqual(results, [True, True, True])
            probe.assert_called_once_with(manager._camofox_process_generation)

    @unittest.skipUnless(shutil.which("node"), "Node is required to exercise the loopback preload")
    def test_camofox_preload_forces_real_tcp_listener_to_loopback(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            preload = manager._camofox_source_dir() / "loopback-preload.cjs"
            script = (
                "const http=require('node:http');"
                "const s=http.createServer((_q,r)=>r.end('ok'));"
                "s.listen(0,()=>{console.log(JSON.stringify(s.address()));s.close();});"
            )
            result = subprocess.run(
                [shutil.which("node") or "node", "--require", str(preload), "-e", script],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            address = json.loads(result.stdout.strip())
            self.assertEqual(address["address"], "127.0.0.1")

    @unittest.skipUnless(shutil.which("node"), "Node is required to exercise the preload")
    def test_camofox_preload_blocks_metadata_link_local_and_dns_rebinding_targets(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            preload = manager._camofox_source_dir() / "loopback-preload.cjs"
            script = r"""
const guard = require(process.argv[1]);
(async () => {
  const direct = guard.isBlockedNetworkAddress('169.254.169.254');
  const ipv6 = guard.isBlockedNetworkAddress('fe80::1');
  const mapped = guard.isBlockedNetworkAddress('::ffff:169.254.170.2');
  const mappedAlibaba = guard.isBlockedNetworkAddress('::ffff:100.100.100.200');
  const expandedAws = guard.isBlockedNetworkAddress('fd00:0ec2:0:0:0:0:0:254');
  const hostname = await guard.inspectNetworkTarget('http://metadata.google.internal/latest');
  const rebound = await guard.inspectNetworkTarget(
    'https://public.example/resource',
    async () => [{ address: '169.254.1.20', family: 4 }],
  );
  const publicTarget = await guard.inspectNetworkTarget(
    'https://public.example/resource',
    async () => [{ address: '93.184.216.34', family: 4 }],
  );
  const dnsFailure = await guard.inspectNetworkTarget(
    'https://unresolved.example/resource',
    async () => { throw new Error('NXDOMAIN'); },
  );
  const dualStack = await guard.resolvePinnedNetworkTarget(
    'dual.example',
    async () => [
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ],
  );
  console.log(JSON.stringify({
    direct, ipv6, mapped, mappedAlibaba, expandedAws, hostname, rebound,
    publicTarget, dnsFailure, dualStack,
  }));
})();
"""
            result = subprocess.run(
                [shutil.which("node") or "node", "-e", script, str(preload)],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["direct"])
            self.assertTrue(payload["ipv6"])
            self.assertTrue(payload["mapped"])
            self.assertTrue(payload["mappedAlibaba"])
            self.assertTrue(payload["expandedAws"])
            self.assertTrue(payload["hostname"]["blocked"])
            self.assertTrue(payload["rebound"]["blocked"])
            self.assertFalse(payload["publicTarget"]["blocked"])
            self.assertTrue(payload["dnsFailure"]["blocked"])
            self.assertEqual(payload["dnsFailure"]["reason"], "dns-resolution-failed")
            self.assertEqual(payload["dualStack"]["family"], 4)

    @unittest.skipUnless(shutil.which("node"), "Node is required to exercise the pinning proxy")
    def test_camofox_pinning_proxy_covers_http_connect_websocket_and_fail_closed_dns(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            preload = manager._camofox_source_dir() / "loopback-preload.cjs"
            script = r"""
const http = require('node:http');
const net = require('node:net');
const guard = require(process.argv[1]);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
function proxyHttp(port, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, method: 'GET', path: target,
      headers: { Host: new URL(target).host },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject);
    request.end();
  });
}
function proxyConnect(port, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    let sent = false;
    const timeout = setTimeout(() => reject(new Error('CONNECT test timed out')), 5000);
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      response += chunk;
      if (!sent && response.includes('\r\n\r\n')) {
        sent = true;
        socket.write('GET /connect HTTP/1.1\r\nHost: safe.test\r\nConnection: close\r\n\r\n');
      }
      if (response.includes('http-ok:/connect')) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(response);
      }
    });
    socket.once('connect', () => {
      socket.write(`CONNECT safe.test:${targetPort} HTTP/1.1\r\nHost: safe.test:${targetPort}\r\n\r\n`);
    });
  });
}
function proxyWebSocket(port, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    const timeout = setTimeout(() => reject(new Error('WebSocket test timed out')), 5000);
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('ws-ok')) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(response);
      }
    });
    socket.once('connect', () => socket.write(
      `GET ws://safe.test:${targetPort}/socket HTTP/1.1\r\n`
      + `Host: safe.test:${targetPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
      + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGVzdC1rZXktMTIzNA==\r\n\r\n',
    ));
  });
}

(async () => {
  const origin = http.createServer((request, response) => response.end(`http-ok:${request.url}`));
  origin.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nws-ok');
  });
  const originPort = await listen(origin);
  const lookup = async (hostname) => {
    if (hostname === 'blocked.test') return [{ address: '169.254.10.20', family: 4 }];
    if (hostname === 'mapped.test') return [{ address: '::ffff:100.100.100.200', family: 6 }];
    if (hostname === 'missing.test') throw new Error('NXDOMAIN');
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const proxy = guard.createPinningProxy({ lookup });
  const proxyUrl = new URL(await proxy.listen());
  const proxyPort = Number(proxyUrl.port);
  try {
    const normal = await proxyHttp(proxyPort, `http://safe.test:${originPort}/http`);
    const blocked = await proxyHttp(proxyPort, `http://blocked.test:${originPort}/secret`);
    const mapped = await proxyHttp(proxyPort, `http://mapped.test:${originPort}/secret`);
    const missing = await proxyHttp(proxyPort, `http://missing.test:${originPort}/missing`);
    const connect = await proxyConnect(proxyPort, originPort);
    const websocket = await proxyWebSocket(proxyPort, originPort);
    console.log(JSON.stringify({ normal, blocked, mapped, missing, connect, websocket }));
  } finally {
    await proxy.close();
    await close(origin);
  }
})().catch((error) => { console.error(error); process.exit(1); });
"""
            result = subprocess.run(
                [shutil.which("node") or "node", "-e", script, str(preload)],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["normal"], {"status": 200, "body": "http-ok:/http"})
            self.assertEqual(payload["blocked"]["status"], 403)
            self.assertEqual(payload["mapped"]["status"], 403)
            self.assertEqual(payload["missing"]["status"], 502)
            self.assertIn("http-ok:/connect", payload["connect"])
            self.assertIn("101 Switching Protocols", payload["websocket"])
            self.assertIn("ws-ok", payload["websocket"])

    @unittest.skipUnless(shutil.which("node"), "Node is required to exercise proxy policy")
    def test_camofox_preload_preserves_explicit_upstream_proxy(self):
        with tempfile.TemporaryDirectory() as td:
            manager = self._manager(Path(td))
            preload = manager._camofox_source_dir() / "loopback-preload.cjs"
            script = r"""
const guard = require(process.argv[1]);
let captured = null;
const context = {
  async route() {},
  async routeWebSocket() {},
  async close() {},
};
const browser = {
  async newContext(options) { captured = options; return context; },
  contexts() { return []; },
};
(async () => {
  guard.patchBrowser(browser, { upstreamProxy: false, source: 'test' });
  await browser.newContext({ proxy: { server: 'http://proxy.example:8080' } });
  console.log(JSON.stringify(captured));
})();
"""
            result = subprocess.run(
                [shutil.which("node") or "node", "-e", script, str(preload)],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["proxy"], {"server": "http://proxy.example:8080"})
            self.assertEqual(payload["serviceWorkers"], "block")
            self.assertIn("upstream proxy preserved", result.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node is required to apply the runtime patch")
    def test_camofox_runtime_patch_is_exact_and_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            server = root / "node_modules" / "@askjo" / "camofox-browser" / "server.js"
            server.parent.mkdir(parents=True)
            server.write_text(
                """function log(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\\n');
  } else {
    process.stdout.write(line + '\\n');
  }
}
before();
reporter.resetNativeMemBaseline();
after();
""",
                encoding="utf-8",
            )
            patch = Path(__file__).resolve().parents[1] / "camofox-runtime" / "patch-runtime.cjs"
            for _ in range(2):
                result = subprocess.run(
                    [shutil.which("node") or "node", str(patch)],
                    cwd=root,
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            patched = server.read_text(encoding="utf-8")
            self.assertIn("reporter.resetNativeMemBaseline?.();", patched)
            self.assertNotIn("reporter.resetNativeMemBaseline();", patched)
            self.assertIn("function sanitizeLogUrl(value)", patched)
            self.assertIn("...sanitizeLogFields(fields)", patched)
            self.assertIn("[invalid-url-redacted]", patched)
            helper_start = patched.index("function sanitizeLogUrl(value)")
            helper_end = patched.index("function log(level", helper_start)
            helper_source = patched[helper_start:helper_end]
            redaction_probe = helper_source + r"""
const payload = sanitizeLogFields({
  url: 'https://alice:password@example.test/path?q=secret#fragment',
  nested: {
    error: 'page.goto failed at https://bob:token@example.test/deep/page?api_key=hidden#frag\u001b[22m.',
    urls: ['ws://user:pass@example.test/socket?credential=gone#tail'],
  },
});
console.log(JSON.stringify(payload));
"""
            result = subprocess.run(
                [shutil.which("node") or "node", "-e", redaction_probe],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            redacted = json.loads(result.stdout)
            serialized = json.dumps(redacted)
            for secret in ("alice", "password", "secret", "bob", "token", "hidden", "credential", "gone"):
                self.assertNotIn(secret, serialized)
            self.assertEqual(redacted["url"], "https://example.test/path")
            self.assertIn("https://example.test/deep/page", redacted["nested"]["error"])
            self.assertIn("\u001b[22m.", redacted["nested"]["error"])
            self.assertEqual(redacted["nested"]["urls"], ["ws://example.test/socket"])

    @unittest.skipUnless(shutil.which("node"), "Node is required to exercise the loopback preload")

    def test_managed_tool_urls_must_be_loopback(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            agent = self._manager(
                tmp,
                config=replace(
                    make_config(tmp),
                    manage_agent_runtime=True,
                    agent_runtime_url="http://0.0.0.0:8766",
                ),
            ).prepare_agent_runtime()
            self.assertEqual(agent.state, "invalid_config")
            self.assertIn("loopback", agent.error)

            camofox = self._manager(
                tmp,
                config=replace(make_config(tmp), camofox_url="http://0.0.0.0:9377"),
            ).prepare_camofox()
            self.assertEqual(camofox.state, "invalid_config")
            self.assertIn("loopback", camofox.error)

            firecrawl = self._manager(
                tmp,
                config=replace(make_config(tmp), firecrawl_api_url="http://192.168.1.2:3002"),
            ).prepare_firecrawl()
            self.assertEqual(firecrawl.state, "invalid_config")
            self.assertIn("loopback", firecrawl.error)

    def test_firecrawl_uses_loopback_publish_and_digest_pins(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            make_fake_firecrawl_repo(tmp / "firecrawl")
            manager = self._manager(tmp)
            env_path = manager._ensure_firecrawl_env()
            self.assertIn('PORT="127.0.0.1:13002"', env_path.read_text(encoding="utf-8"))
            override = manager._ensure_firecrawl_compose_override().read_text(encoding="utf-8")
            expected_images = (
                FIRECRAWL_IMAGE,
                FIRECRAWL_PLAYWRIGHT_IMAGE,
                FIRECRAWL_POSTGRES_IMAGE,
                FIRECRAWL_REDIS_IMAGE,
                FIRECRAWL_RABBITMQ_IMAGE,
                FIRECRAWL_FOUNDATIONDB_IMAGE,
            )
            for service, image in FIRECRAWL_SERVICE_IMAGES:
                self.assertIn(f"  {service}:\n    image: {image}", override)
            for image in expected_images:
                repository, digest = image.rsplit("@sha256:", 1)
                self.assertTrue(repository)
                self.assertEqual(len(digest), 64)
                self.assertTrue(all(character in "0123456789abcdef" for character in digest))
                self.assertNotIn(":", repository.rsplit("/", 1)[-1])
            override_images = [
                line.split("image:", 1)[1].strip()
                for line in override.splitlines()
                if line.strip().startswith("image:")
            ]
            self.assertEqual(len(override_images), len(FIRECRAWL_SERVICE_IMAGES))
            for image in override_images:
                self.assertRegex(image, r"^[^@\s]+@sha256:[0-9a-f]{64}$")

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is required to merge Firecrawl config")
    def test_firecrawl_merged_compose_uses_only_digest_pinned_images(self):
        compose_version = subprocess.run(
            ["docker", "compose", "version"],
            text=True,
            capture_output=True,
            check=False,
        )
        if compose_version.returncode != 0:
            self.skipTest("docker compose is unavailable")

        repository = Path(__file__).resolve().parents[2] / "firecrawl"
        compose_file = repository / "docker-compose.yaml"
        if not compose_file.is_file():
            self.skipTest("Firecrawl submodule compose file is unavailable")

        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            config = replace(make_config(tmp), firecrawl_repo=repository)
            manager = self._manager(tmp, config=config)
            env_path = manager._ensure_firecrawl_env()
            override = manager._ensure_firecrawl_compose_override()
            service_result = subprocess.run(
                [
                    "docker", "compose", "--env-file", str(env_path),
                    "-f", str(compose_file), "config", "--services",
                ],
                cwd=repository,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(service_result.returncode, 0, service_result.stderr)
            upstream_services = {line.strip() for line in service_result.stdout.splitlines() if line.strip()}
            self.assertEqual(upstream_services, {service for service, _ in FIRECRAWL_SERVICE_IMAGES})
            result = subprocess.run(
                [
                    "docker", "compose", "--env-file", str(env_path),
                    "-f", str(compose_file), "-f", str(override),
                    "config", "--format", "json",
                ],
                cwd=repository,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            merged = json.loads(result.stdout)
            services = merged.get("services") or {}
            self.assertEqual(set(services), upstream_services)
            for service, image in FIRECRAWL_SERVICE_IMAGES:
                self.assertEqual(services[service]["image"], image)
                self.assertRegex(image, r"^[^@\s]+@sha256:[0-9a-f]{64}$")

    def test_managed_health_probe_requires_2xx_and_expected_json_shape(self):
        validator = lambda payload: payload.get("ok") is True and payload.get("engine") == "camoufox"
        with mock.patch(
            "enterprise_agent_platform.runtimes.urllib.request.urlopen",
            return_value=_FakeHTTPResponse(404, {"ok": True, "engine": "camoufox"}),
        ):
            self.assertFalse(
                PlatformRuntimeManager._probe_json_health("http://127.0.0.1:9", ("/health",), validator)
            )
        with mock.patch(
            "enterprise_agent_platform.runtimes.urllib.request.urlopen",
            return_value=_FakeHTTPResponse(200, {"status": "some unrelated service"}),
        ):
            self.assertFalse(
                PlatformRuntimeManager._probe_json_health("http://127.0.0.1:9", ("/health",), validator)
            )
        with mock.patch(
            "enterprise_agent_platform.runtimes.urllib.request.urlopen",
            return_value=_FakeHTTPResponse(200, {"ok": True, "engine": "camoufox"}),
        ):
            self.assertTrue(
                PlatformRuntimeManager._probe_json_health("http://127.0.0.1:9", ("/health",), validator)
            )


if __name__ == "__main__":
    unittest.main()
