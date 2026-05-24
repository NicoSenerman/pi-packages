---
issue: 166
issue_title: "refactor(pi-subagents): extract ParentSessionInfo from AgentSpawnConfig (13 fields)"
---

# Retro: #166 — Extract ParentSessionInfo from AgentSpawnConfig

## Stage: Planning (2026-05-24T16:00:00Z)

### Session summary

Produced a 6-step TDD plan to extract `ParentSessionInfo` from `AgentSpawnConfig`.
The refactoring groups three co-traveling fields (`parentSessionFile`, `parentSessionId`, `toolCallId`) into a named value object, reducing `AgentSpawnConfig` from 13 to 11 fields.

### Observations

- The `SubagentsService` boundary (`service-adapter.ts`) does not pass any of the three fields, so this is a purely internal refactoring with no public API impact.
- `getSessionInfo` in `AgentToolDeps` returns only `parentSessionFile` and `parentSessionId`; `toolCallId` comes from the `execute` callback's first argument — the plan keeps this separation and merges them at the `agent-tool.ts` boundary.
- `RunOptions` in `agent-runner.ts` never carried `toolCallId` (it was consumed in `AgentManager.spawn` before reaching the runner), so the nested `parentSession` on `RunOptions` only holds the two session fields.
- The deep-merge trap from the testing skill is relevant: `background-spawner.test.ts` has a `makeParams` factory that spreads flat fields — must be converted to nested `parentSession` construction.
- Issue #165 (decompose `ResolvedSpawnConfig`) is closed, so this plan builds on stable ground.
