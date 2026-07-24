#!/bin/sh
set -eu

mkdir -p "${HOME:-/var/lib/ubitech-agent/.home}"

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

load_secret ENTERPRISE_SESSION_SECRET
load_secret ENTERPRISE_AGENT_TOOL_TOKEN
load_secret ENTERPRISE_AGENT_RUNTIME_TOKEN
load_secret CAMOFOX_ACCESS_KEY
load_secret FIRECRAWL_API_KEY

case "${1:-}" in
  migrate|serve|init-admin|print-agent-token)
    set -- enterprise-agent-platform "$@"
    ;;
esac

exec "$@"
