# AGENTS.md

## Monorepo Structure

This is a pnpm workspace monorepo.
Each package under `packages/` is a Pi extension published to npm under `@gotgenes/`.
Always launch Pi from the repo root — the root `.pi/settings.json` and `.pi/prompts/` are only discovered from CWD.
The working directory is always the repo root, so for a package-scoped script run `pnpm --filter @gotgenes/<pkg> run <script>` (or `pnpm -C packages/<pkg> run <script>`) from the root instead of `cd packages/<pkg> && pnpm run <script>`.
Before working on a specific package, load its `package-<name>` skill for architecture, priorities, and testing context.
Load skills inline — never dispatch a subagent to load skills.
When adding a new package, wire it into all of:

1. `release-please-config.json` — add to `packages` (component) and add `docs/plans` + `docs/retro` to `exclude-paths`.
2. `.release-please-manifest.json` — add the package at `0.0.0`.
3. `.pi/settings.json` — add the `../packages/<pkg>` load path, plus a `{ "source": "npm:@gotgenes/<pkg>", "extensions": [], "skills": [] }` disable entry once it is in global settings (prevents double-load).
4. `README.md` — add the package to the Packages table, and to the no-dedicated-skill note unless it ships a `package-<pkg>` skill.

Publishing is automatic — `scripts/publish-released.sh` derives the package list from release-please's `paths_released`, so no publish-script edit is needed.

When adding a new internal docs subdirectory (retro, plans, architecture, decisions, assets), add its path to `exclude-paths` in `release-please-config.json`.
Commits that only touch excluded paths do not trigger releases.
Run `pnpm fallow dead-code` locally before pushing a new or dependency-changed package — CI gates on it, and `devDependencies` copied from a sibling package often include unused entries.

## Workflow

- Keep scope tight.
- Prefer small, reversible changes.
- Preserve intentional behavior unless there is a clear reason to change it.
- Ask before removing functionality or changing defaults.

### Tool-injected messages

The `pi-autoformat` extension emits a `[pi-autoformat] Formatted N file(s)` message after `Edit`/`Write`.
It is informational — not a turn boundary.
Continue the current step (e.g. Red→Green→Commit) until it is complete.
It also reflows what you just wrote (line wrapping, quote style), so an `oldText` built from the layout you emitted can fail to match — re-read a region you just edited before editing it again.

### Edit tool batches

A multi-edit `Edit` call is atomic: if one `oldText` fails to match, the whole batch is rejected and nothing is applied.
After a rejection, re-apply every intended edit (not just the ones you retried) and run `pnpm run check` to confirm none were silently dropped — but `tsc` passes on a dropped `import type` removal (an unused type import is not an error), so re-read the affected region rather than trusting the check alone.
When an edit's `oldText` would span a decorative comment rule (a long run of `─`/`═`), anchor on adjacent unique code lines rather than the rule itself — miscounting the run fails the whole atomic batch.
If you delete such a block by line number with `sed`, re-read the region afterward to confirm you did not remove an enclosing brace.
When wrapping existing lines in a new enclosing block (a `describe`, function, or `try`), emit the opening and closing braces as two `edits[]` entries in one `Edit` call (or use `Write`) — a lone opening brace fails the whole file parse, and the close is too far from the open to anchor in the same `oldText`.

### Multi-session issue lifecycle

Larger issues span multiple sessions, each handling one stage.
The standard flow is:

1. `/plan-issue #N` — read the issue, explore the codebase, produce a numbered plan, commit it.
2. `/tdd-plan` or `/build-plan` — execute the plan (TDD for code changes, build for docs/config).
3. Pre-completion review — dispatched automatically at the end of step 2; a fresh-context `pre-completion-reviewer` subagent runs deterministic checks and a judgment checklist before recommending `/ship-issue`.
4. `/ship-issue #N` — push, verify CI, close the issue, merge the release-please PR.
5. `/retro` — review the session(s) for workflow improvements, persist retro notes.

Each prompt template writes a stage entry to `docs/retro/NNNN-<slug>.md` (or `packages/<PKG>/docs/retro/`) before finishing.
These entries accumulate across sessions and serve as the cross-session context bridge — when a later stage starts, it reads the retro file to pick up decisions, observations, and warnings from prior sessions.

Release batching is plan-driven: `/plan-improvements` annotates each roadmap step with a grep-able `Release:` tag (and a `Release batches` subsection), `/plan-issue` derives a `Release Recommendation` from those annotations, and `/ship-issue` reads the plan's `**Release:**` marker early — asking only when it is `mid-batch — defer`, otherwise releasing now.

### Background agent guardrails

When delegating lint-fix or refactoring work to a background agent:

- Do not change function semantics (removing comparisons, altering control flow, removing defensive checks).
- Only add `eslint-disable` comments or make type-safe transformations (removing unused imports, adding type annotations).
- Include `pnpm -r run test` as a verification step before reporting completion.

### Session naming convention

Each prompt template calls `set_session_name` (from `pi-session-tools`) to label the session automatically:

