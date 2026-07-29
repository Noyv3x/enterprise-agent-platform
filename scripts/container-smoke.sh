#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail() {
  printf 'container validation failed: %s\n' "$*" >&2
  exit 1
}

for path in \
  containers/platform.Dockerfile \
  containers/agent-runtime.Dockerfile \
  containers/camofox.Dockerfile \
  containers/agent-sandbox.Dockerfile \
  containers/agent-sandbox-entrypoint.sh \
  containers/compose.yaml \
  containers/compose.dev.yaml \
  containers/release-manifest.schema.json \
  install.sh; do
  [[ -s "$path" ]] || fail "$path is missing or empty"
done

bash -n install.sh
for expected in \
  'This installer supports fresh container installations only.' \
  'docker compose version' \
  'read -r answer </dev/tty' \
  'systemctl --user enable --now ubitech-agent-manager.service' \
  '"$stable_manager" preflight --config "$config_path"' \
  'if ((status != 0 && manager_activated == 0)); then' \
  'rm -rf --one-file-system -- "$data_root/manager"' \
  '"$stable_manager" install --config "$config_path" --release-manifest-url "$manifest_url"'; do
  grep -Fq "$expected" install.sh || fail "fresh container installer contract is missing: $expected"
done
grep -Fq 'bash -s -- --yes' README.md \
  || fail "README fresh-install command does not pass explicit non-interactive consent"
for excluded in \
  'enterprise-agent-platform/build/' \
  'enterprise-agent-platform/dist/' \
  'enterprise-agent-platform/*.egg-info/' \
  'enterprise-agent-platform/**/__pycache__/' \
  'enterprise-agent-platform/**/*.pyc' \
  'enterprise-agent-platform/.venv/'; do
  grep -Fxq "$excluded" containers/platform.Dockerfile.dockerignore \
    || fail "Platform image context can include local build residue: $excluded"
done
if grep -Fxq 'COPY enterprise-agent-platform .' containers/platform.Dockerfile; then
  fail "Platform Python build copies the whole mixed-language source tree"
fi
grep -Fq \
  'COPY enterprise-agent-platform/pyproject.toml enterprise-agent-platform/README.md ./' \
  containers/platform.Dockerfile \
  || fail "Platform Python build does not copy an explicit package boundary"
[[ "$(grep -Fxc 'COPY enterprise-agent-platform/enterprise_agent_platform ./enterprise_agent_platform' containers/platform.Dockerfile)" -eq 1 ]] \
  || fail "Platform package source must enter only the Python build stage"

installer_test="$(mktemp -d)"
installer_stubs="$installer_test/bin"
mkdir -p "$installer_stubs"
cat > "$installer_test/fake-manager" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  preflight)
    if [[ "${FAKE_FAIL_STAGE:-preflight}" == preflight ]]; then
      mkdir -p "$FAKE_DATA_ROOT/manager/secrets"
      printf '%s\n' partial > "$FAKE_DATA_ROOT/manager/secrets/partial"
      exit 42
    fi
    ;;
  install)
    mkdir -p "$FAKE_DATA_ROOT/manager/operations"
    printf '%s\n' retained > "$FAKE_DATA_ROOT/manager/operations/install"
    exit 43
    ;;
