---
issue: 216
issue_title: "Decompose startAgent in agent-manager.ts (Phase 13, Step 3)"
---

# Retro: #216 — Decompose startAgent in agent-manager.ts

## Stage: Planning (2026-05-25T20:00:00Z)

### Session summary

Analyzed the `startAgent` method's structural problems beyond surface-level length.
The original issue proposed extracting three methods (`handleRunCompletion`, `handleRunError`, `finalizeBackgroundRun`).
Through design discussion, identified the root cause as **mutable closure state without an owner** — two `let` variables shared across three closures — and proposed a `RunHandle` lifecycle object as the missing collaborator.

### Observations

- The initial mechanical-extraction approach (3 methods) wouldn't have eliminated the mutable closure variables — `.then()`/`.catch()` would still close over `unsubRecordObserver` and `detach`.
  `RunHandle` eliminates these entirely by owning the resource-release handles.
- `WorktreeState` has an ask-tell smell: callers call `worktrees.cleanup()` then `worktreeState.recordCleanup()`.
  Adding `performCleanup()` is a small prep step that simplifies `RunHandle`'s completion/error methods.
- `record.description` is already available on `AgentRecord`, so `RunHandle` doesn't need `description` as a separate dependency — it can use `record.description` for worktree cleanup.
- `RunResult` is already exported from `agent-runner.ts`, so `RunHandle.complete()` can accept it directly without a new type.
- The `.catch()` handler doesn't wrap `onAgentCompleted` in try/catch while `.then()` does — `finalizeBackgroundRun` unifies this by always wrapping, preventing an observer error from blocking `drainQueue()`.
- `fireOnFinished` idempotency is important: if `complete()` throws after worktree cleanup but before returning, `.catch()` → `fail()` must not double-fire the background finalization.
  `AgentRecord`'s transition guards (`if (this._status !== "stopped")`) provide a second safety net.
