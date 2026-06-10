# AGENTS.md

## Monorepo Structure

This is a pnpm workspace monorepo.
Each package under `packages/` is a Pi extension published to npm under `@gotgenes/`.
Always launch Pi from the repo root — the root `.pi/settings.json` and `.pi/prompts/` are only discovered from CWD.
The working directory is always the repo root, so for a package-scoped script run `pnpm --filter @gotgenes/<pkg> run <script>` (or `pnpm -C packages/<pkg> run <script>`) from the root instead of `cd packages/<pkg> && pnpm run <script>`.
Before working on a specific package, load its `package-<name>` skill for architecture, priorities, and testing context.
Load skills inline — never dispatch a subagent to load skills.
When adding a new package or a new internal docs subdirectory (retro, plans, architecture, decisions, assets), add the path to `exclude-paths` in `release-please-config.json`.
Commits that only touch excluded paths do not trigger releases.

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
After a rejection, re-apply every intended edit (not just the ones you retried) and run `pnpm run check` to confirm none were silently dropped.

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

### Background agent guardrails

When delegating lint-fix or refactoring work to a background agent:

- Do not change function semantics (removing comparisons, altering control flow, removing defensive checks).
- Only add `eslint-disable` comments or make type-safe transformations (removing unused imports, adding type annotations).
- Include `pnpm -r run test` as a verification step before reporting completion.

### Session naming convention

Each prompt template calls `set_session_name` (from `pi-session-tools`) to label the session automatically:

| Stage                | Session name format          |
| -------------------- | ---------------------------- |
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
It runs as a fresh-context subagent (no implementation bias) and produces a PASS / WARN / FAIL report covering: deterministic checks (`pnpm run check`, `pnpm run lint`, `pnpm run test`, `pnpm fallow dead-code`), acceptance criteria verification, conventional commits, documentation staleness, code design, test artifacts, and Mermaid diagrams.
The `pre-completion` skill (`.pi/skills/pre-completion/SKILL.md`) encodes the dispatch protocol loaded by both templates.
The agent's `model:` frontmatter must use the `provider/id` alias form the Pi CLI/UI accepts (e.g. `anthropic/claude-sonnet-4-6`); an ID absent from the model registry silently falls back to the parent session's model.

Use `/retro-note` to capture quick observations mid-session without interrupting the workflow.
Use `scripts/issue-context.sh <N>` to gather all available context for an issue (plan, retro, commits, branches) when bootstrapping a new session.

## Code Style

- Use TypeScript.
- Avoid `any` unless absolutely necessary.
- Use standard top-level imports only.
- Keep modules focused and composable (one concern per file).
- Prefer explicit configuration over hidden behavior.
- This project uses **pnpm** exclusively — never `npm` or `npx`.
- When you change a `package.json` dependency, run `pnpm install` and commit the updated `pnpm-lock.yaml` in the same commit — CI installs with `--frozen-lockfile`.
- pnpm settings (`catalog`, `allowBuilds`, `linkWorkspacePackages`) live in `pnpm-workspace.yaml`, not `.npmrc` — pnpm 11 reads them there.
- The tsconfig target is ES2024 (`noEmit: true`).
  ES2023 APIs (`findLast`, `findLastIndex`, `toReversed`, `toSorted`, `toSpliced`, `with`) and ES2024 APIs (`Promise.withResolvers`, `Object.groupBy`, `Map.groupBy`, `Array.fromAsync`) are available and preferred.
  Do not use APIs introduced after ES2024.

When a rename or extraction adds exports to a barrel file (`types.ts`, `index.ts`), verify at least one consumer imports the symbol from that barrel — not from the source module directly.
Do not add speculative re-exports; fallow will flag them as dead code.

When adding a public or cross-extension API (a service method, exported seam, or registration hook), document it for third-party authors — input/return contract, error/throw semantics, a minimal wiring example, and known limitations — not just the type signature.

Use `colgrep` for intent-based codebase exploration and convention discovery; use `grep` for exact symbol matching.

