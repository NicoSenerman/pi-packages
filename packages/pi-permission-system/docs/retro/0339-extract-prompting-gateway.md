---
issue: 339
issue_title: "Extract a context-owning PromptingGateway; collapse the prompt twins"
---

# Retro: #339 — Extract a context-owning PromptingGateway; collapse the prompt twins

## Stage: Planning (2026-06-07T14:21:40Z)

### Session summary

Produced the implementation plan for Phase 4 Step 6: extracting a `PromptingGateway` collaborator out of `PermissionSession` and collapsing the `canPrompt`/`canConfirm` and `prompt`/`promptPermission` twins into a single context-bound pair.
Confirmed the prerequisite Step 1 ([#334]) is closed and the issue only depends on it; Steps 7/8 ([#340]/[#341]) are downstream.
Plan filed at `packages/pi-permission-system/docs/plans/0339-extract-prompting-gateway.md`.

### Observations

- Two design choices surfaced via `ask_user`: (1) rename `GatePrompter.promptPermission` → `prompt` (chosen, matches the issue's literal `prompt(details)`); (2) full clean end state via lift-and-shift for the test fixtures (chosen over a minimal bridge).
- Decided the gateway absorbs the can-prompt policy (`canResolveAskPermissionRequest` + `isSubagentExecutionContext`), not just a relayed closure, so the `index.ts` `canRequestPermissionConfirmation` closure disappears (index closures 11 → 10, matching the roadmap claim at architecture.md line 669).
  Trade-off: gateway deps widen to 4 fields (`config`, `subagentSessionsDir`, `registry`, `prompter`), all used.
- Key constraint identified: the session still needs `this.context` for `getRuntimeContext`/`reload`/`logResolvedConfigPaths`, so this step accepts a transitional dual context store (session copy + gateway copy), synchronized through the single `activate`/`deactivate` path.
  Consolidation deferred to Step 8.
- The session forwards `activate`/`deactivate` to the gateway, mirroring the existing `forwarding.start/stop` pattern — this keeps the production change inside the four target files (`prompting-gateway.ts`, `permission-session.ts`, `runner.ts`, `index.ts`) since every existing `session.activate(ctx)` call site inherits gateway activation.
- Heaviest area is test migration: `MockGateHandlerSession` is the shared pivot; removing its `GatePrompter` fields breaks every constructor at once.
  The `promptPermission` → `prompt` rename also collides with the session's own `prompt(ctx, details)` until the session drops `GatePrompter`, so the rename must land *after* the rewire (cycle 3, not cycle 1).
  `input.test.ts` asserts on `session.promptPermission` directly, and `external-directory-session-dedup.test.ts` has its own local `makeStatefulSession`/`makeHandlerForSession` — both require migration.
- Plan uses a 9-cycle lift-and-shift: add gateway → rewire + bridge → rename → migrate 5 handler suites → drop bridge.
  Small adjacent suites may be grouped.

[#334]: https://github.com/gotgenes/pi-packages/issues/334
[#340]: https://github.com/gotgenes/pi-packages/issues/340
[#341]: https://github.com/gotgenes/pi-packages/issues/341
