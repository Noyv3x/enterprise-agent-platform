#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$ROOT/enterprise-agent-platform"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SERVICE_NAME="${ENTERPRISE_SERVICE_NAME:-enterprise-agent-platform.service}"

usage() {
  cat <<'EOF'
Usage:
  ./deploy.sh [deploy|service|foreground|prepare] [options]
  ./deploy.sh [update|start|stop|restart|status|logs|test]

Default:
  ./deploy.sh

Deploy options are passed to the Python bootstrapper, for example:
  ./deploy.sh --host 0.0.0.0 --port 8765
  ./deploy.sh service
  ./deploy.sh foreground

Update and redeploy from the current branch (rolls back on failure):
  ./deploy.sh update

Durability note: the systemd integration installs a per-user service. For it
to survive logout and start at boot, systemd user linger must be enabled. The
deploy attempts this automatically; if it cannot (e.g. it is polkit-gated),
enable it manually:
  loginctl enable-linger "$USER"
EOF
}

python_bootstrap() {
  local mode="$1"
  shift || true
  export PYTHONPATH="$PLATFORM_DIR${PYTHONPATH:+:$PYTHONPATH}"
  exec "$PYTHON_BIN" -m enterprise_agent_platform.deployment bootstrap --root "$ROOT" --mode "$mode" "$@"
}

# Like python_bootstrap, but runs as a child process (no exec) so the caller
# regains control afterwards and can inspect the exit status. Used by the
# update path so a failed redeploy can be rolled back.
python_bootstrap_checked() {
  local mode="$1"
  shift || true
  export PYTHONPATH="$PLATFORM_DIR${PYTHONPATH:+:$PYTHONPATH}"
  "$PYTHON_BIN" -m enterprise_agent_platform.deployment bootstrap --root "$ROOT" --mode "$mode" "$@"
}

check_documentation() {
  "$PYTHON_BIN" "$ROOT/scripts/docs_sync.py" check
}

check_documentation_change() {
  local base="$1"
  local head="$2"
  "$PYTHON_BIN" "$ROOT/scripts/docs_sync.py" check-change --base "$base" --head "$head"
}

# Select a committed change set for the local test gate. A branch that is
# ahead of its upstream is checked from their merge-base; a synchronized
# branch (or a checkout without an upstream) falls back to the newest commit
# so a clean worktree cannot hide a previously committed code-only change.
documentation_test_base() {
  local head upstream merge_base parent
  head="$(git -C "$ROOT" rev-parse --verify HEAD^{commit} 2>/dev/null || true)"
  upstream="$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ -n "$head" && -n "$upstream" ]]; then
    merge_base="$(git -C "$ROOT" merge-base HEAD "$upstream" 2>/dev/null || true)"
    if [[ -n "$merge_base" && "$merge_base" != "$head" ]] \
      && ! git -C "$ROOT" diff --quiet "$merge_base" "$head" --; then
      printf '%s\n' "$merge_base"
      return 0
    fi
  fi

  parent="$(git -C "$ROOT" rev-parse --verify HEAD^ 2>/dev/null || true)"
  if [[ -n "$parent" ]]; then
    printf '%s\n' "$parent"
  else
    # check-change treats an all-zero base as a first-rollout bootstrap while
    # still applying all current-tree checks.
    printf '%040d\n' 0
  fi
}

check_documentation_checkout() {
  local recent_base
  recent_base="$(documentation_test_base)"
  check_documentation
  check_documentation_change "$recent_base" HEAD
  check_documentation_change HEAD INDEX
  check_documentation_change HEAD WORKTREE
}

require_node_runtime() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "Node.js 22.19 or newer and npm are required." >&2
    exit 1
  fi
  local version major minor
  version="$(node -p 'process.versions.node')"
  IFS=. read -r major minor _ <<<"$version"
  if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ ]] \
    || (( major < 22 || (major == 22 && minor < 19) )); then
    echo "Node.js 22.19 or newer is required (found ${version:-unknown})." >&2
    exit 1
  fi
}

