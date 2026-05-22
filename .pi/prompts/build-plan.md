---
description: Execute a package docs/plans/ plan that has no TDD cycle (docs-only, config-only, or prose changes)
---

# Execute a plan (non-TDD)

Argument: `$1` is either a plan path, an issue number, or empty (use the most recently modified plan).

Use this template for plans whose "TDD Order" section says there are no tests to write (docs-only, config-only, or other non-code changes).
For plans with red→green test cycles, use `/tdd-plan` instead.

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
If the plan has a "TDD Order" section with red→green test cycles, stop and tell the user to run `/tdd-plan` instead.

## Read project rules and load skills

Read `AGENTS.md` for project priorities and conventions.
Load the `package-<PKG>` skill (e.g., `package-pi-permission-system`) for package-specific architecture, priorities, and testing context.
If the plan touches code: load the `code-design` skill.
If the plan touches markdown/docs: load the `markdown-conventions` skill.

## Verify green baseline

Before making any changes, confirm the starting state is clean:

1. `pnpm run check` — must pass (if the package has TypeScript sources).
2. `pnpm run lint` — must pass.

If any check fails, stop and report to the user.
Do not start from a broken baseline.

## Execute the plan steps

For **each** numbered step in the plan's "TDD Order" (or equivalent execution section), in order:

1. **Implement** the change the step describes.
2. **Verify.**
   Run the linters to confirm the change is clean:
   - `pnpm run lint`.
     If it fails, run `pnpm run lint:fix` and re-check.
     Fix all failures — including pre-existing ones unrelated to the current change.
3. **Commit.**
   Use the commit message the plan suggests, or a Conventional Commits message that matches:
   - `docs:` for documentation changes.
   - `feat:` for new behavior.
   - `feat!:` for breaking changes the plan calls out (include a `BREAKING CHANGE:` footer).
   - `fix:` for bug fixes.
   - `style:` for lint/format fixups.

One logical change per commit.
Do not bundle unrelated steps into one commit.

If a step uncovers a problem the plan didn't anticipate, fix it as part of the same commit and note the deviation in the commit body.
If the deviation is large, stop and ask.

## After the last step

1. If any `src/` or `test/` files were touched (even tangentially), run the full suite: `pnpm vitest run`.
   Must be all green.
2. If any `.ts` files were touched, run the type check: `pnpm run check` (`tsc --noEmit`).
   Must succeed.
3. Run the linter one final time: `pnpm run lint`.
   Commit any fixup as `style:` if you haven't pushed yet.
4. **Do not edit `CHANGELOG.md`** — release-please owns it and will generate entries from your Conventional Commit messages on the next release.

## Summarize

Print:

- `git log --oneline <N>` for the commits you just made (N = number of steps).
- One-line summary of what changed.
- Any deviations from the plan.

Stop.
The next step is `/ship-issue`.
