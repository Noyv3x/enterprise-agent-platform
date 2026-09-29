#!/usr/bin/env bash
# Run from the repository root with artifacts/managed-images.json and CI runner variables.
set -euo pipefail
root="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/agent-platform-compose-smoke.XXXXXX")"
export AGENT_PLATFORM_COMPOSE_PROJECT="agent-platform-release-smoke-${GITHUB_RUN_ID}"
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
  length == 10 and
  all(.[]; test("^[^@\\s]+@sha256:[0-9a-f]{64}$"))
' "$verified_images" >/dev/null
AGENT_PLATFORM_PLATFORM_IMAGE="$(jq -er '.platform' "$verified_images")"
AGENT_PLATFORM_AGENT_RUNTIME_IMAGE="$(jq -er '."agent-runtime"' "$verified_images")"
AGENT_PLATFORM_CAMOFOX_IMAGE="$(jq -er '.camofox' "$verified_images")"
AGENT_PLATFORM_AGENT_SANDBOX_IMAGE="$(jq -er '."agent-sandbox"' "$verified_images")"
AGENT_PLATFORM_SEARXNG_IMAGE="$(jq -er '.searxng' "$verified_images")"
AGENT_PLATFORM_FIRECRAWL_API_IMAGE="$(jq -er '."firecrawl-api"' "$verified_images")"
AGENT_PLATFORM_FIRECRAWL_PLAYWRIGHT_IMAGE="$(jq -er '."firecrawl-playwright"' "$verified_images")"
AGENT_PLATFORM_FIRECRAWL_POSTGRES_IMAGE="$(jq -er '."firecrawl-postgres"' "$verified_images")"
AGENT_PLATFORM_FIRECRAWL_REDIS_IMAGE="$(jq -er '."firecrawl-redis"' "$verified_images")"
AGENT_PLATFORM_FIRECRAWL_RABBITMQ_IMAGE="$(jq -er '."firecrawl-rabbitmq"' "$verified_images")"
export \
  AGENT_PLATFORM_PLATFORM_IMAGE AGENT_PLATFORM_AGENT_RUNTIME_IMAGE AGENT_PLATFORM_CAMOFOX_IMAGE \
  AGENT_PLATFORM_AGENT_SANDBOX_IMAGE AGENT_PLATFORM_SEARXNG_IMAGE \
  AGENT_PLATFORM_FIRECRAWL_API_IMAGE AGENT_PLATFORM_FIRECRAWL_PLAYWRIGHT_IMAGE \
  AGENT_PLATFORM_FIRECRAWL_POSTGRES_IMAGE AGENT_PLATFORM_FIRECRAWL_REDIS_IMAGE \
  AGENT_PLATFORM_FIRECRAWL_RABBITMQ_IMAGE
sandbox_image="$AGENT_PLATFORM_AGENT_SANDBOX_IMAGE"
sandbox_container="${AGENT_PLATFORM_COMPOSE_PROJECT}-sandbox"
browser_fixture_container="${AGENT_PLATFORM_COMPOSE_PROJECT}-browser-fixture"
manager_stub_pid=""
cleanup() {
  docker rm --force "$sandbox_container" >/dev/null 2>&1 || true
  docker rm --force "$browser_fixture_container" >/dev/null 2>&1 || true
  docker compose -f containers/compose.yaml down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker network rm "$AGENT_PLATFORM_CORE_NETWORK" >/dev/null 2>&1 || true
  if [[ -n "$manager_stub_pid" ]]; then
    kill "$manager_stub_pid" >/dev/null 2>&1 || true
    wait "$manager_stub_pid" 2>/dev/null || true
  fi
  case "$root" in
    "$RUNNER_TEMP"/agent-platform-compose-smoke.*) ;;
    *) echo "Refusing to remove unexpected smoke root: $root" >&2; return 1 ;;
  esac
  sudo -n rm -rf --one-file-system -- "$root"
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
  session-secret agent-tool-token agent-runtime-token camofox-access-key manager-token manager-executor-token \
  firecrawl-postgres-password firecrawl-bull-auth-key; do
  openssl rand -hex 32 > "$AGENT_PLATFORM_SECRETS_DIR/$secret"
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
python3 - "$AGENT_PLATFORM_MANAGER_CONTROL_DIR/manager.sock" "$AGENT_PLATFORM_SECRETS_DIR/manager-token" <<'PY' &
import datetime
import hmac
import http.server
import json
import os
import socketserver
import sys
from pathlib import Path

