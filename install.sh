#!/usr/bin/env bash
set -euo pipefail
umask 077

repository="${UBITECH_RELEASE_REPOSITORY:-Noyv3x/enterprise-agent-platform}"
default_manifest_url="https://github.com/${repository}/releases/latest/download/release.json"
manifest_url="${UBITECH_RELEASE_MANIFEST_URL:-$default_manifest_url}"
manager_url="${UBITECH_MANAGER_URL:-}"
manager_checksum_url="${UBITECH_MANAGER_CHECKSUM_URL:-}"
config_path="${XDG_CONFIG_HOME:-$HOME/.config}/ubitech-agent/manager.toml"
data_root="${XDG_DATA_HOME:-$HOME/.local/share}/ubitech-agent"
listen="127.0.0.1:8080"
assume_yes=0

usage() {
  cat <<'EOF'
Install ubitech agent from the current container release channel.

Usage: ./install.sh [options]
  --manifest-url URL          persistent release manifest URL
  --manager-url URL           Manager binary URL
  --manager-checksum-url URL  Manager SHA-256 sidecar URL
  --config PATH               manager.toml destination
  --data-root PATH            persistent data root
  --listen HOST:PORT          public Manager listener
  --yes                       do not prompt
  -h, --help                  show this help

This installer supports fresh container installations only. Existing
installations must use the Manager update operation.
EOF
}

while (($#)); do
  case "$1" in
    --manifest-url) manifest_url="${2:?missing URL}"; shift 2 ;;
    --manager-url) manager_url="${2:?missing URL}"; shift 2 ;;
    --manager-checksum-url) manager_checksum_url="${2:?missing URL}"; shift 2 ;;
    --config) config_path="${2:?missing path}"; shift 2 ;;
    --data-root) data_root="${2:?missing path}"; shift 2 ;;
    --listen) listen="${2:?missing listener}"; shift 2 ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
done

for command in curl sha256sum install systemctl uname awk stat realpath id mktemp docker find grep rm rmdir; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'required command is missing: %s\n' "$command" >&2
    exit 69
  }
done

docker version >/dev/null 2>&1 || {
  printf '%s\n' 'Docker Engine is unavailable to the current user.' >&2
  exit 69
}
docker compose version >/dev/null 2>&1 || {
  printf '%s\n' 'Docker Compose v2 is required.' >&2
  exit 69
}
systemctl --user show-environment >/dev/null 2>&1 || {
  printf '%s\n' 'A working user-systemd session is required.' >&2
  exit 69
}

case "$(uname -m)" in
  x86_64|amd64) architecture=amd64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) printf 'unsupported architecture: %s\n' "$(uname -m)" >&2; exit 65 ;;
esac

asset="ubitech-manager-linux-${architecture}"
if [[ -z "$manager_url" ]]; then
  manager_url="https://github.com/${repository}/releases/latest/download/${asset}"
fi
if [[ -z "$manager_checksum_url" ]]; then
  manager_checksum_url="${manager_url}.sha256"
fi

