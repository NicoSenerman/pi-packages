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
- If `$1` is a number, find `packages/*/docs/plans/NNNN-*.md` or `docs/plans/NNNN-*.md` matching that integer (issue number or plan number).
- Otherwise, use the newest file across all `packages/*/docs/plans/` and `docs/plans/` (by mtime).

If the plan lives under `packages/<PKG>/docs/plans/`, that determines the target package.
If the plan lives under `docs/plans/`, it is cross-package — load skills for each affected package listed in the plan.

Read the plan in full before doing anything else.
If "TDD Order" is missing or empty, stop and report — re-run `/plan-issue` first.

Extract the issue number from the plan filename (pattern `NNNN-`) or from the plan's frontmatter `issue:` field.
If the issue title is not in the frontmatter, fetch it via `gh issue view N --json title -q .title`.
Call `set_session_name` with name `#N TDD — <issue title>` to identify this session in the session selector.

## Load prior session context

Check whether prior sessions have already done work on this issue:

1. Extract the issue number from the plan filename (pattern `NNNN-`) or its frontmatter `issue:` field.
2. Search for an existing retro file: look for `packages/*/docs/retro/NNNN-*.md` and `docs/retro/NNNN-*.md` matching the issue number.
3. If a retro file exists, read it.
   Prior stage entries contain summaries and observations from earlier sessions (e.g., planning decisions, risks identified, alternatives rejected).
4. Use this context to inform your work — it may contain warnings about edge cases, decisions that were already debated, or friction points to avoid repeating.

## Load skills

Before executing the TDD cycle, load skills relevant to the change:

- Load the `package-<PKG>` skill (e.g., `package-pi-permission-system`) for package-specific architecture, priorities, and testing context.
- Load the `code-design` skill for design principles, TypeScript conventions, and structural heuristics.
- Load the `testing` skill for Vitest mock patterns and TDD planning rules.

## Verify green baseline

Before writing any code, confirm the starting state is clean:

1. `pnpm run check` — must pass.
2. `pnpm run lint` — must pass.
3. `pnpm vitest run` — must pass.

If any check fails, stop and report to the user.
Do not start TDD cycles from a broken baseline.

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
   If it fails, run `pnpm exec biome check --write .` to auto-fix, then re-check.
   Fix all failures — including pre-existing ones unrelated to the current change.
   Commit any fixup as part of the most recent feat commit (amend) only if you haven't pushed; otherwise as a `style:` commit.
   The fixup must NOT land in a `docs:` commit.
4. Run the fallow dead-code gate **from the repo root**: `pnpm fallow dead-code`.
   Running from a package subdirectory detects fewer entry points than CI, producing false positives that become stale suppressions in CI.
   If it exits non-zero, fix the findings (remove dead exports, add suppressions for false positives).
   Commit fixes as part of the most recent feat commit (amend) if not yet pushed; otherwise as a `fix:` commit.
5. Cross-check the plan's "Module-Level Changes" table against actually-changed files.
   If a listed file was not touched, update it now or note the deviation.
6. If `packages/<PKG>/docs/architecture/` exists, check whether the changes affect the module structure or data-flow descriptions and update them.
7. Commit doc updates as `docs: <summary>`.
8. **Do not edit `CHANGELOG.md`** — release-please owns it and will generate entries from your Conventional Commit messages on the next release.

## Summarize

Print:

- `git log --oneline <N>` for the commits you just made (N = number of TDD steps + docs).
- One-line summary of behavioral change.
- Any test-count delta.
- Any deviations from the plan.

## Write stage notes

Before stopping, persist implementation observations for cross-session continuity:

1. Determine the retro file path: same location as the plan file (single-package → `packages/<PKG>/docs/retro/`; cross-package → `docs/retro/`).
   Use the same `NNNN-<slug>` as the plan file.
   Create the directory if needed.
2. If the retro file does not exist, create it with YAML frontmatter:

   ```yaml
   ---
   issue: N
   issue_title: "<exact title from issue>"
   ---
   ```

   Followed by `# Retro: #N — <issue title>`.
3. Append a stage entry:

   ```markdown
   ## Stage: Implementation — TDD (<ISO 8601 timestamp>)

   ### Session summary

   2–3 sentences: what was implemented, how many TDD cycles completed, test count delta.

   ### Observations

   Note deviations from the plan, unexpected edge cases, tests that were harder than expected, and any decisions made during implementation.
   If the session was cut short (not all TDD steps completed), note which steps remain.
   ```

4. Commit: `git add <retro-file> && git commit -m "docs(retro): add TDD stage notes for issue #N"`.

Wrap code identifiers, filenames, and text containing underscores in backticks in the retro file.

Stop.
The next step is `/ship-issue`.
