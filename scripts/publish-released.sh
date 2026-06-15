#!/usr/bin/env bash
# Publish packages that were released by release-please.
#
# Expects RELEASES env var containing the JSON output from
# googleapis/release-please-action (all step outputs as JSON).
#
# Derives the packages to publish from the `paths_released` array, reading each
# package name from its package.json. There is no hardcoded package list, so a
# newly added package publishes automatically once release-please releases it.
#
# Usage:
#   RELEASES='{"paths_released":"[\"packages/pi-foo\"]",...}' ./scripts/publish-released.sh

set -euo pipefail

if [ -z "${RELEASES:-}" ]; then
  echo "Error: RELEASES env var is required" >&2
  exit 1
fi

# release-please emits paths_released as a JSON-encoded string (e.g.
# "[\"packages/pi-foo\"]"); tolerate a bare array too.
mapfile -t paths < <(printf '%s' "$RELEASES" | jq -r '
  .paths_released // "[]"
  | (if type == "string" then fromjson else . end)
  | .[]
')

if [ ${#paths[@]} -eq 0 ]; then
  echo "No released packages to publish."
  exit 0
fi

for path in "${paths[@]}"; do
  pkg_json="$path/package.json"
  if [ ! -f "$pkg_json" ]; then
    echo "Error: $pkg_json not found for released path '$path'" >&2
    exit 1
  fi
  name=$(jq -r '.name' "$pkg_json")

  echo "::group::Publishing $name ($path)"
  pnpm --filter "$name" publish --access public --no-git-checks --provenance
  echo "::endgroup::"
done
