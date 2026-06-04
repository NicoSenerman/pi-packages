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
