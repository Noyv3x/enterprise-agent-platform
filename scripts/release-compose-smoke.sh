#!/usr/bin/env bash
# Image integration only: no model credentials or model calls; Manager control is a test double.
# Real OAuth, executor lifecycle, migration context, and cache behavior require staging.
# Browser control uses example.com -> IANA; public-site availability is required.
set -euo pipefail
root="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/agent-platform-compose-smoke.XXXXXX")"
export AGENT_PLATFORM_COMPOSE_PROJECT="agent-platform-release-smoke-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
export AGENT_PLATFORM_CORE_NETWORK="${AGENT_PLATFORM_COMPOSE_PROJECT}-core"
export AGENT_PLATFORM_DATA_ROOT="$root/state"
export AGENT_PLATFORM_SECRETS_DIR="$AGENT_PLATFORM_DATA_ROOT/manager/secrets"
export AGENT_PLATFORM_MANAGER_CONTROL_DIR="$AGENT_PLATFORM_DATA_ROOT/manager/control"
AGENT_PLATFORM_UID="$(id -u)"
AGENT_PLATFORM_GID="$(id -g)"
export AGENT_PLATFORM_UID AGENT_PLATFORM_GID
export AGENT_PLATFORM_PLATFORM_BIND=127.0.0.1:18080
export AGENT_PLATFORM_PUBLIC_BASE_URL=http://127.0.0.1:18080
verified_images=artifacts/managed-images.json
jq -e '
  keys == ["agent-runtime", "agent-sandbox", "camofox", "platform", "searxng"] and
  all(.[]; test("^[^@\\s]+@sha256:[0-9a-f]{64}$"))
' "$verified_images" >/dev/null
AGENT_PLATFORM_PLATFORM_IMAGE="$(jq -er '.platform' "$verified_images")"
AGENT_PLATFORM_AGENT_RUNTIME_IMAGE="$(jq -er '."agent-runtime"' "$verified_images")"
AGENT_PLATFORM_CAMOFOX_IMAGE="$(jq -er '.camofox' "$verified_images")"
AGENT_PLATFORM_AGENT_SANDBOX_IMAGE="$(jq -er '."agent-sandbox"' "$verified_images")"
AGENT_PLATFORM_SEARXNG_IMAGE="$(jq -er '.searxng' "$verified_images")"
export \
  AGENT_PLATFORM_PLATFORM_IMAGE AGENT_PLATFORM_AGENT_RUNTIME_IMAGE AGENT_PLATFORM_CAMOFOX_IMAGE \
  AGENT_PLATFORM_AGENT_SANDBOX_IMAGE AGENT_PLATFORM_SEARXNG_IMAGE
sandbox_image="$AGENT_PLATFORM_AGENT_SANDBOX_IMAGE"
sandbox_container="${AGENT_PLATFORM_COMPOSE_PROJECT}-sandbox"
manager_stub_pid=""
cleanup() {
  local status=$? failed=0 resources="" resource
  resources="$(docker ps --all --quiet \
    --filter "name=^/${sandbox_container}$")" || failed=1
  while IFS= read -r resource; do
    [[ -z "$resource" ]] || docker rm --force "$resource" || failed=1
  done <<<"$resources"
  docker compose -f containers/compose.yaml down --volumes --remove-orphans || failed=1
  resources="$(docker network ls --quiet \
    --filter "name=^${AGENT_PLATFORM_CORE_NETWORK}$")" || failed=1
  while IFS= read -r resource; do
    [[ -z "$resource" ]] || docker network rm "$resource" || failed=1
  done <<<"$resources"
  if [[ -n "$manager_stub_pid" ]]; then
    kill "$manager_stub_pid" || failed=1
    wait "$manager_stub_pid" || failed=1
  fi
  case "$root" in
    "$RUNNER_TEMP"/agent-platform-compose-smoke.*) ;;
    *) echo "Refusing to remove unexpected smoke root: $root" >&2; return 1 ;;
  esac
  sudo -n rm -rf --one-file-system -- "$root" || failed=1
  if (( failed )); then
    echo "Release smoke cleanup failed; inspect project $AGENT_PLATFORM_COMPOSE_PROJECT" >&2
    return 1
  fi
  return "$status"
}
trap cleanup EXIT
mkdir -p \
  "$AGENT_PLATFORM_SECRETS_DIR" "$AGENT_PLATFORM_MANAGER_CONTROL_DIR" \
  "$AGENT_PLATFORM_DATA_ROOT/data/workspaces" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/agent" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/camofox" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/searxng/config" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/searxng/cache"