| Stage                | Session name format          |
| -------------------- | ---------------------------- |
| PR review            | `#N PR Review — <title>`     |
| Planning             | `#N Planning — <title>`      |
| TDD implementation   | `#N TDD — <title>`           |
| Build implementation | `#N Build — <title>`         |
| Shipping             | `#N Ship — <title>`          |
| Retrospective        | `#N Retrospective — <title>` |

Each prompt template sets the appropriate name automatically via `set_session_name`.

### Retro file format

Retro files use YAML frontmatter and accumulate `## Stage:` entries:

````markdown
---
issue: 42
issue_title: "Extract ExtensionPaths value object"
---

# Retro: #42 — Extract ExtensionPaths value object

## Stage: Planning (2026-05-20T14:00:00Z)

### Session summary

...

### Observations

...

## Stage: Implementation — TDD (2026-05-21T10:00:00Z)

### Session summary

...

### Observations

...

## Stage: Final Retrospective (2026-05-22T16:00:00Z)

### Session summary

...

### Diagnostic details

- **Model-performance correlation** — Explore subagent ran on claude-sonnet-4-20250514; appropriate for read-only codebase search.
- **Escalation-delay tracking** — 8 consecutive tool calls on the same lint error in TDD step 3 before switching approach.
- **Feedback-loop gap analysis** — `pnpm run check` ran only after step 6; should have run after step 4 (interface change).
````

The `### Diagnostic details` subsection is optional — include it only when the `/retro` prompt's diagnostic lenses produce actionable findings.
Omit it when all lenses find nothing notable.

### Pre-completion reviewer

The `pre-completion-reviewer` agent (`.pi/agents/pre-completion-reviewer.md`) is dispatched automatically by `/tdd-plan` and `/build-plan` after all implementation steps are complete.
It runs as a fresh-context subagent (no implementation bias) and produces a PASS / WARN / FAIL report covering: deterministic checks (`pnpm run check`, `pnpm run lint`, `pnpm run test`, `pnpm fallow dead-code`), acceptance criteria verification, conventional commits, documentation staleness, code design, test artifacts, Mermaid diagrams, and cross-step invariant preservation (a later phase step must not regress an earlier step's documented `Outcome:` invariant).
The `pre-completion` skill (`.pi/skills/pre-completion/SKILL.md`) encodes the dispatch protocol loaded by both templates.
The agent's `model:` frontmatter must use the `provider/id` alias form the Pi CLI/UI accepts (e.g. `anthropic/claude-sonnet-4-6`); an ID absent from the model registry silently falls back to the parent session's model.

Use `/retro-note` to capture quick observations mid-session without interrupting the workflow.
Use `scripts/issue-context.sh <N>` to gather all available context for an issue (plan, retro, commits, branches) when bootstrapping a new session.

## Code Style

This project uses **pnpm** exclusively — never `npm` or `npx`.
Before implementing, refactoring, or reviewing code, load the `code-design` skill — it covers naming, SOLID and structural design heuristics, TypeScript conventions, pnpm/ES2024 tooling rules, Pi SDK boundaries, and Biome/ESLint conflict workarounds.
Use `colgrep` for intent-based codebase exploration and convention discovery; use `grep` for exact symbol matching.

## Markdown

Before writing or editing markdown files, load the `markdown-conventions` skill — it covers the formatting rules (one-sentence-per-line, fence languages, list numbering, table style) and the YAML frontmatter schema for plans and retros.

## Mermaid

Before authoring or reviewing Mermaid diagrams, load the `mermaid` skill.

## Testing

Before writing or debugging tests, load the `testing` skill for Vitest mock patterns and TDD planning rules.

## Commits

Use Conventional Commits.
Commit at meaningful checkpoints without waiting for an explicit reminder.
Prefer small, reviewable commits that leave the repository in a valid state.
Do not edit `CHANGELOG.md` — release-please owns it.
Before naming a remediation in a breaking-change migration note (CLI flag, config key, API call), verify it exists in the real surface (SDK types, `--help`, schema) — do not infer a config key by analogy.
The note ships to the `BREAKING CHANGE:` footer, the release-please CHANGELOG (uneditable), and the issue close comment.
Do not put `Closes #N` / `Fixes #N` / `Resolves #N` in commit messages.
`/ship-issue` posts a curated close comment (implemented-in SHA, behavior summary) via `issue_close`; a commit keyword auto-closes the issue on push and pre-empts that comment, leaving the issue with no summary.
Reference issues as `(#N)` in the subject or `Refs #N` in the body instead.
Avoid `git rebase -i` in this environment — `$EDITOR` opens an interactive editor that aborts non-interactively.
Reorder or fix unpushed commits with `git reset` + re-commit, or set `GIT_SEQUENCE_EDITOR`/`EDITOR=true`.
After `git reset --soft HEAD~N`, all N commits' changes are staged together — to re-split into separate commits, run `git reset` (mixed) first, then `git add` per commit.
Before `git commit --amend`, confirm HEAD is your own commit (`git log -1`) — a concurrent session may have committed since yours, and amend rewrites whatever HEAD points at.
