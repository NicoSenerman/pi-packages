---
description: Read a GitHub issue, gather context, and write a numbered plan to the package's docs/plans/
---

# Plan a GitHub issue

Issue number: `$1`

Your job is to produce a numbered implementation plan for issue #$1, then commit it.
Single-package plans go in `packages/<PKG>/docs/plans/NNNN-<slug>.md`; cross-package plans go in `docs/plans/NNNN-<slug>.md`.
Stop after the commit.
Do **not** start implementation — the next step is `/tdd-plan` (for plans with test cycles) or `/build-plan` (for docs-only or non-code changes).

## Sync with remote (do this first)

Before reading anything, make sure the working tree is up to date with the remote so the plan is written against current `main`:

1. Run `git pull --ff-only`.
2. If it fails for **any** reason — uncommitted changes, divergent history, merge conflict, network error, detached HEAD — stop immediately and report the failure to the user.
   Do not attempt to stash, rebase, force, or otherwise resolve.
3. Only proceed once the pull reports a clean fast-forward (or `Already up to date.`).

## Load skills

Before investigating the plan, load skills relevant to the change:

- Load the `package-<PKG>` skill for each affected package (e.g., `package-pi-permission-system`) for package-specific architecture, priorities, and testing context.
- Load the `code-design` skill and the `colgrep` skill for convention discovery during exploration.
- Load the `testing` skill if the plan involves test changes or TDD steps.
- Load the `markdown-conventions` skill.
- Load the `design-review` skill and run its checklist on the affected modules if the plan adds fields to shared interfaces or touches wiring between layers.

## Gather context

1. Run `gh issue view $1` to read the issue body and labels.
   After fetching the issue, suggest the user name the session for later identification:

   ```text
   Please run: /name #N Planning — <issue title>
   ```

   This helps identify sessions when resuming work across multiple sessions.
2. **Determine the target package(s).**
   Extract the `pkg:*` label(s) from the issue (e.g., `pkg:pi-permission-system` → package is `pi-permission-system`).
   If no `pkg:*` label exists or it seems incongruent with the issue content, ask the user which package this issue belongs to.
   If the issue has **multiple** `pkg:*` labels, the plan is cross-package — use `docs/plans/` at the repo root instead of a single package's directory.
   Set `PKG` to the package name for single-package issues; for cross-package issues, load skills for each affected package.
3. List the target plans directory (`packages/<PKG>/docs/plans/` for single-package, `docs/plans/` for cross-package) to see numbering and style conventions (create the directory if it does not exist yet).
   Pick the next free `NNNN` (prefer matching the issue number when reasonable).
   If `docs/plans/archive/` exists, those files use issue numbers from a previous repository — ignore them when resolving conflicts.
4. Read every issue the body references as a prerequisite or related (`gh issue view <n>`).
   Note whether each is implemented yet — your plan must say what it depends on vs. defers.
5. Open the source files most relevant to the change and skim them before writing.
6. When the plan introduces a public API pattern (package `exports`, `Symbol.for()` accessor, service interface) or agent-facing message formatting (attribution tags, error prefixes, log labels), use colgrep or grep to search sibling packages for the established convention and follow it unless there is a documented reason to diverge.

## Check for prior session context

Before starting fresh, check whether prior sessions have already done work on this issue:

1. Search for an existing retro file: look for `packages/*/docs/retro/NNNN-*.md` and `docs/retro/NNNN-*.md` where NNNN matches the issue number (zero-padded to 4 digits).
2. If a retro file exists, read it in full.
   It contains stage-boundary notes from prior sessions — summaries, observations, friction points, and decisions already made.
3. If prior stage entries exist (e.g., a "Stage: Planning" entry from an earlier attempt), factor them into your approach.
   Do not repeat work that was already completed unless explicitly asked.
4. If no retro file exists, this is the first session on this issue — proceed normally.

## Decide

Before writing the plan, identify any genuinely ambiguous design choices.
If there are 1–2 such choices (breaking-vs-non-breaking, result-shape change, fallback semantics, etc.), use the `ask-user` skill once to surface them with a short context summary and concrete options.
Skip this step if the issue's "Proposed change" section is unambiguous.

## Write the plan

File: `packages/<PKG>/docs/plans/NNNN-<short-slug>.md` (single-package) or `docs/plans/NNNN-<short-slug>.md` (cross-package).

Start with YAML frontmatter:

```yaml
---
issue: $1
issue_title: "<exact title from `gh issue view`>"
---
```

Then an H1 title (e.g., `# <short descriptive title>`) — required by markdownlint MD041 — followed by the body sections:

- **Problem Statement** — quote the issue's framing in your own words.
- **Goals** — bullet list, scoped to this change.
- **Non-Goals** — explicitly defer anything tangential (sibling issues, follow-ups).
- **Background** — relevant existing modules/functions and how they relate.
  Flag any constraint from AGENTS.md that applies.
- **Design Overview** — decision model, data shapes, separation of concerns, edge cases.
  Include code-fenced TS types when shape changes.
  When the design introduces a new collaborator that multiple consumers will use, sketch the consumer's call site (3–5 lines of pseudocode) to verify the interaction pattern follows Tell-Don't-Ask and Law of Demeter.
  When the design extracts code into a new module, sketch the extracted module's interaction with its upstream dependencies (3–5 lines) to verify it doesn't carry Tell-Don't-Ask violations, output-argument mutations, or reverse-search patterns from the original code.
  Fix upstream API gaps in the plan before planning the extraction.
- **Module-Level Changes** — file-by-file list of what's added, changed, or removed.
  When a step removes or renames an export, grep all `src/` and `test/` files for every removed symbol before finalizing the file list.
- **Test Impact Analysis** — for extraction and refactoring issues: (1) what new unit tests does the extraction enable that were previously impossible or impractical?
  (2) what existing tests become redundant with the new lower-level tests, and can they be simplified or removed?
  (3) which existing tests must stay as-is because they genuinely exercise the layer being extracted?
- **TDD Order** — numbered red→green→commit cycles.
  Each item names the test surface, what's covered, and the suggested commit message (`test:`, `feat:`, `feat!:`, `fix:`, `docs:`).
  When a refactor replaces a type, interface, or function that a large test file depends on, use lift-and-shift: introduce the new thing alongside the old, migrate callers and fixtures incrementally across steps, then remove the old in a final step.
  Never plan a single step that requires rewriting an entire large test file at once.
- **Risks and Mitigations** — concrete risks and how the plan addresses each.
- **Open Questions** — defer-until-needed items.

If the change is breaking, say so explicitly in Goals and use `feat!:` in the suggested commit messages.

## Commit

```bash
git add <plan-file>
git commit -m "docs: plan <short summary> (#$1)"
```

## Write stage notes

Before stopping, persist planning observations for cross-session continuity:

1. Determine the retro file path: same location logic as the plan file (single-package → `packages/<PKG>/docs/retro/NNNN-<slug>.md`; cross-package → `docs/retro/NNNN-<slug>.md`).
   Use the same slug as the plan file.
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
   ## Stage: Planning (<ISO 8601 timestamp>)

   ### Session summary

   2–3 sentences on what was accomplished in this planning session.

   ### Observations

   Note any significant decisions made, alternatives considered and rejected, risks identified, or scope adjustments.
   Keep it concise — this is a breadcrumb trail for future sessions, not a full retrospective.
   ```

4. Commit: `git add <retro-file> && git commit -m "docs(retro): add planning stage notes for issue #N"`.

Wrap code identifiers, filenames, and text containing underscores in backticks in the retro file.

Then print a 5-line summary of the plan's key decisions and stop.
