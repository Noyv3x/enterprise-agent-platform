#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
component="${1:-full}"
if [[ "$#" -gt 1 ]]; then
  echo "usage: $0 [full|docs|scripts|manager|python|runtime|camofox|frontend|containers]" >&2
  exit 2
fi
case "$component" in
  full) components=(docs scripts manager python runtime camofox frontend containers) ;;
  docs|scripts|manager|python|runtime|camofox|frontend|containers) components=("$component") ;;
  *) echo "Unknown component: $component" >&2; exit 2 ;;
esac

for component in "${components[@]}"; do
  printf '\nRunning %s checks\n' "$component"
  (
    cd "$ROOT"
    case "$component" in
      docs)
        "$PYTHON_BIN" scripts/docs_sync.py check
        ;;
      scripts)
        "$PYTHON_BIN" -m unittest discover -s scripts/tests
        ;;
      manager)
        cd manager
        go test ./...
        go vet ./...
        go build -buildvcs=false ./cmd/agent-platform-manager
        ;;
      python)
        cd enterprise-agent-platform
        "$PYTHON_BIN" -m unittest discover -s tests
        "$PYTHON_BIN" -m compileall -q enterprise_agent_platform tests
        ;;
      runtime)
        cd enterprise-agent-platform/agent-runtime
        npm ci
        npm run check
        npm run build
        npm test
        ;;
      camofox)
        cd enterprise-agent-platform/camofox-runtime
        npm ci
        npm test
        ;;
      frontend)
        cd enterprise-agent-platform/frontend
        npm ci
        npm run check
        npm test
        npm run build
        ;;
      containers)
        if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
          echo "Docker Compose is unavailable; container definition checks cannot run." >&2
          exit 1
        fi
        scripts/container-smoke.sh
        ;;
    esac
  )
done