for secret in \
  session-secret agent-tool-token agent-runtime-token camofox-access-key manager-token manager-executor-token; do
  openssl rand -hex 32 > "$AGENT_PLATFORM_SECRETS_DIR/$secret"
done
# Only the read-only Manager control boundary is doubled. No executor or update routes.
chmod 0700 "$AGENT_PLATFORM_MANAGER_CONTROL_DIR" "$AGENT_PLATFORM_SECRETS_DIR"
chmod 0600 "$AGENT_PLATFORM_SECRETS_DIR"/*
release_source="$(git -c safe.directory="$PWD" rev-parse HEAD)"
python3 - "$AGENT_PLATFORM_MANAGER_CONTROL_DIR/manager.sock" \
  "$AGENT_PLATFORM_SECRETS_DIR/manager-token" "$verified_images" "$release_source" <<'MANAGER' &
import hmac
import json
import os
import signal
import socketserver
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path

socket_path, token_path, images_path, commit = sys.argv[1:]
images = json.loads(Path(images_path).read_text())
schema = json.loads(Path("docs/contracts/container-platform.json").read_text())
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
services = {name: {"status": "unknown"} for name in (
    "platform", "agent-runtime", "camofox", "searxng", "firecrawl-playwright",
    "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-postgres", "firecrawl-api",
)}
services["manager"] = {"status": "healthy"}
responses = {
    "/v1/status": {
        "generation": 1,
        "current": {"id": commit, "source_commit": commit,
                    "database_version": schema["database_schema_version"],
                    "images": images, "activated_at": now},
        "previous": None, "target": None, "public_state": "idle", "phase": "",
        "services": services, "error": "", "maintenance": False,
        "active_operation_id": "", "finalize_pending_operation_id": "",
        "operation_id": "", "gate_settlement": None, "checked_at": now,
    },
    "/v1/config": {
        "update_enabled": False, "update_interval": 60,
        "release_manifest_url": "https://example.invalid/release.json",
        "lan_enabled": False, "lan_listen": "127.0.0.1:8081",
        "direct_access_cidrs": ["127.0.0.0/8", "::1/128", "10.0.0.0/8",
                               "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"],
        "trusted_ingress_cidrs": ["127.0.0.0/8", "::1/128"], "lan_active": False,
    },
}

class Handler(BaseHTTPRequestHandler):
    def handle_request(self):
        expected = "Bearer " + Path(token_path).read_text().strip()
        if not hmac.compare_digest(self.headers.get("Authorization", ""), expected):
            code, payload = 401, {"error": "control authentication failed"}
        elif self.command == "GET" and self.path in responses:
            code, payload = 200, responses[self.path]
        else:
            code, payload = 404, {"error": "not found"}
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = handle_request

    def log_message(self, *_):
        pass

signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
os.umask(0o077)
with socketserver.UnixStreamServer(socket_path, Handler) as server:
    os.chmod(socket_path, 0o600)
    server.serve_forever()
MANAGER
manager_stub_pid=$!
for attempt in $(seq 1 50); do
  if curl --fail --silent --unix-socket "$AGENT_PLATFORM_MANAGER_CONTROL_DIR/manager.sock" \
    --header "Authorization: Bearer $(cat "$AGENT_PLATFORM_SECRETS_DIR/manager-token")" \
    http://localhost/v1/status >/dev/null; then
    break
  fi
  kill -0 "$manager_stub_pid"
  [[ "$attempt" -lt 50 ]] || { echo "Manager control double did not become ready" >&2; exit 1; }
  sleep 0.1
done
cp containers/searxng/settings.yml "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/searxng/config/settings.yml"
chmod 0700 \
  "$AGENT_PLATFORM_DATA_ROOT/data" \
  "$AGENT_PLATFORM_DATA_ROOT/data/workspaces" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/agent" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/camofox" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/searxng/config" \
  "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/searxng/cache"
chmod 0600 "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/searxng/config/settings.yml"
docker network create \
  --driver bridge \
  --label io.agent-platform.network=core \
  "$AGENT_PLATFORM_CORE_NETWORK"
docker compose -f containers/compose.yaml config --quiet
resolved_compose="$(docker compose -f containers/compose.yaml config --format json)"
jq -e --slurpfile expected "$verified_images" '
  {
    platform: .services.platform.image,
    "agent-runtime": .services["agent-runtime"].image,
    camofox: .services.camofox.image,
    searxng: .services.searxng.image
  } == ($expected[0] | del(."agent-sandbox"))
' <<<"$resolved_compose" >/dev/null
database_marker() {
  python3 -c 'import sqlite3,sys; from pathlib import Path; uri=Path(sys.argv[1]).resolve().as_uri()+"?mode=ro"; rows=sqlite3.connect(uri, uri=True).execute("SELECT version FROM schema_migrations ORDER BY version").fetchall(); assert rows; print(rows)' \
    "$AGENT_PLATFORM_DATA_ROOT/data/platform.db"
}
shadow_sentinel="$AGENT_PLATFORM_DATA_ROOT/data/root-python-shadow-loaded"
mkdir -m 0700 "$AGENT_PLATFORM_DATA_ROOT/data/enterprise_agent_platform"
for shadow in \
  "$AGENT_PLATFORM_DATA_ROOT/data/enterprise_agent_platform/__init__.py" \
  "$AGENT_PLATFORM_DATA_ROOT/data/sitecustomize.py"; do
  printf '%s\n' \
    'from pathlib import Path' \
    'Path("/var/lib/agent-platform/root-python-shadow-loaded").write_text("loaded", encoding="utf-8")' \
    > "$shadow"
  chmod 0600 "$shadow"
done
docker compose -f containers/compose.yaml run --rm --no-deps platform migrate
test ! -e "$shadow_sentinel"
initial_schema="$(database_marker)"
# Re-running migration on the current schema must preserve the initialized database.
docker compose -f containers/compose.yaml run --rm --no-deps platform migrate
test "$(database_marker)" = "$initial_schema"
test ! -e "$shadow_sentinel"
test "$(stat -c %u:%g:%a "$AGENT_PLATFORM_DATA_ROOT/data/platform.db")" = "$AGENT_PLATFORM_UID:$AGENT_PLATFORM_GID:600"
if docker compose -f containers/compose.yaml run --rm --no-deps platform sh -c true; then
  echo "Platform entrypoint accepted a root shell" >&2
  exit 1
fi
docker compose -f containers/compose.yaml up --detach agent-runtime camofox searxng platform
for service in agent-runtime camofox searxng platform; do
  container="$(docker compose -f containers/compose.yaml ps -q "$service")"
  for attempt in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    [[ "$status" == healthy ]] && break
    [[ "$status" != unhealthy || "$attempt" -lt 60 ]] || {
      docker compose -f containers/compose.yaml logs "$service"
      exit 1
    }
    sleep 5
  done
  test "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy
done
platform_container="$(docker compose -f containers/compose.yaml ps -q platform)"
docker exec \
  --user "$AGENT_PLATFORM_UID:$AGENT_PLATFORM_GID" \
  --env "EXPECTED_UID=$AGENT_PLATFORM_UID" \
  --env "EXPECTED_GID=$AGENT_PLATFORM_GID" \
  "$platform_container" sh -eu -c '
    test "$(awk "/^Uid:/ {print \$2 \":\" \$3 \":\" \$4 \":\" \$5}" /proc/1/status)" = "$EXPECTED_UID:$EXPECTED_UID:$EXPECTED_UID:$EXPECTED_UID"
    test "$(awk "/^Gid:/ {print \$2 \":\" \$3 \":\" \$4 \":\" \$5}" /proc/1/status)" = "$EXPECTED_GID:$EXPECTED_GID:$EXPECTED_GID:$EXPECTED_GID"
    test "$(awk "/^Groups:/ {print NF}" /proc/1/status)" = 1
    test "$(awk "/^CapInh:/ {print \$2}" /proc/1/status)" = 0000000000000000
    test "$(awk "/^CapPrm:/ {print \$2}" /proc/1/status)" = 0000000000000000
    test "$(awk "/^CapEff:/ {print \$2}" /proc/1/status)" = 0000000000000000
    test "$(awk "/^CapAmb:/ {print \$2}" /proc/1/status)" = 0000000000000000
    test "$(awk "/^NoNewPrivs:/ {print \$2}" /proc/1/status)" = 1
  '
test ! -e "$shadow_sentinel"
searxng_container="$(docker compose -f containers/compose.yaml ps -q searxng)"
docker inspect "$searxng_container" | jq -e \
  --arg source "$AGENT_PLATFORM_DATA_ROOT/data/runtimes/searxng/config" '
    [.[0].Mounts[] | select(.Destination == "/etc/searxng")] as $config |
    ($config | length) == 1 and
    $config[0].Type == "bind" and
    $config[0].Source == $source and
    $config[0].RW == false and
    ([.[0].Mounts[] | select(.Type == "volume")] | length) == 0
  ' >/dev/null
docker compose -f containers/compose.yaml exec -T searxng sh -eu -c '
  test -r /etc/searxng/settings.yml
  test "$(stat -c %u /etc/searxng/settings.yml)" = "$(id -u)"
'
curl --fail --silent --show-error http://127.0.0.1:18080/healthz |
  jq -e '. == {"status":"ok","service":"agent-platform"}'
docker compose -f containers/compose.yaml exec -T agent-runtime node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
const token = readFileSync(process.env.AGENT_RUNTIME_TOKEN_FILE, 'utf8').trim();
const response = await fetch('http://127.0.0.1:8766/health', {
  headers: { Authorization: `Bearer ${token}` },
});
const body = await response.json();
if (!response.ok || body.status !== 'ok' || body.service !== 'agent-platform-runtime') {
  throw new Error(`Runtime health failed: ${response.status} ${JSON.stringify(body)}`);
}
JS
python3 - "$AGENT_PLATFORM_DATA_ROOT/data/bootstrap-admin-password.txt" <<'PY'
import http.cookiejar
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

base = "http://127.0.0.1:18080"
client = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
)
holder = str(uuid.uuid4())

def request(path, payload=None, method=None):
    req = urllib.request.Request(
        base + path,
        data=None if payload is None else json.dumps(payload).encode(),
        method=method,
        headers={"Content-Type": "application/json", "Origin": base},
    )
    with client.open(req, timeout=60) as response:
        data = response.read()
        return data if response.headers.get_content_type() == "image/png" else json.loads(data)

def action(name, **arguments):
    result = request("/api/browser/action", {
        "holder_id": holder, "action": name, "arguments": arguments,
    })
    assert result["is_error"] is False, result
    return result["data"]

login = request("/api/auth/login", {
    "username": "admin", "password": Path(sys.argv[1]).read_text().strip(),
})
user_id = login["user"]["id"]
assert login["user"]["role"] == "admin", login
assert request("/api/me")["user"]["id"] == user_id
request("/api/browser/lease", {"holder_id": holder})
try:
    try:
        request("/api/browser/lease", {"holder_id": str(uuid.uuid4())})
    except urllib.error.HTTPError as error:
        assert error.code == 409, error
    else:
        raise AssertionError("Browser takeover accepted a competing holder")
    tab = action("new_tab", url="https://example.com/")
    tab_id = tab["tabId"]
    snapshot = action("snapshot", tab_id=tab_id)["snapshot"]
    # Camofox 1.11.2 GET /tabs/:id/snapshot annotates native ARIA YAML.
    links = re.findall(r'^\s*-\s+link(?:\s+"[^"]*")? \[(e\d+)\]', snapshot, re.MULTILINE)
    assert len(links) == 1, f"Public smoke page changed: {snapshot}"
    action("click", tab_id=tab_id, ref=links[0])
    # Sidecar click awaits Playwright navigation; snapshot refresh waits DOMContentLoaded.
    snapshot = action("snapshot", tab_id=tab_id)
    assert urllib.parse.urlsplit(snapshot["url"]).hostname in {"iana.org", "www.iana.org"}, snapshot
    assert re.search(r"\bIANA\b", snapshot["snapshot"]), f"Public link did not reach IANA: {snapshot}"
    image = request("/api/browser/screenshot?" + urllib.parse.urlencode({"tab_id": tab_id}))
    assert image.startswith(b"\x89PNG\r\n\x1a\n"), "Browser preview is not PNG"
finally:
    request("/api/browser/lease", {"holder_id": holder}, method="DELETE")
assert request("/api/browser")["lease"] is None
print("Platform cookie login and real browser takeover/control/PNG preview passed")
PY
sandbox_mount_root="$root/sandbox-uid-mapping"
mkdir -p "$sandbox_mount_root/workspace" "$sandbox_mount_root/home" "$sandbox_mount_root/env"
touch "$sandbox_mount_root/workspace/ownership-sentinel"
sentinel_uid="$(stat -c %u "$sandbox_mount_root/workspace/ownership-sentinel")"
docker run --rm \
  --env AGENT_PLATFORM_AGENT_UID=12345 \
  --env AGENT_PLATFORM_AGENT_GID=23456 \
  --env "AGENT_PLATFORM_SENTINEL_UID=$sentinel_uid" \
  --mount "type=bind,src=$sandbox_mount_root/workspace,dst=/workspace" \
  --mount "type=bind,src=$sandbox_mount_root/home,dst=/home/agent" \
  --mount "type=bind,src=$sandbox_mount_root/env,dst=/opt/agent-env" \
  "$sandbox_image" \
  sh -eu -c 'test "$(id -u)" = 12345; test "$(id -g)" = 23456; test "$(sudo -n id -u)" = 0; test "$(stat -c %u /workspace/ownership-sentinel)" = "$AGENT_PLATFORM_SENTINEL_UID"; chmod 0755 /workspace /home/agent /opt/agent-env'
test "$(stat -c %u "$sandbox_mount_root/workspace/ownership-sentinel")" = "$sentinel_uid"
docker run --detach \
  --name "$sandbox_container" \
  --network "$AGENT_PLATFORM_CORE_NETWORK" \
  --env AGENT_PLATFORM_AGENT_UID=12345 \
  --env AGENT_PLATFORM_AGENT_GID=23456 \
  "$sandbox_image"
docker exec --user 12345:23456 "$sandbox_container" sh -eu -c \
  'test "$(id -u)" = 12345; test "$(id -g)" = 23456'
docker compose -f containers/compose.yaml down --remove-orphans
test "$(docker inspect --format '{{.State.Running}}' "$sandbox_container")" = true
docker network inspect "$AGENT_PLATFORM_CORE_NETWORK" \
  --format '{{index .Labels "io.agent-platform.network"}}' | grep -Fx core
docker network inspect "$AGENT_PLATFORM_CORE_NETWORK" \
  --format '{{json .Containers}}' | jq -e --arg id "$(docker inspect --format '{{.Id}}' "$sandbox_container")" 'has($id)'
docker compose -f containers/compose.yaml up --detach --wait \
  agent-runtime camofox searxng platform
test "$(docker inspect --format '{{.State.Running}}' "$sandbox_container")" = true
printf '%s\n' \
  'Image smoke passed: Platform health/login, Runtime health, browser control, sandbox execution.' \
  'Not covered: real-model turns, agent-vs-human browser exclusion, Manager executor/profile lifecycle, migrated context, compaction, prompt cache.' \
  'R2 still requires copied-production-data staging with real OAuth before release.'
