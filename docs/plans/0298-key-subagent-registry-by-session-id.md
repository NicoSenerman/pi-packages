---
issue: 298
issue_title: "Concurrent subagent siblings collide on one registry key — a finishing sibling unregisters the shared entry and blocks the others' ask forwarding"
---

# Key the subagent session registry by child session id

## Problem Statement

`SubagentSessionRegistry` borrows the child's session *directory* as its identity key.
`@gotgenes/pi-subagents` derives that directory from the parent session file alone (`<parent-dir>/<parent-basename>/tasks`), so every concurrent child of the same parent registers under the **identical** key.
What actually differs per child is the transcript *filename* (`<timestamp>_<sessionId>.jsonl`) inside that directory — not the directory itself.

The overwrite on `register` is benign (siblings share the same `parentSessionId`, and the stored `agentName` is never read).
The `disposed` handler is the bug: it is an unconditional `Map.delete(key)` with no notion that the key has multiple live occupants.
When the first sibling finishes, it deletes the shared entry, and every still-running sibling silently stops being detected as a subagent — `isSubagentExecutionContext()` returns `false`, so their `ask` decisions get blocked instead of forwarded for the rest of their lives.

The natural per-child identity is the session id, which is already unique per child and available on both the producer side (`sessionManager.getSessionId()` after `newSession()`) and the consumer side (`ctx.sessionManager.getSessionId()`).
This plan re-keys the registry on the child session id, fixing the identity confusion at its root rather than masking it with a refcount.

## Goals

- Each concurrent child is detected independently; one sibling's `disposed` never affects another sibling's detection or `ask` forwarding.
- Key `SubagentSessionRegistry` on the **child session id** instead of the session directory path.
- Carry the child `sessionId` on the `subagents:child:session-created` and `subagents:child:disposed` lifecycle events, **replacing** the `sessionDir` field on those two events.
- Remove the vestigial `agentName` from the registry entry (`SubagentSessionInfo`) and from the `session-created` payload — it is never read (gates resolve the agent name from the `<active_agent>` system-prompt tag, not the registry).
- **Breaking (event contract):** the `subagents:child:session-created` / `:disposed` payloads change shape; external subscribers that read `sessionDir`/`agentName` off those two events break.

## Non-Goals

- The `subagents:child:spawning` and `subagents:child:completed` event payloads are **unchanged** (they keep `agentName`; `completed` keeps `sessionDir` as the transcript location).
- The on-disk session layout (`<parent>/<basename>/tasks/`) and session discovery/resume are unchanged — this plan does **not** give each child a unique directory (the rejected alternative).
- The forwarding-request file path (keyed by `parentSessionId`) is unaffected.
- The env-var and filesystem-heuristic detection branches for process-based subagent extensions are unchanged.
- `#296` (process-global registry storage) is already landed; this plan builds on it and does not revisit `globalThis` storage.

## Background

Relevant modules and their roles:

- `@gotgenes/pi-subagents`
  - `src/lifecycle/child-lifecycle.ts` — declares the lifecycle event channel names and payload shapes, and the `createChildLifecyclePublisher` that emits them.
  - `src/lifecycle/create-subagent-session.ts` — the born-complete session factory; calls `sessionManager.newSession(...)`, then emits `sessionCreated(...)` before `bindExtensions()`.
    Its `SessionManagerLike` IO interface declares only `newSession` / `getSessionFile` today.
  - `src/lifecycle/subagent-session.ts` — the `SubagentSession` value object; its `meta` carries `sessionDir`/`agentName`, emits `completed(...)` in `runTurnLoop`, and emits `disposed(...)` in `dispose()`.
  - `src/session/session-dir.ts` — `deriveSubagentSessionDir`; unchanged (still groups transcripts under the parent).
