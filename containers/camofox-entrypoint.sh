#!/bin/sh
set -eu

mkdir -p "${HOME:-/var/lib/ubitech-agent/camofox/home}"

if [ -n "${CAMOFOX_ACCESS_KEY_FILE:-}" ]; then
  if [ -n "${CAMOFOX_ACCESS_KEY:-}" ] || [ -n "${CAMOFOX_API_KEY:-}" ]; then
    echo "Camoufox access key and CAMOFOX_ACCESS_KEY_FILE cannot both be set" >&2
    exit 64
  fi
  if [ ! -f "$CAMOFOX_ACCESS_KEY_FILE" ] || [ -L "$CAMOFOX_ACCESS_KEY_FILE" ]; then
    echo "CAMOFOX_ACCESS_KEY_FILE does not name a regular secret file" >&2
    exit 66
  fi
  key="$(cat "$CAMOFOX_ACCESS_KEY_FILE")"
  if [ "${#key}" -lt 32 ]; then
    echo "CAMOFOX_ACCESS_KEY_FILE is empty or too short" >&2
    exit 65
  fi
  export CAMOFOX_ACCESS_KEY="$key"
  export CAMOFOX_API_KEY="$key"
  export CAMOFOX_ADMIN_KEY="$key"
  unset CAMOFOX_ACCESS_KEY_FILE
fi

unset DISPLAY WAYLAND_DISPLAY XAUTHORITY
exec "$@"
