#!/bin/sh
set -eu

if env | grep -Eq '^(UBITECH_|ENTERPRISE_)'; then
  echo "source-profile environment is not accepted by the target Agent Runtime image" >&2
  exit 64
fi

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
require_exact AGENT_RUNTIME_HOME /var/lib/agent-platform/runtime
require_exact AGENT_RUNTIME_TOKEN_FILE /run/secrets/agent-platform/agent-runtime-token
require_exact AGENT_PLATFORM_INTERNAL_TOKEN_FILE /run/secrets/agent-platform/agent-tool-token
require_exact AGENT_MANAGER_EXECUTOR_SOCKET /run/agent-platform-manager/manager.sock
require_exact AGENT_MANAGER_EXECUTOR_TOKEN_FILE /run/secrets/agent-platform/manager-executor-token

mkdir -p "${HOME:-/var/lib/agent-platform/runtime/home}"

if [ -n "${AGENT_PLATFORM_INTERNAL_TOKEN_FILE:-}" ]; then
  if [ -n "${AGENT_PLATFORM_INTERNAL_TOKEN:-}" ]; then
    echo "AGENT_PLATFORM_INTERNAL_TOKEN and AGENT_PLATFORM_INTERNAL_TOKEN_FILE cannot both be set" >&2
    exit 64
  fi
  if [ ! -f "$AGENT_PLATFORM_INTERNAL_TOKEN_FILE" ] || [ -L "$AGENT_PLATFORM_INTERNAL_TOKEN_FILE" ]; then
    echo "AGENT_PLATFORM_INTERNAL_TOKEN_FILE does not name a regular secret file" >&2
    exit 66
  fi
  AGENT_PLATFORM_INTERNAL_TOKEN="$(cat "$AGENT_PLATFORM_INTERNAL_TOKEN_FILE")"
  if [ -z "$AGENT_PLATFORM_INTERNAL_TOKEN" ]; then
    echo "AGENT_PLATFORM_INTERNAL_TOKEN_FILE is empty" >&2
    exit 65
  fi
  export AGENT_PLATFORM_INTERNAL_TOKEN
  unset AGENT_PLATFORM_INTERNAL_TOKEN_FILE
fi

exec "$@"