- `@gotgenes/pi-permission-system`
  - `src/subagent-registry.ts` — `SubagentSessionRegistry` + the process-global `getSubagentSessionRegistry()` accessor.
  - `src/subagent-lifecycle-events.ts` — subscribes to the two lifecycle channels and writes/removes registry entries; declares its own duck-typed copy of the payload shapes.
  - `src/subagent-context.ts` — `isSubagentExecutionContext()`; branch 1 keys on the registry.
  - `src/permission-forwarding.ts` — `resolvePermissionForwardingTargetSessionId()`; branch 1 reads `parentSessionId` from the registry.
  - `src/forwarded-permissions/polling.ts` — `waitForForwardedPermissionApproval()` wires both functions; already computes `requesterSessionId = getSessionId(ctx)`.

Key constraint from `AGENTS.md` / the package skills:

- The two packages **must not import each other** under jiti; the event contract is a runtime channel-name + duck-typed payload, declared independently on each side.
  They are therefore **type-decoupled** (a producer payload change does not type-break the consumer) but **runtime-coupled** (both sides must agree on the field name for forwarding to work).
- The `session-created` handler MUST stay synchronous (the core emits it on the same call stack right before `bindExtensions()`); this plan does not introduce any `await` before `registry.register(...)`.
- Treat any declared field not read at runtime as a maintenance trap — this motivates dropping `agentName` rather than leaving it vestigial.

## Design Overview

### Decision model

The registry key becomes the child session id on both sides:

- Producer (`@gotgenes/pi-subagents`): emits the child's `sessionId` (from `sessionManager.getSessionId()`) on `session-created` and `disposed`.
- Consumer (`@gotgenes/pi-permission-system`): the lifecycle subscriber registers/unregisters by `event.sessionId`; detection and forwarding-target resolution look up by `ctx.sessionManager.getSessionId()`.

Because the parent's permission-system instance registers under the child's session id (carried on the event), and the child's separate jiti instance reads the same process-global store via its own `getSessionId()`, both sides resolve the same key — and two siblings now occupy two distinct keys, so one `disposed` cannot evict the other.

### Data shapes

`@gotgenes/pi-subagents` — `src/lifecycle/child-lifecycle.ts`:

```typescript
/** Payload for `subagents:child:session-created`. */
export interface ChildSessionCreatedEvent {
  /** Child session id — the registry key. */
  sessionId: string;
  parentSessionId?: string;
}

/** Payload for `subagents:child:disposed`. */
export interface ChildDisposedEvent {
  /** Child session id — the registry key. */
  sessionId: string;
}

// Unchanged: ChildSpawningEvent, ChildCompletedEvent (still carry agentName; completed keeps sessionDir).
```

`@gotgenes/pi-permission-system` — `src/subagent-registry.ts`:

```typescript
/** Signal stored per registered in-process subagent session. */
export interface SubagentSessionInfo {
  /** Parent session id for permission forwarding. Omit when unknown. */
  parentSessionId?: string;
}
```

`@gotgenes/pi-permission-system` — `src/subagent-lifecycle-events.ts` (its own duck-typed copy):

```typescript
interface ChildSessionCreatedEvent {
  sessionId: string;
  parentSessionId?: string;
}
interface ChildDisposedEvent {
  sessionId: string;
}
```

### Consumer call-site sketch (detection)

`isSubagentExecutionContext()` keeps reading `getSessionDir()` for the filesystem-heuristic branch (branch 3, used by other extensions), but branch 1 now keys on the session id:

```typescript
const sessionId = ctx.sessionManager.getSessionId?.();
// 1. Explicit registry — in-process subagents register by child session id.
if (registry && sessionId && registry.has(sessionId)) {
  return true;
}
const sessionDir = ctx.sessionManager.getSessionDir();
// 2. env hints …  3. filesystem heuristic on sessionDir …
```

This stays Tell-Don't-Ask-clean: the function asks the context for two flat values it already exposes and consults the registry; no reaching through nested objects.

### Producer call-site sketch (factory)

```typescript
sessionManager.newSession({ parentSession: params.parentSession?.parentSessionId });
const sessionId = sessionManager.getSessionId();
// … create session, build SubagentSession with meta.sessionId = sessionId …
deps.lifecycle.sessionCreated({ sessionId, parentSessionId });
```

