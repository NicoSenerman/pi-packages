# AGENTS.md

## Monorepo Structure

This is a pnpm workspace monorepo.
Each package under `packages/` is a Pi extension published to npm under `@gotgenes/`.
Always launch Pi from the repo root — the root `.pi/settings.json` and `.pi/prompts/` are only discovered from CWD.
Before working on a specific package, load its `package-<name>` skill for architecture, priorities, and testing context.

## Workflow

- Keep scope tight.
- Prefer small, reversible changes.
- Preserve intentional behavior unless there is a clear reason to change it.
- Ask before removing functionality or changing defaults.

### Multi-session issue lifecycle

Larger issues span multiple sessions, each handling one stage.
The standard flow is:

1. `/plan-issue #N` — read the issue, explore the codebase, produce a numbered plan, commit it.
2. `/tdd-plan` or `/build-plan` — execute the plan (TDD for code changes, build for docs/config).
3. `/ship-issue #N` — push, verify CI, close the issue, merge the release-please PR.
4. `/retro` — review the session(s) for workflow improvements, persist retro notes.

Each prompt template writes a stage entry to `docs/retro/NNNN-<slug>.md` (or `packages/<PKG>/docs/retro/`) before finishing.
These entries accumulate across sessions and serve as the cross-session context bridge — when a later stage starts, it reads the retro file to pick up decisions, observations, and warnings from prior sessions.

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
````

Use `/retro-note` to capture quick observations mid-session without interrupting the workflow.
Use `scripts/issue-context.sh <N>` to gather all available context for an issue (plan, retro, commits, branches) when bootstrapping a new session.

## Code Style

- Use TypeScript.
- Avoid `any` unless absolutely necessary.
- Use standard top-level imports only.
- Keep modules focused and composable (one concern per file).
- Prefer explicit configuration over hidden behavior.
- This project uses **pnpm** exclusively — never `npm` or `npx`.
- The tsconfig target is ES2024 (`noEmit: true`).
  ES2023 APIs (`findLast`, `findLastIndex`, `toReversed`, `toSorted`, `toSpliced`, `with`) and ES2024 APIs (`Promise.withResolvers`, `Object.groupBy`, `Map.groupBy`, `Array.fromAsync`) are available and preferred.
  Do not use APIs introduced after ES2024.

Use `colgrep` for intent-based codebase exploration and convention discovery; use `grep` for exact symbol matching.

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
