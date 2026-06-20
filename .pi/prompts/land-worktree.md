---
description: Root-session landing — ff-merge a rebased worktree branch into main, verify CI, close the issue, release, and tear down
---

# Land a worktree branch (root session)

Argument: `$1` is the issue number whose peer branch is ready to land.

This is the **root-session** half of the parallel-worktree ship flow.
Run it after the peer session finished `/ship-worktree $1` (checks passed, retro committed, branch rebased onto `origin/main`).
It lands the branch on linear `main`, verifies CI, closes the issue, optionally releases, and tears down the worktree.

Fetch the issue title via `gh issue view $1 --json title -q .title`, then call `set_session_name` with name `#$1 Land — <issue title>`.

## 1. Confirm root + sync main

1. Run `git rev-parse --show-toplevel` and `git branch --show-current` — confirm you are in the **root** checkout on `main`.
   If not, stop and report.
2. `git fetch origin`.
3. `git pull --ff-only`.
   If it fails for any reason, stop and report — do not stash, rebase, or force.

## 2. Fast-forward merge the peer branch

The peer worktree shares this repo's `.git`, so the branch ref is visible locally — no fetch of the branch is needed.

1. Find the branch: `git branch --list "issue-$1-*"`.
   If zero or more than one match, stop and report.
2. `git merge --ff-only <branch>`.
3. If the merge is **not** a fast-forward, stop and report: `main` advanced since the peer rebased (another peer landed first).
   The peer must re-run `/ship-worktree $1` to rebase onto the new `origin/main`, then retry this step.

## 3. Push

- `git push`.
- If rejected as non-fast-forward, stop and report — do not force-push.

## 4. Verify CI on the pushed commit

1. `git rev-parse HEAD` to capture the full 40-char SHA; pass that exact value to `ci_find` (workflow `ci`).
2. `ci_watch` with the returned `run_id` (workflow `ci`).
3. If the conclusion is `failure`, stop and report — do not close the issue, release, or tear down.
4. On `success`, continue.

## 5. Close the issue

Build the close comment from the commits since the previous release (`git log --oneline <previous-tag-or-base>..HEAD`):

- "Implemented in <sha> …" — SHA as plain text (no backticks) so GitHub auto-links it.
- A short bullet list of feature/breaking commits.
- One sentence on user-visible behavior change.
- A note flagging any breaking change (`feat!:`).

Then call `issue_close` with issue number `$1` and that summary.
Also close any **other** issues this push shipped (stacked refactors, other `(#M)` refs, sibling `docs/retro/` files in range) with their own short summaries.

## 6. Release (decoupled and serialized)

Releasing is the root's serialized responsibility — only the root merges the single release-please PR, so peers never race on it.

1. Read the issue's plan for a `**Release:**` marker.
   If it says `mid-batch — defer`, **skip releasing**: leave the release-please PR open, note the deferral, and continue to teardown.
   Otherwise release now.
2. To release: `release_pr_find` → check the **full** PR body for which packages it bumps (release-please collapses each in a `<details>` block) → `release_pr_merge` (rebase).
   - On an `UNSTABLE`-no-checks refusal (the `GITHUB_TOKEN` case — empty `statusCheckRollup`), fall back to `gh pr merge <N> --rebase`, then `git pull --ff-only`.
   - Never `--merge`; never merge a genuinely blocked PR (`CONFLICTING`/`DIRTY`/`BEHIND` or a failing check).
3. `release_watch` for the tag.

## 7. Tear down the worktree

Run `scripts/worktree-rm.sh $1 --delete-branch`.
The branch deletes cleanly because its commits are now in `main`; the worktree is not anyone's live CWD (the peer session can stay open or be closed — its work is landed).

## 8. Final report

Print:

- New HEAD on `main` (`git log --oneline -1`).
- Released version, if a release just landed (`git tag --points-at HEAD`), or that release was deferred and why.
- Issue close confirmation(s).
- Worktree/branch teardown confirmation.
- Anything skipped and why.

## Constraints

- Never force-push.
- If the ff-merge is not a fast-forward, stop — the peer re-rebases; the root never merges non-linearly.
- If CI fails, the issue stays open and nothing is released or torn down.
- Never merge a genuinely blocked release-please PR; `UNSTABLE` from no checks is the expected `GITHUB_TOKEN` case.
