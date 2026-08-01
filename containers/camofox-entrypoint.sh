#!/bin/sh
set -eu

if env | grep -Eq '^(UBITECH_|ENTERPRISE_)'; then
  echo "source-profile environment is not accepted by the target Camoufox image" >&2
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
require_exact AGENT_PLATFORM_CAMOFOX_BIND_HOST 0.0.0.0
require_exact AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE /run/secrets/agent-platform/camofox-access-key
require_exact CAMOFOX_PROFILE_DIR /var/lib/agent-platform/camofox/profiles
require_exact CAMOFOX_COOKIES_DIR /var/lib/agent-platform/camofox/cookies
require_exact CAMOFOX_TRACES_DIR /var/lib/agent-platform/camofox/traces
require_exact XDG_CACHE_HOME /var/lib/agent-platform/camofox/home/.cache

mkdir -p "${HOME:-/var/lib/agent-platform/camofox/home}"

if [ -n "${AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE:-}" ]; then
  if [ -n "${CAMOFOX_ACCESS_KEY:-}" ] || [ -n "${CAMOFOX_API_KEY:-}" ]; then
    echo "Camoufox access key and AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE cannot both be set" >&2
    exit 64
  fi
  if [ ! -f "$AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE" ] || [ -L "$AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE" ]; then
    echo "AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE does not name a regular secret file" >&2
    exit 66
  fi
  key="$(cat "$AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE")"
  if [ "${#key}" -lt 32 ]; then
    echo "AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE is empty or too short" >&2
    exit 65
  fi
  export CAMOFOX_ACCESS_KEY="$key"
  export CAMOFOX_API_KEY="$key"
  export CAMOFOX_ADMIN_KEY="$key"
  unset AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE
fi

unset DISPLAY WAYLAND_DISPLAY XAUTHORITY
exec "$@"
