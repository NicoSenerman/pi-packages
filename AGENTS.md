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

Release-please PRs merge by **rebase** (linear `chore: release main`), per `defaultMergeMethod: rebase` (`.pi/extensions/pi-github-tools/config.json`) — set in `cacc724f`.
Prefer `release_pr_merge`; on its `UNSTABLE`-no-checks refusal, fall back to `gh pr merge <N> --rebase`, never `--merge`.
Do not infer the method from older history — releases before `cacc724f` are merge commits.
This holds for releases cut outside `/ship-issue` (e.g. an extended review session), where the ship-prompt guidance is not loaded.

### Background agent guardrails

When delegating lint-fix or refactoring work to a background agent:

- Do not change function semantics (removing comparisons, altering control flow, removing defensive checks).
- Only add `eslint-disable` comments or make type-safe transformations (removing unused imports, adding type annotations).
- Include `pnpm -r run test` as a verification step before reporting completion.

### Parallel peer sessions (git worktrees)

Run two agents in parallel by giving each its own git worktree and its own interactive Pi session.
Use `/worktree <issue>` (the project-local `.pi/extensions/worktree.ts` command) or `scripts/worktree-new.sh <issue> [initial-command]` directly.
The launcher creates branch `issue-<N>-<slug>` off `origin/main`, checks out a worktree at `~/development/pi/pi-packages-worktrees/issue-<N>`, runs `pnpm install`, and spawns a new WezTerm tab whose CWD is the worktree, launching `pi --approve "/plan-issue <N>"`.

Key properties:

- CWD is set at spawn (`wezterm cli spawn --cwd`), never via `cd` — the peer session is born in its worktree, so the `pi-permission-system` `external_directory` gate never fires for its own work.
- `--approve` is required: Pi keys project trust by directory path, so each fresh worktree is untrusted and would otherwise block on a startup trust prompt.
- The initial slash command is passed as Pi's first positional message, which interactive mode runs through `session.prompt()` — the same path as typed input — so the prompt template expands and runs on startup.
- Tear down with `scripts/worktree-rm.sh <issue> [--delete-branch]`.

Convergence (the two-session ship flow):

The trunk `/ship-issue` assumes linear `main` and breaks for a worktree branch, so the convergence is split across the peer and root sessions:

1. Peer session — `/ship-worktree <N>`: run pre-push checks, run `/retro <N>` (committed on the branch so it rides the land), then `git fetch origin` + `git rebase origin/main`.
   The peer never touches `main`, never pushes the branch, never force-pushes — worktrees share the same `.git`, so the root sees the branch ref directly.
2. Root session — `/land-worktree <N>`: `git merge --ff-only <branch>` into `main`, push, verify CI, `issue_close`, then release.
   If the ff-merge is not a fast-forward (another peer landed first), the peer re-runs `/ship-worktree <N>` to rebase onto the new `origin/main`.
3. Release is the root's serialized responsibility — only the root merges the single release-please PR (by rebase), so peers never race on it.
   It honors the plan's `**Release:**` marker: `mid-batch — defer` leaves the PR open.
4. `/land-worktree` ends by running `scripts/worktree-rm.sh <N> --delete-branch`.

Guardrails:

- Partition work by package — one package per peer.
  Two peers touching `pnpm-lock.yaml`, `release-please-config.json`, or the same package's source is the main parallel-work hazard.
- `/ship-issue` is trunk-only; ship a worktree branch with `/ship-worktree` (peer) + `/land-worktree` (root), never `/ship-issue`.
- Whoever lands second rebases first: if `/land-worktree`'s ff-merge fails, the peer re-runs `/ship-worktree` to rebase onto the new `origin/main` (a non-linear merge into `main` is rejected by design).
- A first launch in each worktree reinstalls `.pi/npm/` (gitignored, so it does not carry over) — a one-time cost Pi handles automatically.

### Session naming convention

Each prompt template calls `set_session_name` (from `pi-session-tools`) to label the session automatically:

| Stage                | Session name format            |
| -------------------- | ------------------------------ |
| PR review            | `#N PR Review — <title>`       |
| Planning             | `#N Planning — <title>`        |
| TDD implementation   | `#N TDD — <title>`             |
| Build implementation | `#N Build — <title>`           |
| Shipping             | `#N Ship — <title>`            |
| Worktree ship (peer) | `#N Ship (worktree) — <title>` |
| Worktree land (root) | `#N Land — <title>`            |
| Retrospective        | `#N Retrospective — <title>`   |

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
Do not gate a commit (or any `&&` step) on a check piped through `tail`/`head` — a pipeline's exit status is the filter's, so a failed `pnpm run lint`/`check` is masked and the commit still runs.
Run the check unpiped, or test `${PIPESTATUS[0]}`.
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
