#!/usr/bin/env bash
set -euo pipefail
umask 077

repository="${UBITECH_RELEASE_REPOSITORY:-Noyv3x/enterprise-agent-platform}"
default_channel_manifest_url="https://github.com/${repository}/releases/latest/download/release.json"
channel_manifest_url="${UBITECH_RELEASE_CHANNEL_MANIFEST_URL:-${UBITECH_RELEASE_MANIFEST_URL:-$default_channel_manifest_url}}"
manifest_url="${UBITECH_RELEASE_MANIFEST_URL:-$channel_manifest_url}"
manager_url="${UBITECH_MANAGER_URL:-}"
manager_checksum_url="${UBITECH_MANAGER_CHECKSUM_URL:-}"
manager_binary="${UBITECH_MANAGER_BINARY:-}"
manager_url_explicit=0
manager_checksum_url_explicit=0
manager_binary_explicit=0
if [[ -n "$manager_url" ]]; then manager_url_explicit=1; fi
if [[ -n "$manager_checksum_url" ]]; then manager_checksum_url_explicit=1; fi
if [[ -n "$manager_binary" ]]; then manager_binary_explicit=1; fi
config_path="${XDG_CONFIG_HOME:-$HOME/.config}/ubitech-agent/manager.toml"
data_root="${XDG_DATA_HOME:-$HOME/.local/share}/ubitech-agent"
listen="127.0.0.1:8080"
legacy_root=""
legacy_data=""
legacy_service="enterprise-agent-platform.service"
legacy_platform_url=""
legacy_update_id="${ENTERPRISE_AUTO_UPDATE_ID:-}"
expected_source_commit=""
assume_yes=0
migration_handoff_accepted=0
recovery_manager=""
repair_failed_handoff=0
recovery_marker_repaired=0
recovery_update_lock_fd=""

record_legacy_migration_exit() {
  local status=$?
  if (($#)); then
    status="$1"
  fi
  trap - EXIT
  if ((status != 0 && ! migration_handoff_accepted)) \
    && (( ! repair_failed_handoff || recovery_marker_repaired )) \
    && [[ -n "$legacy_root" && -n "$legacy_data" \
      && -n "$legacy_update_id" \
      && -f "$legacy_root/enterprise-agent-platform/enterprise_agent_platform/update_state.py" ]]; then
    local outcome="container_migration_failed"
    local error="Container migration installer failed with exit status ${status}; the source bridge remains available."
    if ((status == 75)); then
      outcome="container_migration_queued"
      error=""
    fi
    local python_bin="${PYTHON_BIN:-python3}"
    local source_python_path="$legacy_root/enterprise-agent-platform"
    if [[ -n "${PYTHONPATH:-}" ]]; then
      source_python_path="$source_python_path:$PYTHONPATH"
    fi
    if command -v "$python_bin" >/dev/null 2>&1; then
      ENTERPRISE_PLATFORM_DATA="$legacy_data" \
      ENTERPRISE_AUTO_UPDATE_ID="$legacy_update_id" \
      PYTHONPATH="$source_python_path" \
        "$python_bin" -m enterprise_agent_platform.update_state \
          container-migration-result --outcome "$outcome" --error "$error" \
          >/dev/null 2>&1 \
        || printf 'Warning: legacy container migration result could not be recorded.\n' >&2
    fi
  fi
  exit "$status"
}

trap record_legacy_migration_exit EXIT

usage() {
  cat <<'EOF'
Install the user-level ubitech agent manager.

Usage: ./install.sh [options]
  --manifest-url URL       bootstrap release manifest
  --release-manifest-url URL
                           alias for --manifest-url (bridge compatibility)
  --channel-manifest-url URL
                           persistent main-channel catalog (bootstrap may be an exact release)
  --manager-url URL        manager binary (defaults to latest release asset)
  --manager-checksum-url URL
                           SHA-256 sidecar for the manager binary
  --manager-binary PATH    use an already-built local manager binary
  --config PATH            manager.toml destination
  --data-root PATH         persistent data root
  --listen HOST:PORT       manager gateway listener
  --migrate-from PATH      migrate an existing source deployment
  --legacy-data PATH       active data directory of that source deployment
  --legacy-service NAME    user-systemd service of that source deployment
  --legacy-platform-url URL
                           authenticated loopback URL used during cutover
  --legacy-update-id ID    durable source update marker identity
  --expected-source-commit COMMIT
                           exact 40-character bridge HEAD required by the release
  --repair-failed-handoff  recover an exact frozen failed source handoff while
                           holding its repository update lock
  --yes                    do not prompt before installation
  -h, --help               show this help
EOF
}

while (($#)); do
  case "$1" in
    --manifest-url|--release-manifest-url) manifest_url="${2:?missing URL}"; shift 2 ;;
    --channel-manifest-url) channel_manifest_url="${2:?missing URL}"; shift 2 ;;
    --manager-url) manager_url="${2:?missing URL}"; manager_url_explicit=1; shift 2 ;;
    --manager-checksum-url) manager_checksum_url="${2:?missing URL}"; manager_checksum_url_explicit=1; shift 2 ;;
    --manager-binary) manager_binary="${2:?missing path}"; manager_binary_explicit=1; shift 2 ;;
    --config) config_path="${2:?missing path}"; shift 2 ;;
    --data-root) data_root="${2:?missing path}"; shift 2 ;;
    --listen) listen="${2:?missing listener}"; shift 2 ;;
    --migrate-from) legacy_root="${2:?missing path}"; assume_yes=1; shift 2 ;;
    --legacy-data) legacy_data="${2:?missing path}"; shift 2 ;;
    --legacy-service) legacy_service="${2:?missing name}"; shift 2 ;;
    --legacy-platform-url) legacy_platform_url="${2:?missing URL}"; shift 2 ;;
    --legacy-update-id) legacy_update_id="${2?missing id}"; shift 2 ;;
    --expected-source-commit) expected_source_commit="${2:?missing commit}"; shift 2 ;;
    --repair-failed-handoff) repair_failed_handoff=1; shift ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 64 ;;
  esac
done

if [[ -n "$legacy_root" || -n "$legacy_data" ]]; then
  if [[ -z "$legacy_root" || -z "$legacy_data" ]]; then
    printf '%s\n' '--migrate-from and --legacy-data must be provided together' >&2
    exit 64
  fi
  if [[ ! -d "$legacy_root" || ! -d "$legacy_data" ]]; then
    printf 'legacy source and data paths must both be existing directories\n' >&2
    exit 66
  fi
  legacy_root="$(cd "$legacy_root" && pwd -P)"
  legacy_data="$(cd "$legacy_data" && pwd -P)"
fi

