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
- Verified the SDK signatures against the live dev source (`~/development/pi/pi`, `v0.79.1`), not just the pinned `0.75.4` in `node_modules`: `getSessionId` / `getSessionDir` / `getEntries` / the `SessionEntry` union are identical across both, so the narrow interfaces are upgrade-safe.
- That check collapsed one proposed divergence: an early draft used `getSessionDir(): string | null` to fit a test stub returning `null`, but the SDK returns `string` in every version (`null` is unreachable) — the production `if (!sessionDir)` guard is really the empty-string case.
  Kept `getSessionDir(): string` faithful to the SDK and coerced the test stub to `""` (`vi.fn(() => sessionDir ?? "")`).
  The only standing local type is `SessionEntryView` (the structural slice `getActiveAgentName` already operated on; the SDK union's nine variants aren't satisfiable by the tests' simplified entry literals).
- Process note: a concurrent session committed a `pi-subagents` doc change between the retro commit and a plan-revision amend, so the amend folded the plan edit into the wrong commit; recovered with `git reset --soft` + re-split into two clean commits.
  Prefer a fresh commit over `--amend` when other sessions may be active in the repo.
- Followed the `0366` sibling-plan precedent (Track C Step 5): single atomic `refactor:` commit, narrow interfaces over wide types, "method bodies unchanged," reuse-over-strict-ISP for the collaborator interface (`SubagentDetectionContext` carries `getSessionDir` even though `isRegisteredSubagentChild` reads only `getSessionId`).
- No `ask_user` was needed — the design is determined by type constraints and the 0366 precedent; the collaborator narrowing is forced, not a discretionary scope choice.
- Grep confirmed all production callers of the narrowed collaborators pass a full `ExtensionContext` (assignable), mocked callers use `vi.mock`, and `index.ts` re-exports only `PermissionForwarder` / `PermissionForwarderDeps` — so the change is non-breaking and stays off the public surface.
- Decided against `extends`-ing the collaborator interfaces from `ForwarderContext` to avoid cross-module type coupling; `ForwarderContext` is defined standalone with a `sessionManager` that is a structural superset of both collaborator needs.

## Stage: Implementation — TDD (2026-06-10T17:52:00Z)

### Session summary

Executed the plan as a single Red→Green→Commit cycle (commit `047e8927`).
Red: removed all 8 `as unknown as ExtensionContext` casts and retyped the three test `makeCtx` helpers to the not-yet-existing narrow interfaces, so `pnpm run check` failed with 4 missing-member errors.
Green: added `SessionEntryView` / `ActiveAgentContext` (`active-agent.ts`), `SubagentDetectionContext` (`subagent-context.ts`), and `ForwarderContext` (`permission-forwarder.ts`), narrowed every signature/field, and dropped the per-entry cast in `getActiveAgentName`.
Test count unchanged at 1902 (pure type-narrowing refactor, no behavior change).

### Observations

- Pre-completion reviewer: PASS — all deterministic checks green (`check`, `lint`, `test`, `fallow dead-code`), no design concerns, conventional commits clean.
- Started from a non-clean state: `git pull --ff-only` failed because last session's history repair left a duplicate-content pi-subagents commit (`93c72ce6`) diverging from the pushed `cd33a322`.
  Resolved (with user approval) via `git rebase --onto origin/main 93c72ce6 main`, dropping the duplicate and replaying the two `#367` doc commits cleanly.
- One pre-existing baseline lint failure in the plan doc itself (MD053 unused link refs `[#366]` / `[#367]`) — the planning session's pre-commit hook runs `rumdl fmt`, not full markdownlint, so it slipped through.
  Fixed as a separate `docs:` cleanup commit before starting TDD.
- The forwarder test `makeCtx` helper deep-merges `sessionManager` (top-level spread would replace the whole object and drop the other two required readers); `getEntries: vi.fn(() => [])` infers `never[]`, which is assignable to `readonly SessionEntryView[]` and needs no annotation since no test overrides it with a non-empty array.
- Reviewer's grep initially reported only 3 remaining out-of-scope cast files; a `test/helpers/` recheck confirmed 4 (`config-store.test.ts`, `handler-fixtures.ts`, `permission-prompter.test.ts`, `prompting-gateway.test.ts`), matching the plan's Non-Goals exactly — the reviewer's pattern just missed the `helpers/` subdir.
- `index.ts`, `permission-prompter.ts`, and `forwarding-manager.ts` needed no edits (full `ExtensionContext` stays assignable to the narrowed params), confirming the plan's assignability analysis.
