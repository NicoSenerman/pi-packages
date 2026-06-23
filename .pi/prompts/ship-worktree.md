---
description: Peer-session ship prep — retro, rebase a worktree branch onto main, hand off to root for landing
---

# Ship a worktree branch (peer session)

Argument: `$1` is the issue number implemented in this worktree.

This is the **peer-session** half of the parallel-worktree ship flow.
It prepares the branch for landing but does **not** touch `main`, close the issue, or release — the **root session** does that via `/land-worktree $1`.
For trunk work (committing directly on `main`), use `/ship-issue` instead.

Fetch the issue title via `gh issue view $1 --json title -q .title`, then call `set_session_name` with name `#$1 Ship (worktree) — <issue title>`.

## 1. Confirm this is a worktree branch

1. Run `git branch --show-current`.
2. If the branch is `main` (or not an `issue-$1-*` branch), stop and report — this is the trunk flow's job; use `/ship-issue` from the root instead.
3. Only proceed on an `issue-$1-<slug>` branch.

## 2. Pre-push checks

Run from the worktree root (your current directory):

1. `pnpm run lint` — catches cross-package lint violations CI runs at root level.
2. `pnpm fallow dead-code` — CI runs this gate on every `main` push, so a failure here blocks the eventual land.

If either fails, fix and commit before continuing.

## 3. Retrospective (must land with the branch)

The retro note lives in an `exclude-paths` dir, so it triggers no release — but it must be committed **on this branch** so it rides the single ff-merge when root lands the work.

1. If you have not yet run the retrospective for issue $1, run `/retro $1` now and let it write and commit the stage entry.
2. Confirm the retro file is committed (`git status` clean for it) before proceeding.

## 4. Sync and rebase onto main

1. `git fetch origin`.
2. `git rebase origin/main`.
3. On a conflict: run `git rebase --abort`, then stop and report the conflicting files.
   Do not auto-resolve — the operator decides.
4. After a clean rebase, the branch is a linear descendant of `origin/main`, ready for a fast-forward merge.

Do **not** push this branch and do **not** force-push anything — the root session shares this repo's `.git` and merges the local branch ref directly.

## 5. Hand off to the root session

Report:

- The branch name and its new HEAD (`git log --oneline -1`).
- That checks passed, retro is committed, and the rebase onto `origin/main` is clean.
- The next action: **switch to the root session and run `/land-worktree $1`**.

## Constraints

- Never touch `main` from a worktree (no checkout, no merge, no push to `main`).
- Never force-push.
- If the rebase conflicts, stop — do not resolve automatically.
- Do not close the issue or merge a release PR here; that is `/land-worktree`'s job.
