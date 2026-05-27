---
issue: 242
issue_title: "Rename `Agent` tool to `subagent`"
---

# Retro: #242 — Rename `Agent` tool to `subagent`

## Stage: Planning (2026-05-27T13:45:29Z)

### Session summary

Produced a plan for renaming the `Agent` tool to `subagent` across pi-subagents source, tests, README, and architecture docs.
Verified that pi-permission-system docs do not reference the `Agent` tool name and require no changes.
Scoped the plan to two commits: one `feat!:` for source + tests, one `docs:` for documentation.

### Observations

- The general-purpose agent type's `displayName` (`"Agent"` in `default-agents.ts` and `agent-types.ts` fallback) is a separate concept from the tool name and stays unchanged.
  Several test files assert this `displayName` — they are not affected by the rename.
- Issue #239 (Step 3, collapse `filterActiveTools`) is still open but independent — #242 only changes the string value in `EXCLUDED_TOOL_NAMES`, not its structure.
- The architecture doc already contains `(née \`Agent\`)` in the "What the core owns" section, anticipating the rename.
- The `widget-renderer.test.ts` comment references `"Agent"` as the general-purpose display name, not the tool name — only the comment text needs updating for clarity.
