---
issue: 262
issue_title: "Add WorkspaceProvider extension seam"
---

# Retro: #262 — Add WorkspaceProvider extension seam

## Stage: Planning (2026-05-29T14:51:15Z)

### Session summary

Produced a numbered implementation plan for the Phase 16, Step 2 `WorkspaceProvider` seam (ADR 0002).
The plan adds the seam additively — `WorkspaceProvider` / `Workspace` interfaces, `SubagentsService.registerWorkspaceProvider`, run-start consultation, and `dispose` with a verbatim `resultAddendum` — while leaving the existing `isolation: "worktree"` path untouched for #263 to evict.
Three TDD steps (two `feat`, one `docs`).

### Observations

- Two ambiguous choices were surfaced via `ask_user` and resolved: **scope = additive seam only** (Option A — leave the legacy worktree path; #263 evicts it), and **duplicate registration = throw** (loud misconfiguration surface, disposer clears only the active provider).
- The package's public surface is `./src/service.ts` (per `package.json` `exports`), so the seam types are defined in a new core `src/lifecycle/workspace.ts` and re-exported from `service.ts` — avoiding a `service ↔ lifecycle` import cycle while still exposing them to the worktrees consumer.
- Diverged from the issue's literal `Disposable` return type: the repo convention for unsubscribe/unregister is a plain `() => void` (matching `SubscribableSession.subscribe` and `pi.events.on`); no `Symbol.dispose` usage exists anywhere in the codebase.
- Provider-first precedence was chosen so the new seam and the legacy worktree collaborator never silently conflict during the transient dual-path window (#263 collapses the branch).
- Headline risk is the ADR "no vacant hooks" rule: within #262 the seam is exercised only by test fakes, so it must land **alongside** #263 (`@gotgenes/pi-subagents-worktrees`) and not ship in a release on its own.
- Step 1 bundles the entire registration surface (types, `SubagentsService` method, adapter impl, `AgentManagerLike`, required `baseCwd`) into one commit because the interface method forces the adapter and the required field forces both construction sites — splitting would not type-check.
- Verified `test/service/service.test.ts` casts its mock `as unknown as SubagentsService`, so adding an interface method does not break it; flagged the `createManager` and `AgentManagerLike` mock updates for the `baseCwd` and registration additions.

## Stage: Implementation — TDD (2026-05-29T15:09:49Z)

### Session summary

Implemented the `WorkspaceProvider` seam across three TDD cycles (two `feat`, one `docs`): the registration surface (`AgentManager.registerWorkspaceProvider` + service/adapter delegation + `workspace.ts` types), run-start consumption in `Agent.run()` with provider-first precedence and `dispose`/`resultAddendum`, and an architecture-doc update.
Test count went from 1049 to 1061 (+12 new tests; +6 in `agent.test.ts`, +4 registration in `agent-manager.test.ts`, +1 adapter delegation, plus existing-helper additions).
All deterministic gates green: `check`, `lint`, `test`, and `fallow dead-code` (run from repo root).

### Observations

- Deviation from plan (Module-Level Changes): the plan said `service.ts` would re-export "the five seam types and `AgentStatus`", but `fallow dead-code` flagged those five re-exports as unused (no consumer until #263), and AGENTS.md forbids speculative re-exports.
  Resolved by re-exporting only `WorkspaceProvider` — a consumer assigning to it gets `Workspace` and the context types via inference; #263 adds named re-exports when it imports them.
  This is the concrete manifestation of the plan's headline "vacant hook" risk surfacing in the dead-code gate.
- Lint surprise: `WorkspaceDisposeResult | void` tripped eslint `no-invalid-void-type`.
  Changed the `dispose` return type to `WorkspaceDisposeResult | undefined` (equivalent — a side-effecting `dispose` that falls off the end returns `undefined`); minor divergence from the issue's literal `| void`.
- Three test mock factories implement `AgentManagerLike` in `service-adapter.test.ts` (`createMockManager`, `defaultManager`, `createTestManager`) — all three needed the new `registerWorkspaceProvider` stub; `tsc` caught the third after the first two were updated.
- Used `git commit --fixup` + `--autosquash` rebase twice (unpushed history) to fold the fallow trim into the Step 1 `feat` commit and the reviewer's doc-wording fix into the Step 3 `docs` commit, keeping each commit self-consistent.
- Pre-completion reviewer: WARN — all blocking checks pass; one non-blocking doc finding (architecture.md overstated that `Workspace` is re-exported).
  Addressed before finishing.
