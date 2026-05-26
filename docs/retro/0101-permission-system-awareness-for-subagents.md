---
issue: 101
issue_title: "Native permission-system awareness for in-process subagents"
---

# Retro: #101 — Native permission-system awareness for in-process subagents

## Stage: Planning (2026-05-25T12:00:00Z)

### Session summary

Produced a cross-package plan for integrating pi-subagents with pi-permission-system's `SubagentSessionRegistry`.
All three prerequisite issues (#98, #99, #100) are implemented.
The plan 0221 `SubagentSessionRegistry` is already wired in pi-permission-system — the work is entirely on the pi-subagents side.

### Observations

- The user chose to rely on pi-permission-system's `before_agent_start` handler for tool filtering (no pre-filtering in pi-subagents) and to forward `ask`-state permissions to the parent UI.
  Both choices simplify the pi-subagents changes to a single new module (`permission-bridge.ts`) plus a few lines in `agent-runner.ts`.
- The critical ordering constraint is: register before `bindExtensions()`, unregister in `finally`.
  This ensures `isSubagentExecutionContext()` returns true on the first check during child extension initialization.
- pi-permission-system requires zero changes — the registry, detection, and forwarding mechanisms are already in place.
- The `PermissionsServiceConsumer` interface follows ISP with only 2 methods, avoiding a dependency on the full `PermissionsService` surface.
- Patch 3 (`<active_agent>` tag) remains the agent-name signaling mechanism; the registry provides child-session detection and forwarding target resolution, not name resolution.