activate_managed_node_runtime() {
  local data_dir managed_bin
  data_dir="${ENTERPRISE_PLATFORM_DATA:-$PLATFORM_DIR/data}"
  managed_bin="$data_dir/runtimes/node/current/bin"
  if [[ -x "$managed_bin/node" && -x "$managed_bin/npm" ]]; then
    export PATH="$managed_bin:$PATH"
  fi
}

systemctl_user() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is not available; run ./deploy.sh foreground instead." >&2
    exit 1
  fi
  systemctl --user "$@"
}

# Holds the pre-update HEAD so a failed redeploy can be rolled back.
PREV_SHA=""
UPDATE_LOCK_FD=""
UPDATE_LOCK_PATH=""
UPDATE_STATE_PROTOCOL_AVAILABLE=0
UPDATE_STATE_ACTIVE=0
UPDATE_SOURCE_MOVED=0
UPDATE_HEARTBEAT_PID=""
UPDATE_RECOVERY_ATTEMPTED=0
UPDATE_COMPLETED=0
UPDATE_COMMAND_ARGS=()
CONTAINER_BRIDGE_ACTIVE=0
LEGACY_DATA=""
LEGACY_SERVICE="${ENTERPRISE_SERVICE_NAME:-$SERVICE_NAME}"
LEGACY_HOST="${ENTERPRISE_PLATFORM_HOST:-127.0.0.1}"
LEGACY_PORT="${ENTERPRISE_PLATFORM_PORT:-8765}"
MANAGER_DATA_ROOT="${UBITECH_DATA_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/ubitech-agent}"

