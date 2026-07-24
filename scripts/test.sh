#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if [[ "${UBITECH_DOCS_ALREADY_CHECKED:-0}" != "1" ]]; then
  "$PYTHON_BIN" "$ROOT/scripts/docs_sync.py" check
fi

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
  docker compose -f "$ROOT/containers/compose.yaml" config >/dev/null
fi