for value in "$manifest_url" "$manager_url" "$manager_checksum_url"; do
  [[ "$value" == https://* ]] || {
    printf 'release URL must use HTTPS: %s\n' "$value" >&2
    exit 65
  }
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *'"'* || "$value" == *"'"* || "$value" == *'\'* ]]; then
    printf '%s\n' 'release URL contains unsupported characters' >&2
    exit 65
  fi
done

if [[ ! "$listen" =~ ^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):([1-9][0-9]{0,4})$ ]] \
  || ((10#${BASH_REMATCH[2]:-0} > 65535)); then
  printf 'invalid listener: %s\n' "$listen" >&2
  exit 65
fi

for path in "$config_path" "$data_root"; do
  [[ "$path" == /* ]] || {
    printf 'installation path must be absolute: %s\n' "$path" >&2
    exit 65
  }
  if [[ "$path" == *$'\n'* || "$path" == *$'\r'* || "$path" == *'"'* || "$path" == *"'"* || "$path" == *'\'* ]]; then
    printf '%s\n' 'installation path contains unsupported characters' >&2
    exit 65
  fi
done

bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
stable_manager="$bin_dir/ubitech-manager"
unit_path="$unit_dir/ubitech-agent-manager.service"
socket_path="$data_root/manager/control/manager.sock"

for path in "$bin_dir" "$unit_dir" "$stable_manager" "$unit_path" "$socket_path"; do
  [[ "$path" == /* ]] || {
    printf 'installation path must be absolute: %s\n' "$path" >&2
    exit 65
  }
done

for path in "$config_path" "$stable_manager" "$unit_path" "$socket_path"; do
  if [[ -e "$path" || -L "$path" || -S "$path" ]]; then
    printf '%s\n' 'an ubitech agent installation already exists; use Manager update' >&2
    exit 73
  fi
done

data_root_preexisting=0
if [[ -e "$data_root" || -L "$data_root" ]]; then
  data_root_preexisting=1
  ensure_data_root="$(realpath -m -s -- "$data_root")"
  physical_data_root="$(realpath -m -- "$data_root")"
  if [[ "$ensure_data_root" != "$physical_data_root" || -L "$data_root" || ! -d "$data_root" ]] \
    || [[ "$(stat -c '%u' "$data_root")" != "$(id -u)" ]]; then
    printf 'refusing an unsafe data root: %s\n' "$data_root" >&2
    exit 73
  fi
  if find "$data_root" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    printf '%s\n' 'the data root is not empty; fresh install never adopts existing data' >&2
    exit 73
  fi
fi

ensure_owner_directory() {
  local directory="$1" lexical physical mode existed=0
  if [[ -e "$directory" || -L "$directory" ]]; then
    existed=1
  fi
  lexical="$(realpath -m -s -- "$directory")"
  physical="$(realpath -m -- "$directory")"
  if [[ "$lexical" != "$physical" ]]; then
    printf 'refusing a path with a symlink component: %s\n' "$directory" >&2
    exit 73
  fi
  mkdir -p "$directory"
  if ((existed == 0)); then
    created_directories+=("$directory")
  fi
  mode="$(stat -c '%a' "$directory" 2>/dev/null || true)"
  if [[ -L "$directory" || ! -d "$directory" ]] \
    || [[ "$(stat -c '%u' "$directory")" != "$(id -u)" ]] \
    || [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] \
    || (( (8#$mode & 022) != 0 )); then
    printf 'refusing an unsafe installation directory: %s\n' "$directory" >&2
    exit 73
  fi
}

if ((assume_yes == 0)); then
  if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
    printf '%s\n' 'interactive confirmation requires a controlling terminal; pass --yes for unattended installation' >&2
    exit 64
  fi
  printf 'Install ubitech agent for user %s? [y/N] ' "${USER:-$(id -un)}" >/dev/tty
  read -r answer </dev/tty
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes || "$answer" == YES ]] || exit 0
fi

temporary="$(mktemp -d)"
manager_activated=0
manager_root_created=0
stable_installed=0
unit_installed=0
config_incoming=""
manager_incoming=""
unit_incoming=""
created_directories=()
cleanup() {
  local status=$? index
  trap - EXIT
  if ((status != 0 && manager_activated == 0)); then
    if ((unit_installed)); then
      systemctl --user disable --now ubitech-agent-manager.service >/dev/null 2>&1 || true
      rm -f "$unit_path"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if ((stable_installed)); then
      rm -f "$stable_manager"
    fi
    rm -f "$config_path"
    if ((manager_root_created)) && [[ -d "$data_root" && ! -L "$data_root" ]] \
      && [[ "$(stat -c '%u' "$data_root" 2>/dev/null || true)" == "$(id -u)" ]] \
      && [[ "$(realpath -m -s -- "$data_root")" == "$(realpath -m -- "$data_root")" ]]; then
      rm -rf --one-file-system -- "$data_root/manager"
      if ((data_root_preexisting == 0)); then
        rmdir "$data_root" >/dev/null 2>&1 || true
      fi
    fi
    for ((index=${#created_directories[@]}-1; index>=0; index--)); do
      rmdir "${created_directories[index]}" >/dev/null 2>&1 || true
    done
  fi
  [[ -z "$config_incoming" ]] || rm -f "$config_incoming"
  [[ -z "$manager_incoming" ]] || rm -f "$manager_incoming"
  [[ -z "$unit_incoming" ]] || rm -f "$unit_incoming"
  rm -rf --one-file-system -- "$temporary"
  exit "$status"
}
trap cleanup EXIT

ensure_owner_directory "$bin_dir"
ensure_owner_directory "$(dirname "$config_path")"
ensure_owner_directory "$unit_dir"
ensure_owner_directory "$data_root"
manager_root_created=1
ensure_owner_directory "$data_root/manager"

download() {
  local output="$1" url="$2"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 4 \
    --connect-timeout 20 --max-time 600 --retry-max-time 600 \
    --output "$output" "$url"
}

download "$temporary/$asset" "$manager_url"
download "$temporary/$asset.sha256" "$manager_checksum_url"
expected="$(awk 'NR == 1 { print $1 }' "$temporary/$asset.sha256")"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || {
  printf '%s\n' 'Manager checksum sidecar is invalid' >&2
  exit 65
}
actual="$(sha256sum "$temporary/$asset" | awk '{ print $1 }')"
[[ "$actual" == "$expected" ]] || {
  printf 'Manager checksum mismatch: expected %s, found %s\n' "$expected" "$actual" >&2
  exit 65
}
chmod 0700 "$temporary/$asset"

config_incoming="$(mktemp "$(dirname "$config_path")/.manager.toml.XXXXXX")"
cat > "$config_incoming" <<EOF
data_root = "$data_root"
listen = "$listen"
release_manifest_url = "$manifest_url"
release_channel = "main"
update_enabled = true
update_interval = "5m"
sandbox_idle = "30m"
log_max_size = "20MiB"
log_max_files = 5
EOF
chmod 0600 "$config_incoming"
mv -f "$config_incoming" "$config_path"
config_incoming=""

manager_incoming="$(mktemp "$bin_dir/.ubitech-manager.XXXXXX")"
install -m 0755 "$temporary/$asset" "$manager_incoming"
[[ "$(sha256sum "$manager_incoming" | awk '{ print $1 }')" == "$expected" ]] || {
  rm -f "$manager_incoming"
  printf '%s\n' 'installed Manager changed before activation' >&2
  exit 73
}
mv -f "$manager_incoming" "$stable_manager"
manager_incoming=""
stable_installed=1

"$stable_manager" preflight --config "$config_path"

unit_incoming="$(mktemp "$unit_dir/.ubitech-agent-manager.service.XXXXXX")"
cat > "$unit_incoming" <<EOF
[Unit]
Description=ubitech agent manager
Documentation=https://github.com/${repository}
After=docker.service

[Service]
Type=simple
ExecStart="$stable_manager" serve --config "$config_path"
Restart=on-failure
RestartSec=3s
TimeoutStopSec=60s
PrivateTmp=true
UMask=0077

[Install]
WantedBy=default.target
EOF
chmod 0600 "$unit_incoming"
mv -f "$unit_incoming" "$unit_path"
unit_incoming=""
unit_installed=1

systemctl --user daemon-reload
systemctl --user enable --now ubitech-agent-manager.service
manager_activated=1
if "$stable_manager" install --config "$config_path" --release-manifest-url "$manifest_url"; then
  :
else
  status=$?
  printf '%s\n' 'Manager is active and owns the installation state; do not rerun this installer or delete the data root.' >&2
  printf 'After correcting the reported cause, retry with:\n  %q install --config %q --release-manifest-url %q\n' \
    "$stable_manager" "$config_path" "$manifest_url" >&2
  exit "$status"
fi

if command -v loginctl >/dev/null \
  && ! loginctl show-user "${USER:-$(id -un)}" -p Linger --value 2>/dev/null | grep -qx yes; then
  printf 'Warning: user lingering is disabled; run `loginctl enable-linger %s`.\n' "${USER:-$(id -un)}" >&2
fi

printf 'ubitech agent installed. Run: %s status\n' "$stable_manager"
