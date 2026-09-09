#!/usr/bin/env bash
set -euo pipefail
umask 077

repository="Noyv3x/enterprise-agent-platform"
default_manifest_url="https://github.com/${repository}/releases/latest/download/release.json"
manifest_url="$default_manifest_url"
listen="127.0.0.1:8080"
assume_yes=0

usage() {
  cat <<'EOF'
Install the Agent Platform from the current container release channel.

Usage: ./install.sh [options]
  --manifest-url URL          persistent release manifest URL
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
    --listen) listen="${2:?missing listener}"; shift 2 ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
done

for command in curl sha256sum install systemctl uname awk stat realpath id getent mktemp docker find grep rm rmdir flock chmod mv; do
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

account_uid="$(id -u)"
account_gid="$(id -g)"
account_records=()
mapfile -t account_records < <(getent passwd "$account_uid")
if [[ "${#account_records[@]}" -ne 1 ]]; then
  printf 'operating-system account lookup returned %s records for uid %s\n' \
    "${#account_records[@]}" "$account_uid" >&2
  exit 65
fi
IFS=: read -r account_name account_password account_record_uid account_record_gid \
  account_gecos account_home account_shell account_extra <<<"${account_records[0]}"
if [[ -n "${account_extra:-}" || -z "$account_name" \
  || "$account_record_uid" != "$account_uid" \
  || "$account_record_gid" != "$account_gid" \
  || "$account_home" != /* ]]; then
  printf '%s\n' 'operating-system account record is invalid for the current user' >&2
  exit 65
fi
account_home="$(realpath -m -s -- "$account_home")"

bin_dir="$account_home/.local/bin"
config_path="$account_home/.config/agent-platform/manager.toml"
unit_dir="$account_home/.config/systemd/user"
data_root="$account_home/.local/share/agent-platform"

asset="agent-platform-manager-linux-${architecture}"
[[ "$manifest_url" == https://* ]] || {
  printf 'release URL must use HTTPS: %s\n' "$manifest_url" >&2
  exit 65
}
if [[ "$manifest_url" == *$'\n'* || "$manifest_url" == *$'\r'* || "$manifest_url" == *'"'* || "$manifest_url" == *"'"* || "$manifest_url" == *'\'* ]]; then
  printf '%s\n' 'release URL contains unsupported characters' >&2
  exit 65
fi

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

runtime_root="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
stable_manager="$bin_dir/agent-platform-manager"
unit_name="agent-platform-manager.service"
unit_path="$unit_dir/$unit_name"
socket_path="$runtime_root/agent-platform-manager/manager.sock"

for path in "$bin_dir" "$unit_dir" "$runtime_root" "$stable_manager" "$unit_path" "$socket_path"; do
  [[ "$path" == /* ]] || {
    printf 'installation path must be absolute: %s\n' "$path" >&2
    exit 65
  }
done

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

temporary=""
manager_activated=0
manager_root_created=0
stable_installed=0
unit_installed=0
installation_owned=0
data_root_preexisting=0
install_lock_fd=""
config_incoming=""
manager_incoming=""
unit_incoming=""
created_directories=()
cleanup() {
  local status=$? index
  trap - EXIT
  if ((status != 0 && manager_activated == 0 && installation_owned == 1)); then
    if ((unit_installed)); then
      systemctl --user disable --now "$unit_name" >/dev/null 2>&1 || true
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
  [[ -z "$temporary" ]] || rm -rf --one-file-system -- "$temporary"
  exit "$status"
}
trap cleanup EXIT

# Bootstrap must execute on the account's installation filesystem, not an
# ambient temporary filesystem that may be mounted noexec. Never create a
# missing account home or publish bootstrap bytes at the stable Manager path.
if [[ ! -d "$account_home" ]]; then
  printf 'operating-system account home does not exist: %s\n' "$account_home" >&2
  exit 73
fi
ensure_owner_directory "$account_home"
temporary="$(mktemp -d "$account_home/.agent-platform-install.XXXXXXXXXX")"

download() {
  local output="$1" url="$2"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 4 \
    --connect-timeout 20 --max-time 600 --retry-max-time 600 \
    --output "$output" "$url"
}

# The validator is always bootstrapped from the installer's trusted release
# source, never from a caller-supplied manifest or artifact URL.
bootstrap_url="${default_manifest_url%/*}/$asset"
download "$temporary/$asset" "$bootstrap_url"
download "$temporary/$asset.sha256" "$bootstrap_url.sha256"
mapfile -t bootstrap_checksums < "$temporary/$asset.sha256"
if [[ "${#bootstrap_checksums[@]}" -ne 1 \
  || ! "${bootstrap_checksums[0]}" =~ ^([0-9a-f]{64})\ \ (.*)$ \
  || "${BASH_REMATCH[2]}" != "$asset" ]]; then
  printf '%s\n' 'bootstrap Manager checksum must contain one complete hash and the fixed asset filename' >&2
  exit 65
fi
bootstrap_sha="${BASH_REMATCH[1]}"
actual="$(sha256sum "$temporary/$asset")"
if [[ "${actual%% *}" != "$bootstrap_sha" ]]; then
  printf '%s\n' 'bootstrap Manager checksum mismatch' >&2
  exit 65
fi
chmod 0700 "$temporary/$asset"
download "$temporary/release.json" "$manifest_url"
# A direct command preserves failure status; process substitution would hide it.
"$temporary/$asset" inspect-release --manifest "$temporary/release.json" \
  --architecture "$architecture" > "$temporary/manifest-artifact"
mapfile -t manifest_artifact < "$temporary/manifest-artifact"
if [[ "${#manifest_artifact[@]}" -ne 2 ]]; then
  printf '%s\n' 'release manifest did not produce one bound Manager artifact' >&2
  exit 65
fi
manager_url="${manifest_artifact[0]}"
expected="${manifest_artifact[1]}"
if [[ "$expected" != "$bootstrap_sha" ]]; then
  download "$temporary/target-manager" "$manager_url"
  actual="$(sha256sum "$temporary/target-manager")"
  if [[ "${actual%% *}" != "$expected" ]]; then
    printf 'Manager checksum mismatch: expected %s, found %s\n' "$expected" "${actual%% *}" >&2
    exit 65
  fi
  mv "$temporary/target-manager" "$temporary/$asset"
  chmod 0700 "$temporary/$asset"
fi

# Serialize the entire fresh-install ownership decision. The lock is acquired
# only after the manifest has passed its closed-world validation, so an
# incompatible or malformed release still creates no installation path. The inode is
# retained deliberately; unlinking a flock file creates a split-lock race.
ensure_owner_directory "$runtime_root"
runtime_mode="$(stat -c '%a' "$runtime_root" 2>/dev/null || true)"
if [[ ! "$runtime_mode" =~ ^[0-7]{3,4}$ ]] \
  || (( (8#$runtime_mode & 077) != 0 )); then
  printf 'refusing a non-private runtime directory: %s\n' "$runtime_root" >&2
  exit 73
fi
install_lock="$runtime_root/agent-platform-install.lock"
if [[ -L "$install_lock" || ( -e "$install_lock" && ! -f "$install_lock" ) ]]; then
  printf '%s\n' 'refusing an unsafe fresh-install lock' >&2
  exit 73
fi
if ! exec {install_lock_fd}<>"$install_lock"; then
  printf '%s\n' 'cannot open the fresh-install lock' >&2
  exit 73
fi
lock_path_identity="$(stat -c '%d:%i:%u:%a:%h' -- "$install_lock" 2>/dev/null || true)"
lock_fd_identity="$(stat -Lc '%d:%i:%u:%a:%h' -- "/proc/$$/fd/$install_lock_fd" 2>/dev/null || true)"
IFS=: read -r lock_device lock_inode lock_uid lock_mode lock_links <<<"$lock_path_identity"
if [[ -L "$install_lock" || -z "$lock_path_identity" || "$lock_path_identity" != "$lock_fd_identity" \
  || ! -f "$install_lock" || "$lock_uid" != "$(id -u)" || "$lock_links" != 1 \
  || ! "$lock_mode" =~ ^[0-7]{3,4}$ ]] \
  || (( (8#$lock_mode & 077) != 0 )); then
  printf '%s\n' 'refusing an unsafe fresh-install lock' >&2
  exit 73
fi
if ! flock -n "$install_lock_fd"; then
  printf '%s\n' 'another Agent Platform installation is already running' >&2
  exit 75
fi

for path in "$config_path" "$stable_manager" "$unit_path" "$socket_path"; do
  if [[ -e "$path" || -L "$path" || -S "$path" ]]; then
    printf '%s\n' 'an Agent Platform installation already exists; use Manager update' >&2
    exit 73
  fi
done

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
installation_owned=1

if ((assume_yes == 0)); then
  if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
    printf '%s\n' 'interactive confirmation requires a controlling terminal; pass --yes for unattended installation' >&2
    exit 64
  fi
  printf 'Install the Agent Platform for user %s? [y/N] ' "$account_name" >/dev/tty
  read -r answer </dev/tty
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes || "$answer" == YES ]] || exit 0
fi

ensure_owner_directory "$bin_dir"
ensure_owner_directory "$(dirname "$config_path")"
ensure_owner_directory "$unit_dir"
ensure_owner_directory "$runtime_root"
ensure_owner_directory "$(dirname "$socket_path")"
ensure_owner_directory "$data_root"
manager_root_created=1
ensure_owner_directory "$data_root/manager"


config_incoming="$(mktemp "$(dirname "$config_path")/.manager.toml.XXXXXX")"
cat > "$config_incoming" <<EOF
data_root = "$data_root"
socket_path = "$socket_path"
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

manager_incoming="$(mktemp "$bin_dir/.agent-platform-manager.XXXXXX")"
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

unit_incoming="$(mktemp "$unit_dir/.agent-platform-manager.service.XXXXXX")"
cat > "$unit_incoming" <<EOF
[Unit]
Description=Agent Platform Manager
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
systemctl --user enable --now "$unit_name"
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
  && ! loginctl show-user "$account_name" -p Linger --value 2>/dev/null | grep -qx yes; then
  printf 'Warning: user lingering is disabled; run `loginctl enable-linger %s`.\n' "$account_name" >&2
fi

printf 'Agent Platform installed. Run: %s status\n' "$stable_manager"
