#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 OWNER/REPOSITORY CANDIDATE_COMMIT" >&2
  exit 2
fi

repository="$1"
candidate="$2"
if [[ ! "$repository" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]]; then
  echo "Invalid canonical repository name" >&2
  exit 1
fi
if [[ ! "$candidate" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Candidate must be a full lowercase commit" >&2
  exit 1
fi

ref="/repos/${repository}/git/ref/tags/container-${candidate}"
document="$(mktemp)"
trap 'rm -f "$document" "$document.tmp"' EXIT
if ! gh api "$ref" > "$document.tmp"; then
  rm -f "$document.tmp"
  gh api --method POST "/repos/${repository}/git/refs" \
    -f "ref=refs/tags/container-${candidate}" \
    -f "sha=${candidate}" >/dev/null
fi
gh api "$ref" > "$document.tmp"
mv "$document.tmp" "$document"
jq -e --arg generation "$candidate" \
  '.object.type == "commit" and .object.sha == $generation' \
  "$document" >/dev/null
