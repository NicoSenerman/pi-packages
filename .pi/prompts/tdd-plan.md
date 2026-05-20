---
description: Execute the TDD steps from a package docs/plans/ plan as red→green→commit cycles
---

# Execute a plan with TDD

Argument: `$1` is either a plan path, an issue number, or empty (use the most recently modified plan).

## Sync with remote (do this first)

Before locating or reading the plan, make sure the working tree is up to date with the remote:

1. Run `git pull --ff-only`.
2. If it fails for **any** reason — uncommitted changes, divergent history, merge conflict, network error, detached HEAD — stop immediately and report the failure to the user.
   Do not attempt to stash, rebase, force, or otherwise resolve.
3. Only proceed once the pull reports a clean fast-forward (or `Already up to date.`).

## Locate the plan

- If `$1` looks like a path, use it.
- If `$1` is a number, find `packages/*/docs/plans/NNNN-*.md` matching that integer (issue number or plan number).
- Otherwise, use the newest file across all `packages/*/docs/plans/` (by mtime).

The plan's path determines the target package: `packages/<PKG>/docs/plans/...` → `PKG` is that directory name.

Read the plan in full before doing anything else.
If "TDD Order" is missing or empty, stop and report — re-run `/plan-issue` first.

## Read project rules and load skills

Read `AGENTS.md` for project priorities and conventions.
Load the `package-<PKG>` skill (e.g., `package-pi-permission-system`) for package-specific architecture, priorities, and testing context.
Load the `code-design` skill (design principles, TypeScript conventions, structural heuristics).
Load the `testing` skill (Vitest mock patterns, TDD planning rules).

## Execute the TDD cycle

For **each** step in the plan's "TDD Order", in order:

1. **Red.**
   Write the failing tests the step describes.
   Run only the affected test file: `pnpm vitest run <test-path>` and confirm failures.
2. **Green.**
   Implement the minimum code to make those tests pass.
   Re-run the same file and confirm green.
3. **Commit.**
   Use the commit message the plan suggests, or a Conventional Commits message that matches:
   - `test:` for test-only commits (rare; usually folded into the feat).
   - `feat:` for new behavior.
   - `feat!:` for breaking changes the plan calls out (include a `BREAKING CHANGE:` footer).
   - `fix:` for bug fixes.

One logical change per commit.
Do not bundle multiple TDD steps into one commit.

When a step replaces a type or function that many tests depend on, use lift-and-shift: add the new alongside the old, migrate test fixtures incrementally, then remove the old.
Do not rewrite an entire large test file in one shot.

If a step uncovers a problem the plan didn't anticipate (e.g. a downstream test breaks), fix it as part of the same commit and note the deviation in the commit body.
If the deviation is large, stop and ask.

## After the last TDD step

1. Run the full suite: `pnpm vitest run`.
   Must be all green.
2. Run the type check: `pnpm run check` (`tsc --noEmit`).
   Must succeed — Vitest does not typecheck.
3. Run the linter: `pnpm run lint`.
   If it fails, run `pnpm run lint:fix` and re-check.
   Commit any fixup as part of the most recent feat commit (amend) only if you haven't pushed; otherwise as a `style:` commit.
   The fixup must NOT land in a `docs:` commit.
4. Cross-check the plan's "Module-Level Changes" table against actually-changed files.
   If a listed file was not touched, update it now or note the deviation.
5. Commit doc updates as `docs: <summary>`.
6. **Do not edit `CHANGELOG.md`** — release-please owns it and will generate entries from your Conventional Commit messages on the next release.

## Summarize

Print:

- `git log --oneline <N>` for the commits you just made (N = number of TDD steps + docs).
- One-line summary of behavioral change.
- Any test-count delta.
- Any deviations from the plan.

Stop.
The next step is `/ship-issue`.
