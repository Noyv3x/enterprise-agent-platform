#!/bin/sh
set -eu

fail() {
  printf 'ubitech sandbox entrypoint: %s\n' "$*" >&2
  exit 64
}

validate_id() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*) fail "$name must be a positive decimal integer" ;;
  esac
  [ "$value" -gt 0 ] 2>/dev/null || fail "$name must be greater than zero"
  [ "$value" -le 2147483647 ] 2>/dev/null || fail "$name exceeds the supported Linux id range"
}

[ "$(id -u)" -eq 0 ] || fail "startup identity must be root"

agent_uid="${UBITECH_AGENT_UID:-}"
agent_gid="${UBITECH_AGENT_GID:-}"
validate_id UBITECH_AGENT_UID "$agent_uid"
validate_id UBITECH_AGENT_GID "$agent_gid"

agent_entry="$(getent passwd agent || true)"
[ -n "$agent_entry" ] || fail "image account agent is missing"

uid_owner="$(awk -F: -v uid="$agent_uid" '$3 == uid && $1 != "agent" { print $1; exit }' /etc/passwd)"
[ -z "$uid_owner" ] || fail "requested UID $agent_uid already belongs to $uid_owner"

target_group="$(awk -F: -v gid="$agent_gid" '$3 == gid { print $1; exit }' /etc/group)"
if [ -z "$target_group" ]; then
  group_tmp="$(mktemp /etc/group.ubitech.XXXXXX)"
  if ! awk -F: -v OFS=: -v gid="$agent_gid" '
      $1 == "agent" { $3 = gid; found += 1 }
      { print }
      END { if (found != 1) exit 42 }
    ' /etc/group >"$group_tmp"; then
    rm -f -- "$group_tmp"
    fail "could not map the agent group"
  fi
  chown root:root "$group_tmp"
  chmod 0644 "$group_tmp"
  mv -f -- "$group_tmp" /etc/group
fi

passwd_tmp="$(mktemp /etc/passwd.ubitech.XXXXXX)"
if ! awk -F: -v OFS=: -v uid="$agent_uid" -v gid="$agent_gid" '
    $1 == "agent" { $3 = uid; $4 = gid; found += 1 }
    { print }
    END { if (found != 1) exit 42 }
  ' /etc/passwd >"$passwd_tmp"; then
  rm -f -- "$passwd_tmp"
  fail "could not map the agent account"
fi
chown root:root "$passwd_tmp"
chmod 0644 "$passwd_tmp"
mv -f -- "$passwd_tmp" /etc/passwd

for mount_root in /workspace /home/agent /opt/agent-env; do
  [ -d "$mount_root" ] || fail "$mount_root must be a directory"
  [ ! -L "$mount_root" ] || fail "$mount_root must not be a symbolic link"
  chown --no-dereference "$agent_uid:$agent_gid" "$mount_root"
  chmod 0700 "$mount_root"
done

[ "$#" -gt 0 ] || fail "no sandbox command was provided"
exec setpriv --reuid="$agent_uid" --regid="$agent_gid" --init-groups -- /usr/bin/tini -- "$@"
