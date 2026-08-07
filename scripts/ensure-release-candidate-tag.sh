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
read_and_verify() {
  gh api "$ref" > "$document.tmp" 2>/dev/null &&
    jq -e --arg generation "$candidate" \
      '.object.type == "commit" and .object.sha == $generation' \
      "$document.tmp" >/dev/null
}

if ! read_and_verify; then
  rm -f "$document.tmp"
  gh api --method POST "/repos/${repository}/git/refs" \
    -f "ref=refs/tags/container-${candidate}" \
    -f "sha=${candidate}" >/dev/null
fi

for delay in 0 1 2 4 8; do
  if (( delay > 0 )); then
    sleep "$delay"
  fi
  if read_and_verify; then
    mv "$document.tmp" "$document"
    exit 0
  fi
done

echo "Candidate tag did not become readable at the expected commit" >&2
exit 1
