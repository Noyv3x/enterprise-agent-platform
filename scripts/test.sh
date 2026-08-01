#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
MODE="${1:-affected}"
if [[ "$#" -gt 0 ]]; then
  shift
fi
if [[ "$#" -ne 0 || ("$MODE" != "affected" && "$MODE" != "full") ]]; then
  echo "usage: $0 [affected|full]" >&2
  exit 2
fi

if [[ "${AGENT_PLATFORM_DOCS_ALREADY_CHECKED:-0}" != "1" ]]; then
  "$PYTHON_BIN" "$ROOT/scripts/docs_sync.py" check
  "$PYTHON_BIN" "$ROOT/scripts/docs_sync.py" check-change \
    --base HEAD \
    --head WORKTREE
fi

declare -A selected=()

select_full() {
  selected[scripts]=1
  selected[manager]=1
  selected[python]=1
  selected[runtime]=1
  selected[camofox]=1
  selected[frontend]=1
  selected[containers]=1
}

select_path() {
  local path="$1"
  case "$path" in
    AGENTS.md|README.md|enterprise-agent-platform/README.md|docs/*.md|docs/*/*.md)
      ;;
    docs/contracts/*|docs/domains.json|.github/*|.github/**/*|scripts/test.sh)
      select_full
      ;;
    scripts/*)
      selected[scripts]=1
      ;;
    containers/*|install.sh)
      selected[containers]=1
      selected[manager]=1
      ;;
    manager/*)
      selected[manager]=1
      ;;
    enterprise-agent-platform/agent-runtime/*)
      selected[runtime]=1
      ;;
    enterprise-agent-platform/camofox-runtime/*)
      selected[camofox]=1
      ;;
    enterprise-agent-platform/frontend/*|enterprise-agent-platform/enterprise_agent_platform/static/*)
      selected[frontend]=1
      ;;
    enterprise-agent-platform/enterprise_agent_platform/container_contract_generated.py)
      select_full
      ;;
    enterprise-agent-platform/enterprise_agent_platform/server.py|enterprise-agent-platform/enterprise_agent_platform/service.py|enterprise-agent-platform/enterprise_agent_platform/runtimes.py|enterprise-agent-platform/enterprise_agent_platform/agent_runtime_client.py)
      selected[python]=1
      selected[runtime]=1
      selected[frontend]=1
      ;;
    enterprise-agent-platform/enterprise_agent_platform/*|enterprise-agent-platform/tests/*|enterprise-agent-platform/pyproject.toml)
      selected[python]=1
      ;;
    .gitignore)
      ;;
    *)
      echo "Unclassified path forces the full gate: $path" >&2
      select_full
      ;;
  esac
}

if [[ "$MODE" == "full" ]]; then
  select_full
else
  while IFS= read -r -d '' path; do
    select_path "$path"
  done < <(
    git -C "$ROOT" diff --name-only --diff-filter=ACDMRTUXB -z HEAD --
    git -C "$ROOT" ls-files --others --exclude-standard -z
  )
fi

component_order=(scripts manager python runtime camofox frontend containers)
selected_names=()
for component in "${component_order[@]}"; do
  if [[ "${selected[$component]:-0}" == "1" ]]; then
    selected_names+=("$component")
  fi
done
if [[ "${#selected_names[@]}" -eq 0 ]]; then
  echo "Selected checks: documentation contracts only"
  exit 0
fi
echo "Selected checks: ${selected_names[*]}"
if [[ "${AGENT_PLATFORM_TEST_PLAN_ONLY:-0}" == "1" ]]; then
  exit 0
fi

ensure_npm_dependencies() {
  local directory="$1"
  local fingerprint stamp
  fingerprint="$(cd "$directory" && sha256sum package.json package-lock.json | sha256sum | cut -d' ' -f1)"
  stamp="$directory/node_modules/.agent-platform-dependency-fingerprint"
  if [[ -d "$directory/node_modules" && -f "$stamp" && "$(<"$stamp")" == "$fingerprint" ]]; then
    echo "npm dependencies are current: ${directory#"$ROOT/"}"
    return
  fi
  (cd "$directory" && npm ci)
  printf '%s\n' "$fingerprint" > "$stamp"
}

run_scripts() {
  cd "$ROOT"
  "$PYTHON_BIN" -m unittest discover -s scripts/tests
}

run_manager() {
  cd "$ROOT/manager"
  go test ./...
  go vet ./...
  go build -buildvcs=false ./cmd/agent-platform-manager
}

run_python() {
  cd "$ROOT/enterprise-agent-platform"
  local shard_count=4 shard_work index status failed
  local -a shard_pids=()
  shard_work="$work/python-shards"
  mkdir -p "$shard_work"
  failed=0
  for ((index = 0; index < shard_count; index++)); do
    "$PYTHON_BIN" ../scripts/python_test_shard.py \
      --shard-index "$index" \
      --shard-count "$shard_count" \
      >"$shard_work/$index.log" 2>&1 &
    shard_pids+=("$!")
  done
  for index in "${!shard_pids[@]}"; do
    if wait "${shard_pids[$index]}"; then
      status=0
    else
      status=$?
      failed=1
      printf '%s\n' "--- failed Python shard $index ---" >&2
      cat "$shard_work/$index.log" >&2
      printf '%s\n' "--- end Python shard $index (exit $status) ---" >&2
    fi
  done
  rm -rf -- "$shard_work"
  if ((failed != 0)); then
    return 1
  fi
  "$PYTHON_BIN" -m compileall -q enterprise_agent_platform tests
}

run_runtime() {
  local directory="$ROOT/enterprise-agent-platform/agent-runtime"
  ensure_npm_dependencies "$directory"
  cd "$directory"
  npm run build
  npm run test:compiled
}

run_camofox() {
  local directory="$ROOT/enterprise-agent-platform/camofox-runtime"
  ensure_npm_dependencies "$directory"
  cd "$directory"
  npm test
}

run_frontend() {
  local directory="$ROOT/enterprise-agent-platform/frontend"
  ensure_npm_dependencies "$directory"
  cd "$directory"
  npm run check
  npm test
  npm run build
}

run_containers() {
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose is unavailable; container definition checks cannot run." >&2
    return 1
  fi
  "$ROOT/scripts/container-smoke.sh"
}

work="$(mktemp -d "${TMPDIR:-/tmp}/agent-platform-tests.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
declare -a pids=() names=()
for component in "${selected_names[@]}"; do
  names+=("$component")
  (
    component_started=$SECONDS
    set +e
    "run_$component"
    component_status=$?
    set -e
    printf '%s\n' "$(( SECONDS - component_started ))" >"$work/$component.elapsed"
    exit "$component_status"
  ) >"$work/$component.log" 2>&1 &
  pids+=("$!")
done

failed=0
for index in "${!pids[@]}"; do
  name="${names[$index]}"
  if wait "${pids[$index]}"; then
    status=0
  else
    status=$?
    failed=1
  fi
  if [[ -f "$work/$name.elapsed" ]]; then
    elapsed="$(<"$work/$name.elapsed")"
  else
    elapsed="?"
  fi
  if [[ "$status" -eq 0 ]]; then
    printf 'PASS %-12s %4ss\n' "$name" "$elapsed"
  else
    printf 'FAIL %-12s %4ss (exit %s)\n' "$name" "$elapsed" "$status" >&2
    cat "$work/$name.log" >&2
  fi
done
exit "$failed"
