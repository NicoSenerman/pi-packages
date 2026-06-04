---
issue: 334
issue_title: "Inject a single PermissionManager into PermissionSession (configure once at session_start)"
---

# Retro: #334 — Inject a single PermissionManager into PermissionSession

## Stage: Planning (2026-06-04T00:00:00Z)

### Session summary

Produced the numbered implementation plan `docs/plans/0334-inject-single-permission-manager.md` for Phase 4 Step 1.
The plan injects one `PermissionManager` into `PermissionSession`, adds `PermissionManager.configureForCwd(cwd)` plus an `agentDir` constructor option, moves the cwd→paths derivation onto a pure `derivePolicyLoaderOptions` helper in `permission-manager.ts`, and deletes the now-dead `createPermissionManagerForCwd` / `derivePiProjectPaths` factory functions.
Structured as three commits: additive `configureForCwd` (`feat:`), the coupled session-injection + `index.ts` + test change (`refactor:`), and the factory removal (`refactor:`).

### Observations

- The package has two separate `PermissionManager` instances today (`runtime.permissionManager` vs. the session's).
  The plan deliberately **preserves** this split-brain — unifying is Step 4 (#337).
  Called out in Non-Goals and Risks so the implementer/reviewer does not treat it as a regression.
- Decided to inject a **narrow `ScopedPermissionManager` interface** (five methods) rather than the concrete class, which is what lets `permission-session.test.ts` drop the `as unknown as PermissionManager` cast — the issue's stated outcome. `getComposedConfigRules` / `getResolvedPolicyPaths` are excluded (ISP) since only the `runtime.permissionManager` path uses them.
- The cwd→paths helper had to move out of `runtime.ts` into `permission-manager.ts` to avoid an import cycle (`runtime.ts` imports `permission-manager.ts`). `config-paths.ts` is cycle-free, so the helper imports `getGlobalConfigPath` / `getProjectConfigPath` from there.
- Intentional tightening: `derivePolicyLoaderOptions` sets `agentsDir = join(agentDir, "agents")` explicitly.
  Today `createPermissionManagerForCwd` leaves it unset, so `FilePolicyLoader` falls back to a hidden `getAgentDir()` env read.
  In production `agentDir === getAgentDir()`, so this is observably identical while removing the env dependency and making the new unit test deterministic.
- Did not invoke `ask_user`: the issue's "Proposed change" plus the architecture roadmap resolved every design choice (no genuinely ambiguous breaking-vs-non-breaking or result-shape decision remained).
- The pre-existing `0334-phase-4-roadmap.md` retro is from the roadmap meta-session, not a prior attempt at this implementation; used a distinct slug (`0334-inject-single-permission-manager`) for both plan and retro.

## Stage: Implementation — TDD (2026-06-04T16:50:00Z)

### Session summary

Completed all three TDD cycles from the plan.
Step 1 (`feat:`) added `PermissionManager.configureForCwd`, the `agentDir` option, `derivePolicyLoaderOptions`, and the `ScopedPermissionManager` interface with 5 new filesystem-backed unit tests.
Step 2 (`refactor:`) injected the manager into `PermissionSession` and updated `index.ts`; `vi.mock("../src/runtime")` and `as unknown as PermissionManager` were removed from `permission-session.test.ts`.
Step 3 (`refactor:`) deleted `createPermissionManagerForCwd` and `derivePiProjectPaths` from `runtime.ts` and their 8 test blocks from `runtime.test.ts`.
Test count: 1834 → 1831 (−3 net: +5 new `configureForCwd` tests, −8 deleted factory tests).

### Observations

- Pre-completion reviewer returned **PASS** with two WARNs fixed before committing: (1) unused `getGlobalConfigPath` import left in `test/runtime.test.ts` after deleting the factory describe blocks, and (2) `derivePolicyLoaderOptions` placed above its caller in `permission-manager.ts` (stepdown rule violation); both were fixed by amending the Step 3 commit.
- A botched intermediate edit accidentally split `PermissionManager` into two class declarations while repositioning `derivePolicyLoaderOptions`.
  Fixed by removing the spurious early `}` and re-inserting the helper after the class's real closing brace.
  The lesson: when moving a helper below its caller in a class file, use two separate focused edits (remove from old location, insert at new location) rather than one large combined replace.
- The plan's `makePermissionManager` overrides parameter was dropped entirely in favour of the per-field `??` pattern (testing skill convention); callers that needed custom return values use `vi.mocked(pm.method).mockReturnValue(...)` after construction instead.
- The `ScopedPermissionManager` interface (5 methods) was introduced in Step 1 and consumed in Step 2 with no intermediate dead-code flag from fallow, confirming same-plan cross-step exports are acceptable.