acquire_update_lock() {
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to update the repository." >&2
    exit 1
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "flock is required to serialize repository updates." >&2
    exit 1
  fi
  if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$ROOT is not a git work tree." >&2
    exit 1
  fi

  UPDATE_LOCK_PATH="$(git -C "$ROOT" rev-parse --git-path ubitech-agent-update.lock)"
  if [[ "$UPDATE_LOCK_PATH" != /* ]]; then
    UPDATE_LOCK_PATH="$ROOT/$UPDATE_LOCK_PATH"
  fi
  exec {UPDATE_LOCK_FD}>"$UPDATE_LOCK_PATH"
  if ! flock -n "$UPDATE_LOCK_FD"; then
    echo "Another ubitech agent update is already in progress." >&2
    exit 1
  fi
  # The durable marker may need to take over state left by an interrupted
  # updater. Pass the inherited descriptor so update_state can verify that
  # this deployment really owns the repository-wide update lock.
  export ENTERPRISE_AUTO_UPDATE_LOCK_FD="$UPDATE_LOCK_FD"
  export ENTERPRISE_AUTO_UPDATE_LOCK_PATH="$UPDATE_LOCK_PATH"
}

update_repo() {
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to update the repository." >&2
    return 1
  fi
  if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$ROOT is not a git work tree." >&2
    return 1
  fi

  local branch upstream remote target_branch
  branch="$(git -C "$ROOT" symbolic-ref --quiet --short HEAD || true)"
  upstream="$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  remote="${ENTERPRISE_AUTO_UPDATE_REMOTE:-origin}"
  target_branch="${ENTERPRISE_AUTO_UPDATE_BRANCH:-}"
  if [[ "$remote" == -* || ! "$remote" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "Cannot update: invalid git remote name." >&2
    return 1
  fi
  if [[ -n "$target_branch" ]] && ! git check-ref-format --branch "$target_branch" >/dev/null 2>&1; then
    echo "Cannot update: invalid git branch name." >&2
    return 1
  fi

  # Rollback uses a hard reset to restore the previous revision. Refuse to
  # enter that workflow when any staged, unstaged, or untracked user changes
  # are present so a failed update can never erase local work.
  local worktree_status
  if ! worktree_status="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"; then
    echo "Cannot update: repository status could not be verified." >&2
    return 1
  fi
  if [[ -n "$worktree_status" ]]; then
    echo "Cannot update: the repository has staged, unstaged, or untracked changes." >&2
    echo "Commit, stash, or remove local changes before running ./deploy.sh update." >&2
    return 1
  fi

  # Checkpoint the current revision before moving the working tree forward so
  # the update can be reverted if the subsequent redeploy fails.
  if [[ -z "$PREV_SHA" ]]; then
    PREV_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  fi

  git -C "$ROOT" fetch "$remote" || return 1
  if [[ -n "$target_branch" ]]; then
    git -C "$ROOT" merge --ff-only "$remote/$target_branch" || return 1
  elif [[ -n "$upstream" && "$remote" == "${upstream%%/*}" ]]; then
    git -C "$ROOT" merge --ff-only "$upstream" || return 1
  elif [[ -n "$branch" ]]; then
    git -C "$ROOT" merge --ff-only "$remote/$branch" || return 1
  else
    echo "Cannot update while the repository is in detached HEAD state." >&2
    return 1
  fi
  UPDATE_SOURCE_MOVED=1
}

# Revert the working tree to the pre-update revision and
# redeploy the known-good code so the service is restored to a working state.
rollback_update() {
  if [[ -z "$PREV_SHA" ]]; then
    echo "Update failed and no previous revision was recorded; manual recovery required." >&2
    return 1
  fi
  # A failed bootstrap can race with local maintenance or a generated file
  # appearing after the pull. Recheck immediately before the destructive reset
  # so rollback never erases changes that were not part of the update itself.
  local worktree_status
  if ! worktree_status="$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"; then
    echo "Update failed, but automatic rollback was refused because repository status could not be verified." >&2
    return 1
  fi
  if [[ -n "$worktree_status" ]]; then
    echo "Update failed, but automatic rollback was refused because the repository gained local changes." >&2
    echo "Preserve those changes and recover the previous revision manually if needed." >&2
    return 1
  fi
  echo "Update failed; rolling back to ${PREV_SHA}." >&2
  # --keep performs its own last-moment local-change check while updating the
  # index/worktree. Unlike --hard, it aborts instead of overwriting a tracked
  # edit that races with the status check above.
  if ! git -C "$ROOT" reset --keep "$PREV_SHA"; then
    echo "Automatic rollback was refused because concurrent local changes could not be preserved." >&2
    return 1
  fi
  # Reinstall and restart from the restored revision so the live service runs
  # known-good code again. If even this fails, surface manual recovery steps.
  if python_bootstrap_checked auto "$@"; then
    echo "Rolled back to ${PREV_SHA}." >&2
    return 0
  else
    echo "Rollback redeploy failed. Recover manually with:" >&2
    echo "  git -C \"$ROOT\" reset --keep ${PREV_SHA} && ./deploy.sh" >&2
  fi
  return 1
}

update_state() {
  local action="$1"
  shift || true
  if (( ! UPDATE_STATE_PROTOCOL_AVAILABLE )); then
    return 0
  fi
  if [[ ! -f "$PLATFORM_DIR/enterprise_agent_platform/update_state.py" ]]; then
    echo "Auto-update state helper disappeared during deployment." >&2
    return 1
  fi
  export ENTERPRISE_PLATFORM_DATA="${ENTERPRISE_PLATFORM_DATA:-$PLATFORM_DIR/data}"
  export PYTHONPATH="$PLATFORM_DIR${PYTHONPATH:+:$PYTHONPATH}"
  "$PYTHON_BIN" -m enterprise_agent_platform.update_state "$action" "$@"
}

begin_update_state() {
  if [[ ! -f "$PLATFORM_DIR/enterprise_agent_platform/update_state.py" ]]; then
    return 0
  fi
  # Freeze protocol availability before git can move the source tree.
  UPDATE_STATE_PROTOCOL_AVAILABLE=1
  if [[ -z "${ENTERPRISE_AUTO_UPDATE_ID:-}" ]]; then
    ENTERPRISE_AUTO_UPDATE_ID="manual-$(date +%s)-$$"
    export ENTERPRISE_AUTO_UPDATE_ID
  fi
  ENTERPRISE_AUTO_UPDATE_OWNER_PID=$$
  export ENTERPRISE_AUTO_UPDATE_OWNER_PID
  update_state begin --phase pulling --takeover
  UPDATE_STATE_ACTIVE=1
  start_update_heartbeat
}

start_update_heartbeat() {
  if (( ! UPDATE_STATE_ACTIVE )) || [[ -n "$UPDATE_HEARTBEAT_PID" ]]; then
    return 0
  fi
  # Run one Python process rather than a shell/sleep/process chain. Killing
  # this PID cannot leave a child behind to race a terminal state transition.
  "$PYTHON_BIN" -m enterprise_agent_platform.update_state \
    heartbeat-loop --phase deploying --interval 5 >/dev/null 2>&1 &
  UPDATE_HEARTBEAT_PID=$!
}

stop_update_heartbeat() {
  if [[ -z "$UPDATE_HEARTBEAT_PID" ]]; then
    return 0
  fi
  kill "$UPDATE_HEARTBEAT_PID" >/dev/null 2>&1 || true
  wait "$UPDATE_HEARTBEAT_PID" >/dev/null 2>&1 || true
  UPDATE_HEARTBEAT_PID=""
}

finish_update_success() {
  if (( UPDATE_STATE_ACTIVE )); then
    stop_update_heartbeat
    if ! update_state success --outcome success; then
      return 1
    fi
    UPDATE_STATE_ACTIVE=0
  fi
}

finish_update_failure() {
  local rollback_succeeded="${1:-0}"
  if (( ! UPDATE_STATE_ACTIVE )); then
    return 0
  fi
  stop_update_heartbeat
  if [[ "$rollback_succeeded" == "1" ]]; then
    update_state failure --rollback-succeeded --error "updated deployment failed; previous version restored" || true
  else
    update_state failure --error "update and automatic recovery did not complete" || true
  fi
  UPDATE_STATE_ACTIVE=0
}

recover_failed_update() {
  if (( UPDATE_RECOVERY_ATTEMPTED )); then
    return 0
  fi
  UPDATE_RECOVERY_ATTEMPTED=1
  local rollback_succeeded=1
  if (( UPDATE_SOURCE_MOVED )); then
    rollback_succeeded=0
    if rollback_update "${UPDATE_COMMAND_ARGS[@]}"; then
      rollback_succeeded=1
    fi
  fi
  finish_update_failure "$rollback_succeeded"
}

finalize_update_on_exit() {
  local status=$?
  trap - EXIT
  if (( ! UPDATE_COMPLETED && ! UPDATE_RECOVERY_ATTEMPTED )) \
    && (( status != 0 || UPDATE_STATE_ACTIVE || UPDATE_SOURCE_MOVED )); then
    # This catches signals and failures in marker/heartbeat steps as well as
    # deployment failures. Once source moved, every incomplete exit attempts
    # the same conservative rollback used by the explicit error paths.
    set +e
    recover_failed_update
    set -e
  fi
  return "$status"
}

capture_update_context() {
  local previous=""
  for argument in "$@"; do
    if [[ -n "$previous" ]]; then
      case "$previous" in
        data) ENTERPRISE_PLATFORM_DATA="$argument"; export ENTERPRISE_PLATFORM_DATA ;;
        service) LEGACY_SERVICE="$argument" ;;
        host) LEGACY_HOST="$argument" ;;
        port) LEGACY_PORT="$argument" ;;
      esac
      previous=""
      continue
    fi
    case "$argument" in
      --data) previous="data" ;;
      --data=*)
        ENTERPRISE_PLATFORM_DATA="${argument#--data=}"
        export ENTERPRISE_PLATFORM_DATA
        ;;
      --service-name) previous="service" ;;
      --service-name=*) LEGACY_SERVICE="${argument#--service-name=}" ;;
      --host) previous="host" ;;
      --host=*) LEGACY_HOST="${argument#--host=}" ;;
      --port) previous="port" ;;
      --port=*) LEGACY_PORT="${argument#--port=}" ;;
    esac
  done
  if [[ -n "$previous" ]]; then
    echo "Missing value for update option --${previous}." >&2
    return 1
  fi
  LEGACY_DATA="${ENTERPRISE_PLATFORM_DATA:-$PLATFORM_DIR/data}"
}

prepare_container_bridge() {
  if [[ ! -x "$ROOT/install.sh" || ! -f "$ROOT/docs/contracts/container-platform.json" ]]; then
    return 0
  fi
  if [[ "${UBITECH_SKIP_CONTAINER_MIGRATION:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "$MANAGER_DATA_ROOT" != /* ]]; then
    echo "Cannot migrate: UBITECH_DATA_ROOT must be an absolute path." >&2
    return 1
  fi
  if [[ ! "$LEGACY_PORT" =~ ^[0-9]+$ ]] || ((10#$LEGACY_PORT < 1 || 10#$LEGACY_PORT > 65535)); then
    echo "Cannot migrate: the effective Platform port is invalid." >&2
    return 1
  fi
  if [[ ! "$LEGACY_SERVICE" =~ ^[A-Za-z0-9_@:.][A-Za-z0-9_.@:-]*\.service$ ]]; then
    echo "Cannot migrate: the effective user-systemd service name is invalid." >&2
    return 1
  fi
  if [[ -z "$LEGACY_HOST" || "$LEGACY_HOST" == *$'\n'* || "$LEGACY_HOST" == *$'\r'* ]]; then
    echo "Cannot migrate: the effective Platform host is invalid." >&2
    return 1
  fi
  export UBITECH_SOURCE_MIGRATION_BRIDGE=1
  export UBITECH_MANAGER_SOCKET="$MANAGER_DATA_ROOT/manager/control/manager.sock"
  export UBITECH_MANAGER_TOKEN_FILE="$MANAGER_DATA_ROOT/manager/secrets/manager-token"
  CONTAINER_BRIDGE_ACTIVE=1
}

run_container_bridge_installer() {
  if (( ! CONTAINER_BRIDGE_ACTIVE )); then
    return 0
  fi
  local listen_host gate_host listen gate_url status source_commit release_base manifest_url channel_manifest_url manager_url manager_arch
  listen_host="$LEGACY_HOST"
  gate_host="$LEGACY_HOST"
  case "$LEGACY_HOST" in
    0.0.0.0) gate_host="127.0.0.1" ;;
    ::|"[::]") gate_host="[::1]" ; listen_host="[::]" ;;
    *:*)
      [[ "$listen_host" == \[*\] ]] || listen_host="[$listen_host]"
      [[ "$gate_host" == \[*\] ]] || gate_host="[$gate_host]"
      ;;
  esac
  listen="$listen_host:$LEGACY_PORT"
  gate_url="http://$gate_host:$LEGACY_PORT"
  source_commit="$(git -C "$ROOT" rev-parse HEAD)"
  release_base="https://github.com/${UBITECH_RELEASE_REPOSITORY:-Noyv3x/enterprise-agent-platform}/releases/download/container-${source_commit}"
  manifest_url="${UBITECH_RELEASE_MANIFEST_URL:-$release_base/release.json}"
  channel_manifest_url="${UBITECH_RELEASE_CHANNEL_MANIFEST_URL:-https://github.com/${UBITECH_RELEASE_REPOSITORY:-Noyv3x/enterprise-agent-platform}/releases/latest/download/release.json}"
  case "$(uname -m)" in
    x86_64|amd64) manager_arch="amd64" ;;
    aarch64|arm64) manager_arch="arm64" ;;
    *) manager_arch="" ;;
  esac
  if [[ -z "$manager_arch" ]]; then
    echo "Cannot migrate: unsupported manager architecture $(uname -m)." >&2
    return 1
  fi
  manager_url="${UBITECH_MANAGER_URL:-$release_base/ubitech-manager-linux-$manager_arch}"
  status=0
  "$ROOT/install.sh" \
    --manifest-url "$manifest_url" \
    --channel-manifest-url "$channel_manifest_url" \
    --manager-url "$manager_url" \
    --manager-checksum-url "${UBITECH_MANAGER_CHECKSUM_URL:-$manager_url.sha256}" \
    --data-root "$MANAGER_DATA_ROOT" \
    --listen "$listen" \
    --migrate-from "$ROOT" \
    --legacy-data "$LEGACY_DATA" \
    --legacy-service "$LEGACY_SERVICE" \
    --legacy-platform-url "$gate_url" \
    --expected-source-commit "$source_commit" \
    --yes || status=$?
  if ((status == 75)); then
    echo "Container migration is queued; the source bridge remains available."
    return 0
  fi
  return "$status"
}

wait_for_gateway_writes() {
  if [[ ! -f "$PLATFORM_DIR/enterprise_agent_platform/gateway.py" ]]; then
    return 0
  fi
  export PYTHONPATH="$PLATFORM_DIR${PYTHONPATH:+:$PYTHONPATH}"
  "$PYTHON_BIN" -c \
    'import os, sys; from enterprise_agent_platform.gateway import wait_for_gateway_drain; sys.exit(0 if wait_for_gateway_drain(os.environ["ENTERPRISE_PLATFORM_DATA"], timeout=60) else 1)'
}

activate_managed_node_runtime

cmd="${1:-deploy}"
case "$cmd" in
  -h|--help|help)
    usage
    ;;
  update|upgrade)
    shift || true
    UPDATE_COMMAND_ARGS=("$@")
    acquire_update_lock
    trap finalize_update_on_exit EXIT
    capture_update_context "$@"
    begin_update_state
    if ! wait_for_gateway_writes; then
      echo "Cannot update: existing write requests did not drain safely." >&2
      recover_failed_update
      exit 1
    fi
    if ! update_repo; then
      recover_failed_update
      exit 1
    fi
    # Freeze capability detection before the pull. During the first rollout
    # the old source has no state helper; do not start speaking the new state
    # protocol merely because the pulled tree now contains it.
    if (( UPDATE_STATE_ACTIVE )); then
      if ! update_state heartbeat --phase deploying; then
        echo "Update state could not advance after the source changed; rolling back." >&2
        recover_failed_update
        exit 1
      fi
    fi
    if ! check_documentation \
      || ! check_documentation_change "$PREV_SHA" HEAD; then
      echo "Updated source failed the canonical documentation gate; rolling back." >&2
      recover_failed_update
      exit 1
    fi
    if ! prepare_container_bridge; then
      recover_failed_update
      exit 1
    fi
    if ! python_bootstrap_checked auto "$@"; then
      recover_failed_update
      exit 1
    fi
    if ! finish_update_success; then
      echo "Updated deployment could not finalize its maintenance state; rolling back." >&2
      recover_failed_update
      exit 1
    fi
    UPDATE_COMPLETED=1
    run_container_bridge_installer
    ;;
  deploy|up)
    shift || true
    check_documentation_checkout
    python_bootstrap auto "$@"
    ;;
  service)
    shift || true
    check_documentation_checkout
    python_bootstrap service "$@"
    ;;
  foreground|run)
    shift || true
    check_documentation_checkout
    python_bootstrap foreground "$@"
    ;;
  prepare)
    shift || true
    check_documentation_checkout
    python_bootstrap prepare "$@"
    ;;
  start|stop|restart|status)
    shift || true
    systemctl_user "$cmd" "$SERVICE_NAME" "$@"
    ;;
  logs)
    shift || true
    if ! command -v journalctl >/dev/null 2>&1; then
      echo "journalctl is not available." >&2
      exit 1
    fi
    exec journalctl --user -u "$SERVICE_NAME" -f "$@"
    ;;
  test)
    shift || true
    check_documentation_checkout
    export UBITECH_DOCS_ALREADY_CHECKED=1
    exec "$ROOT/scripts/test.sh" "$@"
    ;;
  *)
    check_documentation_checkout
    python_bootstrap auto "$@"
    ;;
esac
