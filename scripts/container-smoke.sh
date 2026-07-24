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
  'Description=Retry ubitech agent source-to-container migration' \
  'OnBootSec=2min' \
  'OnUnitInactiveSec=2min' \
  'Persistent=true' \
  'Unit=ubitech-agent-migrate.service' \
  'chmod 0600 "$retry_service" "$retry_timer"' \
  'systemctl --user enable --now ubitech-agent-migrate.timer'; do
  grep -Fq "$expected" install.sh || fail "migration retry unit is missing: $expected"
done
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
grep -Fq '"$STAGE/install.sh"' .github/workflows/container-release.yml \
  || fail "release publication does not upload install.sh"
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

compose_smoke = job("compose-smoke")
for fragment in (
    'root="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/ubitech-compose-smoke.XXXXXX")"',
    '"$RUNNER_TEMP"/ubitech-compose-smoke.*) ;;',
    'sudo -n rm -rf --one-file-system -- "$root"',
):
    if fragment not in compose_smoke:
        raise SystemExit(f"compose-smoke lacks guarded remapped-UID cleanup: {fragment}")
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
if schema.get("properties", {}).get("schema_version", {}).get("const") != 1:
    raise SystemExit("release manifest schema does not lock schema_version=1")
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
    "firecrawl-postgres", "firecrawl-foundationdb", "firecrawl-foundationdb-init",
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
if services["searxng"].get("user") != "1000:1000":
    raise SystemExit("SearXNG must run as the deployment UID/GID")
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
PY

docker compose \
  --env-file "$temporary/compose.env" \
  -f containers/compose.yaml \
  -f containers/compose.dev.yaml \
  config --quiet

printf 'container definitions validated\n'
