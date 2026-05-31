---
issue: 286
issue_title: "Decompose resolvePermissions in permission-manager.ts"
---

# Retro: #286 — Decompose `resolvePermissions` in `permission-manager.ts`

## Stage: Planning (2026-05-31T04:36:52Z)

### Session summary

Planned the Phase 2 step 2 decomposition of `PermissionManager.resolvePermissions`.
The plan extracts `mergeScopesWithOrigins(scopes)` (returning `{ mergedPermission, origins }`) into a new `src/scope-merge.ts` module with a sibling `test/scope-merge.test.ts`, leaving the remaining method as a linear pipeline.
Behavior-preserving: `permission-manager-unified.test.ts` stays green unmodified.

### Observations

- One genuine design decision surfaced via `ask_user`: where the extracted function lives.
  Options were a new module, folding into `permission-merge.ts`, or an exported in-file helper (the [#285] precedent).
  User chose the new `scope-merge.ts` module — matches the package's dominant one-concern-per-file convention and keeps `permission-merge.ts` purely about config-shape merge.
- Caught a non-obvious cleanup: after extraction, `permission-manager.ts` no longer calls `mergeFlatPermissions` directly (it was the sole call site there), so its import must be removed in the same step — `pnpm check` will catch a stray reference.
- The `OriginMap` type alias moves into `scope-merge.ts` and stays unexported (the consumer reads `origins` via the inferred `MergedScopes` return type); `MergedScopes` is exported and the new test imports it so fallow does not flag a dead export.
- TDD order follows the accepted [#285] pattern: step 1 commits a red test (module not yet created), step 2 creates the module + rewires the sole call site in one commit, step 3 updates `architecture.md` after re-running `fallow health --targets` to record new numbers.
- The attribution branch (shallow-merge vs. full-replacement, including the `eslint-disable @typescript-eslint/no-unnecessary-condition` comments) moves verbatim — the densest, highest-risk part — so behavior is preserved by construction.
