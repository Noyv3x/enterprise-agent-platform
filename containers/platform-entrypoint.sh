#!/bin/sh
set -eu

fail() {
  printf 'Agent Platform entrypoint: %s\n' "$*" >&2
  exit 64
}

require_exact() {
  variable="$1"
  expected="$2"
  eval "actual=\${$variable:-}"
  if [ "$actual" != "$expected" ]; then
    echo "$variable must be $expected for the target technical profile" >&2
    exit 64
  fi
}

validate_id() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*) fail "$name must be a positive decimal integer" ;;
  esac
  [ "$value" -gt 0 ] 2>/dev/null || fail "$name must be greater than zero"
  [ "$value" -le 2147483647 ] 2>/dev/null || fail "$name exceeds the supported Linux id range"
}

require_exact AGENT_PLATFORM_TECHNICAL_PROFILE agent-platform-v1
require_exact AGENT_PLATFORM_DATA /var/lib/agent-platform
require_exact AGENT_PLATFORM_DEPLOYMENT_MODE container
require_exact AGENT_PLATFORM_SESSION_SECRET_FILE /run/secrets/agent-platform/session-secret
require_exact AGENT_PLATFORM_AGENT_TOOL_TOKEN_FILE /run/secrets/agent-platform/agent-tool-token
require_exact AGENT_PLATFORM_AGENT_RUNTIME_TOKEN_FILE /run/secrets/agent-platform/agent-runtime-token
require_exact AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE /run/secrets/agent-platform/camofox-access-key
require_exact AGENT_PLATFORM_MANAGER_SOCKET /run/agent-platform-manager/manager.sock
require_exact AGENT_PLATFORM_MANAGER_TOKEN_FILE /run/secrets/agent-platform/manager-token

if [ "$(/usr/bin/id -u)" -eq 0 ]; then
  run_uid="${AGENT_PLATFORM_RUN_UID:-}"
  run_gid="${AGENT_PLATFORM_RUN_GID:-}"
  validate_id AGENT_PLATFORM_RUN_UID "$run_uid"
  validate_id AGENT_PLATFORM_RUN_GID "$run_gid"
  root_command="${1:-}"
  if [ "$root_command" = enterprise-agent-platform ]; then
    root_command="${2:-}"
  fi
  case "$root_command" in
    migrate)
      require_exact AGENT_PLATFORM_WORKSPACE_MOUNT_COMPAT 2026080801-to-2026082901
      if ! compatibility_action="$(
        cd /
        exec /usr/bin/setpriv \
          --reuid="$run_uid" \
          --regid="$run_gid" \
          --clear-groups \
          --no-new-privs \
          -- /opt/venv/bin/python -I -m enterprise_agent_platform.workspace_mount_compat --check-source
      )"; then
        fail "workspace compatibility source check failed"
      fi
      case "$compatibility_action" in
        apply)
          (
            cd /
            exec /opt/venv/bin/python -I -m enterprise_agent_platform.workspace_mount_compat
          )
          ;;
        skip) ;;
        *) fail "workspace compatibility source check returned an invalid action" ;;
      esac
      ;;
    serve|init-admin|print-agent-token|__healthcheck)
      ;;
    *)
      fail "root startup command is not allowed"
      ;;
  esac
  unset AGENT_PLATFORM_RUN_UID AGENT_PLATFORM_RUN_GID AGENT_PLATFORM_WORKSPACE_MOUNT_COMPAT
  exec /usr/bin/setpriv \
    --reuid="$run_uid" \
    --regid="$run_gid" \
    --clear-groups \
    --no-new-privs \
    -- "$0" "$@"
fi

if [ "${1:-}" = __healthcheck ]; then
  exec /opt/venv/bin/python -I -c 'import json,urllib.request; p=json.load(urllib.request.urlopen("http://127.0.0.1:8765/healthz", timeout=2)); raise SystemExit(0 if p.get("service")=="agent-platform" else 1)'
fi

mkdir -p "${HOME:-/var/lib/agent-platform/.home}"

load_secret() {
  variable="$1"
  file_variable="${variable}_FILE"
  eval "file_path=\${$file_variable:-}"
  eval "current_value=\${$variable:-}"
  if [ -n "$current_value" ] && [ -n "$file_path" ]; then
    echo "$variable and $file_variable cannot both be set" >&2
    exit 64
  fi
  if [ -n "$file_path" ]; then
    if [ ! -f "$file_path" ] || [ -L "$file_path" ]; then
      echo "$file_variable does not name a regular secret file" >&2
      exit 66
    fi
    value="$(cat "$file_path")"
    if [ -z "$value" ]; then
      echo "$file_variable is empty" >&2
      exit 65
    fi
    export "$variable=$value"
    unset "$file_variable"
  fi
}

load_secret AGENT_PLATFORM_SESSION_SECRET
load_secret AGENT_PLATFORM_AGENT_TOOL_TOKEN
load_secret AGENT_PLATFORM_AGENT_RUNTIME_TOKEN
load_secret AGENT_PLATFORM_CAMOFOX_ACCESS_KEY

case "${1:-}" in
  migrate|serve|init-admin|print-agent-token)
    set -- enterprise-agent-platform "$@"
    ;;
esac

exec "$@"
