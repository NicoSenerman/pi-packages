#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  printf 'Usage: %s <issue-number>\n' "$(basename "$0")" >&2
  exit 1
fi

ISSUE="$1"
PADDED=$(printf '%04d' "$ISSUE")

printf '\n=== GitHub Issue #%s ===\n\n' "$ISSUE"
gh issue view "$ISSUE" || printf '(failed to fetch issue #%s)\n' "$ISSUE"

# --- Plan files ---
printf '\n=== Plan Files ===\n\n'
plan_files=()
for f in packages/*/docs/plans/"${PADDED}"-*.md docs/plans/"${PADDED}"-*.md; do
  [[ -f "$f" ]] && plan_files+=("$f")
done

if [[ ${#plan_files[@]} -eq 0 ]]; then
  printf '(none found)\n'
else
  for f in "${plan_files[@]}"; do
    printf '--- %s ---\n' "$f"
    cat "$f"
    printf '\n'
  done
fi

# --- Retro files ---
printf '\n=== Retro Files ===\n\n'
retro_files=()
for f in packages/*/docs/retro/"${PADDED}"-*.md docs/retro/"${PADDED}"-*.md; do
  [[ -f "$f" ]] && retro_files+=("$f")
done

if [[ ${#retro_files[@]} -eq 0 ]]; then
  printf '(none found)\n'
else
  for f in "${retro_files[@]}"; do
    printf '--- %s ---\n' "$f"
    cat "$f"
    printf '\n'
  done
fi

# --- Recent commits ---
printf '\n=== Recent Commits Mentioning #%s ===\n\n' "$ISSUE"
commits=$(git log --oneline --grep="#${ISSUE}" -15 2>/dev/null || true)
if [[ -z "$commits" ]]; then
  printf '(none found)\n'
else
  printf '%s\n' "$commits"
fi

# --- Branches ---
printf '\n=== Branches Mentioning %s ===\n\n' "$ISSUE"
branches=$(git branch --list "*${ISSUE}*" 2>/dev/null || true)
if [[ -z "$branches" ]]; then
  printf '(none found)\n'
else
  printf '%s\n' "$branches"
fi
