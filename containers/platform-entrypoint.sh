#!/bin/sh
set -eu

require_exact() {
  variable="$1"
  expected="$2"
  eval "actual=\${$variable:-}"
  if [ "$actual" != "$expected" ]; then
    echo "$variable must be $expected for the target technical profile" >&2
    exit 64
  fi
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
