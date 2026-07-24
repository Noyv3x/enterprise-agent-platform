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
config_path="${XDG_CONFIG_HOME:-$HOME/.config}/ubitech-agent/manager.toml"
data_root="${XDG_DATA_HOME:-$HOME/.local/share}/ubitech-agent"
listen="127.0.0.1:8080"
legacy_root=""
legacy_data=""
legacy_service="enterprise-agent-platform.service"
legacy_platform_url=""
expected_source_commit=""
assume_yes=0

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
  --expected-source-commit COMMIT
                           exact 40-character bridge HEAD required by the release
  --yes                    do not prompt before installation
  -h, --help               show this help
EOF
}

while (($#)); do
  case "$1" in
    --manifest-url|--release-manifest-url) manifest_url="${2:?missing URL}"; shift 2 ;;
    --channel-manifest-url) channel_manifest_url="${2:?missing URL}"; shift 2 ;;
    --manager-url) manager_url="${2:?missing URL}"; shift 2 ;;
    --manager-checksum-url) manager_checksum_url="${2:?missing URL}"; shift 2 ;;
    --manager-binary) manager_binary="${2:?missing path}"; shift 2 ;;
    --config) config_path="${2:?missing path}"; shift 2 ;;
    --data-root) data_root="${2:?missing path}"; shift 2 ;;
    --listen) listen="${2:?missing listener}"; shift 2 ;;
    --migrate-from) legacy_root="${2:?missing path}"; assume_yes=1; shift 2 ;;
    --legacy-data) legacy_data="${2:?missing path}"; shift 2 ;;
    --legacy-service) legacy_service="${2:?missing name}"; shift 2 ;;
    --legacy-platform-url) legacy_platform_url="${2:?missing URL}"; shift 2 ;;
    --expected-source-commit) expected_source_commit="${2:?missing commit}"; shift 2 ;;
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

for command in curl sha256sum install systemctl uname awk; do
  command -v "$command" >/dev/null || {
    printf 'required command is missing: %s\n' "$command" >&2
    exit 69
  }
done

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
for value in "$config_path" "$data_root" "$listen" "$legacy_root" "$legacy_data" "$legacy_service" "$legacy_platform_url" "$expected_source_commit" "$manager_binary" "$manifest_url" "$channel_manifest_url" "$manager_url" "$manager_checksum_url"; do
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

