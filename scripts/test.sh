#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if [[ "${UBITECH_DOCS_ALREADY_CHECKED:-0}" != "1" ]]; then
  "$PYTHON_BIN" "$ROOT/scripts/docs_sync.py" check
  "$PYTHON_BIN" "$ROOT/scripts/docs_sync.py" check-change \
    --base HEAD \
    --head WORKTREE
fi

cd "$ROOT"
"$PYTHON_BIN" -m unittest discover -s scripts/tests

cd "$ROOT/manager"
go test ./...
go vet ./...
go build ./cmd/ubitech-manager

cd "$ROOT/enterprise-agent-platform"
"$PYTHON_BIN" -m unittest discover -s tests "$@"
"$PYTHON_BIN" -m compileall enterprise_agent_platform tests

cd "$ROOT/enterprise-agent-platform/agent-runtime"
npm ci
npm run check
npm test
npm run build

cd "$ROOT/enterprise-agent-platform/frontend"
npm ci
npm run check
npm test
npm run build

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    UBITECH_PLATFORM_IMAGE="example.invalid/ubitech/platform@sha256:0000000000000000000000000000000000000000000000000000000000000000" \
    UBITECH_AGENT_RUNTIME_IMAGE="example.invalid/ubitech/agent-runtime@sha256:1111111111111111111111111111111111111111111111111111111111111111" \
    UBITECH_CAMOFOX_IMAGE="example.invalid/ubitech/camofox@sha256:2222222222222222222222222222222222222222222222222222222222222222" \
    UBITECH_DATA_ROOT="/tmp/ubitech-compose-config/data" \
    UBITECH_SECRETS_DIR="/tmp/ubitech-compose-config/secrets" \
    UBITECH_MANAGER_CONTROL_DIR="/tmp/ubitech-compose-config/control" \
    docker compose --env-file /dev/null \
      -f "$ROOT/containers/compose.yaml" config --quiet
fi
