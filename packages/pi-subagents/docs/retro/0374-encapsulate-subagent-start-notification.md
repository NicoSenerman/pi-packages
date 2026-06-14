---
issue: 374
issue_title: "Encapsulate run start and notification attachment on Subagent"
---

# Retro: #374 — Encapsulate run start and notification attachment on Subagent

## Stage: Planning (2026-06-14T00:00:00Z)

### Session summary

Read issue #374 (Phase 17 Step 3 — output-argument encapsulation), loaded skills, explored `subagent.ts`, `subagent-manager.ts`, `notification-state.ts`, and all seven test files with external writes.
Produced a 4-step TDD plan in `packages/pi-subagents/docs/plans/0374-encapsulate-subagent-start-notification.md`.

### Observations

- The `notification` field was already constructor-wired in Phase 17 Step 2 (from `execution.parentSession?.toolCallId`); the remaining work is making both `promise` and `notification` externally read-only and updating the 7 + 3 test write sites.
- Steps 1 and 2 in the TDD order are effectively merged: introducing `private _promise` alongside the existing public `promise?` field is a TypeScript duplicate-identifier error, so the public field removal and all consumer updates must land in one atomic commit (`feat: make Subagent.promise read-only, add start() (#374)`).
- The status guard (`if (status !== "queued" && status !== "running")`) in `start()` allows foreground agents (constructed with `status: "running"`) to pass through cleanly, while stopping aborted-while-queued agents; this folds the inline guard out of the `SubagentManager` limiter callback.
- `service-adapter.test.ts` tests that set `record.promise = Promise.resolve()` only test that `toSubagentRecord()` strips the field — the setup is vestigial once `promise` becomes a getter; simply removing it is sufficient.
- The "waits for promise when wait=true" test in `get-result-tool.test.ts` needs a more realistic execution stub (`runTurnLoop` returning `{ responseText: "Finished after wait.", aborted: false, steered: false }`) so `record.start()` triggers the full run pipeline and calls `markCompleted()` internally.
- `TestSubagentOptions.toolCallId?: string` is the cleanest shorthand for the 5 test files that create passive records but need a `NotificationState`; it routes through `makeStubExecution({ parentSession: { toolCallId } })`, matching the production constructor path exactly.

## Stage: Implementation — TDD (2026-06-14T16:31:00Z)

### Session summary

Implemented all 4 plan steps in 2 substantive commits: one atomic `feat:` commit for `start()` + `promise`/`notification` read-only + all test site updates, and one `docs:` commit for the architecture doc.
Test count went from 975 to 981 (+6 new `start()` unit tests).
Pre-completion reviewer returned PASS with one WARN (stale test count in `package-pi-subagents` SKILL.md — fixed immediately).

### Observations

- Plan steps 1–3 landed in a single commit because making `notification` private required the same `subagent.ts` file as making `promise` private; splitting would have required complex partial staging.
- The `void record.start()` and `void this.limiter.schedule(...)` patterns were needed in `subagent-manager.ts` to satisfy `@typescript-eslint/no-floating-promises` — `start()` returns a `Promise<void>` but the manager stores the state internally; callers don't need to await it.
- The "waits for promise when wait=true" test in `get-result-tool.test.ts` required `void record.start()` (intentional fire-and-forget) for the same reason.
- Grep-verifiable outcome confirmed: `\.promise =` and `\.notification =` appear only inside `subagent.ts` (as `this._promise =` and `this._notification =`).
- Pre-completion reviewer: PASS (no FAIL findings; WARN on stale skill test count addressed inline).
