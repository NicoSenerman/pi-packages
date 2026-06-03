---
issue: 322
issue_title: "Extract a DecisionReporter for permission gate review-log and decision events"
---

# Retro: #322 — Extract a DecisionReporter for permission gate review-log and decision events

## Stage: Planning (2026-06-03T00:47:01Z)

### Session summary

Planned the extraction of a `DecisionReporter` interface + `GateDecisionReporter` class that owns the `SessionLogger` and the event bus, removing the `writeReviewLog`/`emitDecision` closures and the Law-of-Demeter reach-through to `session.logger.review` from `PermissionGateHandler`.
Confirmed #319's `PermissionResolver` work has already landed in `src/`, so the prerequisite is satisfied despite the issue still being open.
Produced a four-step plan (new module + test, atomic runner wiring, `handleInput` adoption, architecture doc) and committed it.

### Observations

- Key design fork surfaced via `ask_user`: how the reporter reaches `runGateCheck`.
  Rejected a 5th positional parameter in favor of carrying `reporter: DecisionReporter` inside the `GateRunnerDeps` bag.
  The user's read — that `runGateCheck` is "hiding a class … instantiated with what they need to act on the extemporaneous data" — confirms the #323 trajectory: the bag's stable role collaborators become `GateRunner` constructor fields while `descriptor`/`agentName`/`toolCallId` stay per-call arguments.
  The bag is the deliberate intermediate, not the destination.
- Second `ask_user` decision: route `handleInput` through the same constructor-built reporter (chosen), removing a second reach-through and `unbound-method` disable.
  Building the reporter once in the constructor (not per `handleToolCall`) is the faithful reading of "build it once" and enables the `handleInput` reuse.
- Test churn is narrow: the four handler integration test files need **no** changes because they assert through the real event bus (`getDecisionEvents` on `events.emit`) and the `session.logger.review` mock — both routed identically by the reporter.
  Churn is concentrated in `gate-fixtures.ts` `makeRunnerDeps` and ~13 `runner.test.ts` assertion sites (`deps.reporter.*`), plus a new `decision-reporter.test.ts`.
- Mid-plan correction from the user: the architecture doc's gate-runner decomposition chain (row 6, Step 6 Outcome, Track C summary, `S6` Mermaid node) stops at #323 and omits #325 — the phase capstone that retypes `PermissionGateHandler` against the role interfaces and drops the `as unknown as PermissionSession` casts.
  Step 4 of the plan now threads #325 into every link in that chain and adds the missing `[#325]` link reference, even though #325's residual-cluster decomposition is still nebulous.
- `step 2` is the single mandated atomic commit: removing the two inline members from `GateRunnerDeps` breaks the descriptor, runner, handler, fixture, and runner test at the type level simultaneously, so they move together.
- Scope held tight: `emitDecisionEvent` and the `permissions:decision` channel are untouched; the reporter wraps the existing primitive.
  No public export is removed or renamed (member swap on an exported interface only).
