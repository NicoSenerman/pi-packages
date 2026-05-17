---
name: package-pi-autoformat
description: |
  Package-specific context for @gotgenes/pi-autoformat.
  Load when working on code, tests, or docs in packages/pi-autoformat/.
---

# pi-autoformat

Pi extension that auto-formats files after agent edits so formatting does not fail late at commit time.

Read `docs/plans/` before making architectural changes.

## Implementation Priorities

- Prefer prompt-end formatting over immediate per-tool formatting unless the task explicitly requires otherwise.
- Favor repository-configured formatter commands over hardcoded formatter behavior.
- Prefer extension-owned config files over Pi `settings.json` keys for package-specific behavior.
- Format only files touched by the agent, not the whole repository.
- Make formatter failures visible, but do not block the original file edit by default.
- When a config pattern or documented recommendation can solve a problem, prefer that over a new runtime mechanism.
  Mechanism is forever; docs are reversible.
- Trust formatters to discover their own project configs (most walk up the directory tree natively).
  Do not reimplement formatter-side config resolution inside this extension.
- Treat any declared config field not read by the dispatcher as a maintenance trap.
  Remove it or document its purpose.

## Configuration

- Use extension-owned config files:
  - global: `~/.pi/agent/extensions/pi-autoformat/config.json`
  - project: `.pi/extensions/pi-autoformat/config.json`
- Project config overrides global config.
- Do not move package configuration into Pi `settings.json` without explicit discussion.
- Keep `schemas/pi-autoformat.schema.json`, `docs/configuration.md`, `README.md`, and the TypeScript config loader aligned.
- When removing a previously accepted config field, keep the loader tolerant: accept the legacy key, emit a single non-fatal config issue per occurrence describing the deprecation, and discard the value.

## Testing

- Test formatter resolution, execution order, and failure handling.
- Test prompt-end batching behavior.
- Test custom formatter command configuration.
- Test multiple formatter chains for the same file type.
- Test config loading, merge precedence, and validation issues.

## Notes for Agents

Before implementing, understand:

1. The problem being solved.
2. The timing tradeoffs between tool-mode and prompt-mode formatting.
3. The need to support repository-specific formatter chains.
4. The chosen config layout and merge precedence.
5. The need to keep schema, config loader, and docs aligned.

Do not assume commit-time hooks are an acceptable primary formatting mechanism.
