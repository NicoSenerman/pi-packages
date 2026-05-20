---
description: Read a GitHub issue, gather context, and write a numbered plan to the package's docs/plans/
---

# Plan a GitHub issue

Issue number: `$1`

Your job is to produce a numbered implementation plan at `packages/<PKG>/docs/plans/NNNN-<slug>.md` for issue #$1, then commit it.
Stop after the commit.
Do **not** start implementation — the next step is `/tdd-plan` (for plans with test cycles) or `/build-plan` (for docs-only or non-code changes).

## Sync with remote (do this first)

Before reading anything, make sure the working tree is up to date with the remote so the plan is written against current `main`:

1. Run `git pull --ff-only`.
2. If it fails for **any** reason — uncommitted changes, divergent history, merge conflict, network error, detached HEAD — stop immediately and report the failure to the user.
   Do not attempt to stash, rebase, force, or otherwise resolve.
3. Only proceed once the pull reports a clean fast-forward (or `Already up to date.`).

## Gather context (do this first, in parallel where possible)

1. Run `gh issue view $1` to read the issue body and labels.
2. **Determine the target package.**
   Extract the `pkg:*` label from the issue (e.g., `pkg:pi-permission-system` → package is `pi-permission-system`).
   If no `pkg:*` label exists or it seems incongruent with the issue content, ask the user which package this issue belongs to.
   Set `PKG` to the package name (e.g., `pi-permission-system`) for the rest of this template.
3. Read `AGENTS.md` for project priorities, constraints, and code-design rules.
   Honor them in the plan.
4. List `packages/<PKG>/docs/plans/` to see numbering and style conventions (create the directory if it does not exist yet).
   Pick the next free `NNNN` (prefer matching the issue number when reasonable).
5. Read every issue the body references as a prerequisite or related (`gh issue view <n>`).
   Note whether each is implemented yet — your plan must say what it depends on vs. defers.
6. Open the source files most relevant to the change and skim them before writing.
7. When the plan introduces a public API pattern (package `exports`, `Symbol.for()` accessor, service interface), grep sibling packages for the established convention and follow it unless there is a documented reason to diverge.

## Load skills

Before writing the plan, load skills relevant to the change:

- Always load the `package-<PKG>` skill (e.g., `package-pi-permission-system`) for package-specific architecture, priorities, and testing context.
- If the plan involves code changes: load the `code-design` skill.
- If the plan involves test changes or TDD steps: load the `testing` skill.
- If the plan involves markdown/doc changes: load the `markdown-conventions` skill.
- If the plan adds fields to shared interfaces or touches wiring between layers: load the `design-review` skill and run its checklist on the affected modules.

## Decide

Before writing the plan, identify any genuinely ambiguous design choices.
If there are 1–2 such choices (breaking-vs-non-breaking, result-shape change, fallback semantics, etc.), use the `ask-user` skill once to surface them with a short context summary and concrete options.
Skip this step if the issue's "Proposed change" section is unambiguous.

## Write the plan

File: `packages/<PKG>/docs/plans/NNNN-<short-slug>.md`.

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
git add packages/<PKG>/docs/plans/NNNN-*.md
git commit -m "docs: plan <short summary> (#$1)"
```

Then print a 5-line summary of the plan's key decisions and stop.
