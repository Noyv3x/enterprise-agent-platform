#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail() {
  printf 'container validation failed: %s\n' "$*" >&2
  exit 1
}

command -v grep >/dev/null 2>&1 || fail "portable grep is required"

for path in \
  containers/platform.Dockerfile \
  containers/agent-runtime.Dockerfile \
  containers/camofox.Dockerfile \
  containers/agent-sandbox.Dockerfile \
  containers/agent-sandbox-entrypoint.sh \
  containers/compose.yaml \
  containers/compose.dev.yaml \
  containers/release-manifest.schema.json \
  install.sh; do
  [[ -s "$path" ]] || fail "$path is missing or empty"
done

bash -n install.sh
grep -Fq 'bash -s -- --yes' README.md \
  || fail "README fresh-install command does not pass explicit non-interactive consent"
grep -Fq -- '--title "Agent Platform ${SOURCE_COMMIT:0:12}"' .github/workflows/container-release.yml \
  || fail "container release title is not deployment-neutral"
for excluded in \
  'enterprise-agent-platform/build/' \
  'enterprise-agent-platform/dist/' \
  'enterprise-agent-platform/*.egg-info/' \
  'enterprise-agent-platform/**/__pycache__/' \
  'enterprise-agent-platform/**/*.pyc' \
  'enterprise-agent-platform/.venv/' \
  'enterprise-agent-platform/enterprise_agent_platform/static/'; do
  grep -Fxq "$excluded" containers/platform.Dockerfile.dockerignore \
    || fail "Platform image context can include local build residue: $excluded"
done
if grep -Fxq 'COPY enterprise-agent-platform .' containers/platform.Dockerfile; then
  fail "Platform Python build copies the whole mixed-language source tree"
fi
grep -Fq \
  'COPY enterprise-agent-platform/pyproject.toml enterprise-agent-platform/README.md ./' \
  containers/platform.Dockerfile \
  || fail "Platform Python build does not copy an explicit package boundary"
[[ "$(grep -Fxc 'COPY enterprise-agent-platform/enterprise_agent_platform ./enterprise_agent_platform' containers/platform.Dockerfile)" -eq 1 ]] \
  || fail "Platform package source must enter only the Python build stage"

python3 - <<'PY'
import pathlib
import re

dockerfiles = (
    pathlib.Path("containers/platform.Dockerfile"),
    pathlib.Path("containers/agent-runtime.Dockerfile"),
    pathlib.Path("containers/camofox.Dockerfile"),
    pathlib.Path("containers/agent-sandbox.Dockerfile"),
)
instruction = re.compile(r"(?m)^(FROM|ARG|LABEL|RUN|COPY|ADD)\b")
for path in dockerfiles:
    source = path.read_text(encoding="utf-8")
    final_from = tuple(re.finditer(r"(?m)^FROM\b", source))[-1].start()
    final_stage = source[final_from:]
    entries = [(match.group(1), match.start()) for match in instruction.finditer(final_stage)]
    filesystem_positions = [
        offset for name, offset in entries if name in {"RUN", "COPY", "ADD"}
    ]
    if not filesystem_positions:
        raise SystemExit(f"{path}: final stage has no filesystem instructions")
    source_arg = final_stage.find("ARG SOURCE_COMMIT=unknown")
    release_arg = final_stage.find("ARG RELEASE_VERSION=development")
    label = final_stage.find("LABEL org.opencontainers.image.title=")
    if not max(filesystem_positions) < source_arg < release_arg < label:
        raise SystemExit(
            f"{path}: volatile release arguments must follow all filesystem layers "
            "and immediately precede image labels"
        )
    label_block_end = min(
        (
            offset
            for name, offset in entries
            if offset > label and name in {"ARG", "LABEL", "RUN", "COPY", "ADD"}
        ),
        default=len(final_stage),
    )
    label_block = final_stage[label:label_block_end]
    for value in ("$SOURCE_COMMIT", "$RELEASE_VERSION"):
        if value not in label_block:
            raise SystemExit(f"{path}: final image label does not consume {value}")

camofox = pathlib.Path("containers/camofox.Dockerfile").read_text(encoding="utf-8")
build_stage, final_stage = camofox.split("\nFROM node:24-bookworm-slim AS camofox\n", 1)
patch_copy = (
    "COPY enterprise-agent-platform/camofox-runtime/patch-runtime.cjs ./"
)
loopback_copy = (
    "COPY enterprise-agent-platform/camofox-runtime/loopback-preload.cjs ./"
)
npm_install = "RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev"
if not build_stage.index(patch_copy) < build_stage.index(npm_install) < build_stage.index(loopback_copy):
    raise SystemExit(
        "Camoufox small runtime preload must not invalidate dependency installation"
    )
if re.search(
    r"(?m)^COPY --from=camofox-build\b[^\n]* /opt/camofox /opt/camofox\s*$",
    final_stage,
):
    raise SystemExit("Camoufox final stage must not repack the complete build root")
for copy in (
    "COPY --from=camofox-build --chown=1000:1000 /opt/camofox/browser ./browser",
    "COPY --from=camofox-build --chown=1000:1000 /opt/camofox/node_modules ./node_modules",
    "COPY --from=camofox-build --chown=1000:1000 /opt/camofox/package.json ./",
    "COPY --from=camofox-build --chown=1000:1000 /opt/camofox/loopback-preload.cjs ./",
):
    if final_stage.count(copy) != 1:
        raise SystemExit(f"Camoufox cache boundary is missing: {copy}")
if "package-lock.json" in final_stage or "patch-runtime.cjs" in final_stage:
    raise SystemExit("Camoufox final stage contains build-only inputs")
PY

installer_test="$(mktemp -d)"
installer_stubs="$installer_test/bin"
mkdir -p "$installer_stubs"
for account_case in schema1 extra extra-image wrong-basename other-arch \
  corrupt-bootstrap corrupt-target unsafe-runtime happy concurrent failure activated; do
  mkdir -m 0700 "$installer_test/${account_case}-account-home"
done
installer_previous_tmpdir="${TMPDIR-}"
installer_had_tmpdir="${TMPDIR+x}"
export TMPDIR="$installer_test/noexec-tmp"
mkdir -m 0700 "$TMPDIR"
# Only the side-effecting target is fake. Manifest inspection executes the
# actual Manager downloaded from the fixed bootstrap source by the curl stub.
go -C manager build -o "$installer_test/bootstrap-manager" ./cmd/agent-platform-manager
for command in bash sha256sum install uname awk stat realpath id mktemp find grep rm rmdir flock mv mkdir dirname cat cp sleep; do
  ln -s "$(command -v "$command")" "$installer_stubs/$command"
done
# Model execve EACCES without mounting anything or requiring root: executable
# mode cannot stick on files in the simulated noexec temporary filesystem.
ln -s "$(command -v chmod)" "$installer_test/real-chmod"
cat > "$installer_stubs/chmod" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
"${FAKE_MANAGER%/*}/real-chmod" "$@"
for path in "$@"; do
  if [[ "$path" == "$TMPDIR/"* && -f "$path" ]]; then
    "${FAKE_MANAGER%/*}/real-chmod" a-x "$path"
  fi
