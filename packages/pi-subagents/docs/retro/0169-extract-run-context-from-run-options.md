---
issue: 169
issue_title: "refactor(pi-subagents): extract RunContext from RunOptions (12 fields)"
---

# Retro: #169 — extract RunContext from RunOptions

## Stage: Planning (2026-05-24T17:07:10Z)

### Session summary

Produced a plan to extract 4 parent-context fields (`exec`, `registry`, `cwd`, `parentSession`) from `RunOptions` into a nested `RunContext` interface.
The plan is a single-step refactor (all changes in one commit) plus a comment-update commit, affecting 3 source files and 3 test files.

### Observations

- The issue body proposed flat `parentSessionFile`/`parentSessionId` fields on `RunContext`, but #166 already grouped these into `ParentSessionInfo`.
  The plan uses `parentSession?: ParentSessionInfo` instead, preserving the existing grouping.
- `RunOptions` is purely internal — not exported via `service.ts` — so the refactor is non-breaking.
- All test call sites construct `RunOptions` inline (no `Partial<RunOptions>` spread patterns), so TypeScript will catch any missing `context` field at compile time.
- The change is small enough to land in a single TDD step — no lift-and-shift needed.
- Prerequisite #164 (directory reorganization) is already implemented.

## Stage: Implementation — TDD (2026-05-24T17:14:32Z)

### Session summary

Completed both TDD steps in one session.
Step 1 defined `RunContext`, updated `RunOptions`, migrated `runAgent()` reads to `options.context.*`, restructured `AgentManager.startAgent()`, and updated all 16 test call sites across 3 test files.
Step 2 updated comment references in `runtime.ts` and `session-config.ts`.
Test count unchanged (50 files, 805 tests — pure refactor with no behavior change).

### Observations

- The `agent-manager.test.ts` update also added two new assertions (`context.exec` and `context.registry` are defined) to each existing `getRunConfig` threading test, confirming the context object is wired correctly; these were not in the plan but add useful coverage.
- All 16 `runAgent()` call sites in tests used inline option literals (no spread patterns), so TypeScript caught any missed site at compile time — the plan's risk mitigation held.
- No deviations from the plan otherwise; the comment-only step was trivial.
