---
name: package-pi-permission-system
description: |
  Package-specific context for @gotgenes/pi-permission-system.
  Load when working on code, tests, or docs in packages/pi-permission-system/.
---

# pi-permission-system

Pi extension that enforces deterministic permission gates over tool, bash, MCP, skill, and special operations so the agent cannot silently exceed the policy a user has configured.

This package is a full fork of [`MasuRii/pi-permission-system`](https://github.com/MasuRii/pi-permission-system).
It began as a config-layout divergence (#10) and has since diverged substantially in config format, internal architecture, and permission model.
The `/permission-system` slash command name is the only upstream identity preserved.

Read `docs/plans/` before making architectural changes (created by `/plan-issue` on first use).

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
- When removing a config field, keep the loader tolerant: detect the legacy key, emit a non-fatal config issue, and discard the value.
- When adding an optional field to `PermissionSystemExtensionConfig`, do not include it in `DEFAULT_EXTENSION_CONFIG` with an explicit `undefined` value — tests use `deepEqual` and it breaks equality.
- When a config example sets a policy for `write`, include the same policy for `edit` — both tools modify files and users expect them gated together.

## Cross-Extension Integration

Pi's extension loader creates a fresh jiti instance per extension with `moduleCache: false`.
Module-scoped state is isolated — a variable set in this extension's module is invisible to other extensions.

Shared communication channels:

- **`pi.events`** (the event bus) — for fire-and-forget broadcasts and RPC.
- **`globalThis` + `Symbol.for()`** — process-global by spec, survives jiti isolation. Use for direct service access.

Do not propose module-scoped singletons or Node.js module-cache sharing as a cross-extension communication mechanism — they do not work under jiti.

## Testing

- Test permission resolution (allow/deny/ask decisions across tools, bash, MCP, skills, special).
- Test wildcard matching (bash patterns, skill globs) including over-match and under-match cases.
- Test policy merge precedence: global → project → per-agent frontmatter.
- Test system-prompt sanitization (denied tools removed, allowed tools preserved).
- Test the external-directory guard for path-bearing file tools.
- Test config loading, validation issues, and tolerance of deprecated keys.

## Debugging

When investigating a reported bug:

1. Check the runtime environment: which extensions are loaded, from which paths, and whether any are loaded more than once.
2. Check `.pi/settings.json` and `~/.pi/agent/settings.json` for overlapping package entries.
3. Instrument only after confirming the bug reproduces in isolation.

## Notes for Agents

Before implementing, understand:

1. The problem being solved.
2. Which permission surface is involved (tools / bash / mcp / skills / special / external_directory).
3. The merge precedence between global, project, and per-agent policies.
4. Whether the change renames the `/permission-system` slash command — if yes, it is breaking.
5. The need to keep schema, example config, loader, and docs aligned.

Do not assume "allow" is a safe default.
Do not add a permission surface without also adding a policy field, schema entry, and example.

When writing documentation that claims this extension lacks a feature, verify by searching `src/`, `docs/retro/`, and closed issues.

When planning a refactoring that targets testability, read the test files alongside the production code.

When planning a refactoring that touches handler wiring or shared interfaces, load the `design-review` skill to audit for structural smells before writing the plan.