done
EOF
chmod 0755 "$installer_stubs/chmod"
cp "$installer_test/bootstrap-manager" "$TMPDIR/exec-probe"
FAKE_MANAGER="$installer_test/fake-manager" "$installer_stubs/chmod" 0700 "$TMPDIR/exec-probe"
set +e
"$TMPDIR/exec-probe" version >"$installer_test/noexec-probe.log" 2>&1
noexec_probe_status=$?
set -e
[[ "$noexec_probe_status" -eq 126 ]] || fail "simulated noexec filesystem allowed execution"
rm "$TMPDIR/exec-probe"
cat > "$installer_test/fake-manager" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  preflight)
    if [[ "${FAKE_FAIL_STAGE:-preflight}" == preflight ]]; then
      mkdir -p "$FAKE_DATA_ROOT/manager/secrets"
      printf '%s\n' partial > "$FAKE_DATA_ROOT/manager/secrets/partial"
      exit 42
    fi
    ;;
  install)
    mkdir -p "$FAKE_DATA_ROOT/manager/operations"
    printf '%s\n' retained > "$FAKE_DATA_ROOT/manager/operations/install"
    if [[ "${FAKE_FAIL_STAGE:-}" == install ]]; then
      exit 43
    fi
    ;;
esac
exit 0
EOF
chmod 0755 "$installer_test/fake-manager"
python3 - "$installer_test/fake-manager" "$installer_test/release.json" <<'PY'
import argparse
import hashlib
import json
import pathlib
import sys

repository = pathlib.Path.cwd()
sys.path.insert(0, str(repository / "scripts"))
import assemble_release_manifest as assembler

manager = pathlib.Path(sys.argv[1])
sha = hashlib.sha256(manager.read_bytes()).hexdigest()
commit = "a" * 40
image_sha = "b" * 64
manifest_path = pathlib.Path(sys.argv[2])
managed_images = {
    "platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
    "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
    "firecrawl-redis", "firecrawl-rabbitmq",
}
images = {
    name: f"registry.example/{name}@sha256:{image_sha}"
    for name in managed_images
}
images_path = manifest_path.parent / "images.json"
images_path.write_text(json.dumps(images), encoding="utf-8")
manifest = assembler.assemble(
    argparse.Namespace(
        images=images_path,
        generation=commit,
        # Match the real `git show --format=%cI` producer instead of hand-writing Z.
        generated_at="2026-08-01T08:00:00+08:00",
        database_schema_version=2026080601,
        manager_amd64_url="https://example.invalid/agent-platform-manager-linux-amd64",
        manager_amd64_sha256=sha,
        manager_arm64_url="https://example.invalid/agent-platform-manager-linux-arm64",
        manager_arm64_sha256=sha,
        compose_url="https://example.invalid/agent-platform-compose.yaml",
        compose_sha256="c" * 64,
        output=manifest_path,
    )
)
if manifest["generated_at"] != "2026-08-01T00:00:00Z":
    raise SystemExit("real assembler did not normalize generated_at to UTC Z")
manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")

schema1 = json.loads(json.dumps(manifest))
schema1["schema_version"] = 1
schema1["protocol_version"] = 1
(manifest_path.parent / "schema1-release.json").write_text(
    json.dumps(schema1) + "\n", encoding="utf-8"
)

extra = json.loads(json.dumps(manifest))
extra["unexpected"] = True
(manifest_path.parent / "extra-release.json").write_text(
    json.dumps(extra) + "\n", encoding="utf-8"
)

extra_image = json.loads(json.dumps(manifest))
extra_image["images"]["unexpected-component"] = (
    f"registry.example/unexpected-component@sha256:{image_sha}"
)
(manifest_path.parent / "extra-image-release.json").write_text(
    json.dumps(extra_image) + "\n", encoding="utf-8"
)

wrong_basename = json.loads(json.dumps(manifest))
for arch in ("amd64", "arm64"):
    wrong_basename["manager"]["artifacts"][arch]["url"] = (
        f"https://example.invalid/wrong-manager-linux-{arch}"
    )
(manifest_path.parent / "wrong-basename-release.json").write_text(
    json.dumps(wrong_basename) + "\n", encoding="utf-8"
)

