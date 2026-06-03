---
issue: 323
issue_title: "Replace GateRunnerDeps with a GateRunner class injected with role collaborators"
---

# Retro: #323 — Replace `GateRunnerDeps` with a `GateRunner` class injected with role collaborators

## Stage: Planning (2026-06-03T02:02:27Z)

### Session summary

Planned the final step of the gate-runner collaborator rework: convert the free `runGateCheck` function and its `GateRunnerDeps` bag into a `GateRunner` class constructed with four role collaborators, adding the two missing roles (`GatePrompter`, `SessionApprovalRecorder`).
Confirmed #319 (`PermissionResolver`) and #322 (`DecisionReporter`) have landed in `src/`, so both prerequisites are satisfied.
Produced a five-step lift-and-shift plan (roles + session adapters, `GateRunner` alongside a temporary `runGateCheck` wrapper, handler migration, deletion, architecture doc) and committed it.

### Observations

- Module placement: put `GatePrompter` and `SessionApprovalRecorder` in their own SDK-free files (`src/gate-prompter.ts`, `src/session-approval-recorder.ts`) to mirror the `permission-resolver.ts` / `decision-reporter.ts` precedent; co-locating `SessionApprovalRecorder` inside `session-approval.ts` was considered and rejected for consistency.
  Verified neither `permission-prompter.ts` nor `session-approval.ts` imports from `handlers/gates`, so the role interfaces import cleanly with no cycle.
- The prompter is the crux: `GatePrompter` (`canConfirm()` + `promptPermission(details)`) carries no `ctx`, so `PermissionSession` implements it with stored-context adapters over `this.context` (set by `activate(ctx)` at the top of `handleToolCall`).
  `canConfirm()` returns `false` when inactive, making the `promptPermission` null-guard unreachable in correct use — a defensive invariant only.
- Transition via lift-and-shift: `GateRunnerDeps` already structurally satisfies all four roles, so `runGateCheck` becomes a one-line wrapper (`new GateRunner(deps, deps, deps, deps.reporter).run(...)`) in step 2, letting the handler (step 3) and the large `runner.test.ts` (step 4) migrate independently before the wrapper, interface, and `makeRunnerDeps` are deleted together.
- Applied the #319-retro `missing-context` lesson proactively: grepped all session mocks up front.
  Three (`handler-fixtures.ts` `makeSession`, `external-directory-integration.test.ts`, `external-directory-session-dedup.test.ts`) are `as unknown as PermissionSession`, so the runtime runner calling `session.canConfirm()` / `session.promptPermission()` would fail at runtime, not typecheck.
  Step 3 adds delegating `canConfirm` → `canPrompt` / `promptPermission` → `prompt` adapters (guarded with `Object.hasOwn` like the existing `resolve` delegation) so the `prompt`-override and `session.prompt` call-count assertions in the dedup and tool-call suites keep passing.
- The delegating-mock tactic is a known transitional smell (#319 retro); flagged as removed by #325 when the handler is retyped against the role interfaces and the `as unknown as` casts drop.
- Scope held: behavior-preserving, no public npm export change (all `#src` internal), `handleInput` untouched, `as unknown as PermissionSession` deferred to #325.

## Stage: Implementation — TDD (2026-06-03T22:27:00Z)

### Session summary

Executed all five TDD cycles: added `GatePrompter` and `SessionApprovalRecorder` role interfaces with `PermissionSession` stored-context adapters (+5 new tests), introduced the `GateRunner` class alongside a transitional `runGateCheck` wrapper (+6 null/bypass dispatch tests), migrated `PermissionGateHandler` to the injected runner with delegating session mocks in all three integration-test harnesses, migrated `runner.test.ts` off `makeRunnerDeps`/`runGateCheck` to `makeGateRunner`/`runner.run` and deleted the wrapper + `GateRunnerDeps` + `makeRunnerDeps`, and updated the architecture doc.
Test count: 1770 → 1781 (+11).
Pre-completion reviewer verdict: PASS.

### Observations

- Step 1 deviation: `promptPermission`’s null guard used `throw new Error(...)` initially, which is synchronous and not a rejected promise; `expect(...).rejects.toThrow(...)` requires a rejected promise.
  Fixed by changing to `return Promise.reject(new Error(...))` — clean and avoids the `@typescript-eslint/require-await` lint rule that would fire on an `async` function with no `await`.
- Step 2 deviation: marking `runGateCheck` with `@deprecated` JSDoc triggered `@typescript-eslint/no-deprecated` on all 19 call sites in the test file at commit time.
  Removed the JSDoc tag and kept only a prose comment explaining the transitional nature.
- The `#319`-retro `missing-context` lesson applied cleanly: all three `as unknown as PermissionSession` session mocks were identified at plan time and received delegating `canConfirm`/`promptPermission` adapters in step 3 before the handler was migrated.
  The full handler integration suite (359 tests) stayed green throughout.
- Reviewer WARNs (both pre-existing, no action needed):
  1. `toolDescriptor.preCheck = toolCheck` patch-after-construction in the last gate producer — pre-dates this issue, out of scope.
  2. `const resolver = this.session` alias types as `PermissionSession` rather than `PermissionResolver` — explicitly deferred to #325 in the plan’s Non-Goals.
