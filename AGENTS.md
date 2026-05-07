# AGENTS.md

## Project Purpose

This repository is a Pi extension that enforces deterministic permission gates over tool, bash, MCP, skill, and special operations so the agent cannot silently exceed the policy a user has configured.

This package is a full fork of [`MasuRii/pi-permission-system`](https://github.com/MasuRii/pi-permission-system).
It began as a config-layout divergence (#10) and has since diverged substantially in config format, internal architecture, and permission model.
The `/permission-system` slash command name is the only upstream identity preserved.

Read `docs/plans/` before making architectural changes (created by `/plan-issue` on first use).

## Workflow

- Keep scope tight.
- Prefer small, reversible changes.
- Preserve intentional behavior unless there is a clear reason to change it.
- Ask before removing functionality or changing defaults.

## Implementation Priorities

- Default to least privilege — when in doubt, prompt (`ask`), do not silently allow.
- Enforce permissions deterministically; the same policy + same input must always produce the same decision.
- Keep config files (`~/.pi/agent/extensions/pi-permission-system/config.json`, per-agent overrides) the source of truth; do not bake policy into code.
- Hide denied tools from the agent before it starts (tool filtering + system-prompt sanitization) so the agent does not waste turns probing for blocked tools.
- Keep block/ask/allow decisions reviewable: write to the permission review log by default and surface readable approval summaries in the dialog.
- Preserve the `/permission-system` slash command name — renaming it is a breaking change.
- In the flat permission format, `permission["*"]` is the universal fallback and each surface key is a direct rule source.
  Pattern ordering within a surface map matters: last-match-wins, so put broad catch-alls first and specific overrides after.
- Wildcard matching (bash patterns, skill globs) must be explicit and tested — silent over-matching is a permission bypass.
- When a config pattern or documented recommendation can solve a problem, prefer that over a new runtime mechanism. Mechanism is forever; docs are reversible.
- When a plan depends on Node.js module resolution, filesystem layout, or subprocess availability varying by environment (dev checkout vs. global install, npm vs. pnpm, Node.js vs. Bun), verify the strategy empirically with a disposable script before committing the plan.
  A strategy that works on paper may fail due to package-manager hoisting, virtual stores, or runtime differences.
- Treat any declared config field not read at runtime as a maintenance trap. Remove it or document its purpose.

## Code Style

- Use TypeScript.
- Avoid `any` unless absolutely necessary.
- Use standard top-level imports only.
- Keep modules focused and composable (one concern per file in `src/`: `bash-filter.ts`, `wildcard-matcher.ts`, `permission-manager.ts`, etc.).
- When writing handler functions that consume Pi SDK events, prefer lean local payload interfaces over full SDK event types.
  The SDK may not export all event interfaces, and exported types often require fields the handler does not read.
  Define a minimal interface with only the fields the handler uses (e.g., `interface SessionStartPayload { reason: string; }`).
- Prefer explicit configuration over hidden behavior.
- Permission decisions should be pure functions of (policy, request) wherever possible — keep IO at the edges.
- Do not cache `getAgentDir()` or other environment-derived values at module scope — tests set `PI_CODING_AGENT_DIR` after import.
  Call `getAgentDir()` at invocation time inside `piPermissionSystemExtension()` closures.
- This project uses **pnpm** exclusively (`"packageManager"` in `package.json`; `pnpm-lock.yaml`).
  Use `pnpm run`, `pnpm exec`, and `pnpm add` — never `npm` or `npx`.
  An npm shim in `scripts/bin/npm` (activated via `mise.toml`) blocks npm at the shell level; `npm root` is the sole pass-through (used by `discoverGlobalNodeModulesRoot` at startup).
- The tsconfig target is ES2023 (`noEmit: true`).
  ES2023 APIs (`findLast`, `findLastIndex`, `Array.prototype.toReversed`, `Array.prototype.toSorted`, `Array.prototype.toSpliced`, `Array.prototype.with`) are available and preferred over manual equivalents.
  Do not use APIs introduced after ES2023 (`Object.groupBy`, `Array.fromAsync`, etc.) — use manual equivalents consistent with existing code.

## Markdown

- Use one sentence per line (unbroken) for better diffs.
- Always specify a language on fenced code blocks (e.g., ` ```typescript `, ` ```bash `, ` ```jsonc `, ` ```text `); use `text` for plain output that has no specific syntax.
- Use sequential numbering (`1.` `2.` `3.`) in ordered lists, restarting at `1.` under each new heading — markdownlint's MD029 rejects continued numbering across section boundaries.
- Do not use bold text (`**...**`) as a substitute for headings — use proper Markdown heading syntax (`##`, `###`, `####`); markdownlint's MD036 rejects emphasis used as headings.
- When embedding markdown content that itself contains fenced code blocks, use a 4-backtick outer fence (` ````markdown `) so inner 3-backtick fences render correctly.
- Use compact table style with no cell padding — markdownlint's MD060 enforces consistent column style and is not auto-fixable.
  Write `| Risk | Mitigation |` with `| ---- | ---------- |`, not padded `| Risk··· | Mitigation··· |`.

## Configuration

One unified config file per scope, following the `pi-autoformat` convention (`extensions/<id>/config.json`).
Both runtime knobs and permission policy live in the same file:

- **Global config**: `~/.pi/agent/extensions/pi-permission-system/config.json` (respects `PI_CODING_AGENT_DIR`)
- **Project config**: `<cwd>/.pi/extensions/pi-permission-system/config.json`
- **Per-agent overrides**: YAML frontmatter in agent definition files (unchanged)
- Schema: `schemas/permissions.schema.json`
- Example: `config/config.example.json`

Merge precedence: project overrides global; per-agent frontmatter overrides both.
The `permission` object uses deep-shallow merge: string vs. string replaces; both-object shallow-merges pattern maps; string vs. object the override replaces the base entirely.
Scalar fields (`debugLog`, `permissionReviewLog`, `yoloMode`) use simple replacement.

Legacy paths (`~/.pi/agent/pi-permissions.jsonc`, `<cwd>/.pi/agent/pi-permissions.jsonc`, `<extension-root>/config.json`) are detected and merged with a migration warning for one release.

- After a breaking config format change, verify the user's live global config file is compatible before committing the final step.
  A format change that silently degrades to all-ask is a usability regression even if the code is correct.

Rules:

- Project config must always override global config; per-agent frontmatter must override both.
- Do not move package configuration into Pi `settings.json` without explicit discussion.
- Keep `schemas/permissions.schema.json`, `config/config.example.json`, `README.md`, and the TypeScript types/loaders aligned.
  Changing one without the others is a bug, not a refactor.
- When removing a previously accepted config field, keep the loader tolerant: detect the legacy key, emit a single non-fatal config issue pointing to the migration guide, and discard the value.
  Drop the field from the TypeScript types, the JSON schema, and the docs in the same change.
- When adding an optional field to `PermissionSystemExtensionConfig`, do not include it in `DEFAULT_EXTENSION_CONFIG` with an explicit `undefined` value.
  Tests use `assert.deepEqual` / `expect().toEqual` against the config object; an explicit `undefined` key fails deep equality against objects that omit the key.
  Set the field conditionally in `normalizePermissionSystemConfig` only when the raw input contains a valid value.

## Documentation frontmatter

Docs under `docs/plans/` and `docs/retro/` use YAML frontmatter for structured metadata.
GitHub renders it as a table at the top of the file.

Schema (both fields are strings/numbers — quote any title containing backticks or colons):

```yaml
---
issue: 14 # optional: omit for plans that predate issue tracking
issue_title: "Per-agent permission frontmatter overrides" # required
---
```

- `issue` stores the number only, never a URL.
- Do not duplicate frontmatter fields as inline metadata in the body (e.g. `Issue #N` in the H1 is fine; a separate `**Issue:** #N` line is not).
- Other doc types (`README.md`) do not use frontmatter.

## Architecture docs

- `docs/architecture/v3-architecture.md` is a historical snapshot — do not update it to reflect new work.
- `docs/architecture/target-architecture.md` is the living target — update it when work is completed or new gaps are identified.
- Per-module architecture notes (`docs/architecture/<module>.md`) describe the current implementation of that module.

## Testing

- Add focused tests for permission resolution (allow/deny/ask decisions across tools, bash, MCP, skills, special).
- Test wildcard matching (bash patterns, skill globs) including over-match and under-match cases.
- Test policy merge precedence: global → project → per-agent frontmatter.
- Test system-prompt sanitization (denied tools removed, allowed tools preserved, multi-block skill prompts).
- Test the external-directory guard for path-bearing file tools.
- Test config loading, validation issues, and tolerance of deprecated keys.
- When using `vi.mock()`, extract each `vi.fn()` stub to a module-scope variable and reset it in `beforeEach` — `vi.restoreAllMocks()` only operates on `vi.spyOn()` spies, not on `vi.fn()` instances.
  Use `.mockReset()` when the stub has no default implementation (each test sets its own return value).
  Use `.mockClear()` when the `vi.mock()` factory provides a default implementation that tests must preserve.
- When a `vi.mock()` factory references a module-scope `vi.fn()` stub, wrap the stub declaration in `vi.hoisted()` — Vitest hoists `vi.mock()` above normal declarations, so unhoisted variables are `undefined` when the factory runs.
- When mocking a class constructor with `vi.mock()`, use `vi.fn()` with no implementation — not `vi.fn(() => ({}))`.
  Arrow-function implementations are not constructable; `new MockClass()` throws `"is not a constructor"`.
- When mocking `node:*` built-in modules with `vi.mock()`, include a `default` key mirroring the named exports — omitting it causes "No default export defined on the mock" errors when any import uses the default.
- When writing TDD steps in a plan, ensure each feat step that changes behavior also accounts for existing tests that will break.
  Either fold the test updates into the same step or place a dedicated test-update step immediately before the feat step — never after it.
- When a TDD plan lists separate steps that share a type definition (e.g. `ResolvedPermissions`), changing that type in step N breaks steps N+1 … N+k.
  Either fold them into one step or introduce the new type alongside the old one in step N and migrate callers incrementally.
- When a plan adds a parameter that flows through callback chains (e.g. handler → runtime → forwarding → dialog), the “Module-Level Changes” section must list every file in the chain, not just the entry and exit points.
- When a fix changes shared helper functions (e.g. `findSection`, `normalizePolicy`), run the full test suite (`pnpm vitest run`) before committing — not just the directly affected test file.
  Helpers are often exercised by integration-level tests in other files.
- When integrating an unfamiliar library or data structure (AST parsers, WASM modules, new SDK types), write a disposable exploratory script first to inspect the actual runtime shape before writing production code or tests.
- When a test reveals a pre-existing bug rather than a wrong assumption, use `test.fails` to document the expected behavior and file a GitHub issue. Do not adjust the test to match the buggy behavior.
- Prefer a concrete test asserting current (even imperfect) behavior over `test.todo`.
  A real assertion documents the limitation and lets a future fix flip the expectation; a `test.todo` is invisible friction that never triggers CI.
- Vitest uses esbuild and does not typecheck. Run `pnpm run build` (`tsc -p tsconfig.json`) for type-only changes.
- When a TDD step changes a shared interface (e.g. `HandlerDeps`, event bus types), run `pnpm run build` immediately after that step's commit — not just at the end of the full cycle.
  Early type-checking catches cascading breakage in integration test harnesses that Vitest's esbuild pipeline silently ignores.
- When adding a field to a shared interface or widening the contract of an injected object (e.g. adding `on` to the event bus), grep for ALL test files that construct a compatible mock — not just `makeDeps` factories.
  Integration harnesses in `permission-system.test.ts` and `session-start.test.ts` construct raw `ExtensionAPI` stubs that bypass `makeDeps`.
- Do not insert no-op statements (`void 0;`, unused locals) in tests just to make an `Edit` tool's `oldText` unique — widen `oldText` with surrounding context instead.

## Commits

- Use Conventional Commits.
- Commit at meaningful checkpoints without waiting for an explicit reminder.
- Prefer small, reviewable commits that leave the repository in a valid state.
- Examples:
  - `feat: add per-agent frontmatter override merge`
  - `fix: tighten bash wildcard matcher for ' --' boundary`
  - `test: cover MCP tool-level deny precedence`
  - `docs: refine permission-system policy schema`

## Notes for Agents

Before implementing, understand:

1. the problem being solved
2. which permission surface is involved (tools / bash / mcp / skills / special / external_directory)
3. the merge precedence between global, project, and per-agent policies
4. whether the change renames the `/permission-system` slash command — if yes, it is breaking.
5. the need to keep schema, example config, loader, and docs aligned

Do not assume "allow" is a safe default. Do not add a permission surface without also adding a policy field, schema entry, and example.