if [[ -n "$legacy_root" ]]; then
  if [[ -z "$expected_source_commit" ]]; then
    command -v git >/dev/null || {
      printf '%s\n' 'git is required to bind a source migration to its bridge HEAD' >&2
      exit 69
    }
    expected_source_commit="$(git -C "$legacy_root" rev-parse HEAD)"
  fi
  if [[ ! "$expected_source_commit" =~ ^[0-9a-f]{40}$ ]]; then
    printf 'invalid expected source commit: %s\n' "$expected_source_commit" >&2
    exit 65
  fi
  if [[ ! "$legacy_service" =~ ^[A-Za-z0-9_@:.][A-Za-z0-9_.@:-]*\.service$ ]]; then
    printf 'invalid legacy user-systemd service name: %s\n' "$legacy_service" >&2
    exit 65
  fi
  if [[ -z "$legacy_platform_url" ]]; then
    printf '%s\n' '--legacy-platform-url is required with --migrate-from' >&2
    exit 64
  fi
  if [[ ! "$legacy_platform_url" =~ ^http://(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$ ]] \
    || ((10#${BASH_REMATCH[2]:-0} > 65535)); then
    printf 'legacy Platform URL must be an explicit loopback HTTP endpoint: %s\n' "$legacy_platform_url" >&2
    exit 65
  fi
fi
if [[ -z "$legacy_root" && -n "$expected_source_commit" ]]; then
  printf '%s\n' '--expected-source-commit is valid only with --migrate-from' >&2
  exit 64
fi
if ((repair_failed_handoff)) \
  && [[ -z "$legacy_root" || -z "$legacy_update_id" || -z "$expected_source_commit" ]]; then
  printf '%s\n' '--repair-failed-handoff requires --migrate-from, --legacy-update-id, and --expected-source-commit' >&2
  exit 64
fi
if ((repair_failed_handoff && ! manager_binary_explicit)) \
  && (( ! manager_url_explicit || ! manager_checksum_url_explicit )); then
  printf '%s\n' '--repair-failed-handoff requires an explicit recovery Manager URL and checksum URL from the verified installer release' >&2
  exit 64
fi
if ((repair_failed_handoff && ! manager_binary_explicit)); then
  if [[ "$manager_url" == *'/releases/latest/'* ]] \
    || [[ ! "$manager_url" =~ ^https://[^?#]+/releases/download/container-[0-9a-f]{40}/[^/?#]+$ ]] \
    || [[ "$manager_checksum_url" != "$manager_url.sha256" ]]; then
    printf '%s\n' '--repair-failed-handoff recovery Manager and checksum URLs must name one immutable container release' >&2
    exit 65
  fi
fi
if [[ -n "$legacy_update_id" ]] \
  && [[ ! "$legacy_update_id" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; then
  printf 'invalid legacy update id: %s\n' "$legacy_update_id" >&2
  exit 65
fi

for command in curl sha256sum install systemctl uname awk stat realpath id mktemp; do
  command -v "$command" >/dev/null || {
    printf 'required command is missing: %s\n' "$command" >&2
    exit 69
  }
done
if [[ -n "$legacy_root" ]]; then
  for command in git flock; do
    command -v "$command" >/dev/null || {
      printf 'required source migration command is missing: %s\n' "$command" >&2
      exit 69
    }
  done
fi

docker version >/dev/null 2>&1 || {
  printf 'Docker Engine is unavailable to the current user. Install Docker and grant this deployment user access first.\n' >&2
  exit 69
}
docker compose version >/dev/null 2>&1 || {
  printf 'Docker Compose v2 is required.\n' >&2
  exit 69
}
systemctl --user show-environment >/dev/null 2>&1 || {
  printf 'A working user-systemd session is required. Log in with a PAM/systemd session and retry.\n' >&2
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

for value in "$manifest_url" "$channel_manifest_url"; do
  [[ "$value" == https://* ]] || {
    printf 'release URLs must use HTTPS: %s\n' "$value" >&2
    exit 65
  }
done
if [[ -z "$manager_binary" ]]; then
  for value in "$manager_url" "$manager_checksum_url"; do
    [[ "$value" == https://* ]] || {
      printf 'release URLs must use HTTPS: %s\n' "$value" >&2
      exit 65
    }
  done
elif [[ ! -f "$manager_binary" || -L "$manager_binary" || ! -x "$manager_binary" ]]; then
  printf 'local manager is not an executable regular file: %s\n' "$manager_binary" >&2
  exit 66
fi
for value in "$config_path" "$data_root" "$listen" "$legacy_root" "$legacy_data" "$legacy_service" "$legacy_platform_url" "$legacy_update_id" "$expected_source_commit" "$manager_binary" "$manifest_url" "$channel_manifest_url" "$manager_url" "$manager_checksum_url"; do
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *'"'* || "$value" == *'\'* ]]; then
    printf 'unsupported control character or quote in installation value\n' >&2
    exit 65
  fi
done

if ((assume_yes == 0)); then
  printf 'Install ubitech-manager for user %s? [y/N] ' "${USER:-$(id -un)}"
  read -r answer
  [[ "$answer" == y || "$answer" == Y || "$answer" == yes || "$answer" == YES ]] || exit 0
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
retry_dir="$data_root/manager/control"
retry_script="$retry_dir/retry-source-migration.sh"
retry_bootstrap_script="$retry_dir/retry-install-source-migration.sh"
retry_installer="$retry_dir/install-source-migration.sh"
retry_service="$unit_dir/ubitech-agent-migrate.service"
retry_timer="$unit_dir/ubitech-agent-migrate.timer"
legacy_python=""
if [[ -n "$legacy_root" ]]; then
  legacy_python="$(command -v "${PYTHON_BIN:-python3}" || true)"
  if [[ -z "$legacy_python" || ! -x "$legacy_python" ]]; then
    printf '%s\n' 'source migration recovery requires an executable Python runtime' >&2
    exit 69
  fi
fi

acquire_failed_handoff_lock() {
  ((repair_failed_handoff)) || return 0
  if ! git -C "$legacy_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'failed handoff recovery requires a Git source checkout: %s\n' "$legacy_root" >&2
    exit 66
  fi
  recovery_update_lock_path="$(git -C "$legacy_root" rev-parse --git-path ubitech-agent-update.lock)"
  if [[ "$recovery_update_lock_path" != /* ]]; then
    recovery_update_lock_path="$legacy_root/$recovery_update_lock_path"
  fi
  exec {recovery_update_lock_fd}>"$recovery_update_lock_path"
  if ! flock -n "$recovery_update_lock_fd"; then
    printf '%s\n' 'another ubitech agent update or migration recovery is already in progress' >&2
    if [[ "${UBITECH_MIGRATION_RETRY_PERSISTED:-0}" == "1" ]]; then
      exit 75
    fi
    exit 73
  fi
  export ENTERPRISE_AUTO_UPDATE_LOCK_FD="$recovery_update_lock_fd"
  export ENTERPRISE_AUTO_UPDATE_LOCK_PATH="$recovery_update_lock_path"
  if ! actual_source_commit="$(git -C "$legacy_root" rev-parse HEAD)"; then
    printf '%s\n' 'failed handoff recovery could not read the frozen source HEAD' >&2
    exit 73
  fi
  if [[ "$actual_source_commit" != "$expected_source_commit" ]]; then
    printf 'frozen source checkout mismatch: expected %s, found %s\n' \
      "$expected_source_commit" "$actual_source_commit" >&2
    exit 73
  fi
  if ! source_worktree_status="$(git -C "$legacy_root" status --porcelain=v1 --untracked-files=all)"; then
    printf '%s\n' 'failed handoff recovery could not verify the frozen source worktree' >&2
    exit 73
  fi
  if [[ -n "$source_worktree_status" ]]; then
    printf '%s\n' 'failed handoff recovery requires a clean frozen source checkout' >&2
    exit 73
  fi
  if [[ ! -f "$legacy_root/enterprise-agent-platform/enterprise_agent_platform/update_state.py" ]]; then
    printf '%s\n' 'failed handoff recovery requires the frozen source state helper' >&2
    exit 66
  fi
}

repair_failed_source_marker() {
  ((repair_failed_handoff)) || return 0
  local source_python_path="$legacy_root/enterprise-agent-platform"
  if [[ -n "${PYTHONPATH:-}" ]]; then
    source_python_path="$source_python_path:$PYTHONPATH"
  fi
  if ! ENTERPRISE_PLATFORM_DATA="$legacy_data" \
    ENTERPRISE_AUTO_UPDATE_ID="$legacy_update_id" \
    PYTHONPATH="$source_python_path" \
      "$legacy_python" -m enterprise_agent_platform.update_state \
        recover-source-bridge --source-revision "$expected_source_commit" \
        --repair-failed; then
    printf '%s\n' 'failed container handoff marker does not match this exact recovery request' >&2
    exit 73
  fi
  recovery_marker_repaired=1
}

acquire_failed_handoff_lock

bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
unit_path="$unit_dir/ubitech-agent-manager.service"
stable_manager="$bin_dir/ubitech-manager"
control_socket="$data_root/manager/control/manager.sock"
manager_binary_state="$data_root/manager/manager-binaries.json"
operation_manager="$stable_manager"

for path in "$bin_dir" "$config_path" "$unit_dir" "$data_root"; do
  if [[ "$path" != /* ]]; then
    printf 'installation paths must be absolute: %s\n' "$path" >&2
    exit 65
  fi
done

manager_footprint=0
for path in "$unit_path" "$stable_manager" "$manager_binary_state" "$control_socket"; do
  if [[ -e "$path" || -L "$path" || -S "$path" ]]; then
    manager_footprint=1
  fi
done
existing_manager_active=0
if ((manager_footprint)); then
  if [[ -z "$legacy_root" ]]; then
    printf '%s\n' 'a Manager installation already exists; use the Manager update path instead of reinstalling it' >&2
    exit 73
  fi
  if [[ ! -f "$unit_path" || -L "$unit_path" ]] \
    || ! systemctl --user is-active --quiet ubitech-agent-manager.service; then
    printf '%s\n' 'an incomplete or inactive Manager installation already exists; refusing source migration recovery' >&2
    exit 73
  fi
  existing_manager_active=1
fi
if ((repair_failed_handoff && ! existing_manager_active)); then
  printf '%s\n' '--repair-failed-handoff requires the existing Manager service to be active' >&2
  exit 73
fi

ensure_owner_directory() {
  local directory="$1" lexical physical directory_mode
  lexical="$(realpath -m -s -- "$directory")"
  physical="$(realpath -m -- "$directory")"
  if [[ "$lexical" != "$physical" ]]; then
    printf 'refusing an installation path with a symlink component: %s\n' "$directory" >&2
    exit 73
  fi
  mkdir -p "$directory"
  directory_mode="$(stat -c '%a' "$directory" 2>/dev/null || true)"
  if [[ -L "$directory" || ! -d "$directory" ]] \
    || [[ "$(stat -c '%u' "$directory")" != "$(id -u)" ]] \
    || [[ ! "$directory_mode" =~ ^[0-7]{3,4}$ ]] \
    || (( (8#$directory_mode & 022) != 0 )); then
    printf 'refusing to use an unowned or non-directory installation path: %s\n' "$directory" >&2
    exit 73
  fi
}

ensure_owner_directory "$bin_dir"
ensure_owner_directory "$(dirname "$config_path")"
ensure_owner_directory "$unit_dir"
ensure_owner_directory "$data_root"
ensure_owner_directory "$data_root/manager"
ensure_owner_directory "$retry_dir"

cleanup_migration_retry() {
  systemctl --user disable --now ubitech-agent-migrate.timer >/dev/null 2>&1 || true
  rm -f "$retry_service" "$retry_timer" "$retry_script" "$retry_bootstrap_script" "$retry_installer"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

fsync_owner_paths() {
  local -a files=() directories=()
  local parsing_directories=0 path
  for path in "$@"; do
    if [[ "$path" == "--" ]]; then
      parsing_directories=1
    elif ((parsing_directories)); then
      directories+=("$path")
    else
      files+=("$path")
    fi
  done
  "$legacy_python" - "$(id -u)" "${files[@]}" -- "${directories[@]}" <<'PY'
import os
from pathlib import Path
import stat
import sys

owner = int(sys.argv[1])
separator = sys.argv.index("--", 2)
files = [Path(value) for value in sys.argv[2:separator]]
directories = [Path(value) for value in sys.argv[separator + 1 :]]
for path in files:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != owner:
            raise SystemExit(f"unsafe durable recovery file: {path}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
for path in directories:
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != owner:
            raise SystemExit(f"unsafe durable recovery directory: {path}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}

sync_migration_retry() {
  local retry_mode="${1:?missing retry mode}"
  local timer_wants_dir="$unit_dir/timers.target.wants"
  local timer_wants_link="$timer_wants_dir/ubitech-agent-migrate.timer"
  local -a durable_retry_files=(
    "$retry_service"
    "$retry_timer"
  )
  local -a durable_retry_dirs=(
    "$data_root"
    "$data_root/manager"
    "$retry_dir"
    "$unit_dir"
    "$timer_wants_dir"
  )
  ensure_owner_directory "$timer_wants_dir"
  case "$retry_mode" in
    bootstrap)
      durable_retry_files+=("$retry_installer" "$retry_bootstrap_script")
      ;;
    direct)
      durable_retry_files+=("$retry_script")
      ;;
    *)
      printf 'invalid migration retry mode: %s\n' "$retry_mode" >&2
      return 1
      ;;
  esac
  if [[ -n "$recovery_manager" ]]; then
    durable_retry_files+=("$recovery_manager")
    durable_retry_dirs+=("$(dirname "$recovery_manager")")
  fi
  fsync_owner_paths "${durable_retry_files[@]}" -- "${durable_retry_dirs[@]}"
  if ! systemctl --user is-enabled --quiet ubitech-agent-migrate.timer \
    || [[ ! -L "$timer_wants_link" ]] \
    || [[ "$(realpath -e -- "$timer_wants_link" 2>/dev/null || true)" != "$retry_timer" ]]; then
    printf '%s\n' 'migration retry timer was not durably enabled; refusing temporary handoff' >&2
    return 1
  fi
  # Persist the enable symlink itself, then prove it still names the unit that
  # was synchronized above. The second check closes a same-user replacement
  # race between fsync and the temporary handoff marker.
  fsync_owner_paths -- "$timer_wants_dir" "$unit_dir"
  if ! systemctl --user is-enabled --quiet ubitech-agent-migrate.timer \
    || [[ ! -L "$timer_wants_link" ]] \
    || [[ "$(realpath -e -- "$timer_wants_link" 2>/dev/null || true)" != "$retry_timer" ]]; then
    printf '%s\n' 'migration retry timer changed before handoff; refusing temporary handoff' >&2
    return 1
  fi
}

schedule_installer_retry() {
  [[ -n "$legacy_root" ]] || return 0
  ensure_owner_directory "$retry_dir"
  ensure_owner_directory "$unit_dir"
  for target in "$retry_script" "$retry_bootstrap_script" "$retry_installer" "$retry_service" "$retry_timer"; do
    if [[ -e "$target" || -L "$target" ]]; then
      retry_target_mode="$(stat -c '%a' "$target" 2>/dev/null || true)"
      if [[ ! -f "$target" || -L "$target" ]] \
        || [[ "$(stat -c '%u' "$target")" != "$(id -u)" ]] \
        || [[ ! "$retry_target_mode" =~ ^[0-7]{3,4}$ ]] \
        || (( (8#$retry_target_mode & 077) != 0 )); then
        printf 'refusing to replace an unsafe migration retry artifact: %s\n' "$target" >&2
        exit 73
      fi
    fi
  done
  retry_update_lock_path="$(git -C "$legacy_root" rev-parse --git-path ubitech-agent-update.lock)" || {
    printf '%s\n' 'could not resolve the frozen source update lock for retry' >&2
    exit 73
  }
  if [[ "$retry_update_lock_path" != /* ]]; then
    retry_update_lock_path="$legacy_root/$retry_update_lock_path"
  fi
  source_installer="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
  if [[ "$source_installer" != "$retry_installer" ]]; then
    retry_installer_incoming="$(mktemp "$retry_dir/.install-source-migration.XXXXXX")"
    install -m 0700 "$source_installer" "$retry_installer_incoming"
    mv -f "$retry_installer_incoming" "$retry_installer"
  fi
  printf -v quoted_installer '%q' "$retry_installer"
  printf -v quoted_manifest '%q' "$manifest_url"
  printf -v quoted_channel_manifest '%q' "$channel_manifest_url"
  printf -v quoted_manager_url '%q' "$manager_url"
  printf -v quoted_manager_checksum_url '%q' "$manager_checksum_url"
  printf -v quoted_config '%q' "$config_path"
  printf -v quoted_data_root '%q' "$data_root"
  printf -v quoted_listen '%q' "$listen"
  printf -v quoted_legacy_root '%q' "$legacy_root"
  printf -v quoted_legacy_data '%q' "$legacy_data"
  printf -v quoted_legacy_service '%q' "$legacy_service"
  printf -v quoted_legacy_platform_url '%q' "$legacy_platform_url"
  printf -v quoted_legacy_update_id '%q' "$legacy_update_id"
  printf -v quoted_legacy_python '%q' "$legacy_python"
  printf -v quoted_legacy_python_path '%q' "$legacy_root/enterprise-agent-platform"
  printf -v quoted_expected_source_commit '%q' "$expected_source_commit"
  printf -v quoted_retry_update_lock_path '%q' "$retry_update_lock_path"
  printf -v quoted_retry_service '%q' "$retry_service"
  printf -v quoted_retry_timer '%q' "$retry_timer"
  retry_repair_argument=""
  if ((repair_failed_handoff)); then
    retry_repair_argument="  --repair-failed-handoff"
  fi
  retry_manager_binary_argument=""
  if [[ -n "$recovery_manager" ]]; then
    printf -v quoted_recovery_bootstrap_manager '%q' "$recovery_manager"
    retry_manager_binary_argument="  --manager-binary $quoted_recovery_bootstrap_manager"
  fi
  retry_bootstrap_incoming="$(mktemp "$retry_dir/.retry-install-source-migration.XXXXXX")"
  cat > "$retry_bootstrap_incoming" <<EOF
#!/usr/bin/env bash
set -u
export ENTERPRISE_AUTO_UPDATE_ID=$quoted_legacy_update_id
export ENTERPRISE_PLATFORM_DATA=$quoted_legacy_data
export PYTHON_BIN=$quoted_legacy_python
export PYTHONPATH=$quoted_legacy_python_path
export UBITECH_MIGRATION_RETRY_PERSISTED=1
status=0
if (($repair_failed_handoff == 0)); then
  exec {update_lock_fd}>$quoted_retry_update_lock_path || exit 69
  if ! flock -n "\$update_lock_fd"; then
    printf 'Source update lock is busy; installer retry remains queued.\n' >&2
    exit 75
  fi
  export ENTERPRISE_AUTO_UPDATE_LOCK_FD="\$update_lock_fd"
  export ENTERPRISE_AUTO_UPDATE_LOCK_PATH=$quoted_retry_update_lock_path
  if ! actual_source_commit="\$(git -C $quoted_legacy_root rev-parse HEAD 2>/dev/null)"; then
    printf 'Frozen source HEAD is unreadable; refusing installer retry.\n' >&2
    exit 73
  fi
  if [[ "\$actual_source_commit" != $quoted_expected_source_commit ]]; then
    printf 'Frozen source checkout changed; refusing installer retry.\n' >&2
    exit 73
  fi
  if ! source_worktree_status="\$(git -C $quoted_legacy_root status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
    printf 'Frozen source worktree is unreadable; refusing installer retry.\n' >&2
    exit 73
  fi
  if [[ -n "\$source_worktree_status" ]]; then
    printf 'Frozen source worktree changed; refusing installer retry.\n' >&2
    exit 73
  fi
fi
installer_args=(
  --manifest-url $quoted_manifest
  --channel-manifest-url $quoted_channel_manifest
  --manager-url $quoted_manager_url
  --manager-checksum-url $quoted_manager_checksum_url
$retry_manager_binary_argument
  --config $quoted_config
  --data-root $quoted_data_root
  --listen $quoted_listen
  --migrate-from $quoted_legacy_root
  --legacy-data $quoted_legacy_data
  --legacy-service $quoted_legacy_service
  --legacy-platform-url $quoted_legacy_platform_url
  --legacy-update-id $quoted_legacy_update_id
  --expected-source-commit $quoted_expected_source_commit
$retry_repair_argument
  --yes
)
$quoted_installer "\${installer_args[@]}" || status=\$?
if ((status != 0 && status != 75)); then
  failure_committed=0
  if PYTHONPATH=$quoted_legacy_python_path \
    ENTERPRISE_PLATFORM_DATA=$quoted_legacy_data \
    ENTERPRISE_AUTO_UPDATE_ID=$quoted_legacy_update_id \
      $quoted_legacy_python - <<'PY' >/dev/null 2>&1
import os
from pathlib import Path
import stat

from enterprise_agent_platform.update_state import (
    read_state,
    state_path,
    update_state_lock,
)

data = os.environ["ENTERPRISE_PLATFORM_DATA"]
update_id = os.environ["ENTERPRISE_AUTO_UPDATE_ID"]

def matches() -> bool:
    state = read_state(data) or {}
    return (
        state.get("update_id") == update_id
        and state.get("state") == "idle"
        and state.get("phase") == "container_migration_failed"
    )

with update_state_lock(data):
    if not matches():
        raise SystemExit(1)
    marker = state_path(data)
    descriptor = os.open(marker, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise SystemExit(1)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    parent = Path(marker).parent
    descriptor = os.open(
        parent,
        os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW,
    )
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
            raise SystemExit(1)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if not matches():
        raise SystemExit(1)
PY
  then
    failure_committed=1
  fi
  if ((failure_committed)); then
    systemctl --user disable --now ubitech-agent-migrate.timer >/dev/null 2>&1 || true
    rm -f $quoted_retry_service $quoted_retry_timer
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  else
    printf 'Permanent migration result is not durable yet; retry remains installed.\n' >&2
  fi
fi
exit "\$status"
EOF
  chmod 0700 "$retry_bootstrap_incoming"
  mv -f "$retry_bootstrap_incoming" "$retry_bootstrap_script"
  retry_service_incoming="$(mktemp "$unit_dir/.ubitech-agent-migrate.service.XXXXXX")"
  cat > "$retry_service_incoming" <<EOF
[Unit]
Description=Retry ubitech agent source-to-container migration
After=ubitech-agent-manager.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart="$retry_bootstrap_script"
UMask=0077
EOF
  chmod 0600 "$retry_service_incoming"
  mv -f "$retry_service_incoming" "$retry_service"
  retry_timer_incoming="$(mktemp "$unit_dir/.ubitech-agent-migrate.timer.XXXXXX")"
  cat > "$retry_timer_incoming" <<'EOF'
[Unit]
Description=Retry ubitech agent migration when release artifacts become available

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
Persistent=true
Unit=ubitech-agent-migrate.service

[Install]
WantedBy=timers.target
EOF
  chmod 0600 "$retry_timer_incoming"
  mv -f "$retry_timer_incoming" "$retry_timer"
  systemctl --user daemon-reload
  systemctl --user enable --now ubitech-agent-migrate.timer
  sync_migration_retry bootstrap || exit 73
}

temporary="$(mktemp -d)"
cleanup_installer_exit() {
  local status=$?
  rm -rf "$temporary" || true
  record_legacy_migration_exit "$status"
}
trap cleanup_installer_exit EXIT

download_release_file() {
  local output="$1" url="$2"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 4 \
    --connect-timeout 20 --max-time 600 --retry-max-time 600 \
    --output "$output" "$url"
}

if [[ -n "$manager_binary" ]]; then
  install -m 0755 "$manager_binary" "$temporary/$asset"
else
  download_status=0
  download_release_file "$temporary/$asset" "$manager_url" || download_status=$?
  if ((download_status != 0)); then
    if [[ -n "$legacy_root" ]]; then
      schedule_installer_retry
      printf 'Docker release is not complete yet; source deployment remains active.\n' >&2
      exit 75
    fi
    exit "$download_status"
  fi
  download_status=0
  download_release_file "$temporary/$asset.sha256" "$manager_checksum_url" || download_status=$?
  if ((download_status != 0)); then
    if [[ -n "$legacy_root" ]]; then
      schedule_installer_retry
      printf 'Docker release metadata is not complete yet; source deployment remains active.\n' >&2
      exit 75
    fi
    exit "$download_status"
  fi
  expected="$(awk 'NR == 1 { print $1 }' "$temporary/$asset.sha256")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || {
    printf 'manager checksum sidecar is invalid\n' >&2
    exit 65
  }
  actual="$(sha256sum "$temporary/$asset" | awk '{ print $1 }')"
  [[ "$actual" == "$expected" ]] || {
    printf 'manager checksum mismatch: expected %s, found %s\n' "$expected" "$actual" >&2
    exit 65
  }
fi
manager_sha="$(sha256sum "$temporary/$asset" | awk '{ print $1 }')"

# The downloaded artifact must execute its own canonical config parser during
# preflight before it is allowed to replace the stable Manager binary.
chmod 0700 "$temporary/$asset"

if ((existing_manager_active)); then
  recovery_dir="$data_root/manager/recovery"
  ensure_owner_directory "$recovery_dir"
  chmod 0700 "$recovery_dir"
  recovery_manager="$recovery_dir/ubitech-manager-$manager_sha"
  if [[ -e "$recovery_manager" || -L "$recovery_manager" ]]; then
    recovery_mode="$(stat -c '%a' "$recovery_manager" 2>/dev/null || true)"
    if [[ ! -f "$recovery_manager" || -L "$recovery_manager" ]] \
      || [[ "$(stat -c '%u' "$recovery_manager")" != "$(id -u)" ]] \
      || [[ ! "$recovery_mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$recovery_mode & 077) != 0 )); then
      printf 'Manager recovery artifact path is unsafe: %s\n' "$recovery_manager" >&2
      exit 73
    fi
  fi
  if [[ ! -f "$recovery_manager" ]] \
    || [[ "$(sha256sum "$recovery_manager" | awk '{ print $1 }')" != "$manager_sha" ]]; then
    recovery_incoming="$(mktemp "$recovery_dir/.ubitech-manager.incoming.XXXXXX")"
    install -m 0700 "$temporary/$asset" "$recovery_incoming"
    if [[ "$(sha256sum "$recovery_incoming" | awk '{ print $1 }')" != "$manager_sha" ]]; then
      rm -f "$recovery_incoming"
      printf 'Manager recovery artifact failed verification\n' >&2
      exit 73
    fi
    mv -f "$recovery_incoming" "$recovery_manager"
  fi
  chmod 0700 "$recovery_manager"
  if [[ "$(sha256sum "$recovery_manager" | awk '{ print $1 }')" != "$manager_sha" ]]; then
    printf 'Manager recovery artifact changed after installation\n' >&2
    exit 73
  fi
  operation_manager="$recovery_manager"
fi

if [[ -L "$config_path" ]]; then
  printf 'refusing to use a symlinked manager config: %s\n' "$config_path" >&2
  exit 73
fi
if [[ ! -e "$config_path" ]]; then
  if ((repair_failed_handoff)); then
    printf 'failed handoff recovery requires the existing Manager config: %s\n' "$config_path" >&2
    exit 66
  fi
  config_incoming="$(mktemp "$(dirname "$config_path")/.manager.toml.XXXXXX")"
  cat > "$config_incoming" <<EOF
data_root = "$data_root"
listen = "$listen"
release_manifest_url = "$channel_manifest_url"
release_channel = "main"
update_enabled = true
update_interval = "5m"
sandbox_idle = "30m"
log_max_size = "20MiB"
log_max_files = 5
legacy_platform_gate_url = "$legacy_platform_url"
EOF
  chmod 0600 "$config_incoming"
  mv -f "$config_incoming" "$config_path"
elif [[ ! -f "$config_path" ]]; then
  printf 'refusing to use a non-regular manager config: %s\n' "$config_path" >&2
  exit 73
fi
config_mode="$(stat -c '%a' "$config_path" 2>/dev/null || true)"
if [[ "$(stat -c '%u' "$config_path")" != "$(id -u)" ]] \
  || [[ ! "$config_mode" =~ ^[0-7]{3,4}$ ]] \
  || (( (8#$config_mode & 077) != 0 )); then
  printf 'Manager config must be an owner-only file: %s\n' "$config_path" >&2
  exit 73
fi
config_identity="$(stat -Lc '%d:%i' "$config_path")"
config_sha="$(sha256sum "$config_path" | awk '{ print $1 }')"

preflight_args=(preflight --config "$config_path")
if [[ -n "$legacy_root" ]]; then
  control_socket="$data_root/manager/control/manager.sock"
  control_token_file="$data_root/manager/secrets/manager-token"
  preflight_args+=(
    --verify-source-migration-config
    --expect-data-root "$data_root"
    --expect-listen "$listen"
    --expect-release-manifest-url "$channel_manifest_url"
    --expect-release-channel main
    --expect-legacy-platform-url "$legacy_platform_url"
    --expect-control-socket "$control_socket"
    --expect-control-token-file "$control_token_file"
    --probe-user-systemd-transient
  )
fi
"$temporary/$asset" "${preflight_args[@]}"

if ((existing_manager_active)); then
  # A newer recovery CLI must never replace the file used by the still-running
  # authority. Restore that stable path to the exact Manager artifact named by
  # the frozen Platform manifest, then run the recovery CLI from a separate
  # owner-only path. This also repairs stable-path contamination left by older
  # installers that replaced the file before their CLI failed.
  authority_manifest="$temporary/authority-release.json"
  download_status=0
  download_release_file "$authority_manifest" "$manifest_url" || download_status=$?
  if ((download_status != 0)); then
    schedule_installer_retry
    printf 'Exact source migration release is not available yet; source deployment remains active.\n' >&2
    exit 75
  fi
  mapfile -t authority_fields < <(
    "$legacy_python" - "$authority_manifest" "$expected_source_commit" "$architecture" <<'PY'
import json
import re
import sys

path, expected_source, architecture = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest.get("schema_version") != 1:
    raise SystemExit("exact release manifest schema is unsupported")
if manifest.get("source_commit") != expected_source:
    raise SystemExit("exact release manifest does not match the frozen source revision")
artifact = manifest.get("manager", {}).get("artifacts", {}).get(architecture, {})
url = str(artifact.get("url") or "")
digest = str(artifact.get("sha256") or "")
if not url.startswith("https://") or any(ch in url for ch in "\r\n\"'"):
    raise SystemExit("exact Manager artifact URL is invalid")
if re.fullmatch(r"[0-9a-f]{64}", digest) is None:
    raise SystemExit("exact Manager artifact checksum is invalid")
print(url)
print(digest)
PY
  )
  if ((${#authority_fields[@]} != 2)); then
    printf 'Could not resolve the exact Manager rollback artifact.\n' >&2
    exit 65
  fi
  authority_url="${authority_fields[0]}"
  authority_sha="${authority_fields[1]}"
  authority_manager="$temporary/authority-$asset"
  download_status=0
  download_release_file "$authority_manager" "$authority_url" || download_status=$?
  if ((download_status != 0)); then
    schedule_installer_retry
    printf 'Exact Manager rollback artifact is not available yet; source deployment remains active.\n' >&2
    exit 75
  fi
  actual_authority_sha="$(sha256sum "$authority_manager" | awk '{ print $1 }')"
  if [[ "$actual_authority_sha" != "$authority_sha" ]]; then
    printf 'exact Manager checksum mismatch: expected %s, found %s\n' "$authority_sha" "$actual_authority_sha" >&2
    exit 65
  fi
  manager_fragment="$(systemctl --user show ubitech-agent-manager.service --property=FragmentPath --value)"
  manager_pid="$(systemctl --user show ubitech-agent-manager.service --property=MainPID --value)"
  manager_dropins="$(systemctl --user show ubitech-agent-manager.service --property=DropInPaths --value)"
  manager_execstart="$(systemctl --user show ubitech-agent-manager.service --property=ExecStart --value)"
  manager_unit_mode="$(stat -c '%a' "$unit_path" 2>/dev/null || true)"
  if [[ "$manager_fragment" != "$unit_path" ]] \
    || [[ -n "$manager_dropins" ]] \
    || [[ "$manager_execstart" != *"path=$stable_manager"* ]] \
    || [[ "$manager_execstart" != *"argv[]=$stable_manager serve --config $config_path"* ]] \
    || [[ "$(stat -c '%u' "$unit_path")" != "$(id -u)" ]] \
    || [[ ! "$manager_unit_mode" =~ ^[0-7]{3,4}$ ]] \
    || (( (8#$manager_unit_mode & 077) != 0 )) \
    || ! grep -Fxq "ExecStart=\"$stable_manager\" serve --config \"$config_path\"" "$unit_path"; then
    printf 'active Manager unit does not match the managed stable ExecStart; refusing recovery\n' >&2
    exit 73
  fi
  manager_unit_identity="$(stat -Lc '%d:%i' "$unit_path")"
  manager_unit_sha="$(sha256sum "$unit_path" | awk '{ print $1 }')"
  if [[ ! "$manager_pid" =~ ^[1-9][0-9]*$ ]] \
    || [[ ! -r "/proc/$manager_pid/exe" ]] \
    || [[ "$(stat -Lc '%u' "/proc/$manager_pid/exe")" != "$(id -u)" ]]; then
    printf 'active Manager process identity is unavailable; refusing recovery\n' >&2
    exit 73
  fi
  manager_starttime="$("$legacy_python" - "$manager_pid" <<'PY'
from pathlib import Path
import sys

raw = Path(f"/proc/{sys.argv[1]}/stat").read_text(encoding="ascii")
close = raw.rfind(")")
fields = raw[close + 2 :].split() if close >= 0 else []
if len(fields) < 20 or not fields[19].isdigit():
    raise SystemExit("active Manager process start time is unavailable")
print(fields[19])
PY
  )"
  running_sha="$(sha256sum "/proc/$manager_pid/exe" | awk '{ print $1 }')"
  if [[ "$running_sha" != "$authority_sha" ]]; then
    printf 'active Manager does not match the frozen release authority; refusing recovery\n' >&2
    exit 73
  fi
  manager_binary_state_present=0
  manager_binary_state_sha=""
  if [[ -e "$manager_binary_state" || -L "$manager_binary_state" ]]; then
    manager_binary_state_present=1
    manager_binary_state_mode="$(stat -c '%a' "$manager_binary_state" 2>/dev/null || true)"
    if [[ ! -f "$manager_binary_state" || -L "$manager_binary_state" ]] \
      || [[ "$(stat -c '%u' "$manager_binary_state")" != "$(id -u)" ]] \
      || [[ ! "$manager_binary_state_mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$manager_binary_state_mode & 077) != 0 )); then
      printf 'Manager self-update state is not an owner-controlled regular file; refusing recovery\n' >&2
      exit 73
    fi
    mapfile -t current_manager_fields < <(
      "$legacy_python" - "$manager_binary_state" <<'PY'
import json
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
with path.open("rb") as handle:
    raw = handle.read((8 << 20) + 1)
if len(raw) > 8 << 20:
    raise SystemExit("Manager self-update state exceeds 8 MiB")
state = json.loads(raw)
if state.get("schema_version") != 1:
    raise SystemExit("Manager self-update state schema is unsupported")
if state.get("activation") is not None:
    raise SystemExit("Manager activation is still pending")
current = state.get("current")
if not isinstance(current, dict):
    raise SystemExit("Manager self-update Current is missing")
current_path = str(current.get("path") or "")
current_sha = str(current.get("sha256") or "")
if not Path(current_path).is_absolute() or any(ch in current_path for ch in "\r\n"):
    raise SystemExit("Manager self-update Current path is invalid")
if re.fullmatch(r"[0-9a-f]{64}", current_sha) is None:
    raise SystemExit("Manager self-update Current checksum is invalid")
print(current_path)
print(current_sha)
PY
    )
    if ((${#current_manager_fields[@]} != 2)); then
      printf 'Manager self-update state is incomplete; refusing recovery\n' >&2
      exit 73
    fi
    current_manager_path="${current_manager_fields[0]}"
    current_manager_sha="${current_manager_fields[1]}"
    current_manager_mode="$(stat -c '%a' "$current_manager_path" 2>/dev/null || true)"
    if [[ "$current_manager_sha" != "$authority_sha" ]] \
      || [[ ! -f "$current_manager_path" || -L "$current_manager_path" ]] \
      || [[ "$(stat -c '%u' "$current_manager_path")" != "$(id -u)" ]] \
      || [[ ! "$current_manager_mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$current_manager_mode & 077) != 0 )) \
      || [[ "$(sha256sum "$current_manager_path" | awk '{ print $1 }')" != "$authority_sha" ]]; then
      printf 'Manager self-update Current does not match the frozen release authority; refusing recovery\n' >&2
      exit 73
    fi
    manager_binary_state_sha="$(sha256sum "$manager_binary_state" | awk '{ print $1 }')"
  fi
  if [[ ! -S "$control_socket" ]]; then
    schedule_installer_retry
    printf 'Active Manager control socket is not ready; source deployment remains active.\n' >&2
    exit 75
  fi
  if [[ "$(stat -c '%u' "$control_socket")" != "$(id -u)" ]]; then
    printf 'Active Manager control socket is not owned by the deployment user; refusing recovery\n' >&2
    exit 73
  fi
  control_socket_mode="$(stat -c '%a' "$control_socket" 2>/dev/null || true)"
  if [[ ! "$control_socket_mode" =~ ^[0-7]{3,4}$ ]] \
    || (( (8#$control_socket_mode & 077) != 0 )); then
    printf 'Active Manager control socket must be owner-only; refusing recovery\n' >&2
    exit 73
  fi
  stable_sha=""
  if [[ -e "$stable_manager" || -L "$stable_manager" ]]; then
    stable_mode="$(stat -c '%a' "$stable_manager" 2>/dev/null || true)"
    if [[ ! -f "$stable_manager" || -L "$stable_manager" ]] \
      || [[ "$(stat -c '%u' "$stable_manager")" != "$(id -u)" ]] \
      || [[ ! "$stable_mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$stable_mode & 022) != 0 )); then
      printf 'Manager stable path is not an owner-controlled regular file; refusing recovery\n' >&2
      exit 73
    fi
    stable_sha="$(sha256sum "$stable_manager" | awk '{ print $1 }')"
  fi
  if [[ "$stable_sha" != "$authority_sha" ]]; then
    authority_incoming="$(mktemp "$bin_dir/.ubitech-manager.authority.XXXXXX")"
    install -m 0755 "$authority_manager" "$authority_incoming"
    if [[ "$(sha256sum "$authority_incoming" | awk '{ print $1 }')" != "$authority_sha" ]]; then
      rm -f "$authority_incoming"
      printf 'restored Manager authority artifact failed verification\n' >&2
      exit 73
    fi
    mv -f "$authority_incoming" "$stable_manager"
  fi
  verified_pid="$(systemctl --user show ubitech-agent-manager.service --property=MainPID --value)"
  verified_starttime=""
  if [[ "$verified_pid" =~ ^[1-9][0-9]*$ ]]; then
    verified_starttime="$("$legacy_python" - "$verified_pid" <<'PY'
from pathlib import Path
import sys

raw = Path(f"/proc/{sys.argv[1]}/stat").read_text(encoding="ascii")
close = raw.rfind(")")
fields = raw[close + 2 :].split() if close >= 0 else []
if len(fields) < 20 or not fields[19].isdigit():
    raise SystemExit("active Manager process start time is unavailable")
print(fields[19])
PY
    )"
  fi
  if [[ "$verified_pid" != "$manager_pid" || "$verified_starttime" != "$manager_starttime" ]] \
    || ! systemctl --user is-active --quiet ubitech-agent-manager.service \
    || [[ "$(systemctl --user show ubitech-agent-manager.service --property=FragmentPath --value)" != "$manager_fragment" ]] \
    || [[ -n "$(systemctl --user show ubitech-agent-manager.service --property=DropInPaths --value)" ]] \
    || [[ "$(systemctl --user show ubitech-agent-manager.service --property=ExecStart --value)" != "$manager_execstart" ]] \
    || [[ "$(stat -Lc '%d:%i' "$unit_path")" != "$manager_unit_identity" ]] \
    || [[ "$(sha256sum "$unit_path" | awk '{ print $1 }')" != "$manager_unit_sha" ]] \
    || [[ "$(sha256sum "/proc/$verified_pid/exe" | awk '{ print $1 }')" != "$authority_sha" ]] \
    || { ((manager_binary_state_present)) \
      && { [[ "$(sha256sum "$manager_binary_state" | awk '{ print $1 }')" != "$manager_binary_state_sha" ]] \
        || [[ "$(sha256sum "$current_manager_path" | awk '{ print $1 }')" != "$authority_sha" ]]; }; } \
    || { (( ! manager_binary_state_present )) \
      && [[ -e "$manager_binary_state" || -L "$manager_binary_state" ]]; }; then
    printf 'active Manager changed while its rollback baseline was restored; retry after it stabilizes\n' >&2
    exit 73
  fi
else
  stable_incoming="$(mktemp "$bin_dir/.ubitech-manager.incoming.XXXXXX")"
  install -m 0755 "$temporary/$asset" "$stable_incoming"
  mv -f "$stable_incoming" "$stable_manager"

  unit_incoming="$(mktemp "$unit_dir/.ubitech-agent-manager.service.XXXXXX")"
  cat > "$unit_incoming" <<EOF
[Unit]
Description=ubitech agent manager
Documentation=https://github.com/${repository}
After=docker.service

[Service]
Type=simple
ExecStart="$bin_dir/ubitech-manager" serve --config "$config_path"
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

  systemctl --user daemon-reload
  systemctl --user enable --now ubitech-agent-manager.service
fi
if ((repair_failed_handoff)); then
  # Persist the exact recovery installer and content-addressed CLI before the
  # failed marker is reopened. A power loss after the state transition can
  # then resume with this client instead of falling back to the frozen CLI.
  schedule_installer_retry
  durable_recovery_files=(
    "$recovery_manager"
    "$stable_manager"
    "$config_path"
    "$unit_path"
    "$retry_installer"
    "$retry_bootstrap_script"
    "$retry_service"
    "$retry_timer"
  )
  if ((manager_binary_state_present)); then
    durable_recovery_files+=("$manager_binary_state" "$current_manager_path")
  fi
  durable_recovery_dirs=(
    "$recovery_dir"
    "$bin_dir"
    "$(dirname "$config_path")"
    "$unit_dir"
    "$unit_dir/timers.target.wants"
    "$retry_dir"
    "$data_root/manager"
  )
  fsync_owner_paths \
    "${durable_recovery_files[@]}" -- "${durable_recovery_dirs[@]}"
  retry_ready_pid="$(systemctl --user show ubitech-agent-manager.service --property=MainPID --value)"
  retry_ready_starttime=""
  if [[ "$retry_ready_pid" =~ ^[1-9][0-9]*$ ]]; then
    retry_ready_starttime="$("$legacy_python" - "$retry_ready_pid" <<'PY'
from pathlib import Path
import sys

raw = Path(f"/proc/{sys.argv[1]}/stat").read_text(encoding="ascii")
close = raw.rfind(")")
fields = raw[close + 2 :].split() if close >= 0 else []
if len(fields) < 20 or not fields[19].isdigit():
    raise SystemExit("active Manager process start time is unavailable")
print(fields[19])
PY
    )"
  fi
  if [[ "$retry_ready_pid" != "$manager_pid" || "$retry_ready_starttime" != "$manager_starttime" ]] \
    || ! systemctl --user is-active --quiet ubitech-agent-manager.service \
    || [[ "$(systemctl --user show ubitech-agent-manager.service --property=FragmentPath --value)" != "$manager_fragment" ]] \
    || [[ -n "$(systemctl --user show ubitech-agent-manager.service --property=DropInPaths --value)" ]] \
    || [[ "$(systemctl --user show ubitech-agent-manager.service --property=ExecStart --value)" != "$manager_execstart" ]] \
    || [[ "$(stat -c '%a' "$unit_path" 2>/dev/null || true)" != "$manager_unit_mode" ]] \
    || [[ "$(sha256sum "$stable_manager" | awk '{ print $1 }')" != "$authority_sha" ]] \
    || [[ "$(stat -c '%u' "$stable_manager")" != "$(id -u)" ]] \
    || (( (8#$(stat -c '%a' "$stable_manager") & 022) != 0 )) \
    || [[ "$(sha256sum "/proc/$retry_ready_pid/exe" | awk '{ print $1 }')" != "$authority_sha" ]] \
    || [[ "$(stat -c '%u' "$control_socket")" != "$(id -u)" ]] \
    || (( (8#$(stat -c '%a' "$control_socket") & 077) != 0 )) \
    || [[ "$(stat -Lc '%d:%i' "$unit_path")" != "$manager_unit_identity" ]] \
    || [[ "$(sha256sum "$unit_path" | awk '{ print $1 }')" != "$manager_unit_sha" ]] \
    || { ((manager_binary_state_present)) \
      && { [[ "$(stat -c '%a' "$manager_binary_state" 2>/dev/null || true)" != "$manager_binary_state_mode" ]] \
        || [[ "$(stat -c '%u' "$manager_binary_state")" != "$(id -u)" ]] \
        || [[ "$(sha256sum "$manager_binary_state" | awk '{ print $1 }')" != "$manager_binary_state_sha" ]] \
        || [[ "$(stat -c '%a' "$current_manager_path" 2>/dev/null || true)" != "$current_manager_mode" ]] \
        || [[ "$(sha256sum "$current_manager_path" | awk '{ print $1 }')" != "$authority_sha" ]]; }; } \
    || { (( ! manager_binary_state_present )) \
      && [[ -e "$manager_binary_state" || -L "$manager_binary_state" ]]; }; then
    printf 'active Manager changed while durable recovery was installed; failed marker remains frozen\n' >&2
    exit 73
  fi
fi
current_config_mode="$(stat -c '%a' "$config_path" 2>/dev/null || true)"
if [[ ! -f "$config_path" || -L "$config_path" ]] \
  || [[ "$(stat -c '%u' "$config_path")" != "$(id -u)" ]] \
  || [[ ! "$current_config_mode" =~ ^[0-7]{3,4}$ ]] \
  || (( (8#$current_config_mode & 077) != 0 )) \
  || [[ "$(stat -Lc '%d:%i' "$config_path")" != "$config_identity" ]] \
  || [[ "$(sha256sum "$config_path" | awk '{ print $1 }')" != "$config_sha" ]]; then
  printf 'Manager config changed after preflight; refusing installation\n' >&2
  exit 73
fi
repair_failed_source_marker
install_args=(install --config "$config_path" --release-manifest-url "$manifest_url")
if [[ -n "$legacy_root" ]]; then
  install_args+=(
    --legacy-root "$legacy_root"
    --legacy-data "$legacy_data"
    --legacy-service "$legacy_service"
    --expected-source-commit "$expected_source_commit"
  )
fi
operation_status=0
"$operation_manager" "${install_args[@]}" || operation_status=$?
if ((operation_status != 0)); then
  if ((operation_status == 75)) && [[ -n "$legacy_root" ]]; then
    ensure_owner_directory "$retry_dir"
    ensure_owner_directory "$unit_dir"
    for target in "$retry_script" "$retry_bootstrap_script" "$retry_installer" "$retry_service" "$retry_timer"; do
      if [[ -e "$target" || -L "$target" ]]; then
        retry_target_mode="$(stat -c '%a' "$target" 2>/dev/null || true)"
        if [[ ! -f "$target" || -L "$target" ]] \
          || [[ "$(stat -c '%u' "$target")" != "$(id -u)" ]] \
          || [[ ! "$retry_target_mode" =~ ^[0-7]{3,4}$ ]] \
          || (( (8#$retry_target_mode & 077) != 0 )); then
          printf 'refusing to replace an unsafe migration retry artifact: %s\n' "$target" >&2
          exit 73
        fi
      fi
    done
    printf -v quoted_manager '%q' "$operation_manager"
    printf -v quoted_config '%q' "$config_path"
    printf -v quoted_manifest '%q' "$manifest_url"
    printf -v quoted_legacy_root '%q' "$legacy_root"
    printf -v quoted_legacy_data '%q' "$legacy_data"
    printf -v quoted_legacy_service '%q' "$legacy_service"
    printf -v quoted_legacy_update_id '%q' "$legacy_update_id"
    printf -v quoted_legacy_python '%q' "$legacy_python"
    printf -v quoted_legacy_python_path '%q' "$legacy_root/enterprise-agent-platform"
    printf -v quoted_expected_source_commit '%q' "$expected_source_commit"
    printf -v quoted_retry_script '%q' "$retry_script"
    printf -v quoted_retry_installer '%q' "$retry_installer"
    printf -v quoted_retry_bootstrap_script '%q' "$retry_bootstrap_script"
    printf -v quoted_retry_service '%q' "$retry_service"
    printf -v quoted_retry_timer '%q' "$retry_timer"
    printf -v quoted_recovery_manager '%q' "$recovery_manager"
    direct_update_lock_path="$(git -C "$legacy_root" rev-parse --git-path ubitech-agent-update.lock)"
    if [[ "$direct_update_lock_path" != /* ]]; then
      direct_update_lock_path="$legacy_root/$direct_update_lock_path"
    fi
    printf -v quoted_direct_update_lock_path '%q' "$direct_update_lock_path"
    retry_script_incoming="$(mktemp "$retry_dir/.retry-source-migration.XXXXXX")"
    cat > "$retry_script_incoming" <<EOF
#!/usr/bin/env bash
set -u
export ENTERPRISE_AUTO_UPDATE_ID=$quoted_legacy_update_id
export ENTERPRISE_PLATFORM_DATA=$quoted_legacy_data
status=0
exec {update_lock_fd}>$quoted_direct_update_lock_path || exit 69
if ! flock -n "\$update_lock_fd"; then
  printf 'Source update lock is busy; migration retry remains queued.\n' >&2
  exit 75
fi
export ENTERPRISE_AUTO_UPDATE_LOCK_FD="\$update_lock_fd"
export ENTERPRISE_AUTO_UPDATE_LOCK_PATH=$quoted_direct_update_lock_path
if ! actual_source_commit="\$(git -C $quoted_legacy_root rev-parse HEAD 2>/dev/null)"; then
  printf 'Frozen source HEAD is unreadable; refusing migration retry.\n' >&2
  status=73
elif [[ "\$actual_source_commit" != $quoted_expected_source_commit ]]; then
  printf 'Frozen source checkout changed; refusing migration retry.\n' >&2
  status=73
fi
source_worktree_status=""
if ((status == 0)); then
  if ! source_worktree_status="\$(git -C $quoted_legacy_root status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
    printf 'Frozen source worktree is unreadable; refusing migration retry.\n' >&2
    status=73
  elif [[ -n "\$source_worktree_status" ]]; then
    printf 'Frozen source worktree changed; refusing migration retry.\n' >&2
    status=73
  fi
fi
marker_phase=""
if ((status == 0)); then
  marker_phase="\$(PYTHONPATH=$quoted_legacy_python_path \\
    $quoted_legacy_python - $quoted_legacy_update_id $quoted_expected_source_commit <<'PY'
import os
import sys

from enterprise_agent_platform.update_state import read_state

update_id, revision = sys.argv[1:]
state = read_state(os.environ["ENTERPRISE_PLATFORM_DATA"]) or {}
existing_revision = str(state.get("source_revision") or state.get("target_revision") or "")
phase = str(state.get("phase") or "")
status = str(state.get("state") or "")
allowed = (
    (status == "waiting_for_tasks" and phase == "source_bridge_ready")
    or (
        status == "idle"
        and phase in {"container_migration_queued", "container_migration_failed"}
    )
)
if str(state.get("update_id") or "") != update_id or existing_revision != revision or not allowed:
    raise SystemExit("source migration marker changed")
print(phase)
PY
  )" || status=73
fi
if ((status == 0)) && [[ "\$marker_phase" == container_migration_failed ]]; then
  PYTHONPATH=$quoted_legacy_python_path \\
    $quoted_legacy_python -m enterprise_agent_platform.update_state \\
      recover-source-bridge --source-revision $quoted_expected_source_commit \\
      --repair-failed || status=73
fi
if ((status == 0)); then
  $quoted_manager install \\
    --config $quoted_config \\
    --release-manifest-url $quoted_manifest \\
    --legacy-root $quoted_legacy_root \\
    --legacy-data $quoted_legacy_data \\
    --legacy-service $quoted_legacy_service \\
    --expected-source-commit $quoted_expected_source_commit || status=\$?
fi
if ((status == 0)); then
  systemctl --user disable --now ubitech-agent-migrate.timer >/dev/null 2>&1 || true
  rm -f $quoted_retry_service $quoted_retry_timer
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -f $quoted_retry_script $quoted_retry_bootstrap_script $quoted_retry_installer
  if [[ -n $quoted_recovery_manager ]]; then rm -f $quoted_recovery_manager; fi
elif ((status != 75)); then
  failure_recorded=0
  if [[ -n $quoted_legacy_update_id && -x $quoted_legacy_python ]]; then
    PYTHONPATH=$quoted_legacy_python_path \
      $quoted_legacy_python -m enterprise_agent_platform.update_state \
        container-migration-result --outcome container_migration_failed \
        --error "Container migration retry failed with exit status \${status}; the source bridge remains available." \
        >/dev/null 2>&1 \
      && failure_recorded=1 \
      || printf 'Warning: permanent migration retry failure could not be recorded; durable retry remains installed.\n' >&2
  fi
  if ((failure_recorded)); then
    systemctl --user disable --now ubitech-agent-migrate.timer >/dev/null 2>&1 || true
    rm -f $quoted_retry_service $quoted_retry_timer
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
fi
exit "\$status"
EOF
    chmod 0700 "$retry_script_incoming"
    mv -f "$retry_script_incoming" "$retry_script"
    retry_service_incoming="$(mktemp "$unit_dir/.ubitech-agent-migrate.service.XXXXXX")"
    cat > "$retry_service_incoming" <<EOF
[Unit]
Description=Retry ubitech agent source-to-container migration
After=ubitech-agent-manager.service
Requires=ubitech-agent-manager.service

[Service]
Type=oneshot
ExecStart="$retry_script"
UMask=0077
EOF
    chmod 0600 "$retry_service_incoming"
    mv -f "$retry_service_incoming" "$retry_service"
    retry_timer_incoming="$(mktemp "$unit_dir/.ubitech-agent-migrate.timer.XXXXXX")"
    cat > "$retry_timer_incoming" <<'EOF'
[Unit]
Description=Retry ubitech agent migration when release artifacts become available

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
Persistent=true
Unit=ubitech-agent-migrate.service

[Install]
WantedBy=timers.target
EOF
    chmod 0600 "$retry_timer_incoming"
    mv -f "$retry_timer_incoming" "$retry_timer"
    systemctl --user daemon-reload
    systemctl --user enable --now ubitech-agent-migrate.timer
    sync_migration_retry direct || exit 73
    printf 'Docker release is not complete yet; source deployment remains active.\n' >&2
  fi
  if ((operation_status != 75 && repair_failed_handoff)); then
    migration_error="Container migration installer failed with exit status ${operation_status}; the source bridge remains available."
    source_python_path="$legacy_root/enterprise-agent-platform${PYTHONPATH:+:$PYTHONPATH}"
    if ENTERPRISE_PLATFORM_DATA="$legacy_data" \
      ENTERPRISE_AUTO_UPDATE_ID="$legacy_update_id" \
      PYTHONPATH="$source_python_path" \
        "$legacy_python" -m enterprise_agent_platform.update_state \
          container-migration-result --outcome container_migration_failed \
          --error "$migration_error"; then
      cleanup_migration_retry
    else
      printf 'Warning: permanent migration failure could not be recorded; durable recovery remains installed.\n' >&2
    fi
    # This path has performed the ordered marker attempt itself. Suppress the
    # EXIT fallback so a failed write cannot be mistaken for safe cleanup.
    migration_handoff_accepted=1
  fi
  exit "$operation_status"
fi
migration_handoff_accepted=1

if [[ -n "$legacy_root" ]]; then
  cleanup_migration_retry
  if [[ -n "$recovery_manager" ]]; then
    rm -f "$recovery_manager"
  fi
fi

if command -v loginctl >/dev/null && ! loginctl show-user "${USER:-$(id -un)}" -p Linger --value 2>/dev/null | grep -qx yes; then
  printf 'Warning: user lingering is disabled; run `loginctl enable-linger %s` if the service must start before login.\n' "${USER:-$(id -un)}" >&2
fi

printf 'ubitech agent manager installed. Run: %s status\n' "$bin_dir/ubitech-manager"
