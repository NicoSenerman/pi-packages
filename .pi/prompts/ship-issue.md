---
description: Push, close a GitHub issue with a summary, and merge the release-please PR
---
# Ship the implementation

Argument: `$1` is the issue number that was just implemented.

## 1. Sync with remote

Before pushing, make sure local `HEAD` is current with the remote:

1. Run `git pull --ff-only`.
2. If it fails for **any** reason — uncommitted changes, divergent history, merge conflict, network error, detached HEAD — stop immediately and report the failure to the user. Do not attempt to stash, rebase, force, or otherwise resolve.
3. Only proceed once the pull reports a clean fast-forward (or `Already up to date.`).

## 2. Push

- Determine the current branch (`git branch --show-current`).
- `git push origin HEAD` (or `<branch>:<branch>`).
- If the push is rejected as non-fast-forward, stop and report — do not force-push.

## 3. Verify CI on the pushed commit

1. Use `ci_find` with the pushed SHA (`git rev-parse HEAD`) and workflow `ci` to locate the CI run.
2. Use `ci_watch` with the returned `run_id` and workflow `ci` to wait for it to complete.
3. If the run conclusion is `failure`, stop and report. Do not close the issue or merge anything.
4. If it lands `success`, continue.

## 4. Close the issue

Build the close comment from the commits since the previous release:

```bash
git log --oneline <previous-tag-or-base>..HEAD
```

The comment should include:

- The commit hash that lands the change ("Implemented in `<sha>` …").
- A short bullet list of feature/breaking commits.
- One sentence on user-visible behavior change.
- A note flagging any breaking change (matches `feat!:` commits).
- If the change unblocks or partially addresses other issues, mention them.

Then use `issue_close` with issue number `$1` and the summary as the comment.

## 5. Merge release-please PR (if present)

1. Use `release_pr_find` to locate an open release-please PR.
2. If none is found (timeout), skip to step 6.
3. If one exists, use `release_pr_merge` with the PR number.
   - Note: release-please PRs typically have **no CI runs** because PRs created by the default `GITHUB_TOKEN` do not trigger workflows. This is expected; do not block on it.
   - If `release_pr_merge` returns an error (not mergeable), stop and report — let the user decide.
4. Use `release_watch` to wait for the release tag to land on HEAD.

## 6. Final report

Print:

- The new HEAD on `main` (`git log --oneline -1`).
- The released version, if a release commit just landed (`git tag --points-at HEAD` or read `package.json`).
- Issue close confirmation.
- Anything that was skipped and why.

## Constraints

- Never force-push.
- Never merge a release-please PR that is not `MERGEABLE`/`CLEAN`.
- If CI fails, the issue stays open.
- If multiple release-please PRs exist for the same component, stop and ask — that's a configuration issue, not a normal merge.