socket_path = Path(sys.argv[1])
token = Path(sys.argv[2]).read_text(encoding="utf-8").strip()

class ManagerContract(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied, f"Bearer {token}"):
            self.send_json(401, {"error": "control authentication failed"})
            return
        if self.path != "/v1/status":
            self.send_json(404, {"error": "not found"})
            return
        checked_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        self.send_json(200, {
            "generation": 0,
            "current": None,
            "previous": None,
            "target": None,
            "public_state": "idle",
            "phase": "",
            "services": {
                "manager": {"status": "healthy"},
                "platform": {"status": "running"},
            },
            "error": "",
            "maintenance": False,
            "active_operation_id": "",
            "finalize_pending_operation_id": "",
            "operation_id": "",
            "gate_settlement": None,
            "checked_at": checked_at,
        })

class ThreadingUnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

server = ThreadingUnixHTTPServer(str(socket_path), ManagerContract)
os.chmod(socket_path, 0o600)
server.serve_forever()
PY
manager_stub_pid="$!"
for attempt in $(seq 1 50); do
  [[ -S "$AGENT_PLATFORM_MANAGER_CONTROL_DIR/manager.sock" ]] && break
  kill -0 "$manager_stub_pid"
  sleep 0.1
done
test -S "$AGENT_PLATFORM_MANAGER_CONTROL_DIR/manager.sock"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --unix-socket "$AGENT_PLATFORM_MANAGER_CONTROL_DIR/manager.sock" \
  http://manager/v1/status)" = 401
manager_status="$(curl --fail --silent --show-error \
  --unix-socket "$AGENT_PLATFORM_MANAGER_CONTROL_DIR/manager.sock" \
  --header "Authorization: Bearer $(<"$AGENT_PLATFORM_SECRETS_DIR/manager-token")" \
  http://manager/v1/status)"
jq -e '
  .public_state == "idle" and
  .maintenance == false and
  .active_operation_id == "" and
  .finalize_pending_operation_id == "" and
  .operation_id == "" and
  .services.manager.status == "healthy"
' <<<"$manager_status" >/dev/null
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
    searxng: .services.searxng.image,
    "firecrawl-api": .services["firecrawl-api"].image,
    "firecrawl-playwright": .services["firecrawl-playwright"].image,
    "firecrawl-postgres": .services["firecrawl-postgres"].image,
    "firecrawl-redis": .services["firecrawl-redis"].image,
    "firecrawl-rabbitmq": .services["firecrawl-rabbitmq"].image
  } == ($expected[0] | del(."agent-sandbox"))
