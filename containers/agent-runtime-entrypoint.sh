#!/bin/sh
set -eu

mkdir -p "${HOME:-/var/lib/ubitech-agent/runtime/home}"

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
