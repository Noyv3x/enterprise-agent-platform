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
require_exact AGENT_RUNTIME_HOME /var/lib/agent-platform/runtime
require_exact AGENT_RUNTIME_TOKEN_FILE /run/secrets/agent-platform/agent-runtime-token
require_exact AGENT_PLATFORM_INTERNAL_TOKEN_FILE /run/secrets/agent-platform/agent-tool-token
require_exact AGENT_MANAGER_EXECUTOR_SOCKET /run/agent-platform-manager/manager.sock
require_exact AGENT_MANAGER_EXECUTOR_TOKEN_FILE /run/secrets/agent-platform/manager-executor-token

mkdir -p "${HOME:-/var/lib/agent-platform/runtime/home}"

# The server reads all bearer secrets from their deployed files. Keep them out
# of the environment inherited by SDK dependencies.

exec "$@"
