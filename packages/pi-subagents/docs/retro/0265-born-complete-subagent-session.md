---
issue: 265
issue_title: "Born-complete child execution; dissolve the runner"
---

# Retro: #265 — Born-complete child execution; dissolve the runner

## Stage: Planning (2026-05-30T02:30:00Z)

### Session summary

Produced the implementation plan for dissolving the `agent-runner` and introducing a born-complete `SubagentSession`.
Most of the session was a design dialogue that resolved naming, the turn-loop home, a discovered Law-of-Demeter cluster, and the workspace-ownership fork before any plan text was written.
Plan committed as `0265-born-complete-subagent-session.md`; a side-quest filed #277 and added an architecture-doc breadcrumb for discovered debt.

### Observations

- Vocabulary was pinned down explicitly because "execution" is overloaded: granular execution = one turn loop (one `session.prompt()`, run or resume); the born-complete object spans the whole session lifetime (run + resumes).
  The object is named `SubagentSession` (matches the existing `SubagentType` / `SubagentSessionDir` / `SubagentSessionRegistry` family; cohesive with the deferred `Agent` → `Subagent` rename).
  Turn driving is `runTurnLoop` / `resumeTurnLoop`; resume is *not* an SDK `session.resume()` — it is `session.prompt()` again on the retained session.
- The turn-loop home is **on `SubagentSession`** (methods), not inline on `Agent` and not a free function.
  The user caught that `subagent.driveTurnLoop(subagentSession.session, …)` is a Law-of-Demeter reach-through; putting the behavior on the object that owns the `AgentSession` is both LoD-correct and more testable (satisfying the user's conditional "inline only if straightforward to test").
- Workspace ownership locked to **Option A** (session-only `SubagentSession`; `Agent` keeps workspace prepare/dispose).
  Decisive reasoning: the workspace and the session have genuinely different lifetimes (workspace dies at run-completion to fold its `resultAddendum` into the result; session survives to cleanup for resume + the new registry boundary), so they are different resources.
  Option B would fuse them into one object needing two teardown methods, and would thread the `WorkspaceProvider` + prepare-context through the factory just to call `prepare()` — a parameter-relay smell the user flagged.
  The factory takes a resolved `cwd` value (used directly), never the provider.
- Worktrees are already out of the core (#263) — confirmed zero git code in `pi-subagents/src/` (only doc comments).
  The A/B fork is purely about how the core sequences its abstract `WorkspaceProvider` seam; `@gotgenes/pi-subagents-worktrees` is untouched.
- Registry semantics: moving `disposed` from run-completion to true session disposal makes resume executions registry-detected (closes the gap deferred from #261).
  The permission system's subscription code does not change; only *when* `disposed` fires moves.
  Edge case planned: `createSubagentSession` must dispose on a post-`session-created` failure to avoid a registry leak.
- Discovered debt captured (the user's "it is in doing the work that we discover the work to be done"): filed #277 for the remaining `agent.session` reach-throughs (steer buffer-or-deliver duplicated across `steer-tool` + `service-adapter`, conversation viewing, resume-readiness guards) and added a "Session encapsulation debt (Law of Demeter)" subsection to `architecture.md` (commit `038a1283`).
  `SubagentSession` exposes a `.session` accessor in #265 so observer wiring + consumers keep working; #277 retires those.
- Two follow-ups deliberately deferred and noted in the plan's Non-Goals / Open Questions: the `Agent` → `Subagent` class rename (mechanical, ~19 files — separate issue) and resume-aware workspaces (a worktree's lifetime is one turn loop; worktree + resume is degenerate today).
- The change is non-breaking (no `feat!:`): the dissolved types (`RunOptions`, `RunResult`, `AgentRunner`) are internal, so `public.d.ts` is unaffected.
  TDD order uses lift-and-shift across 7 steps to keep each commit compiling; transient duplication of the turn-loop helpers/assembly exists between steps 3–5 and is deleted in step 6.
