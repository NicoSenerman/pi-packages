---
issue: 367
issue_title: "Narrow `PermissionForwarder`'s context dependency to a local interface"
---

# Retro: #367 — Narrow `PermissionForwarder`'s context dependency to a local interface

## Stage: Planning (2026-06-10T14:16:13Z)

### Session summary

Produced the implementation plan for Track C Step 6: narrowing `PermissionForwarder`'s `ExtensionContext` dependency to a local `ForwarderContext` interface to eliminate the five `as unknown as ExtensionContext` casts in `permission-forwarder.test.ts`.
Investigation found the narrowing cannot be confined to the forwarder — it passes `ctx` into the shared collaborators `isSubagentExecutionContext` / `isRegisteredSubagentChild` (`subagent-context.ts`) and `getActiveAgentName` (`active-agent.ts`), which must also accept the narrower type for the change to type-check.
The plan therefore narrows those collaborators too, which incidentally clears three more casts (2 in `subagent-context.test.ts`, 1 in `active-agent.test.ts`) — 8 of the 12 systemic casts cleared.

### Observations

- The forwarder's `requestPermissionDecisionFromUi` dep already receives a `PermissionDecisionUi`-typed function (from `permission-dialog.ts`) but redundantly widens the parameter to `ExtensionContext["ui"]`.
  Narrowing it to `PermissionDecisionUi` is what makes the `{ select, input }` test stubs satisfy `ForwarderContext.ui` without a cast.
- Two deliberate SDK divergences are required to let the existing test stubs satisfy the narrow interface without casts: `getSessionDir(): string | null` (SDK says `string`, but `isSubagentExecutionContext` reads it defensively and a test stubs `null`) and a minimal `SessionEntryView` for `getEntries` (the SDK `SessionEntry` union is not satisfiable by the tests' simplified entry literals).
  Both narrow types remain assignable from the SDK types, so full-`ExtensionContext` callers are unaffected.
- Followed the `0366` sibling-plan precedent (Track C Step 5): single atomic `refactor:` commit, narrow interfaces over wide types, "method bodies unchanged," reuse-over-strict-ISP for the collaborator interface (`SubagentDetectionContext` carries `getSessionDir` even though `isRegisteredSubagentChild` reads only `getSessionId`).
- No `ask_user` was needed — the design is determined by type constraints and the 0366 precedent; the collaborator narrowing is forced, not a discretionary scope choice.
- Grep confirmed all production callers of the narrowed collaborators pass a full `ExtensionContext` (assignable), mocked callers use `vi.mock`, and `index.ts` re-exports only `PermissionForwarder` / `PermissionForwarderDeps` — so the change is non-breaking and stays off the public surface.
- Decided against `extends`-ing the collaborator interfaces from `ForwarderContext` to avoid cross-module type coupling; `ForwarderContext` is defined standalone with a `sessionManager` that is a structural superset of both collaborator needs.