esac
exit 0
EOF
chmod 0755 "$installer_test/fake-manager"
cat > "$installer_stubs/curl" <<'EOF'
#!/usr/bin/env bash
output=""
url=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == output ]]; then
    output="$argument"
    previous=""
    continue
  fi
  if [[ "$argument" == --output ]]; then
    previous=output
  elif [[ "$argument" == https://* ]]; then
    url="$argument"
  fi
done
[[ -n "$output" && -n "$url" ]]
if [[ "$url" == *.sha256 ]]; then
  sha256sum "$FAKE_MANAGER" > "$output"
else
  cp "$FAKE_MANAGER" "$output"
fi
EOF
cat > "$installer_stubs/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$installer_stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 0755 "$installer_stubs/curl" "$installer_stubs/docker" "$installer_stubs/systemctl"
installer_data="$installer_test/xdg-data/ubitech-agent"
if cat install.sh | env \
  PATH="$installer_stubs:$PATH" \
  FAKE_MANAGER="$installer_test/fake-manager" \
  FAKE_DATA_ROOT="$installer_data" \
  XDG_DATA_HOME="$installer_test/xdg-data" \
  XDG_CONFIG_HOME="$installer_test/xdg-config" \
  XDG_BIN_HOME="$installer_test/xdg-bin" \
  bash -s -- --yes \
    --manifest-url https://example.invalid/release.json \
    --manager-url https://example.invalid/manager \
    --manager-checksum-url https://example.invalid/manager.sha256; then
  fail "injected Manager preflight failure unexpectedly succeeded"
fi
[[ ! -e "$installer_data" ]] || fail "failed fresh install retained its data root"
[[ ! -e "$installer_test/xdg-bin/ubitech-manager" ]] \
  || fail "failed fresh install retained its Manager binary"
[[ ! -e "$installer_test/xdg-config/ubitech-agent/manager.toml" ]] \
  || fail "failed fresh install retained its Manager config"
[[ ! -e "$installer_test/xdg-config/systemd/user/ubitech-agent-manager.service" ]] \
  || fail "failed fresh install retained its systemd unit"

activated_data="$installer_test/activated-data/ubitech-agent"
activated_output="$installer_test/activated-install.log"
set +e
cat install.sh | env \
  PATH="$installer_stubs:$PATH" \
  FAKE_MANAGER="$installer_test/fake-manager" \
  FAKE_DATA_ROOT="$activated_data" \
  FAKE_FAIL_STAGE=install \
  XDG_DATA_HOME="$installer_test/activated-data" \
  XDG_CONFIG_HOME="$installer_test/activated-config" \
  XDG_BIN_HOME="$installer_test/activated-bin" \
  bash -s -- --yes \
    --manifest-url https://example.invalid/release.json \
    --manager-url https://example.invalid/manager \
    --manager-checksum-url https://example.invalid/manager.sha256 \
    >"$activated_output" 2>&1
activated_status=$?
set -e
[[ "$activated_status" -eq 43 ]] \
  || fail "post-activation install failure exit status was masked: $activated_status"
grep -Fq 'Manager is active and owns the installation state' "$activated_output" \
  || fail "post-activation failure has no Manager-owned recovery guidance"
grep -Fq 'install --config' "$activated_output" \
  || fail "post-activation failure has no exact retry command"
[[ -f "$activated_data/manager/operations/install" ]] \
  || fail "post-activation failure deleted Manager-owned operation state"
[[ -x "$installer_test/activated-bin/ubitech-manager" ]] \
  || fail "post-activation failure deleted the active Manager binary"
[[ -f "$installer_test/activated-config/ubitech-agent/manager.toml" ]] \
  || fail "post-activation failure deleted Manager config"
[[ -f "$installer_test/activated-config/systemd/user/ubitech-agent-manager.service" ]] \
  || fail "post-activation failure deleted Manager unit"
rm -rf --one-file-system -- "$installer_test"

for secret in firecrawl-postgres-password firecrawl-bull-auth-key; do
  grep -Fq "$secret" containers/compose.yaml \
    || fail "Compose is missing Firecrawl secret $secret"
done
grep -Fq "url: 'https://example.com/'" .github/workflows/container-release.yml \
  || fail "release smoke test does not launch a real Camoufox page"
grep -Fq 'docker network inspect "$UBITECH_CORE_NETWORK"' .github/workflows/container-release.yml \
  || fail "release smoke test does not verify the durable core network"
grep -Fq 'cp install.sh "$stage/install.sh"' .github/workflows/container-release.yml \
  || fail "release assembly does not include install.sh"
grep -Fq 'sha256sum install.sh > install.sh.sha256' .github/workflows/container-release.yml \
  || fail "release assembly does not checksum install.sh"
grep -Fq '"$STAGE/install.sh"' .github/workflows/container-release.yml \
  || fail "release publication does not upload install.sh"
grep -Fq '"$STAGE/install.sh.sha256"' .github/workflows/container-release.yml \
  || fail "release publication does not upload the install.sh checksum"
grep -Fq -- '--latest=false' .github/workflows/container-release.yml \
  || fail "stale qualified releases are not prevented from replacing the main channel"
grep -Fq "group: container-release-\${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.ref }}" .github/workflows/container-release.yml \
  || fail "container releases are not isolated per source commit"
grep -Fq 'group: container-channel-main' .github/workflows/container-release.yml \
  || fail "main-channel release promotion is not serialized"
grep -Fq 'done < <(git rev-list origin/main)' .github/workflows/container-release.yml \
  || fail "main-channel release promotion does not choose the newest qualified main commit"
grep -Fq 'public-images:' .github/workflows/container-release.yml \
  || fail "container release has no public-image publication gate"
grep -Fq 'GitHub exposes no supported package-visibility mutation API' .github/workflows/container-release.yml \
  || fail "private GHCR packages do not produce an actionable fail-closed error"
grep -Fq 'unset DOCKER_AUTH_CONFIG REGISTRY_AUTH_FILE' .github/workflows/container-release.yml \
  || fail "anonymous image verification can inherit registry credentials"
grep -Fq 'export DOCKER_CONFIG="$anonymous_config"' .github/workflows/container-release.yml \
  || fail "anonymous image verification does not use an isolated Docker config"
grep -Fq 'env -u GH_TOKEN -u GITHUB_TOKEN curl -q' .github/workflows/container-release.yml \
  || fail "public package metadata verification can inherit GitHub credentials"
grep -Fq 'https://ghcr.io/v2/${owner}/${package}/manifests/${digest}' .github/workflows/container-release.yml \
  || fail "release does not verify final digest metadata through the anonymous GHCR registry contract"
grep -Fq 'docker pull "$image"' .github/workflows/container-release.yml \
  || fail "release does not anonymously pull each final image digest"
if grep -Fq '"firecrawl-foundationdb"' .github/workflows/container-release.yml; then
  fail "container release still publishes a retired FoundationDB image key"
fi
if grep -Fq 'foundationdb/foundationdb@sha256:' .github/workflows/container-release.yml; then
  fail "container release still publishes or validates a FoundationDB image"
fi
if rg -n 'gh api[^\n]*(--method|-X)[[:space:]]+PATCH|gh api[[:space:]]+--method[[:space:]]+PATCH' .github/workflows/container-release.yml; then
  fail "release relies on an unsupported GitHub package visibility mutation"
fi
python3 - <<'PY'
import re
from pathlib import Path

workflow = Path(".github/workflows/container-release.yml").read_text(encoding="utf-8")

def job(name: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n.*?(?=^  [a-zA-Z0-9_-]+:\n|\Z)",
        workflow,
    )
    if match is None:
        raise SystemExit(f"container release job is missing: {name}")
    return match.group(0)

public_images = job("public-images")
if "packages: read" not in public_images:
    raise SystemExit("public-image gate lacks package metadata read permission")
if "docker/login-action" in public_images:
    raise SystemExit("public-image gate must never establish a registry login")
for dependent in ("compose-smoke", "publish"):
    if "      - public-images\n" not in job(dependent):
        raise SystemExit(f"{dependent} can run before the public-image gate")
for component in ("platform", "agent-runtime", "camofox", "agent-sandbox"):
    if component not in public_images:
        raise SystemExit(f"public-image gate omits {component}")

upstream_contracts = job("upstream-contracts")
if 'grep -Fxq "$service" "$root/actual-services"' not in upstream_contracts:
    raise SystemExit("upstream contract does not verify every managed Firecrawl service")
if 'diff -u "$root/expected-services" "$root/actual-services"' in upstream_contracts:
    raise SystemExit("upstream contract still requires unrelated upstream Compose services")

compose_smoke = job("compose-smoke")
if "    timeout-minutes: 45\n" not in compose_smoke:
    raise SystemExit("compose-smoke must reserve the 45-minute cold/warm Firecrawl budget")
for fragment in (
    'root="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/ubitech-compose-smoke.XXXXXX")"',
    '"$RUNNER_TEMP"/ubitech-compose-smoke.*) ;;',
    'sudo -n rm -rf --one-file-system -- "$root"',
    'http://127.0.0.1:3002/v0/health/liveness',
    "url: 'https://example.com/'",
    "fetch('http://127.0.0.1:3002/v1/scrape'",
    'signal: AbortSignal.timeout(120000)',
    'firecrawl_scrape() {',
    'for attempt in 1 2 3; do',
    'Firecrawl ${phase} scrape failed after 3 attempts',
    'firecrawl_scrape cold',
    'firecrawl_scrape warm',
    'sentinel_key=ubitech_ci_persistence',
    'CREATE TABLE IF NOT EXISTS ubitech_release_smoke',
    'INSERT INTO ubitech_release_smoke',
    'SELECT value FROM ubitech_release_smoke',
    'first_postgres="$(docker compose -f containers/compose.yaml ps -q firecrawl-postgres)"',
    'second_postgres="$(docker compose -f containers/compose.yaml ps -q firecrawl-postgres)"',
    'test "$second_postgres" != "$first_postgres"',
    'test "$read_output" = "$sentinel_value"',
    'rm --stop --force',
    '--wait --wait-timeout 600 firecrawl-api',
):
    if fragment not in compose_smoke:
        raise SystemExit(f"compose-smoke lacks PostgreSQL Firecrawl acceptance coverage: {fragment}")
if compose_smoke.count('--wait --wait-timeout 600 firecrawl-api') < 2:
    raise SystemExit("compose-smoke must use the production Firecrawl wait budget for cold and warm starts")
if compose_smoke.count("fetch('http://127.0.0.1:3002/v1/scrape'") != 1 or compose_smoke.count(
    'signal: AbortSignal.timeout(120000)'
) != 1:
    raise SystemExit("compose-smoke must centralize the bounded real scrape in its retry helper")
if "foundationdb/foundationdb@sha256:" in compose_smoke:
    raise SystemExit("compose-smoke still pulls or runs the retired FoundationDB image")

publish = job("publish")
if "pattern: '*'" in publish or 'pattern: "*"' in publish:
    raise SystemExit("publish must not download every workflow artifact")
for fragment in ("pattern: image-*", "pattern: manager-*"):
    if fragment not in publish:
        raise SystemExit(f"publish omits scoped release artifact family: {fragment}")
for fragment in (
    "group: container-publish-${{ needs.prepare.outputs.source_commit }}",
    "cancel-in-progress: false",
    'image_name = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")',
    "if not image_name.fullmatch(name):",
    'if set(data["images"]) != expected_images:',
):
    if fragment not in publish:
        raise SystemExit(f"publish lacks resolved-commit serialization: {fragment}")
for producer in ("images", "manager-binaries"):
    if "overwrite: true" not in job(producer):
        raise SystemExit(f"{producer} artifacts cannot be replaced by a full-run retry")
PY
for entrypoint in containers/*-entrypoint.sh; do
  sh -n "$entrypoint"
done
grep -Fq 'migrate|serve|init-admin|print-agent-token)' containers/platform-entrypoint.sh \
  || fail "Platform entrypoint does not dispatch CLI subcommands"

python3 - <<'PY'
import json
from pathlib import Path

schema = json.loads(Path("containers/release-manifest.schema.json").read_text(encoding="utf-8"))
upstream = json.loads(Path("docs/contracts/upstream-sources.json").read_text(encoding="utf-8"))
if schema.get("properties", {}).get("schema_version", {}).get("const") != 1:
    raise SystemExit("release manifest schema does not lock schema_version=1")
if schema.get("properties", {}).get("protocol_version", {}).get("const") != 1:
    raise SystemExit("release manifest schema does not lock protocol_version=1")
required = set(schema.get("required", ()))
expected = {
    "schema_version", "channel", "source_commit", "generated_at",
    "protocol_version", "database_schema_version", "manager", "compose", "images",
}
if required != expected:
    raise SystemExit(f"unexpected top-level release manifest fields: {sorted(required)}")
image_pattern = schema.get("$defs", {}).get("image", {}).get("pattern", "")
if "@sha256:" not in image_pattern:
    raise SystemExit("release images are not constrained to immutable digests")
required_images = set(schema.get("properties", {}).get("images", {}).get("required", ()))
image_name_pattern = schema.get("properties", {}).get("images", {}).get("propertyNames", {}).get("pattern", "")
if image_name_pattern != "^[a-z0-9]+(-[a-z0-9]+)*$":
    raise SystemExit("release image property names are not constrained to lowercase kebab-case")
expected_images = {
    "platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
    "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
    "firecrawl-redis", "firecrawl-rabbitmq",
}
if required_images != expected_images:
    raise SystemExit(f"unexpected required release images: {sorted(required_images)}")
images_schema = schema.get("properties", {}).get("images", {})
if images_schema.get("minProperties") != len(expected_images) or images_schema.get("maxProperties") != len(expected_images):
    raise SystemExit("release image directory is not constrained to the exact current service set")
if "firecrawl-foundationdb" in required_images:
    raise SystemExit("the current release schema still requires FoundationDB")
managed_firecrawl_services = set(upstream["sources"]["firecrawl"]["compose_services"])
expected_firecrawl_services = {"api", "nuq-postgres", "playwright-service", "rabbitmq", "redis"}
if managed_firecrawl_services != expected_firecrawl_services:
    raise SystemExit(f"unexpected managed Firecrawl upstream services: {sorted(managed_firecrawl_services)}")
PY

for dockerfile in containers/*.Dockerfile; do
  grep -Eq '^FROM .+ AS ' "$dockerfile" || fail "$dockerfile has no named production stage"
  if [[ "$dockerfile" == containers/agent-sandbox.Dockerfile ]]; then
    grep -Fq 'ENTRYPOINT ["/usr/local/bin/ubitech-agent-sandbox-entrypoint"]' "$dockerfile" \
      || fail "Agent Sandbox does not use the UID/GID mapping entrypoint"
  else
    grep -q '^USER ' "$dockerfile" || fail "$dockerfile has no explicit USER"
    grep -q '^HEALTHCHECK ' "$dockerfile" || fail "$dockerfile has no image healthcheck"
  fi
  if grep -Eq '(^|[[:space:]/:])latest([[:space:]@]|$)' "$dockerfile"; then
    fail "$dockerfile contains a latest image or dependency reference"
  fi
done
grep -Fq 'exec setpriv --reuid="$agent_uid" --regid="$agent_gid" --init-groups -- /usr/bin/tini -- "$@"' containers/agent-sandbox-entrypoint.sh \
  || fail "Agent Sandbox entrypoint does not permanently drop privileges"
grep -Fq 'chown --no-dereference "$agent_uid:$agent_gid" "$mount_root"' containers/agent-sandbox-entrypoint.sh \
  || fail "Agent Sandbox entrypoint does not protect mount roots from symlink traversal"
if rg -n 'chown[^\n]*(--recursive|-R)' containers/agent-sandbox-entrypoint.sh; then
  fail "Agent Sandbox entrypoint recursively changes persistent ownership"
fi
grep -Fq 'browser/version.json' containers/camofox.Dockerfile \
  || fail "Camoufox image does not generate the external bundle version metadata"
grep -Fq '"release": "beta.25"' containers/camofox.Dockerfile \
  || fail "Camoufox image metadata does not match the pinned GitHub release"
grep -Fq 'XDG_CACHE_HOME=/var/lib/ubitech-agent/camofox/home/.cache' containers/camofox.Dockerfile \
  || fail "Camoufox and camoufox-js cache locations are inconsistent"

if rg -n '/var/run/docker\.sock|/run/docker\.sock|privileged:[[:space:]]*true' containers; then
  fail "a product container can access Docker or runs privileged"
fi

command -v docker >/dev/null || fail "docker is required to validate Compose"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
zero_digest="sha256:$(printf '0%.0s' {1..64})"
cat > "$temporary/compose.env" <<EOF
UBITECH_COMPOSE_PROJECT=ubitech-agent-validation
UBITECH_DATA_ROOT=$temporary/data-root
UBITECH_SECRETS_DIR=$temporary/data-root/manager/secrets
UBITECH_MANAGER_CONTROL_DIR=$temporary/data-root/manager/control
UBITECH_CORE_NETWORK=ubitech-agent-validation-core
UBITECH_PLATFORM_IMAGE=registry.invalid/ubitech/platform@$zero_digest
UBITECH_AGENT_RUNTIME_IMAGE=registry.invalid/ubitech/agent-runtime@$zero_digest
UBITECH_CAMOFOX_IMAGE=registry.invalid/ubitech/camofox@$zero_digest
EOF

docker compose \
  --env-file "$temporary/compose.env" \
  -f containers/compose.yaml \
  config --format json > "$temporary/compose.json"

python3 - "$temporary/compose.json" <<'PY'
import json
import re
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
services = document.get("services") or {}
networks = document.get("networks") or {}
core = networks.get("core") or {}
if core.get("name") != "ubitech-agent-validation-core" or core.get("external") is not True:
    raise SystemExit(f"core network must be the Manager-owned external network: {core}")
required = {
    "platform", "agent-runtime", "camofox", "searxng", "firecrawl-api",
    "firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq",
    "firecrawl-postgres",
}
if set(services) != required:
    raise SystemExit(f"fixed Compose service set mismatch: {sorted(set(services) ^ required)}")
if "agent-sandbox" in services:
    raise SystemExit("Agent Sandboxes must be created dynamically, not as a fixed service")

digest = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
for name, service in services.items():
    image = str(service.get("image") or "")
    if not digest.fullmatch(image):
        raise SystemExit(f"{name} image is not an immutable digest: {image}")
    if service.get("privileged"):
        raise SystemExit(f"{name} is privileged")
    for volume in service.get("volumes") or []:
        source = str(volume.get("source") or "")
        target = str(volume.get("target") or "")
        if "docker.sock" in source or "docker.sock" in target:
            raise SystemExit(f"{name} mounts the Docker socket")

for name, service in services.items():
    ports = service.get("ports") or []
    if name == "platform":
        if len(ports) != 1 or ports[0].get("host_ip") not in {"127.0.0.1", "::1"}:
            raise SystemExit("Platform must have exactly one loopback publication")
    elif ports:
        raise SystemExit(f"private service {name} publishes a host port")

platform = services["platform"]
searxng = services["searxng"]
if searxng.get("user") != "1000:1000":
    raise SystemExit("SearXNG must run as the deployment UID/GID")
searxng_config = [
    volume for volume in searxng.get("volumes") or []
    if volume.get("target") == "/etc/searxng"
]
if (
    len(searxng_config) != 1
    or searxng_config[0].get("type") != "bind"
    or not searxng_config[0].get("read_only")
    or not str(searxng_config[0].get("source") or "").endswith(
        "/data/runtimes/searxng/config"
    )
):
    raise SystemExit("SearXNG must read-only bind its complete managed config root")
if any(
    volume.get("target") == "/etc/searxng/settings.yml"
    for volume in searxng.get("volumes") or []
):
    raise SystemExit("SearXNG single-file settings mounts leak anonymous volumes")
environment = platform.get("environment") or {}
if environment.get("UBITECH_DEPLOYMENT_MODE") != "container":
    raise SystemExit("Platform is not explicitly in container deployment mode")
if environment.get("UBITECH_MANAGER_SOCKET") != "/run/ubitech-manager/manager.sock":
    raise SystemExit("Platform Manager socket contract mismatch")
if environment.get("UBITECH_MANAGER_TOKEN_FILE") != "/run/secrets/manager-token":
    raise SystemExit("Platform Manager token contract mismatch")
runtime_environment = (services["agent-runtime"].get("environment") or {})
if runtime_environment.get("AGENT_MANAGER_EXECUTOR_SOCKET") != "/run/ubitech-manager/manager.sock":
    raise SystemExit("Agent Runtime Manager socket contract mismatch")
if runtime_environment.get("AGENT_MANAGER_EXECUTOR_TOKEN_FILE") != "/run/secrets/manager-executor-token":
    raise SystemExit("Agent Runtime executor token contract mismatch")
if int(runtime_environment.get("AGENT_RUNTIME_MAX_BODY_BYTES") or 0) < 32 * 1024 * 1024:
    raise SystemExit("Agent Runtime request body limit cannot carry inline images")
for name in ("platform", "agent-runtime"):
    manager_mounts = [
        volume for volume in services[name].get("volumes") or []
        if volume.get("target") == "/run/ubitech-manager"
    ]
    if len(manager_mounts) != 1 or not manager_mounts[0].get("read_only"):
        raise SystemExit(f"{name} must read-only mount the Manager control directory")
platform_secret_targets = {
    str(volume.get("target") or "") for volume in platform.get("volumes") or []
}
runtime_secret_targets = {
    str(volume.get("target") or "")
    for volume in services["agent-runtime"].get("volumes") or []
}
if "/run/secrets/manager-token" not in platform_secret_targets or "/run/secrets/manager-executor-token" in platform_secret_targets:
    raise SystemExit("Platform must receive only the Manager control capability")
if "/run/secrets/manager-executor-token" not in runtime_secret_targets or "/run/secrets/manager-token" in runtime_secret_targets:
    raise SystemExit("Agent Runtime must receive only the Manager executor capability")
platform_data = [v for v in platform.get("volumes") or [] if v.get("target") == "/var/lib/ubitech-agent"]
if len(platform_data) != 1 or not str(platform_data[0].get("source") or "").endswith("/data"):
    raise SystemExit("Platform data must map <manager data root>/data to /var/lib/ubitech-agent")

firecrawl = services["firecrawl-api"]
firecrawl_environment = firecrawl.get("environment") or {}
if firecrawl_environment.get("NUQ_BACKEND") != "pg":
    raise SystemExit("Firecrawl must explicitly use the PostgreSQL queue backend")
if "FDB_CLUSTER_FILE" in firecrawl_environment:
    raise SystemExit("Firecrawl must not receive a FoundationDB cluster file")
for service_name, service in services.items():
    if "foundationdb" in service_name.lower():
        raise SystemExit(f"retired FoundationDB service remains: {service_name}")
    for volume in service.get("volumes") or []:
        source = str(volume.get("source") or "").lower()
        target = str(volume.get("target") or "").lower()
        if "foundationdb" in source or "foundationdb" in target or target.startswith("/var/fdb"):
            raise SystemExit(f"{service_name} still mounts retired FoundationDB state")
api_dependencies = firecrawl.get("depends_on") or {}
expected_dependencies = {
    "firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-postgres",
}
if set(api_dependencies) != expected_dependencies:
    raise SystemExit(f"Firecrawl API dependency set mismatch: {sorted(api_dependencies)}")
postgres_volumes = [
    volume for volume in services["firecrawl-postgres"].get("volumes") or []
    if volume.get("target") == "/var/lib/postgresql/data"
]
if (
    len(postgres_volumes) != 1
    or postgres_volumes[0].get("type") != "bind"
    or not str(postgres_volumes[0].get("source") or "").endswith(
        "/data/runtimes/firecrawl/postgres"
    )
):
    raise SystemExit("Firecrawl PostgreSQL data must use its managed host bind")
PY

docker compose \
  --env-file "$temporary/compose.env" \
  -f containers/compose.yaml \
  -f containers/compose.dev.yaml \
  config --quiet

printf 'container definitions validated\n'
