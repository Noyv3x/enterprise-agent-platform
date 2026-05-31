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

systemctl_user() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is not available; run ./deploy.sh foreground instead." >&2
    exit 1
  fi
  systemctl --user "$@"
}

# Holds the pre-update HEAD so a failed redeploy can be rolled back.
PREV_SHA=""

update_repo() {
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to update the repository." >&2
    exit 1
  fi
  if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "$ROOT is not a git work tree." >&2
    exit 1
  fi

  local branch upstream
  branch="$(git -C "$ROOT" symbolic-ref --quiet --short HEAD || true)"
  upstream="$(git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

  # Checkpoint the current revision before moving the working tree forward so
  # the update can be reverted if the subsequent redeploy fails.
  PREV_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"

  git -C "$ROOT" fetch --recurse-submodules origin
  if [[ -n "$upstream" ]]; then
    git -C "$ROOT" pull --ff-only --recurse-submodules
  elif [[ -n "$branch" ]]; then
    git -C "$ROOT" pull --ff-only --recurse-submodules origin "$branch"
  else
    echo "Cannot update while the repository is in detached HEAD state." >&2
    exit 1
  fi
  git -C "$ROOT" submodule update --init --recursive
}

# Revert the working tree (and submodules) to the pre-update revision and
# redeploy the known-good code so the service is restored to a working state.
rollback_update() {
  if [[ -z "$PREV_SHA" ]]; then
    echo "Update failed and no previous revision was recorded; manual recovery required." >&2
    return 1
  fi
  echo "Update failed; rolling back to ${PREV_SHA}." >&2
  git -C "$ROOT" reset --hard "$PREV_SHA"
  git -C "$ROOT" submodule update --init --recursive --force
  # Reinstall and restart from the restored revision so the live service runs
  # known-good code again. If even this fails, surface manual recovery steps.
  if python_bootstrap_checked auto "$@"; then
    echo "Rolled back to ${PREV_SHA}." >&2
  else
    echo "Rollback redeploy failed. Recover manually with:" >&2
    echo "  git -C \"$ROOT\" reset --hard ${PREV_SHA} && git -C \"$ROOT\" submodule update --init --recursive --force && ./deploy.sh" >&2
  fi
  return 1
}

cmd="${1:-deploy}"
case "$cmd" in
  -h|--help|help)
    usage
    ;;
  update|upgrade)
    shift || true
    update_repo
    if ! python_bootstrap_checked auto "$@"; then
      rollback_update "$@" || true
      exit 1
    fi
    ;;
  deploy|up)
    shift || true
    python_bootstrap auto "$@"
    ;;
  service)
    shift || true
    python_bootstrap service "$@"
    ;;
  foreground|run)
    shift || true
    python_bootstrap foreground "$@"
    ;;
  prepare)
    shift || true
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
    cd "$PLATFORM_DIR"
    "$PYTHON_BIN" -m unittest discover -s tests "$@"
    "$PYTHON_BIN" -m compileall enterprise_agent_platform hermes_plugin tests
    ;;
  *)
    python_bootstrap auto "$@"
    ;;
esac
