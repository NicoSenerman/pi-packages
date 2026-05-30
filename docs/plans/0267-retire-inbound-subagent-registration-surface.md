---
issue: 267
issue_title: "Finish the inversion: retire inbound subagent-registration surface from PermissionsService"
---

# Retire the inbound subagent-registration surface from `PermissionsService`

## Problem Statement

Phase 16 inverted the dependency between `@gotgenes/pi-subagents` and `@gotgenes/pi-permission-system` ([#261], ADR 0002).
The core now *publishes* its child-execution lifecycle on `pi.events`; the permission system *subscribes* (`subscribeSubagentLifecycle`) and registers/unregisters child sessions on `subagents:child:session-created` / `subagents:child:disposed`.
The core no longer reaches out to the permission system's published service.

That leaves `registerSubagentSession` / `unregisterSubagentSession` on the `PermissionsService` interface as an inbound RPC with no in-process caller.
`fallow` will flag them, and a vacant inbound API contradicts the inversion.
This issue finishes the inversion: it removes those two methods (and the dead surface that trailed behind them) so registration flows *only* through the event subscription.

## Goals

- Remove `registerSubagentSession` and `unregisterSubagentSession` from the `PermissionsService` interface and its implementation.
- Remove the now-orphaned `SubagentSessionInfo` re-export from the public service module.
- Remove the corresponding test cases and update the test helpers so the suite compiles and passes.
- Reconcile every doc that describes registration as an inbound service call so it describes the event-subscription mechanism instead.
- Refresh the stale `@gotgenes/pi-subagents` `README.md` sections left behind by the Phase 16 work (full refresh — see Decision below).
- This is a **breaking** change to the published `PermissionsService` interface; suggested commit for the interface removal uses `feat!:`.

## Non-Goals

- Removing or changing the `SubagentSessionRegistry` class itself — only the externally-exposed inbound methods go.
  The registry stays; the event subscriber and the in-process forwarding/detection paths keep using it.
- Registry-semantics changes (executing-now vs. exists) for resume detection — tracked separately on [#265] (closed) and already addressed there; out of scope here.
- Touching the event publisher (`child-lifecycle.ts`) or the subscriber (`subagent-lifecycle-events.ts`) — the live mechanism is unchanged.
- Editing `.pi/settings.json` or `~/.pi/agent/settings.json` — load order is not a functional concern (see Risks), and these are harness/machine config, not a deliverable of this issue.
- The deprecated event-bus RPC (`permissions:rpc:check`) and prompt-forwarding RPC — they stay as documented fallbacks.

## Background

Relevant modules:

- `packages/pi-permission-system/src/service.ts` — the `PermissionsService` interface, the `Symbol.for()` accessor functions, and the `SubagentSessionInfo` re-export.
  The package's `exports["."]` points directly at this file (no rollup; ship-source), so removing a method here is the public-API change.
- `packages/pi-permission-system/src/index.ts` — the extension factory builds the `permissionsService` object literal (the only construction site) and wires `subscribeSubagentLifecycle(pi.events, subagentRegistry)`.
- `packages/pi-permission-system/src/subagent-registry.ts` — defines `SubagentSessionRegistry` and `SubagentSessionInfo`; its class doc comment still cites the two methods as the external surface.
- `packages/pi-permission-system/src/subagent-lifecycle-events.ts` — the live subscriber; declares its own payload interfaces independently and does **not** import `SubagentSessionInfo`.
- `packages/pi-permission-system/test/service.test.ts` — `makeService` helper plus two delegation tests and two `getToolPermission` literals that name the methods.

Constraints from AGENTS.md and skills:

- Barrel discipline (AGENTS.md): "Do not add speculative re-exports; fallow will flag them as dead code."
  Once the methods are gone, the `SubagentSessionInfo` re-export from `service.ts` is dead public surface and must be removed.
- Removing fields from a shared interface that has a single object-literal construction site means the interface change and the call-site update must land in the **same** commit (TypeScript excess-property checking rejects the stale methods immediately) — testing skill, "single call site" rule.
- Keep schema/example/README/types aligned (permission-system skill) — not triggered here (no config field changes), but docs alignment is in scope.

## Design Overview

The change is a pure removal plus doc reconciliation; there is no new data shape.

The public interface shrinks from four methods to two:

```typescript
export interface PermissionsService {
  checkPermission(
    surface: string,
    value?: string,
    agentName?: string,
  ): PermissionCheckResult;

  getToolPermission(toolName: string, agentName?: string): PermissionState;
}
```

The `service.ts` module-level exports lose `SubagentSessionInfo`:

```typescript
// before
import type { SubagentSessionInfo } from "./subagent-registry";
export type { PermissionCheckResult, PermissionState, SubagentSessionInfo };

// after
export type { PermissionCheckResult, PermissionState };
```

The construction site in `index.ts` drops two properties; nothing else in the literal changes:

```typescript
const permissionsService: PermissionsService = {
  checkPermission(surface, value, agentName) {
    /* unchanged */
  },
  getToolPermission(toolName, agentName) {
    /* unchanged */
  },
};
publishPermissionsService(permissionsService);
```

`subagentRegistry` stays alive — it is still passed to `PermissionPrompter`, `forwardingDeps`, `isSubagentExecutionContext`, and `subscribeSubagentLifecycle`.
Only the two object-literal delegation methods disappear.

Separation of concerns is unchanged: the registry remains owned by the permission system's runtime; the only external write path is now the event subscriber, exactly as ADR 0002 intends.

Edge cases:

- No external consumer imports `SubagentSessionInfo` (pi-subagents declares its own `ChildSessionCreatedEvent`), so removing the re-export is safe.
- Out-of-process callers: the docs previously claimed the methods "remain available for out-of-process callers."
  No such caller exists in the monorepo; removal closes a vacant surface rather than breaking a real client.

## Module-Level Changes

`@gotgenes/pi-permission-system`:

- **Change** `src/service.ts` — remove `registerSubagentSession` and `unregisterSubagentSession` from the `PermissionsService` interface (and their JSDoc); drop the `import type { SubagentSessionInfo }` and remove `SubagentSessionInfo` from the `export type { ... }` line.
- **Change** `src/index.ts` — remove the `registerSubagentSession` / `unregisterSubagentSession` properties from the `permissionsService` object literal.
  Leave `subagentRegistry` and the `subscribeSubagentLifecycle` wiring intact.
- **Change** `src/subagent-registry.ts` — update the `SubagentSessionRegistry` class doc comment that cites `registerSubagentSession` / `unregisterSubagentSession` as the external surface; reword to reference the event subscriber (`subscribeSubagentLifecycle`) as the writer.
- **Change** `test/service.test.ts` — remove `registerSubagentSession` / `unregisterSubagentSession` from the `makeService` defaults; delete the two delegation tests (`registerSubagentSession delegates to the registry`, `unregisterSubagentSession delegates to the registry`); remove the two methods from the two `getToolPermission` service literals; remove the now-unused `import { SubagentSessionRegistry }` if no other test in the file uses it.
- **Change** `docs/cross-extension-api.md` — remove the two methods from the `PermissionsService` interface code block, remove the `SubagentSessionInfo` interface block, and remove the `#### registerSubagentSession / unregisterSubagentSession` subsection (code example included).
  Add a short pointer to `subagent-integration.md` describing event-driven registration.
  Grep for and fix the anchor link `#registersubagentsession--unregistersubagentsession` referenced from other docs.
- **Change** `docs/subagent-integration.md` — remove the paragraph stating the methods "remain available … removal tracked in #267"; reword the "does not call `registerSubagentSession()`" line (in the upstream-fork note) to describe the absence of event publication instead; ensure the "In-process case" framing reads as event-driven.
- **Change** `docs/architecture/architecture.md` — update the `isSubagentExecutionContext` detection bullet (item 1) that says sessions register "via `PermissionsService.registerSubagentSession()`"; collapse the "interface exposes four methods" list to two methods; drop `registerSubagentSession` / `unregisterSubagentSession` bullets; remove `SubagentSessionInfo` from the `exports`-contents sentence; rewrite the "In-process case (resolved)" section to point at the event subscriber rather than the service methods; fix any stale `cross-extension-api.md#registersubagentsession…` anchor.

`@gotgenes/pi-subagents` (docs only — full refresh per Decision):

- **Change** `README.md` "Permission System Integration" — reword the "Deterministic child detection — every child session registers with … `SubagentSessionRegistry` before `bindExtensions()`" bullet and the "registration calls are silent no-ops" line to describe lifecycle-event publication (no subscriber → harmless no-op).
- **Change** `README.md` "Deviations from upstream" — rewrite Deviation #4 (`src/lifecycle/permission-bridge.ts`, `runAgent` registers/unregisters) to describe the current event-publication mechanism (`child-lifecycle.ts`); the bridge module no longer exists.
- **Change** `README.md` architecture file-tree block — correct the Phase 16 drift: remove `permission-bridge.ts`; replace the dissolved `agent-runner.ts` / `agent-record.ts` entries with the current modules (`agent.ts`, `subagent-session.ts`, `create-subagent-session.ts`, `child-lifecycle.ts`, `concurrency-queue.ts`, `turn-limits.ts`, `usage.ts`, `workspace.ts`); note `worktree.ts` moved to `@gotgenes/pi-subagents-worktrees` ([#263]).
  Cross-check the listing against the actual `src/lifecycle/` contents before writing.

No doc in `packages/pi-subagents/docs/architecture/` references the removed `PermissionsService` methods (they were reconciled in #261); verify with a grep during the doc step and extend only if a stale reference surfaces.

## Test Impact Analysis

This is a removal/refactor, not a feature.

1. New unit tests enabled: none.
   The change removes API surface; there is no new behavior to cover.
   The compile-time disappearance of the methods is the guarantee — no runtime assertion is meaningful or possible.
2. Tests becoming redundant: the two delegation tests in `test/service.test.ts` (`registerSubagentSession delegates to the registry`, `unregisterSubagentSession delegates to the registry`) are removed entirely, along with the method stubs in `makeService` and the two `getToolPermission` literals.
3. Tests that must stay as-is: `test/subagent-registry.test.ts` (genuinely exercises the registry, which survives) and the event-subscription coverage in `test/subagent-lifecycle-events.test.ts` (exercises the live write path) are untouched.

## TDD Order

1. **Remove the inbound registration surface (interface + impl + tests, one commit).**
   Test surface: `test/service.test.ts`.
   Covers: dropping the two methods from `PermissionsService`, removing their implementation in `index.ts`, removing the `SubagentSessionInfo` re-export from `service.ts`, deleting the two delegation tests, and cleaning the `makeService` / `getToolPermission` literals and the now-unused `SubagentSessionRegistry` import.
   These must land together — TypeScript excess-property checking rejects the stale methods on the single `index.ts` literal and on the test literals the instant the interface changes.
   Also update the `SubagentSessionRegistry` class doc comment in the same commit.
   Run `pnpm run check`, `pnpm run lint`, `pnpm -r run test`, and `pnpm fallow dead-code` after this step (interface change + dead-surface removal).
   Suggested commit: `feat!: remove inbound subagent-registration methods from PermissionsService (#267)`.

2. **Reconcile pi-permission-system docs.**
   Surface: `docs/cross-extension-api.md`, `docs/subagent-integration.md`, `docs/architecture/architecture.md`.
   Covers: deleting the method/`SubagentSessionInfo` documentation, fixing dead anchors, and rewording every registration claim to event-driven.
   Suggested commit: `docs(pi-permission-system): describe event-driven subagent registration (#267)`.

3. **Refresh the pi-subagents README.**
   Surface: `packages/pi-subagents/README.md`.
   Covers: the "Permission System Integration" section, Deviation #4, and the architecture file-tree block (full Phase 16 refresh).
   Suggested commit: `docs(pi-subagents): refresh permission-integration and architecture sections (#267)`.

## Risks and Mitigations

- **Breaking the published `PermissionsService` interface.**
  External consumers calling the removed methods would break.
  Mitigation: no in-process or monorepo caller remains (the premise of this issue, established by #261); the change ships as `feat!:` so release-please records the breaking change in the changelog.
- **Dead anchor links after removing doc sections.**
  Other docs link to `cross-extension-api.md#registersubagentsession--unregistersubagentsession`.
  Mitigation: grep all `docs/` for the anchor and the method names during step 2/3 and repoint or remove each reference.
- **Load order between pi-subagents and pi-permission-system (considered and dismissed).**
  Removing the load-order-resilient service-call path could *seem* to introduce ordering sensitivity.
  It does not: the subscriber registers its listener at extension load time, while the publisher emits only at child-spawn time (runtime, during an agent turn) — load always precedes runtime, so the subscriber is ready before any emission regardless of which extension loads first.
  The only timing guarantee that matters (synchronous `session-created` handler so the registry entry lands before the child's `bindExtensions()`) is intra-event and is preserved untouched.
  For the record, both settings files already list `pi-permission-system` before `pi-subagents` (subscriber before publisher), so even the conservative interpretation is already satisfied; no settings edit is part of this change.
- **Missing a straggler the sweep should catch.**
  Mitigation: `pnpm fallow dead-code` after step 1 confirms no orphaned registration surface; a repo-wide grep for `registerSubagentSession` / `unregisterSubagentSession` / `permission-bridge` after the doc steps confirms no live code or doc still describes the inbound path.

## Open Questions

- None blocking.
  The pi-subagents README file-tree refresh (per the Decision) brushes against #263/#265 territory; if it grows beyond a straightforward listing correction, split the non-bridge file-tree drift into a dedicated docs cleanup rather than expanding this issue.

[#261]: https://github.com/gotgenes/pi-packages/issues/261
[#263]: https://github.com/gotgenes/pi-packages/issues/263
[#265]: https://github.com/gotgenes/pi-packages/issues/265
