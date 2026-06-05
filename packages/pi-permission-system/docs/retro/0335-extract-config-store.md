---
issue: 335
issue_title: "Extract a ConfigStore from the runtime free-functions"
---

# Retro: #335 — Extract a ConfigStore from the runtime free-functions

## Stage: Planning (2026-06-05T01:50:00Z)

### Session summary

Produced the numbered implementation plan for Phase 4 Step 2 — extracting a `ConfigStore` class that owns `config` + `lastConfigWarning` and converts the three `(runtime, …)` config free functions into methods.
Predecessor #334 (inject a single `PermissionManager`) is already merged; this is the first session on #335 (no prior retro).
The plan is six behavior-preserving TDD cycles using a lift-and-shift migration (introduce the store, back the runtime with it via a temporary `get config()` getter, migrate consumers one at a time, then delete the free functions).

### Observations

- The one genuine design fork — how the store obtains the runtime context that `refresh` / `logResolvedPaths` need — was settled by the roadmap, not by `ask_user`.
  `docs/architecture/architecture.md` deliberately scopes the store to `config` + `lastConfigWarning` (context unification onto `PermissionSession` is Step 4 / #337), so owning `runtimeContext` in the store was rejected.
  The plan injects a transitional `RuntimeContextRef` (get/set) backed by the still-runtime-owned `runtimeContext` field; it dissolves in #337.
- Tension between the issue's "the 4× `() => runtime.config` closures … are gone" and the roadmap reserving the `index.ts` deps-bag collapse for Step 5 (#338).
  Resolved by removing the `PermissionSession`, `PermissionPrompter`, and command `() => runtime.config` closures here (those consumers hold the store / a `ConfigReader`), while the logger `getConfig` adapter is redirected to `configStore.current()` and fully retired in Step 3 (#336), and the forwarding `shouldAutoApprove` adapter survives to Step 5.
  Documented as an explicit scoping decision in the plan's Non-Goals / Open Questions.
- The logger ↔ config temporal coupling (the store must be built before the logger whose sink the store defers to) is preserved verbatim — it is the existing deferred-binding pattern and Step 3 (#336) removes it.
  Avoided pulling that fix forward into this Step.
- `createSessionLogger(runtime)` reads `runtime.writeDebugLog` / `writeReviewLog` / `runtimeContext` but **not** `runtime.config`, so removing the `config` field does not touch it — confirmed by grep before finalizing the module list.
- Lift-and-shift chosen because the alternative (remove `config` + the free functions in one commit) would force every consumer and test into a single oversized commit; the temporary `get config()` getter keeps `index.ts` compiling across the four consumer-migration steps.

## Stage: Implementation — TDD (2026-06-05T22:25:00Z)

### Session summary

All 6 TDD cycles completed across `config-store.ts` (new), `runtime.ts`, `permission-session.ts`, `permission-prompter.ts`, `config-modal.ts`, and `index.ts`.
Test count went from 1831 (86 files) to 1840 (87 files): +22 new `config-store.test.ts` tests, -13 deleted `refreshExtensionConfig` tests from `runtime.test.ts`.
Pre-completion reviewer returned PASS with no findings requiring action.

### Observations

- Step 2 (`runtime.ts`) required `Object.defineProperty` for the transitional `get config()` getter bridge; the plain-object-literal factory pattern can't have getters inline.
  The `as unknown as ExtensionRuntime` cast is needed because `Object.defineProperty` returns the pre-cast type.
  The bridge was removed cleanly in Step 6 when the last consumer (`canResolveAskPermissionRequest` in `index.ts`) migrated.
- `@deprecated` JSDoc tags on the Step-2 delegator functions triggered `@typescript-eslint/no-deprecated` on every call site in `index.ts`.
  Replaced with prose comments per the AGENTS.md lift-and-shift rule ("do not mark it `@deprecated`").
- `ConfigStore.save` was flagged as dead code by fallow because fallow cannot trace calls through the `CommandConfigStore` interface.
  Suppressed with `// fallow-ignore-next-line unused-class-member` plus an explanatory prose comment above it.
- Step 5 (`config-modal.ts`) needed two passes: the batch edit for the interface + import was rejected (edit[2] in the first call failed to match), but the body-method edits applied.
  Lesson: when one edit in a batch fails, the entire batch is rolled back — check match fidelity for every oldText before sending.
- Architecture doc updated: `config-store.ts` added to the module-structure listing; Steps 1 and 2 marked `✓ complete` in the Phase 4 roadmap.
- Pre-completion reviewer verdict: **PASS** — all deterministic checks green, no structural findings, `fallow` clean.