other_arch = "arm64" if __import__("os").uname().machine in ("x86_64", "amd64") else "amd64"
bad_other = json.loads(json.dumps(manifest))
bad_other["manager"]["artifacts"][other_arch]["sha256"] = "invalid"
(manifest_path.parent / "other-arch-release.json").write_text(
    json.dumps(bad_other) + "\n", encoding="utf-8"
)
PY
cat > "$installer_stubs/curl" <<'EOF'
#!/usr/bin/env bash
output=""
url=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == output ]]; then
    output="$argument"
    previous=""
    continue
  fi
  if [[ "$argument" == --output ]]; then
    previous=output
  elif [[ "$argument" == https://* ]]; then
    url="$argument"
  fi
done
[[ -n "$output" && -n "$url" ]]
if [[ "$url" == */release.json ]]; then
  cp "$FAKE_MANIFEST" "$output"
elif [[ "$url" == https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/agent-platform-manager-linux-*.sha256 ]]; then
  digest="$(sha256sum "${FAKE_MANAGER%/*}/bootstrap-manager")"
  asset="${url##*/}"
  printf '%s  %s\n' "${digest%% *}" "${asset%.sha256}" > "$output"
elif [[ "$url" == https://github.com/Noyv3x/enterprise-agent-platform/releases/latest/download/agent-platform-manager-linux-* ]]; then
  cp "${FAKE_MANAGER%/*}/bootstrap-manager" "$output"
  if [[ "${FAKE_CORRUPT:-}" == bootstrap ]]; then
    printf '\ncorrupt\n' >> "$output"
  fi
else
  cp "$FAKE_MANAGER" "$output"
  if [[ "${FAKE_CORRUPT:-}" == target ]]; then
    printf '\ncorrupt\n' >> "$output"
  fi
fi
EOF
cat > "$installer_stubs/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$installer_stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ " $* " == *' enable '* && -n "${FAKE_ENABLE_READY:-}" ]]; then
  : > "$FAKE_ENABLE_READY"
  while [[ ! -e "${FAKE_ENABLE_RELEASE:?}" ]]; do
    sleep 0.02
  done
fi
exit 0
EOF
cat > "$installer_stubs/getent" <<'EOF'
#!/usr/bin/env bash
[[ "$#" -eq 2 && "$1" == passwd && "$2" == "$(id -u)" ]]
printf 'installer:x:%s:%s:Installer Test:%s:/bin/sh\n' \
  "$(id -u)" "$(id -g)" "${FAKE_ACCOUNT_HOME:?}"
EOF
chmod 0755 \
  "$installer_stubs/curl" \
  "$installer_stubs/docker" \
  "$installer_stubs/systemctl" \
  "$installer_stubs/getent"

assert_manifest_rejected_before_paths() {
  local case_name="$1" manifest="$2"
  local output="$installer_test/${case_name}-install.log" status path
  set +e
  cat install.sh | env \
    PATH="$installer_stubs:$PATH" \
    FAKE_MANAGER="$installer_test/fake-manager" \
    FAKE_MANIFEST="$manifest" \
    FAKE_CORRUPT="${3:-}" \
    FAKE_ACCOUNT_HOME="$installer_test/${case_name}-account-home" \
    HOME="$installer_test/${case_name}-ambient-home" \
    XDG_DATA_HOME="$installer_test/${case_name}-data" \
    XDG_CONFIG_HOME="$installer_test/${case_name}-config" \
    XDG_BIN_HOME="$installer_test/${case_name}-bin" \
    XDG_RUNTIME_DIR="$installer_test/${case_name}-runtime" \
    bash -s -- --yes --manifest-url https://example.invalid/release.json \
    >"$output" 2>&1
  status=$?
  set -e
  local expected_status=1
  [[ -z "${3:-}" ]] || expected_status=65
  [[ "$status" -eq "$expected_status" ]] || fail "$case_name validation did not reject the release: $status"
  [[ -z "$(find "$installer_test/${case_name}-account-home" -mindepth 1 -print -quit)" ]] \
    || fail "$case_name rejection left temporary or formal installation files in account home"
  for path in ambient-home data config bin runtime; do
    [[ ! -e "$installer_test/${case_name}-${path}" ]] \
      || fail "$case_name rejection created target installation path: $path"
  done
}

assert_manifest_rejected_before_paths schema1 "$installer_test/schema1-release.json"
assert_manifest_rejected_before_paths extra "$installer_test/extra-release.json"
assert_manifest_rejected_before_paths extra-image "$installer_test/extra-image-release.json"
assert_manifest_rejected_before_paths wrong-basename "$installer_test/wrong-basename-release.json"
assert_manifest_rejected_before_paths other-arch "$installer_test/other-arch-release.json"
assert_manifest_rejected_before_paths corrupt-bootstrap "$installer_test/release.json" bootstrap
assert_manifest_rejected_before_paths corrupt-target "$installer_test/release.json" target
grep -Fq 'bootstrap Manager checksum mismatch' "$installer_test/corrupt-bootstrap-install.log" \
  || fail "corrupt bootstrap was not rejected at the checksum boundary"
grep -Fq 'Manager checksum mismatch' "$installer_test/corrupt-target-install.log" \
  || fail "corrupt target was not rejected at the checksum boundary"

unsafe_runtime="$installer_test/unsafe-runtime"
unsafe_runtime_home="$installer_test/unsafe-runtime-account-home"
unsafe_runtime_output="$installer_test/unsafe-runtime-install.log"
mkdir -p "$unsafe_runtime"
chmod 0755 "$unsafe_runtime"
set +e
cat install.sh | env \
  PATH="$installer_stubs:$PATH" \
  FAKE_MANAGER="$installer_test/fake-manager" \
  FAKE_MANIFEST="$installer_test/release.json" \
  FAKE_ACCOUNT_HOME="$unsafe_runtime_home" \
  HOME="$installer_test/unsafe-runtime-ambient-home" \
  XDG_DATA_HOME="$installer_test/unsafe-runtime-data" \
  XDG_CONFIG_HOME="$installer_test/unsafe-runtime-config" \
  XDG_BIN_HOME="$installer_test/unsafe-runtime-bin" \
  XDG_RUNTIME_DIR="$unsafe_runtime" \
  bash -s -- --yes --manifest-url https://example.invalid/release.json \
  >"$unsafe_runtime_output" 2>&1
unsafe_runtime_status=$?
set -e
[[ "$unsafe_runtime_status" -eq 73 ]] \
  || fail "fresh installer did not reject a non-private runtime directory"
grep -Fq 'refusing a non-private runtime directory' "$unsafe_runtime_output" \
  || fail "unsafe runtime rejection did not report the private-directory boundary"
[[ -z "$(find "$unsafe_runtime_home" -mindepth 1 -print -quit)" ]] \
  || fail "unsafe runtime rejection retained temporary or formal installation files"
for ignored_root in \
  "$installer_test/unsafe-runtime-ambient-home" \
  "$installer_test/unsafe-runtime-data" \
  "$installer_test/unsafe-runtime-config" \
  "$installer_test/unsafe-runtime-bin"; do
  [[ ! -e "$ignored_root" ]] \
    || fail "unsafe runtime rejection used an ambient persistent root: $ignored_root"
done

happy_home="$installer_test/happy-account-home"
happy_data="$happy_home/.local/share/agent-platform"
cat install.sh | env \
  PATH="$installer_stubs" \
  FAKE_MANAGER="$installer_test/fake-manager" \
  FAKE_MANIFEST="$installer_test/release.json" \
  FAKE_DATA_ROOT="$happy_data" \
  FAKE_FAIL_STAGE=none \
  FAKE_ACCOUNT_HOME="$happy_home" \
  HOME="$installer_test/happy-ambient-home" \
  XDG_DATA_HOME="$installer_test/happy-data" \
  XDG_CONFIG_HOME="$installer_test/happy-config" \
  XDG_BIN_HOME="$installer_test/happy-bin" \
  XDG_RUNTIME_DIR="$installer_test/happy-runtime" \
  bash -s -- --yes
[[ -x "$happy_home/.local/bin/agent-platform-manager" ]] \
  || fail "schema-2 fresh install did not activate the target Manager path"
[[ -f "$happy_home/.config/agent-platform/manager.toml" ]] \
  || fail "schema-2 fresh install did not create the target config path"
[[ -f "$happy_home/.config/systemd/user/agent-platform-manager.service" ]] \
  || fail "schema-2 fresh install did not create the target unit"
grep -Fq "$installer_test/happy-runtime/agent-platform-manager/manager.sock" \
  "$happy_home/.config/agent-platform/manager.toml" \
  || fail "schema-2 fresh install did not bind the target runtime socket"
for ignored_root in \
  "$installer_test/happy-ambient-home" \
  "$installer_test/happy-data" \
  "$installer_test/happy-config" \
  "$installer_test/happy-bin"; do
  [[ ! -e "$ignored_root" ]] \
    || fail "schema-2 fresh install used an ambient persistent root: $ignored_root"
done

concurrent_home="$installer_test/concurrent-account-home"
concurrent_data="$concurrent_home/.local/share/agent-platform"
concurrent_ready="$installer_test/concurrent-enable-ready"
concurrent_release="$installer_test/concurrent-enable-release"
set +e
cat install.sh | env \
  PATH="$installer_stubs:$PATH" \
  FAKE_MANAGER="$installer_test/fake-manager" \
  FAKE_MANIFEST="$installer_test/release.json" \
  FAKE_DATA_ROOT="$concurrent_data" \
  FAKE_FAIL_STAGE=none \
  FAKE_ENABLE_READY="$concurrent_ready" \
  FAKE_ENABLE_RELEASE="$concurrent_release" \
  FAKE_ACCOUNT_HOME="$concurrent_home" \
  HOME="$installer_test/concurrent-ambient-home" \
  XDG_DATA_HOME="$installer_test/concurrent-data" \
  XDG_CONFIG_HOME="$installer_test/concurrent-config" \
  XDG_BIN_HOME="$installer_test/concurrent-bin" \
  XDG_RUNTIME_DIR="$installer_test/concurrent-runtime" \
  bash -s -- --yes --manifest-url https://example.invalid/release.json \
  >"$installer_test/concurrent-winner.log" 2>&1 &
concurrent_winner_pid=$!
set -e
for _ in $(seq 1 200); do
  [[ ! -e "$concurrent_ready" ]] || break
  sleep 0.02
done
if [[ ! -e "$concurrent_ready" ]]; then
  kill "$concurrent_winner_pid" >/dev/null 2>&1 || true
  wait "$concurrent_winner_pid" >/dev/null 2>&1 || true
  fail "first concurrent installer did not reach its held activation boundary"
fi

set +e
cat install.sh | env \
  PATH="$installer_stubs:$PATH" \
  FAKE_MANAGER="$installer_test/fake-manager" \
  FAKE_MANIFEST="$installer_test/release.json" \
  FAKE_DATA_ROOT="$concurrent_data" \
  FAKE_FAIL_STAGE=none \
  FAKE_ACCOUNT_HOME="$concurrent_home" \
  HOME="$installer_test/concurrent-other-ambient-home" \
  XDG_DATA_HOME="$installer_test/concurrent-data" \
  XDG_CONFIG_HOME="$installer_test/concurrent-config" \
  XDG_BIN_HOME="$installer_test/concurrent-bin" \
  XDG_RUNTIME_DIR="$installer_test/concurrent-runtime" \
  bash -s -- --yes --manifest-url https://example.invalid/release.json \
  >"$installer_test/concurrent-loser.log" 2>&1
concurrent_loser_status=$?
set -e
[[ "$concurrent_loser_status" -eq 75 ]] \
  || fail "competing fresh installer did not fail at the single-owner lock"
grep -Fq 'another Agent Platform installation is already running' \
  "$installer_test/concurrent-loser.log" \
  || fail "competing fresh installer did not report lock ownership"
for path in \
  "$concurrent_home/.local/bin/agent-platform-manager" \
  "$concurrent_home/.config/agent-platform/manager.toml" \
  "$concurrent_home/.config/systemd/user/agent-platform-manager.service" \
  "$concurrent_data/manager"; do
  [[ -e "$path" ]] || fail "competing installer removed winner-owned path: $path"
done

touch "$concurrent_release"
set +e
wait "$concurrent_winner_pid"
concurrent_winner_status=$?
set -e
[[ "$concurrent_winner_status" -eq 0 ]] \
  || fail "single-owner fresh installer failed after its competitor exited"
[[ -f "$concurrent_data/manager/operations/install" ]] \
  || fail "single-owner fresh installer did not complete its Manager operation"

installer_home="$installer_test/failure-account-home"
installer_data="$installer_home/.local/share/agent-platform"
mkdir -p \
  "$installer_test/xdg-data" \
  "$installer_test/xdg-bin" \
  "$installer_test/xdg-config/agent-platform" \
  "$installer_test/xdg-config/systemd/user" \
  "$installer_test/xdg-runtime"
chmod 0700 "$installer_test/xdg-runtime"
touch \
  "$installer_test/xdg-data/keep" \
  "$installer_test/xdg-bin/keep" \
  "$installer_test/xdg-config/agent-platform/keep" \
  "$installer_test/xdg-config/systemd/user/keep" \
  "$installer_test/xdg-runtime/keep"
if cat install.sh | env \
  PATH="$installer_stubs:$PATH" \
  FAKE_MANAGER="$installer_test/fake-manager" \
  FAKE_MANIFEST="$installer_test/release.json" \
  FAKE_DATA_ROOT="$installer_data" \
  FAKE_ACCOUNT_HOME="$installer_home" \
  HOME="$installer_test/failure-ambient-home" \
  XDG_DATA_HOME="$installer_test/xdg-data" \
  XDG_CONFIG_HOME="$installer_test/xdg-config" \
  XDG_BIN_HOME="$installer_test/xdg-bin" \
  XDG_RUNTIME_DIR="$installer_test/xdg-runtime" \
  bash -s -- --yes \
    --manifest-url https://example.invalid/release.json; then
  fail "injected Manager preflight failure unexpectedly succeeded"
fi
[[ ! -e "$installer_data" ]] || fail "failed fresh install retained its data root"
[[ ! -e "$installer_home/.local/bin/agent-platform-manager" ]] \
  || fail "failed fresh install retained its Manager binary"
[[ ! -e "$installer_home/.config/agent-platform/manager.toml" ]] \
  || fail "failed fresh install retained its Manager config"
[[ ! -e "$installer_home/.config/systemd/user/agent-platform-manager.service" ]] \
  || fail "failed fresh install retained its systemd unit"
for marker in \
  xdg-data/keep \
  xdg-bin/keep \
  xdg-config/agent-platform/keep \
  xdg-config/systemd/user/keep \
  xdg-runtime/keep; do
  [[ -f "$installer_test/$marker" ]] \
    || fail "failed fresh install removed a pre-existing object: $marker"
done

activated_home="$installer_test/activated-account-home"
activated_data="$activated_home/.local/share/agent-platform"
activated_output="$installer_test/activated-install.log"
set +e
cat install.sh | env \
  PATH="$installer_stubs:$PATH" \
  FAKE_MANAGER="$installer_test/fake-manager" \
  FAKE_MANIFEST="$installer_test/release.json" \
  FAKE_DATA_ROOT="$activated_data" \
  FAKE_FAIL_STAGE=install \
  FAKE_ACCOUNT_HOME="$activated_home" \
  HOME="$installer_test/activated-ambient-home" \
  XDG_DATA_HOME="$installer_test/activated-data" \
  XDG_CONFIG_HOME="$installer_test/activated-config" \
  XDG_BIN_HOME="$installer_test/activated-bin" \
  XDG_RUNTIME_DIR="$installer_test/activated-runtime" \
  bash -s -- --yes \
    --manifest-url https://example.invalid/release.json \
    >"$activated_output" 2>&1
activated_status=$?
set -e
[[ "$activated_status" -eq 43 ]] \
  || fail "post-activation install failure exit status was masked: $activated_status"
grep -Fq 'Manager is active and owns the installation state' "$activated_output" \
  || fail "post-activation failure has no Manager-owned recovery guidance"
grep -Fq 'install --config' "$activated_output" \
  || fail "post-activation failure has no exact retry command"
[[ -f "$activated_data/manager/operations/install" ]] \
  || fail "post-activation failure deleted Manager-owned operation state"
[[ -x "$activated_home/.local/bin/agent-platform-manager" ]] \
  || fail "post-activation failure deleted the active Manager binary"
[[ -f "$activated_home/.config/agent-platform/manager.toml" ]] \
  || fail "post-activation failure deleted Manager config"
[[ -f "$activated_home/.config/systemd/user/agent-platform-manager.service" ]] \
  || fail "post-activation failure deleted Manager unit"
[[ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ]] \
  || fail "installer retained files in the default temporary filesystem"
for account_home in "$installer_test/"*-account-home; do
  [[ -z "$(find "$account_home" -name '.agent-platform-install.*' -print -quit)" ]] \
    || fail "installer retained private bootstrap staging after success or failure"
done
if [[ -n "$installer_had_tmpdir" ]]; then
  export TMPDIR="$installer_previous_tmpdir"
else
  unset TMPDIR
fi
rm -rf --one-file-system -- "$installer_test"

for secret in firecrawl-postgres-password firecrawl-bull-auth-key; do
  grep -Fq "$secret" containers/compose.yaml \
    || fail "Compose is missing Firecrawl secret $secret"
done
release_workflow=.github/workflows/container-release.yml
[[ -x scripts/verify-release-images-anonymous.sh ]] \
  || fail "anonymous release-image verifier is missing or not executable"
[[ -x scripts/ensure-release-candidate-tag.sh ]] \
  || fail "release candidate tag verifier is missing or not executable"
[[ ! -e .github/workflows/channel-promotion.yml ]] \
  || fail "a second release-promotion workflow remains"
[[ ! -e scripts/release_promotion.py ]] \
  || fail "a second release-promotion implementation remains"

for expected in \
  'send(1, "drag", points=drag_points)' \
  '"duplicate") is True' \
  '"drag_count=1"' \
  '"pointer_down=0"' \
  'X-Preview-Refresh-Ms'; do
  grep -Fq "$expected" scripts/browser-control-compose-smoke.py \
    || fail "browser control Compose smoke is missing: $expected"
done
grep -Fq 'handle.addEventListener("pointerdown"' scripts/fixtures/browser-control.html \
  || fail "browser control fixture no longer exercises a real pointer drag"
grep -Fq "app.post('/tabs/:tabId/pointer'" enterprise-agent-platform/camofox-runtime/patch-runtime.cjs \
  || fail "Camoufox patch is missing the atomic pointer endpoint"

for expected in \
  'python3 scripts/browser-control-compose-smoke.py' \
  'docker network inspect "$AGENT_PLATFORM_CORE_NETWORK"' \
  'group: container-channel-main' \
  'python3 scripts/assemble_release_manifest.py' \
  'gh release view "$release_tag"' \
  'gh api "/repos/${GITHUB_REPOSITORY}/releases/${release_id}"' \
  'scripts/ensure-release-candidate-tag.sh "$GITHUB_REPOSITORY" "$SOURCE_COMMIT"' \
  'gh release upload "$release_tag" --repo "$GITHUB_REPOSITORY" "$stage/$asset"' \
  'gh release edit "$release_tag" --repo "$GITHUB_REPOSITORY" --draft=false --latest' \
  'gh release download "$release_tag" --repo "$GITHUB_REPOSITORY" --dir "$root"' \
  'scripts/verify-release-images-anonymous.sh "$stage/release.json"'; do
  grep -Fq "$expected" "$release_workflow" \
    || fail "current release workflow is missing: $expected"
done
for asset in \
  agent-platform-manager-linux-amd64 \
  agent-platform-manager-linux-arm64 \
  agent-platform-compose.yaml \
  install.sh \
  release.json; do
  grep -Fq "$asset" "$release_workflow" \
    || fail "release asset is absent: $asset"
done
[[ "$(grep -Fc 'scripts/verify-release-images-anonymous.sh "$stage/release.json"' "$release_workflow")" -eq 2 ]] \
  || fail "release images must be anonymously verified before and after publication"
if grep -Eq -- '--clobber' "$release_workflow"; then
  fail "immutable release assets can be overwritten"
fi

python3 - <<'PY'
import re
from pathlib import Path

workflow = Path(".github/workflows/container-release.yml").read_text(encoding="utf-8")
quality = Path(".github/workflows/quality.yml").read_text(encoding="utf-8")

def job(source: str, name: str) -> str:
    match = re.search(
        rf"(?ms)^  {re.escape(name)}:\n.*?(?=^  [a-zA-Z0-9_-]+:\n|\Z)",
        source,
    )
    if match is None:
        raise SystemExit(f"workflow job is missing: {name}")
    return match.group(0)

required_jobs = {
    "prepare", "upstream-contracts", "images", "image-catalog", "public-images",
    "manager-binaries", "manager-systemd-integration", "compose-smoke", "publish",
}
jobs_source = workflow.split("\njobs:\n", 1)[1]
actual_jobs = set(re.findall(r"(?m)^  ([a-zA-Z0-9_-]+):\n", jobs_source))
if actual_jobs != required_jobs:
    raise SystemExit(f"unexpected release jobs: {sorted(actual_jobs ^ required_jobs)}")

for path, source in (
    (".github/workflows/quality.yml", quality),
    (".github/workflows/container-release.yml", workflow),
):
    for action in re.findall(r"(?m)^\s+uses:\s+([^#\s]+)", source):
        if action.startswith("./"):
            continue
        if re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action) is None:
            raise SystemExit(f"{path} action is not pinned by commit: {action}")


manager_binaries = job(workflow, "manager-binaries")
manager_systemd = job(workflow, "manager-systemd-integration")
if quality.count("go test -count=1 ./...") != 1:
    raise SystemExit("Quality must run the Manager full suite exactly once")
if "go test" in manager_binaries:
    raise SystemExit("Manager artifact builders repeat the full test suite")
for fragment in (
    "GOARCH: ${{ matrix.arch }}",
    "CGO_ENABLED=0 GOOS=linux go -C manager build",
    "agent-platform-manager-linux-${GOARCH}",
    "name: manager-${{ matrix.arch }}",
    "cache-dependency-path: manager/go.sum",
):
    if fragment not in manager_binaries:
        raise SystemExit(f"Manager artifact build is incomplete: {fragment}")
for fragment in (
    'AGENT_PLATFORM_SYSTEMD_INTEGRATION: "1"',
    "go test -count=1 -v",
    "RecoverySystemdQuiescenceIntegration",
    "OrdinarySystemdActivationRestartIntegration",
):
    if fragment not in manager_systemd:
        raise SystemExit(f"real Manager systemd gate is incomplete: {fragment}")

public_images = job(workflow, "public-images")
if "packages: read" not in public_images or "docker/login-action" in public_images:
    raise SystemExit("public-image verification is not anonymous")
image_catalog = job(workflow, "image-catalog")
for fragment in (
    "architecture:",
    "ARCHITECTURE: ${{ matrix.architecture }}",
    'docker pull --platform "linux/${ARCHITECTURE}" "$image"',
    ".managed_image_capacity_estimates[$component].compressed_bytes",
    ".managed_image_capacity_estimates[$component].unpacked_bytes",
    "name: managed-images",
):
    if fragment not in public_images:
        raise SystemExit(f"public-image gate is incomplete: {fragment}")

for fragment in (
    "pattern: image-*",
    "name: managed-images",
    "path: managed-images.json",
    ".managed_image_capacity_estimates | keys",
):
    if fragment not in image_catalog:
        raise SystemExit(f"managed-image catalog is incomplete: {fragment}")

compose = job(workflow, "compose-smoke")
for fragment in (
    "timeout-minutes: 45",
    "name: managed-images",
    "--wait --wait-timeout 600 firecrawl-api",
    "firecrawl_scrape cold",
    "firecrawl_scrape warm",
    "agent_platform_ci_persistence",
    "compatibility_workspaces=",
    "unsafe legacy workspace mount unexpectedly passed compatibility preflight",
    "invalid source database migration unexpectedly succeeded",
    "root-python-shadow-loaded",
    "tests.test_workspace_mount_compat",
    "/^CapPrm:/",
    "/^NoNewPrivs:/",
    "python3 scripts/browser-control-compose-smoke.py",
    'docker network inspect "$AGENT_PLATFORM_CORE_NETWORK"',
):
    if fragment not in compose:
        raise SystemExit(f"Compose acceptance gate is incomplete: {fragment}")
if "      - public-images\n" in compose or "      - images\n" in compose:
    raise SystemExit("Compose acceptance is still serialized behind image verification")

publish = job(workflow, "publish")
for dependency in required_jobs - {"publish"}:
    if f"      - {dependency}\n" not in publish:
        raise SystemExit(f"publish does not require {dependency}")
for fragment in (
    "group: container-channel-main",
    "cancel-in-progress: false",
    "pattern: manager-*",
    "name: managed-images",
    'git merge-base --is-ancestor "$SOURCE_COMMIT" origin/main',
    'git merge-base --is-ancestor "$current" "$SOURCE_COMMIT"',
    "verify_tag",
    'verify_asset_set "$release_api" 1',
    'cmp "$RUNNER_TEMP/release-identity-before.json" "$RUNNER_TEMP/release-identity-after.json"',
):
    if fragment not in publish:
        raise SystemExit(f"atomic publication gate is incomplete: {fragment}")
if "pattern: '*'" in publish or 'pattern: "*"' in publish:
    raise SystemExit("publish downloads an unscoped artifact family")
if "--contract" in publish or "--predecessor-manifest" in publish:
    raise SystemExit("current manifest assembly accepts unrelated inputs")
for producer in ("images", "image-catalog", "manager-binaries"):
    if "overwrite: true" not in job(workflow, producer):
        raise SystemExit(f"{producer} artifacts cannot be replaced by a full-run retry")
PY
for entrypoint in containers/*-entrypoint.sh; do
  sh -n "$entrypoint"
done
for entrypoint in \
  containers/platform-entrypoint.sh \
  containers/agent-runtime-entrypoint.sh \
  containers/camofox-entrypoint.sh \
  containers/agent-sandbox-entrypoint.sh; do
  grep -Fq 'AGENT_PLATFORM_TECHNICAL_PROFILE' "$entrypoint" \
    || fail "$entrypoint does not bind the target technical profile"
done
grep -Fq 'migrate|serve|init-admin|print-agent-token)' containers/platform-entrypoint.sh \
  || fail "Platform entrypoint does not dispatch CLI subcommands"
grep -Fq '/opt/venv/bin/python -I -m enterprise_agent_platform.workspace_mount_compat --check-source' containers/platform-entrypoint.sh \
  || fail "Platform compatibility source check is not isolated from the writable data root"
grep -Fq 'exec /opt/venv/bin/python -I -m enterprise_agent_platform.workspace_mount_compat' containers/platform-entrypoint.sh \
  || fail "Platform compatibility helper is not isolated from the writable data root"
grep -Fq 'exec /usr/bin/setpriv' containers/platform-entrypoint.sh \
  || fail "Platform entrypoint does not use the fixed privilege dropper"

python3 - <<'PY'
import json
from pathlib import Path

schema = json.loads(Path("containers/release-manifest.schema.json").read_text(encoding="utf-8"))
upstream = json.loads(Path("docs/contracts/upstream-sources.json").read_text(encoding="utf-8"))
properties = schema.get("properties", {})
if properties.get("schema_version", {}).get("const") != 2:
    raise SystemExit("target release manifest schema must require schema version 2")
if properties.get("protocol_version", {}).get("const") != 2:
    raise SystemExit("target release manifest schema must require protocol version 2")
required = set(schema.get("required", ()))
expected = {
    "schema_version", "channel", "source_commit", "generated_at",
    "protocol_version", "database_schema_version", "manager", "compose", "images",
}
if required != expected:
    raise SystemExit(f"unexpected top-level release manifest fields: {sorted(required)}")
image_pattern = schema.get("$defs", {}).get("image", {}).get("pattern", "")
if "@sha256:" not in image_pattern:
    raise SystemExit("release images are not constrained to immutable digests")
expected_images = {
    "platform", "agent-runtime", "camofox", "agent-sandbox", "searxng",
    "firecrawl-api", "firecrawl-playwright", "firecrawl-postgres",
    "firecrawl-redis", "firecrawl-rabbitmq",
}
if properties.get("images", {}).get("$ref") != "#/$defs/images":
    raise SystemExit("target release manifest does not bind its image directory")
images_schema = schema.get("$defs", {}).get("images", {})
required_images = set(images_schema.get("required", ()))
if required_images != expected_images:
    raise SystemExit(f"unexpected target release images: {sorted(required_images)}")
if (
    images_schema.get("minProperties") != len(expected_images)
    or images_schema.get("maxProperties") != len(expected_images)
    or images_schema.get("additionalProperties") is not False
):
    raise SystemExit("target image directory is not an exact closed set")
image_name_pattern = images_schema.get("propertyNames", {}).get("pattern", "")
if image_name_pattern != "^[a-z0-9]+(-[a-z0-9]+)*$":
    raise SystemExit("target image names are not lowercase kebab-case")
if schema.get("allOf") is not None:
    raise SystemExit("current release schema must have one closed shape")
if "firecrawl-foundationdb" in expected_images:
    raise SystemExit("the current release schema still requires FoundationDB")
managed_firecrawl_services = set(upstream["sources"]["firecrawl"]["compose_services"])
expected_firecrawl_services = {"api", "nuq-postgres", "playwright-service", "rabbitmq", "redis"}
if managed_firecrawl_services != expected_firecrawl_services:
    raise SystemExit(f"unexpected managed Firecrawl upstream services: {sorted(managed_firecrawl_services)}")
PY

for dockerfile in containers/*.Dockerfile; do
  grep -Eq '^FROM .+ AS ' "$dockerfile" || fail "$dockerfile has no named production stage"
  if [[ "$dockerfile" == containers/agent-sandbox.Dockerfile ]]; then
    grep -Fq 'ENTRYPOINT ["/usr/local/bin/agent-sandbox-entrypoint"]' "$dockerfile" \
      || fail "Agent Sandbox does not use the UID/GID mapping entrypoint"
  else
    grep -q '^USER ' "$dockerfile" || fail "$dockerfile has no explicit USER"
    grep -q '^HEALTHCHECK ' "$dockerfile" || fail "$dockerfile has no image healthcheck"
  fi
  if grep -Eq '(^|[[:space:]/:])latest([[:space:]@]|$)' "$dockerfile"; then
    fail "$dockerfile contains a latest image or dependency reference"
  fi
done
grep -Fq 'exec setpriv --reuid="$agent_uid" --regid="$agent_gid" --init-groups -- /usr/bin/tini -- "$@"' containers/agent-sandbox-entrypoint.sh \
  || fail "Agent Sandbox entrypoint does not permanently drop privileges"
grep -Fq 'chown --no-dereference "$agent_uid:$agent_gid" "$mount_root"' containers/agent-sandbox-entrypoint.sh \
  || fail "Agent Sandbox entrypoint does not protect mount roots from symlink traversal"
grep -Fq 'AGENT_PLATFORM_AGENT_UID' containers/agent-sandbox-entrypoint.sh \
  || fail "Agent Sandbox does not consume the target UID prefix"
grep -Fq 'io.agent-platform.role="sandbox"' containers/agent-sandbox.Dockerfile \
  || fail "Agent Sandbox image does not carry the target ownership label"
if grep -En 'chown.*(--recursive|-R)' containers/agent-sandbox-entrypoint.sh; then
  fail "Agent Sandbox entrypoint recursively changes persistent ownership"
else
  status=$?
  [[ "$status" -eq 1 ]] || fail "could not inspect Agent Sandbox ownership commands (grep exit $status)"
fi
grep -Fq 'browser/version.json' containers/camofox.Dockerfile \
  || fail "Camoufox image does not generate the external bundle version metadata"
grep -Fq '"release": "beta.25"' containers/camofox.Dockerfile \
  || fail "Camoufox image metadata does not match the pinned GitHub release"
grep -Fq 'XDG_CACHE_HOME=/var/lib/agent-platform/camofox/home/.cache' containers/camofox.Dockerfile \
  || fail "Camoufox and camoufox-js cache locations are inconsistent"

python3 - <<'PY'
import re
from pathlib import Path

compose = Path("containers/compose.yaml").read_text(encoding="utf-8")
interpolated = set(re.findall(r"\$\{([A-Z][A-Z0-9_]*)", compose))
unexpected = sorted(name for name in interpolated if not name.startswith("AGENT_PLATFORM_"))
if unexpected:
    raise SystemExit(f"target Compose accepts non-target host environment: {unexpected}")
if not interpolated:
    raise SystemExit("target Compose has no generated host environment contract")
PY

if grep -Ern '/var/run/docker\.sock|/run/docker\.sock|privileged:[[:space:]]*true' containers; then
  fail "a product container can access Docker or runs privileged"
else
  status=$?
  [[ "$status" -eq 1 ]] || fail "could not inspect container privilege boundaries (grep exit $status)"
fi

command -v docker >/dev/null || fail "docker is required to validate Compose"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
zero_digest="sha256:$(printf '0%.0s' {1..64})"
cat > "$temporary/compose.env" <<EOF
AGENT_PLATFORM_COMPOSE_PROJECT=agent-platform
AGENT_PLATFORM_DATA_ROOT=$temporary/data-root
AGENT_PLATFORM_SECRETS_DIR=$temporary/data-root/manager/secrets
AGENT_PLATFORM_MANAGER_CONTROL_DIR=$temporary/runtime/agent-platform-manager
AGENT_PLATFORM_CORE_NETWORK=agent-platform_core
AGENT_PLATFORM_UID=23456
AGENT_PLATFORM_GID=23457
AGENT_PLATFORM_PLATFORM_IMAGE=registry.invalid/agent-platform/platform@$zero_digest
AGENT_PLATFORM_AGENT_RUNTIME_IMAGE=registry.invalid/agent-platform/agent-runtime@$zero_digest
AGENT_PLATFORM_CAMOFOX_IMAGE=registry.invalid/agent-platform/camofox@$zero_digest
EOF

docker compose \
  --env-file "$temporary/compose.env" \
  -f containers/compose.yaml \
  config --format json > "$temporary/compose.json"

python3 - "$temporary/compose.json" <<'PY'
import json
import re
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
services = document.get("services") or {}
networks = document.get("networks") or {}
core = networks.get("core") or {}
if document.get("name") != "agent-platform":
    raise SystemExit(f"target Compose project mismatch: {document.get('name')}")
if core.get("name") != "agent-platform_core" or core.get("external") is not True:
    raise SystemExit(f"core network must be the Manager-owned external network: {core}")
required = {
    "platform", "agent-runtime", "camofox", "searxng", "firecrawl-api",
    "firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq",
    "firecrawl-postgres",
}
if set(services) != required:
    raise SystemExit(f"fixed Compose service set mismatch: {sorted(set(services) ^ required)}")
if "agent-sandbox" in services:
    raise SystemExit("Agent Sandboxes must be created dynamically, not as a fixed service")

digest = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
for name, service in services.items():
    image = str(service.get("image") or "")
    if not digest.fullmatch(image):
        raise SystemExit(f"{name} image is not an immutable digest: {image}")
    if service.get("privileged"):
        raise SystemExit(f"{name} is privileged")
    labels = service.get("labels") or {}
    if labels.get("io.agent-platform.profile") != "agent-platform-v1":
        raise SystemExit(f"{name} does not carry the target ownership profile")
    for volume in service.get("volumes") or []:
        source = str(volume.get("source") or "")
        target = str(volume.get("target") or "")
        if "docker.sock" in source or "docker.sock" in target:
            raise SystemExit(f"{name} mounts the Docker socket")

for name, service in services.items():
    ports = service.get("ports") or []
    if name == "platform":
        if len(ports) != 1 or ports[0].get("host_ip") not in {"127.0.0.1", "::1"}:
            raise SystemExit("Platform must have exactly one loopback publication")
    elif ports:
        raise SystemExit(f"private service {name} publishes a host port")

platform = services["platform"]
searxng = services["searxng"]
if platform.get("user") != "0:0" or platform.get("init") is not False:
    raise SystemExit("Platform compatibility entrypoint must start as root without a persistent root init")
if set(platform.get("cap_drop") or ()) != {"ALL"}:
    raise SystemExit("Platform compatibility entrypoint must drop the default capability set")
if set(platform.get("cap_add") or ()) != {
    "CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID",
}:
    raise SystemExit("Platform compatibility entrypoint has an unexpected capability set")
for service_name in ("agent-runtime", "camofox", "searxng"):
    if services[service_name].get("user") != "23456:23457":
        raise SystemExit(f"{service_name} must run as the target deployment UID/GID")
searxng_config = [
    volume for volume in searxng.get("volumes") or []
    if volume.get("target") == "/etc/searxng"
]
if (
    len(searxng_config) != 1
    or searxng_config[0].get("type") != "bind"
    or not searxng_config[0].get("read_only")
    or not str(searxng_config[0].get("source") or "").endswith(
        "/data/runtimes/searxng/config"
    )
):
    raise SystemExit("SearXNG must read-only bind its complete managed config root")
if any(
    volume.get("target") == "/etc/searxng/settings.yml"
    for volume in searxng.get("volumes") or []
):
    raise SystemExit("SearXNG single-file settings mounts leak anonymous volumes")
environment = platform.get("environment") or {}
if environment.get("AGENT_PLATFORM_TECHNICAL_PROFILE") != "agent-platform-v1":
    raise SystemExit("Platform target technical profile mismatch")
if environment.get("AGENT_PLATFORM_DEPLOYMENT_MODE") != "container":
    raise SystemExit("Platform is not explicitly in container deployment mode")
if environment.get("AGENT_PLATFORM_RUN_UID") != "23456" or environment.get("AGENT_PLATFORM_RUN_GID") != "23457":
    raise SystemExit("Platform compatibility entrypoint target identity mismatch")
if environment.get("AGENT_PLATFORM_WORKSPACE_MOUNT_COMPAT") != "2026080801-to-2026082901":
    raise SystemExit("Platform compatibility entrypoint marker mismatch")
if environment.get("AGENT_PLATFORM_MANAGER_SOCKET") != "/run/agent-platform-manager/manager.sock":
    raise SystemExit("Platform Manager socket contract mismatch")
if environment.get("AGENT_PLATFORM_MANAGER_TOKEN_FILE") != "/run/secrets/agent-platform/manager-token":
    raise SystemExit("Platform Manager token contract mismatch")
runtime_environment = (services["agent-runtime"].get("environment") or {})
if runtime_environment.get("AGENT_PLATFORM_TECHNICAL_PROFILE") != "agent-platform-v1":
    raise SystemExit("Agent Runtime target technical profile mismatch")
if runtime_environment.get("AGENT_MANAGER_EXECUTOR_SOCKET") != "/run/agent-platform-manager/manager.sock":
    raise SystemExit("Agent Runtime Manager socket contract mismatch")
if runtime_environment.get("AGENT_MANAGER_EXECUTOR_TOKEN_FILE") != "/run/secrets/agent-platform/manager-executor-token":
    raise SystemExit("Agent Runtime executor token contract mismatch")
if int(runtime_environment.get("AGENT_RUNTIME_MAX_BODY_BYTES") or 0) < 32 * 1024 * 1024:
    raise SystemExit("Agent Runtime request body limit cannot carry inline images")
camofox_environment = services["camofox"].get("environment") or {}
if camofox_environment.get("AGENT_PLATFORM_TECHNICAL_PROFILE") != "agent-platform-v1":
    raise SystemExit("Camoufox target technical profile mismatch")
if camofox_environment.get("AGENT_PLATFORM_CAMOFOX_BIND_HOST") != "0.0.0.0":
    raise SystemExit("Camoufox target bind contract mismatch")
if camofox_environment.get("AGENT_PLATFORM_CAMOFOX_ACCESS_KEY_FILE") != "/run/secrets/agent-platform/camofox-access-key":
    raise SystemExit("Camoufox target secret contract mismatch")
if camofox_environment.get("CAMOFOX_PROFILE_DIR") != "/var/lib/agent-platform/camofox/profiles":
    raise SystemExit("Camoufox target profile root mismatch")
for name in ("platform", "agent-runtime"):
    manager_mounts = [
        volume for volume in services[name].get("volumes") or []
        if volume.get("target") == "/run/agent-platform-manager"
    ]
    if len(manager_mounts) != 1 or not manager_mounts[0].get("read_only"):
        raise SystemExit(f"{name} must read-only mount the Manager control directory")
platform_secret_targets = {
    str(volume.get("target") or "") for volume in platform.get("volumes") or []
}
runtime_secret_targets = {
    str(volume.get("target") or "")
    for volume in services["agent-runtime"].get("volumes") or []
}
if "/run/secrets/agent-platform/manager-token" not in platform_secret_targets or "/run/secrets/agent-platform/manager-executor-token" in platform_secret_targets:
    raise SystemExit("Platform must receive only the Manager control capability")
if "/run/secrets/agent-platform/manager-executor-token" not in runtime_secret_targets or "/run/secrets/agent-platform/manager-token" in runtime_secret_targets:
    raise SystemExit("Agent Runtime must receive only the Manager executor capability")
platform_data = [v for v in platform.get("volumes") or [] if v.get("target") == "/var/lib/agent-platform"]
if len(platform_data) != 1 or not str(platform_data[0].get("source") or "").endswith("/data"):
    raise SystemExit("Platform data must map <manager data root>/data to /var/lib/agent-platform")

firecrawl = services["firecrawl-api"]
firecrawl_environment = firecrawl.get("environment") or {}
if firecrawl_environment.get("NUQ_BACKEND") != "pg":
    raise SystemExit("Firecrawl must explicitly use the PostgreSQL queue backend")
if "FDB_CLUSTER_FILE" in firecrawl_environment:
    raise SystemExit("Firecrawl must not receive a FoundationDB cluster file")
for service_name, service in services.items():
    if "foundationdb" in service_name.lower():
        raise SystemExit(f"retired FoundationDB service remains: {service_name}")
    for volume in service.get("volumes") or []:
        source = str(volume.get("source") or "").lower()
        target = str(volume.get("target") or "").lower()
        if "foundationdb" in source or "foundationdb" in target or target.startswith("/var/fdb"):
            raise SystemExit(f"{service_name} still mounts retired FoundationDB state")
api_dependencies = firecrawl.get("depends_on") or {}
expected_dependencies = {
    "firecrawl-playwright", "firecrawl-redis", "firecrawl-rabbitmq", "firecrawl-postgres",
}
if set(api_dependencies) != expected_dependencies:
    raise SystemExit(f"Firecrawl API dependency set mismatch: {sorted(api_dependencies)}")
postgres_volumes = [
    volume for volume in services["firecrawl-postgres"].get("volumes") or []
    if volume.get("target") == "/var/lib/postgresql/data"
]
if (
    len(postgres_volumes) != 1
    or postgres_volumes[0].get("type") != "bind"
    or not str(postgres_volumes[0].get("source") or "").endswith(
        "/data/runtimes/firecrawl/postgres"
    )
):
    raise SystemExit("Firecrawl PostgreSQL data must use its managed host bind")
PY

docker compose \
  --env-file "$temporary/compose.env" \
  -f containers/compose.yaml \
  -f containers/compose.dev.yaml \
  config --quiet

printf 'container definitions validated\n'