`SubagentSession.dispose()` then emits `disposed({ sessionId: this.meta.sessionId })`.
`meta.sessionDir`/`meta.agentName` remain only because `runTurnLoop` still emits them on the untouched `completed` event.

### Edge cases

- `getSessionId()` unavailable/empty: branch 1 simply misses (no registry hit) and detection falls through to env/filesystem — identical to a registry miss today.
  The forwarding path's existing `getSessionId(ctx)` helper returns the `"unknown"` sentinel on failure, which never matches a real registry key (no behavior change).
- Fallback (non-persisted parent) sessions still produce a real per-child session id from `newSession()`, so keying is correct even when `deriveSubagentSessionDir` returns a temp directory.

## Module-Level Changes

`@gotgenes/pi-subagents`:

- `src/lifecycle/child-lifecycle.ts` — `ChildSessionCreatedEvent`: drop `sessionDir` + `agentName`, add `sessionId`; `ChildDisposedEvent`: replace `sessionDir` with `sessionId`; update the "registry key" doc comment.
- `src/lifecycle/create-subagent-session.ts` — add `getSessionId(): string` to the `SessionManagerLike` interface; capture `sessionId` after `newSession()`; thread it into the `SubagentSession` meta; emit `sessionCreated({ sessionId, parentSessionId })`.
- `src/lifecycle/subagent-session.ts` — add `sessionId: string` to `SubagentSessionMeta` (keep `sessionDir`/`agentName` for `completed`); `dispose()` emits `disposed({ sessionId: this.meta.sessionId })`.

`@gotgenes/pi-permission-system`:

- `src/subagent-registry.ts` — `SubagentSessionInfo`: remove `agentName`; rename the method parameter `sessionKey` → `sessionId` for intent; rewrite the file/class docstrings (keyed by child session id; drop the "concurrent siblings share a key / tracked in #298" caveat).
- `src/subagent-lifecycle-events.ts` — update both duck-typed payload interfaces (`sessionId`, drop `sessionDir`/`agentName`); `register(event.sessionId, { parentSessionId: event.parentSessionId })`; `unregister(event.sessionId)`; refresh the "must match the publisher" docstring.
- `src/subagent-context.ts` — branch 1 keys on `ctx.sessionManager.getSessionId()`; keep `getSessionDir()` for the filesystem-heuristic branch.
- `src/permission-forwarding.ts` — `resolvePermissionForwardingTargetSessionId`: replace the `sessionDir?` option with `sessionId?`; look up `registry.get(options.sessionId)`.
- `src/forwarded-permissions/polling.ts` — pass `sessionId: requesterSessionId` to the resolver; drop the now-unused `sessionDir` local in `waitForForwardedPermissionApproval` (confirmed it is used nowhere else in that function).

Docs (verify and update — these reference the directory-keying as fact):

- `packages/pi-permission-system/docs/architecture/architecture.md` — the "Detection" section ("registry keyed by session directory path" → "keyed by child session id") and the "Parent-session resolution" section ("provides a `sessionDir`" → "provides a `sessionId`").
- Grep `packages/pi-subagents/docs/subagent-integration.md` (referenced from the permission-system arch doc) and the `child-lifecycle.ts` header for any "registry key = directory" wording; update if present.
- No change needed to the package `SKILL.md` files (neither asserts directory keying); the `subagent-registry.ts` docstring caveat referencing #298 is removed as part of the source change above.

## Test Impact Analysis

1. New tests enabled by the re-key:
   - `subagent-lifecycle-events.test.ts`: a sibling-collision regression — two `session-created` events with **distinct** `sessionId`s, then one `disposed`; assert the other session id remains registered.
     This is the direct regression guard for #298, now expressible because the key is per-child.
   - `subagent-context.test.ts`: registry-detection driven by `ctx.sessionManager.getSessionId()` rather than `getSessionDir()`.
