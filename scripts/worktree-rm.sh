#!/usr/bin/env bash
#
# Remove a peer-session worktree created by worktree-new.sh.
#
# Removes the worktree directory. The branch is left intact by default so you
# don't lose unmerged work; pass --delete-branch to remove it too (only works
# once the branch is merged, unless you also pass --force).
#
# Usage:
#   scripts/worktree-rm.sh <issue-number> [--delete-branch] [--force]

set -euo pipefail

WORKTREE_PARENT="${WORKTREE_PARENT:-$HOME/development/pi/pi-packages-worktrees}"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

if [[ $# -lt 1 ]]; then
  printf 'Usage: %s <issue-number> [--delete-branch] [--force]\n' "$(basename "$0")" >&2
  exit 1
fi

issue="$1"
shift
[[ "$issue" =~ ^[0-9]+$ ]] || die "issue number must be numeric, got: $issue"

delete_branch=false
force=false
for arg in "$@"; do
  case "$arg" in
    --delete-branch) delete_branch=true ;;
    --force) force=true ;;
    *) die "unknown argument: $arg" ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel)" || die "not inside a git repository"
worktree="${WORKTREE_PARENT}/issue-${issue}"

[[ -d "$worktree" ]] || die "no worktree at $worktree"

# Capture the branch checked out in the worktree before removing it.
branch="$(git -C "$worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

if $force; then
  git -C "$repo_root" worktree remove --force "$worktree"
else
  git -C "$repo_root" worktree remove "$worktree"
fi
printf '✓ removed worktree %s\n' "$worktree"

if $delete_branch && [[ -n "$branch" && "$branch" != "HEAD" ]]; then
  if $force; then
    git -C "$repo_root" branch -D "$branch"
  else
    git -C "$repo_root" branch -d "$branch"
  fi
  printf '✓ deleted branch %s\n' "$branch"
elif [[ -n "$branch" && "$branch" != "HEAD" ]]; then
  printf 'branch %s kept (pass --delete-branch to remove it)\n' "$branch"
fi
