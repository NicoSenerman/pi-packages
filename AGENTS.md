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
- Keep config files the source of truth; do not bake policy into code.
- Hide denied tools from the agent before it starts (tool filtering + system-prompt sanitization).
- Keep block/ask/allow decisions reviewable: write to the permission review log by default.
- Preserve the `/permission-system` slash command name — renaming it is a breaking change.
- In the flat permission format, `permission["*"]` is the universal fallback; pattern ordering is last-match-wins.
- Wildcard matching must be explicit and tested — silent over-matching is a permission bypass.
- Prefer config patterns over new runtime mechanisms. Mechanism is forever; docs are reversible.
- Treat any declared config field not read at runtime as a maintenance trap.

## Code Style

Before implementing, refactoring, or reviewing code, load the `code-style` skill.
It covers TypeScript conventions, structural design heuristics (dependency width, Law of Demeter, output arguments), pnpm rules, and the ES2023 target.

Use TypeScript. This project uses **pnpm** exclusively — never `npm` or `npx`.

## Markdown

Before writing or editing markdown files, load the `markdown-conventions` skill.
It covers markdownlint rules, documentation frontmatter schema, and architecture doc conventions.

## Configuration

One unified config file per scope, following the `pi-autoformat` convention (`extensions/<id>/config.json`).

- **Global config**: `~/.pi/agent/extensions/pi-permission-system/config.json` (respects `PI_CODING_AGENT_DIR`)
- **Project config**: `<cwd>/.pi/extensions/pi-permission-system/config.json`
- **Per-agent overrides**: YAML frontmatter in agent definition files

Merge precedence: project overrides global; per-agent frontmatter overrides both.
The `permission` object uses deep-shallow merge; scalar fields use simple replacement.

- Schema: `schemas/permissions.schema.json`
- Example: `config/config.example.json`
- Keep schema, example, `README.md`, and TypeScript types/loaders aligned — changing one without the others is a bug.
- Project config must always override global config; per-agent frontmatter must override both.
- When removing a config field, keep the loader tolerant: detect the legacy key, emit a non-fatal config issue, and discard the value.
- When adding an optional field to `PermissionSystemExtensionConfig`, do not include it in `DEFAULT_EXTENSION_CONFIG` with an explicit `undefined` value — tests use `deepEqual` and it breaks equality.
- After a breaking config format change, verify the user's live global config is compatible before committing.

## Debugging

When investigating a reported bug in this extension:

1. First check the runtime environment: which extensions are loaded, from which paths, and whether any are loaded more than once.
   Run `pi --no-extensions -e .` to isolate this extension before instrumenting code.
2. Check `.pi/settings.json` and `~/.pi/agent/settings.json` for overlapping package entries.
3. Instrument only after confirming the bug reproduces in isolation.

## Testing

Before writing or debugging tests, load the `testing` skill.
It covers Vitest mock patterns, TDD planning rules, test strategy for permission resolution, and common pitfalls.

## Commits

Use Conventional Commits.
Commit at meaningful checkpoints without waiting for an explicit reminder.
Prefer small, reviewable commits that leave the repository in a valid state.

## Notes for Agents

Before implementing, understand:

1. the problem being solved
2. which permission surface is involved (tools / bash / mcp / skills / special / external_directory)
3. the merge precedence between global, project, and per-agent policies
4. whether the change renames the `/permission-system` slash command — if yes, it is breaking
5. the need to keep schema, example config, loader, and docs aligned

Do not assume "allow" is a safe default.
Do not add a permission surface without also adding a policy field, schema entry, and example.

When writing documentation that claims this extension lacks a feature, verify by searching `src/`, `docs/retro/`, and closed issues.

When planning a refactoring that targets testability, read the test files alongside the production code.
Tests reveal consumption ergonomics: mock depth, irrelevant fields, cast gymnastics, and override boilerplate define the target interface shape.

When planning a refactoring that touches handler wiring or shared interfaces, load the `design-review` skill to audit for structural smells before writing the plan.

When a plan depends on Node.js module resolution or filesystem layout varying by environment, verify the strategy empirically with a disposable script before committing.