cleanup_migration_retry() {
  systemctl --user disable --now ubitech-agent-migrate.timer >/dev/null 2>&1 || true
  rm -f "$retry_service" "$retry_timer" "$retry_script" "$retry_bootstrap_script" "$retry_installer"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

schedule_installer_retry() {
  [[ -n "$legacy_root" ]] || return 0
  mkdir -p "$retry_dir" "$unit_dir"
  source_installer="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
  if [[ "$source_installer" != "$retry_installer" ]]; then
    install -m 0700 "$source_installer" "$retry_installer"
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
  printf -v quoted_expected_source_commit '%q' "$expected_source_commit"
  printf -v quoted_retry_service '%q' "$retry_service"
  printf -v quoted_retry_timer '%q' "$retry_timer"
  cat > "$retry_bootstrap_script" <<EOF
#!/usr/bin/env bash
set -u
status=0
$quoted_installer \\
  --manifest-url $quoted_manifest \\
  --channel-manifest-url $quoted_channel_manifest \\
  --manager-url $quoted_manager_url \\
  --manager-checksum-url $quoted_manager_checksum_url \\
  --config $quoted_config \\
  --data-root $quoted_data_root \\
  --listen $quoted_listen \\
  --migrate-from $quoted_legacy_root \\
  --legacy-data $quoted_legacy_data \\
  --legacy-service $quoted_legacy_service \\
  --legacy-platform-url $quoted_legacy_platform_url \\
  --expected-source-commit $quoted_expected_source_commit \\
  --yes || status=\$?
if ((status != 0 && status != 75)); then
  systemctl --user disable --now ubitech-agent-migrate.timer >/dev/null 2>&1 || true
  rm -f $quoted_retry_service $quoted_retry_timer
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
exit "\$status"
EOF
  chmod 0700 "$retry_bootstrap_script"
  cat > "$retry_service" <<EOF
[Unit]
Description=Retry ubitech agent source-to-container migration
After=ubitech-agent-manager.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart="$retry_bootstrap_script"
UMask=0077
EOF
  cat > "$retry_timer" <<'EOF'
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
  chmod 0600 "$retry_service" "$retry_timer"
  systemctl --user daemon-reload
  systemctl --user enable --now ubitech-agent-migrate.timer
}

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
if [[ -n "$manager_binary" ]]; then
  install -m 0755 "$manager_binary" "$temporary/$asset"
else
  download_status=0
  curl --fail --location --proto '=https' --tlsv1.2 --retry 4 \
    --output "$temporary/$asset" "$manager_url" || download_status=$?
  if ((download_status != 0)); then
    if [[ -n "$legacy_root" ]]; then
      schedule_installer_retry
      printf 'Docker release is not complete yet; source deployment remains active.\n' >&2
      exit 75
    fi
    exit "$download_status"
  fi
  download_status=0
  curl --fail --location --proto '=https' --tlsv1.2 --retry 4 \
    --output "$temporary/$asset.sha256" "$manager_checksum_url" || download_status=$?
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

# The downloaded artifact must execute its own canonical config parser during
# preflight before it is allowed to replace the stable Manager binary.
chmod 0700 "$temporary/$asset"

bin_dir="${XDG_BIN_HOME:-$HOME/.local/bin}"
mkdir -p "$bin_dir" "$(dirname "$config_path")" "$unit_dir" "$data_root"

if [[ ! -e "$config_path" ]]; then
  cat > "$config_path" <<EOF
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
  chmod 0600 "$config_path"
elif [[ ! -f "$config_path" || -L "$config_path" ]]; then
  printf 'refusing to use a non-regular manager config: %s\n' "$config_path" >&2
  exit 73
fi

preflight_args=(preflight --config "$config_path")
if [[ -n "$legacy_root" ]]; then
  control_socket="$data_root/manager/control/manager.sock"
  preflight_args+=(
    --verify-source-migration-config
    --expect-data-root "$data_root"
    --expect-listen "$listen"
    --expect-release-manifest-url "$channel_manifest_url"
    --expect-release-channel main
    --expect-legacy-platform-url "$legacy_platform_url"
    --expect-control-socket "$control_socket"
    --probe-user-systemd-transient
  )
fi
"$temporary/$asset" "${preflight_args[@]}"

install -m 0755 "$temporary/$asset" "$bin_dir/.ubitech-manager.incoming"
mv -f "$bin_dir/.ubitech-manager.incoming" "$bin_dir/ubitech-manager"

unit_path="$unit_dir/ubitech-agent-manager.service"
cat > "$unit_path" <<EOF
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
chmod 0600 "$unit_path"

systemctl --user daemon-reload
systemctl --user enable --now ubitech-agent-manager.service
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
"$bin_dir/ubitech-manager" "${install_args[@]}" || operation_status=$?
if ((operation_status != 0)); then
  if ((operation_status == 75)) && [[ -n "$legacy_root" ]]; then
    mkdir -p "$retry_dir"
    printf -v quoted_manager '%q' "$bin_dir/ubitech-manager"
    printf -v quoted_config '%q' "$config_path"
    printf -v quoted_manifest '%q' "$manifest_url"
    printf -v quoted_legacy_root '%q' "$legacy_root"
    printf -v quoted_legacy_data '%q' "$legacy_data"
    printf -v quoted_legacy_service '%q' "$legacy_service"
    printf -v quoted_expected_source_commit '%q' "$expected_source_commit"
    printf -v quoted_retry_script '%q' "$retry_script"
    printf -v quoted_retry_installer '%q' "$retry_installer"
    printf -v quoted_retry_bootstrap_script '%q' "$retry_bootstrap_script"
    printf -v quoted_retry_service '%q' "$retry_service"
    printf -v quoted_retry_timer '%q' "$retry_timer"
    cat > "$retry_script" <<EOF
#!/usr/bin/env bash
set -u
status=0
$quoted_manager install \\
  --config $quoted_config \\
  --release-manifest-url $quoted_manifest \\
  --legacy-root $quoted_legacy_root \\
  --legacy-data $quoted_legacy_data \\
  --legacy-service $quoted_legacy_service \\
  --expected-source-commit $quoted_expected_source_commit || status=\$?
if ((status == 0)); then
  systemctl --user disable --now ubitech-agent-migrate.timer >/dev/null 2>&1 || true
  rm -f $quoted_retry_service $quoted_retry_timer
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  rm -f $quoted_retry_script $quoted_retry_bootstrap_script $quoted_retry_installer
elif ((status != 75)); then
  systemctl --user disable --now ubitech-agent-migrate.timer >/dev/null 2>&1 || true
  rm -f $quoted_retry_service $quoted_retry_timer
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi
exit "\$status"
EOF
    chmod 0700 "$retry_script"
    cat > "$retry_service" <<EOF
[Unit]
Description=Retry ubitech agent source-to-container migration
After=ubitech-agent-manager.service
Requires=ubitech-agent-manager.service

[Service]
Type=oneshot
ExecStart="$retry_script"
UMask=0077
EOF
    cat > "$retry_timer" <<'EOF'
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
    chmod 0600 "$retry_service" "$retry_timer"
    systemctl --user daemon-reload
    systemctl --user enable --now ubitech-agent-migrate.timer
    printf 'Docker release is not complete yet; source deployment remains active.\n' >&2
  fi
  exit "$operation_status"
fi

if [[ -n "$legacy_root" ]]; then
  cleanup_migration_retry
fi

if command -v loginctl >/dev/null && ! loginctl show-user "${USER:-$(id -un)}" -p Linger --value 2>/dev/null | grep -qx yes; then
  printf 'Warning: user lingering is disabled; run `loginctl enable-linger %s` if the service must start before login.\n' "${USER:-$(id -un)}" >&2
fi

printf 'ubitech agent manager installed. Run: %s status\n' "$bin_dir/ubitech-manager"