' <<<"$resolved_compose" >/dev/null
database_marker() {
  python3 -c 'import sqlite3,sys; from pathlib import Path; uri=Path(sys.argv[1]).resolve().as_uri()+"?mode=ro"; print(sqlite3.connect(uri, uri=True).execute("SELECT version FROM schema_migrations").fetchone()[0])' \
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
test "$(database_marker)" = 2026082901
# Re-running migration on the current schema must preserve the initialized database.
docker compose -f containers/compose.yaml run --rm --no-deps platform migrate
test "$(database_marker)" = 2026082901
test ! -e "$shadow_sentinel"
test "$(stat -c %u:%g:%a "$AGENT_PLATFORM_DATA_ROOT/data/platform.db")" = "$AGENT_PLATFORM_UID:$AGENT_PLATFORM_GID:600"
if docker compose -f containers/compose.yaml run --rm --no-deps platform sh -c true; then
  echo "Platform entrypoint accepted a root shell" >&2
  exit 1
fi
test "$(docker run --rm --pull=always --network=none --read-only --entrypoint sh \
  "$AGENT_PLATFORM_FIRECRAWL_REDIS_IMAGE" -c 'printf "%s:%s" "$(id -u redis)" "$(id -g redis)"')" = "999:1000"
test "$(docker run --rm --pull=always --network=none --read-only --entrypoint sh \
  "$AGENT_PLATFORM_FIRECRAWL_RABBITMQ_IMAGE" -c 'printf "%s:%s" "$(id -u rabbitmq)" "$(id -g rabbitmq)"')" = "999:999"
test "$(docker run --rm --pull=always --network=none --read-only --entrypoint sh \
  "$AGENT_PLATFORM_FIRECRAWL_POSTGRES_IMAGE" -c 'printf "%s:%s" "$(id -u postgres)" "$(id -g postgres)"')" = "999:999"
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
curl --fail --silent --show-error http://127.0.0.1:18080/healthz | jq -e '.service == "agent-platform"'
browser_fixture_path="$GITHUB_WORKSPACE/scripts/fixtures/browser-control.html"
test -f "$browser_fixture_path"
docker run --detach \
  --name "$browser_fixture_container" \
  --network "$AGENT_PLATFORM_CORE_NETWORK" \
  --user "$AGENT_PLATFORM_UID:$AGENT_PLATFORM_GID" \
  --read-only \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --mount "type=bind,src=$browser_fixture_path,dst=/fixture/index.html,readonly" \
  --entrypoint python \
  "$AGENT_PLATFORM_PLATFORM_IMAGE" \
  -m http.server 18081 --bind 0.0.0.0 --directory /fixture
for attempt in $(seq 1 50); do
  if docker exec "$browser_fixture_container" python -c \
    'import urllib.request; urllib.request.urlopen("http://127.0.0.1:18081/", timeout=1).read(1)'; then
    break
  fi
  [[ "$attempt" -lt 50 ]] || {
    docker logs "$browser_fixture_container"
    exit 1
  }
  sleep 0.2
done
python3 scripts/browser-control-compose-smoke.py \
  --platform-url http://127.0.0.1:18080 \
  --bootstrap-password-file "$AGENT_PLATFORM_DATA_ROOT/data/bootstrap-admin-password.txt" \
  --agent-tool-token-file "$AGENT_PLATFORM_SECRETS_DIR/agent-tool-token" \
  --fixture-url "http://${browser_fixture_container}:18081/"
docker rm --force "$browser_fixture_container"
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
docker compose -f containers/compose.yaml stop \
  platform agent-runtime camofox searxng
if ! docker compose -f containers/compose.yaml up --detach --wait --wait-timeout 600 firecrawl-api; then
  docker compose -f containers/compose.yaml ps --all
  docker compose -f containers/compose.yaml logs --no-color --tail 200 \
    firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq \
    firecrawl-postgres
  exit 1
fi
for service in \
  firecrawl-playwright firecrawl-redis firecrawl-rabbitmq \
  firecrawl-postgres firecrawl-api; do
  container="$(docker compose -f containers/compose.yaml ps -q "$service")"
  test -n "$container"
  for attempt in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    [[ "$status" == healthy ]] && break
    [[ "$status" != unhealthy || "$attempt" -lt 60 ]] || {
      docker compose -f containers/compose.yaml logs --no-color --tail 200 "$service"
      exit 1
    }
    sleep 5
  done
  test "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy
done
firecrawl_scrape() {
  local phase="$1"
  local attempt
  for attempt in 1 2 3; do
    if docker compose -f containers/compose.yaml exec -T firecrawl-api \
      node --input-type=module - "$phase" <<'NODE'
const phase = process.argv[2] || 'unknown';
const response = await fetch('http://127.0.0.1:3002/v1/scrape', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({url: 'https://example.com/', formats: ['markdown']}),
  signal: AbortSignal.timeout(120000),
});
const text = await response.text();
let body;
try {
  body = JSON.parse(text);
} catch (error) {
  throw new Error(`Firecrawl ${phase} scrape returned non-JSON: ${response.status} ${text.slice(0, 2000)}`, {cause: error});
}
// example.com's wording changes upstream; prove a real page was
// fetched and converted rather than pinning its exact text.
if (!response.ok || body.success !== true || !/\bdomain\b/i.test(body.data?.markdown ?? '')) {
  throw new Error(`Firecrawl ${phase} scrape failed: ${response.status} ${text.slice(0, 2000)}`);
}
NODE
    then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "Firecrawl ${phase} scrape attempt ${attempt}/3 failed; retrying" >&2
      sleep $((attempt * 5))
    fi
  done
  echo "Firecrawl ${phase} scrape failed after 3 attempts" >&2
  docker compose -f containers/compose.yaml ps --all >&2
  docker compose -f containers/compose.yaml logs --no-color --timestamps --tail 200 \
    firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq \
    firecrawl-postgres >&2
  return 1
}
sentinel_key=agent_platform_ci_persistence
sentinel_value="retained_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}"
first_postgres="$(docker compose -f containers/compose.yaml ps -q firecrawl-postgres)"
test -n "$first_postgres"
docker compose -f containers/compose.yaml exec -T \
  -e "AGENT_PLATFORM_SENTINEL_KEY=$sentinel_key" \
  -e "AGENT_PLATFORM_SENTINEL_VALUE=$sentinel_value" \
  firecrawl-postgres sh -eu -c '
    export PGPASSWORD="$(cat /run/secrets/agent-platform/firecrawl-postgres-password)"
    psql --host 127.0.0.1 --username postgres --dbname postgres \
      --set ON_ERROR_STOP=1 --command "
        CREATE TABLE IF NOT EXISTS agent_platform_release_smoke (
          key text PRIMARY KEY,
          value text NOT NULL
        );
        INSERT INTO agent_platform_release_smoke (key, value)
        VALUES ('"'"'$AGENT_PLATFORM_SENTINEL_KEY'"'"', '"'"'$AGENT_PLATFORM_SENTINEL_VALUE'"'"')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
      "
  '