### Biome / ESLint linter conflicts

Biome's `noNonNullAssertion` bans `x!` and ESLint's `no-unnecessary-type-assertion` auto-fixes `x as T` back to `x!`.
When both linters run on the same file, assertion-based workarounds create an unsolvable loop.
Fix: restructure the code to eliminate the assertion entirely (explicit `if` guard with early return).

Passing an interface method as a bare value (`writeReviewLog: logger.review`) trips `@typescript-eslint/unbound-method`; the rule's suggested `this: void` fix is itself rejected by `@typescript-eslint/no-invalid-void-type`.
Fix: wrap in an arrow (`(e, d) => logger.review(e, d)`).

ESLint `prefer-const` fires on a `let` assigned exactly once — even with no initializer (e.g. a forward declaration captured by a closure before assignment).
`const` without an initializer is a syntax error, so the suggested fix is impossible, but the error still triggers (biome's `useConst` correctly skips it; a `let` reassigned 2+ times is also skipped).
Fix: `// eslint-disable-next-line prefer-const -- forward-declared let; const requires an initializer`.

Before implementing, refactoring, or reviewing code, load the `code-design` skill for design principles and structural heuristics.

## Markdown

- Use one sentence per line (unbroken) for better diffs.
- Always specify a language on fenced code blocks (e.g., ` ```typescript `, ` ```bash `, ` ```text `); use `text` for plain output.
- Use sequential numbering (`1.` `2.` `3.`) in ordered lists, restarting at `1.` under each new heading — markdownlint's MD029 rejects continued numbering across section boundaries.
- Do not use bold text (`**...**`) as a substitute for headings — use proper heading syntax; markdownlint's MD036 rejects emphasis used as headings.
- When embedding markdown that itself contains fenced code blocks, use a 4-backtick outer fence (` ````markdown `).
- Use compact table style — markdownlint's MD060 enforces consistent column style.
- Separate adjacent blockquotes with an HTML comment (`<!-- -->`) to satisfy markdownlint's MD028.

Before writing or editing markdown files, load the `markdown-conventions` skill.

## Mermaid

Before authoring or reviewing Mermaid diagrams, load the `mermaid` skill.

## Documentation Frontmatter

Docs under `docs/plans/` and `docs/retro/` use YAML frontmatter for structured metadata.
Single-package work lives in `packages/<PKG>/docs/{plans,retro}/`; cross-package work lives in the top-level `docs/{plans,retro}/`.
GitHub renders frontmatter as a table at the top of the file.

Schema (both fields are strings/numbers — quote any title containing backticks or colons):

```yaml
---
issue: 14                                              # optional: omit for plans that predate issue tracking
issue_title: "Batch-by-default formatter dispatch"     # required
---
```

- `issue` stores the number only, never a URL.
- Do not duplicate frontmatter fields as inline metadata in the body.
- Other doc types (`README.md`) do not use frontmatter.

## Testing

Before writing or debugging tests, load the `testing` skill for Vitest mock patterns and TDD planning rules.

## Commits

Use Conventional Commits.
Commit at meaningful checkpoints without waiting for an explicit reminder.
Prefer small, reviewable commits that leave the repository in a valid state.
Do not edit `CHANGELOG.md` — release-please owns it.
Do not put `Closes #N` / `Fixes #N` / `Resolves #N` in commit messages.
`/ship-issue` posts a curated close comment (implemented-in SHA, behavior summary) via `issue_close`; a commit keyword auto-closes the issue on push and pre-empts that comment, leaving the issue with no summary.
Reference issues as `(#N)` in the subject or `Refs #N` in the body instead.
Avoid `git rebase -i` in this environment — `$EDITOR` opens an interactive editor that aborts non-interactively.
Reorder or fix unpushed commits with `git reset` + re-commit, or set `GIT_SEQUENCE_EDITOR`/`EDITOR=true`.
Before `git commit --amend`, confirm HEAD is your own commit (`git log -1`) — a concurrent session may have committed since yours, and amend rewrites whatever HEAD points at.