2. Tests that become redundant / change meaning:
   - `subagent-registry.test.ts`: the `agentName`-storage assertions are dropped (field removed); the "multiple keys are independent" test is reframed in terms of session ids (its intent — independence — is preserved and is exactly the property #298 needs).
3. Tests that must stay as-is:
   - `subagent-context.test.ts` env-hint and filesystem-heuristic suites (branches 2 and 3 are untouched).
   - `permission-forwarding.test.ts` env-var resolution suite (branch 2 unchanged).
   - pi-subagents `subagent-session.test.ts` `completed`-event assertions (that event keeps `sessionDir`/`agentName`).

## TDD Order

1. **pi-permission-system — registry + lifecycle subscriber keyed by session id, `agentName` removed.**
   Surface: `subagent-registry.test.ts`, `subagent-lifecycle-events.test.ts`.
   Covers: `SubagentSessionInfo` without `agentName`; `register`/`unregister` by `sessionId`; the new sibling-collision regression (two ids, one disposed, other survives).
   Folded into one commit because removing `agentName` from `SubagentSessionInfo` breaks `subagent-lifecycle-events.ts` and both test files at the type / excess-property level.
   Commit: `fix(pi-permission-system): key subagent registry by session id and drop vestigial agentName`

2. **pi-permission-system — detection + forwarding-target resolution by session id.**
   Surface: `subagent-context.test.ts`, `permission-forwarding.test.ts` (and the `makeCtx` helper gains `getSessionId`).
   Covers: branch 1 of `isSubagentExecutionContext` keyed on `getSessionId()`; `resolvePermissionForwardingTargetSessionId` taking `sessionId`; `polling.ts` passing it.
   Independent of step 1's type change (these read only `parentSessionId`/`has`), so it stays a separate, reviewable commit.
   Commit: `fix(pi-permission-system): resolve subagent detection and forwarding target by session id`

3. **pi-subagents — carry child session id on the two registry-driving events.**
   Surface: `child-lifecycle.test.ts`, `create-subagent-session.test.ts`, `subagent-session.test.ts` (and the `subagent-session-io.ts` helper's `createSessionManager` mock gains `getSessionId`).
   Covers: `ChildSessionCreatedEvent`/`ChildDisposedEvent` shape; factory emitting `sessionId`; `SubagentSession.dispose()` emitting `sessionId`.
   One commit because the payload-interface change breaks the publisher, the factory emit, the dispose emit, and all three test files together within the package.
   This is a **breaking** event-contract change (fields removed from public lifecycle events).
   Commit: `fix(pi-subagents)!: carry child session id on session-created/disposed lifecycle events` with a `BREAKING CHANGE:` footer describing the payload shape change.

4. **Docs — describe the session-id-keyed registry.**
   Surface: `packages/pi-permission-system/docs/architecture/architecture.md` (+ `subagent-integration.md` if it documents the key).
   Commit: `docs(pi-permission-system): describe session-id-keyed subagent registry`

Ordering note: the two packages are type-decoupled, so `pnpm -r run test` stays green after every commit regardless of order; steps 1–2 (consumer) precede step 3 (producer) only for narrative clarity.

## Risks and Mitigations

- Runtime-coupling window: between merging the consumer change and the producer change, an installed mix could have the producer still emitting `sessionDir` while the consumer reads `sessionId` (or vice versa), breaking forwarding.
  Mitigation: ship both package changes in the same PR/release cycle; the monorepo releases them together, and the issue already sequences this work as a unit.
- Breaking event contract for third-party subscribers reading `sessionDir`/`agentName` off `session-created`/`disposed`.
  Mitigation: call it out explicitly (Goals + `!` commit + `BREAKING CHANGE:` footer); the only in-repo consumer is updated in the same change.
- `SubagentSessionInfo` is an exported type — removing `agentName` is breaking if it is re-exported on the package's public surface.
  Mitigation: confirm during implementation that it is internal (not in the `exports` public type bundle); if it is public, note it in the breaking-change footer.
- A future code path that needs the child's `agentName` from the registry would have to re-add it.
  Mitigation: the agent name is already available via `tcc.agentName` / the `<active_agent>` tag, which is the supported resolution path; document this in the registry docstring.

## Open Questions

- None blocking.
  If `subagent-integration.md` turns out to specify `sessionDir` as the documented registry key for external authors, fold its update into step 4 rather than deferring.
