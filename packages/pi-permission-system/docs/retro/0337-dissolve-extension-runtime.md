---
issue: 337
issue_title: "Dissolve ExtensionRuntime; one source of truth for session state"
---

# Retro: #337 — Dissolve ExtensionRuntime; one source of truth for session state

## Stage: Planning (2026-06-06T22:30:24Z)

### Session summary

Produced the implementation plan for Phase 4 Step 4: dissolving the `ExtensionRuntime` god object and unifying session state.
Confirmed Steps 1–3 (`#334`/`#335`/`#336`) are complete and that the transitional `RuntimeContextRef` seam was explicitly left for this step to retire.
Traced the split-brain through `index.ts`, `runtime.ts`, `config-store.ts`, `permission-session.ts`, `permission-event-rpc.ts`, `config-modal.ts`, and `permissions-service.ts`.

### Observations

- The codebase actually has *two* split-brains, not one.
  The documented one is `PermissionManager` / `SessionRules`: the gate path uses a separate `sessionManager` and `PermissionSession`'s private `new SessionRules()`, while the RPC check / config-modal / `LocalPermissionsService` read `runtime.permissionManager` / `runtime.sessionRules`.
  The second, quieter one is context: `ConfigStore` reads/writes `runtime.runtimeContext` via `RuntimeContextRef`, while `PermissionSession` owns its own private `this.context` — kept in sync only by `session_start` call order.
  The plan closes both.
- Decided to split delivery into a `fix:` commit (share single instances, minimal structural change, runtime object still present) and a `refactor:` commit (dissolve the runtime, retire `RuntimeContextRef`, delete `runtime.ts`).
  This isolates a real `fix:` (patch release) from behavior-preserving churn and keeps each commit green.
- `test/runtime.test.ts` is fully redundant: every path-derivation case already exists in `test/extension-paths.test.ts` against `computeExtensionPaths`; default-config in `config-store.test.ts`; logger wiring in `composition-root.test.ts`.
  Deletes cleanly with no coverage loss.
- `makeSession` in `handler-fixtures.ts` is a duck-typed mock, not a real `PermissionSession`, so the new injected `SessionRules` constructor slot only affects `permission-session.test.ts` `createSession` and `index.ts` — not the gate-handler fixtures.
- `src/runtime.ts` can be deleted outright rather than left as a re-export shell: no module imports `ExtensionPaths` from it (consumers already import from `extension-paths.ts`).
- Characterization-test approach: drive a gate session-approval through the composition root with a UI `ctx` whose `ui.select` returns `options[1]` (label-agnostic "for this session"), then assert the RPC check and `getPermissionsService().checkPermission` both report `allow`.
  Red on current code (RPC reads empty session rules), green after the fix.
- No `ask_user` needed — the issue's proposed change and the roadmap pin the design unambiguously.
