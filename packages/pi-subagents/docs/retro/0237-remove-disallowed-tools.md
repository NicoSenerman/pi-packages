---
issue: 237
issue_title: "Remove disallowed_tools from pi-subagents (Phase 14, Step 1)"
---

# Retro: #237 — Remove disallowed_tools from pi-subagents

## Stage: Planning (2026-05-27T00:52:26Z)

### Session summary

Produced a 6-step TDD plan to remove `disallowedTools` from `AgentConfig`, `disallowedSet` from `ToolFilterConfig`, and all parsing/serialization/UI/test code that references them.
The plan covers 7 source files, 4 test files, README, and the architecture doc.

### Observations

- The issue label `pkg:pi-permission-system` was incorrect — all target files live in `packages/pi-subagents`.
  Confirmed with the user that the plan targets pi-subagents.
- The README still references `disallowed_tools` in the context of memory write-capability detection, but memory was already removed in #185.
  The plan treats this as a stale reference to clean up.
- After removing `disallowedSet`, the `filterActiveTools` `extensions === false` branch simplifies to a trivial passthrough (`return activeTools`), and both guard conditions at the call sites drop the `|| cfg.toolFilter.disallowedSet` arm.
  This leaves the function in the exact shape that Step 3 (#239) expects.
- The plan orders steps to follow the type dependency chain: `AgentConfig` first (surfaces all downstream errors), then `ToolFilterConfig`, then `filterActiveTools`, then UI, then docs.