docker compose -f containers/compose.yaml exec -T firecrawl-api \
  node -e 'fetch("http://127.0.0.1:3002/v0/health/liveness").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
firecrawl_scrape cold
docker compose -f containers/compose.yaml rm --stop --force \
  firecrawl-api firecrawl-postgres
if ! docker compose -f containers/compose.yaml up --detach --wait --wait-timeout 600 firecrawl-api; then
  docker compose -f containers/compose.yaml ps --all
  docker compose -f containers/compose.yaml logs --no-color --tail 200 \
    firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq \
    firecrawl-postgres
  exit 1
fi
for service in firecrawl-postgres firecrawl-api; do
  container="$(docker compose -f containers/compose.yaml ps -q "$service")"
  test -n "$container"
  for attempt in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
    [[ "$status" == healthy ]] && break
    [[ "$status" != unhealthy || "$attempt" -lt 60 ]] || {
      docker compose -f containers/compose.yaml logs --no-color --tail 200 "$service"
      exit 1
    }
    sleep 5
  done
  test "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy
done
second_postgres="$(docker compose -f containers/compose.yaml ps -q firecrawl-postgres)"
test -n "$second_postgres"
test "$second_postgres" != "$first_postgres"
read_output="$(docker compose -f containers/compose.yaml exec -T \
  -e "AGENT_PLATFORM_SENTINEL_KEY=$sentinel_key" \
  firecrawl-postgres sh -eu -c '
    export PGPASSWORD="$(cat /run/secrets/agent-platform/firecrawl-postgres-password)"
    psql --host 127.0.0.1 --username postgres --dbname postgres \
      --tuples-only --no-align --set ON_ERROR_STOP=1 \
      --command "SELECT value FROM agent_platform_release_smoke WHERE key = '"'"'$AGENT_PLATFORM_SENTINEL_KEY'"'"';"
  ')"
test "$read_output" = "$sentinel_value"
docker compose -f containers/compose.yaml exec -T firecrawl-api \
  node -e 'fetch("http://127.0.0.1:3002/v0/health/liveness").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
firecrawl_scrape warm
docker compose -f containers/compose.yaml stop \
  firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq \
  firecrawl-postgres
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
