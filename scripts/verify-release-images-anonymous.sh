#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 RELEASE_MANIFEST" >&2
  exit 2
fi

manifest="$1"
if [[ ! -f "$manifest" || -L "$manifest" ]]; then
  echo "Release manifest must be a regular non-symlink file: $manifest" >&2
  exit 1
fi

expected_components=(
  agent-runtime
  agent-sandbox
  camofox
  firecrawl-api
  firecrawl-playwright
  firecrawl-postgres
  firecrawl-rabbitmq
  firecrawl-redis
  handoff-fs-helper
  platform
  searxng
)
expected_json="$(printf '%s\n' "${expected_components[@]}" | jq -R . | jq -sc .)"
jq -e --argjson expected "$expected_json" '
  .images | type == "object" and
  (keys == $expected) and
  all(to_entries[];
    (.key | test("^[a-z0-9]+(-[a-z0-9]+)*$")) and
    (.value | test("^[^@\\s]+@sha256:[0-9a-f]{64}$"))
  )
' "$manifest" >/dev/null

curl_args=(
  -q --fail --silent --show-error --location
  --proto '=https' --proto-redir '=https' --tlsv1.2
  --connect-timeout 5 --max-time 20
  --retry 1 --retry-all-errors --retry-max-time 25
)

verify_registry_digest() {
  local component="$1"
  local image="$2"
  local reference="${image%@*}"
  local digest="${image##*@}"
  local repository registry service token_url
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
  case "$reference" in
    ghcr.io/*)
      repository="${reference#ghcr.io/}"
      [[ "$repository" =~ ^[a-z0-9._/-]+$ ]]
      registry=https://ghcr.io
      service=ghcr.io
      token_url=https://ghcr.io/token
      ;;
    redis)
      repository=library/redis
      registry=https://registry-1.docker.io
      service=registry.docker.io
      token_url=https://auth.docker.io/token
      ;;
    rabbitmq)
      repository=library/rabbitmq
      registry=https://registry-1.docker.io
      service=registry.docker.io
      token_url=https://auth.docker.io/token
      ;;
    *)
      echo "Unsupported anonymous registry reference for ${component}: ${image}" >&2
      return 1
      ;;
  esac

  local token headers observed
  token="$(env -u GH_TOKEN -u GITHUB_TOKEN curl "${curl_args[@]}" --get \
    --data-urlencode "service=${service}" \
    --data-urlencode "scope=repository:${repository}:pull" \
    "$token_url" | jq -er '(.token // .access_token) | select(type == "string" and length > 0)')"
  headers="$(env -u GH_TOKEN -u GITHUB_TOKEN curl "${curl_args[@]}" --head \
    --header "Authorization: Bearer ${token}" \
    --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "${registry}/v2/${repository}/manifests/${digest}")"
  observed="$(awk 'BEGIN {IGNORECASE=1} $1 == "docker-content-digest:" {gsub("\r", "", $2); print tolower($2)}' <<<"$headers" | tail -n 1)"
  if [[ "$observed" != "$digest" ]]; then
    echo "Anonymous registry returned ${observed:-no digest} for ${component} (${image})" >&2
    return 1
  fi
}

mapfile -t managed_images < <(jq -er '
  .images | to_entries | sort_by(.key)[] |
  [.key, .value] | @tsv
' "$manifest")
[[ "${#managed_images[@]}" -eq "${#expected_components[@]}" ]]
for item in "${managed_images[@]}"; do
  IFS=$'\t' read -r component image <<<"$item"
  verify_registry_digest "$component" "$image"
done
