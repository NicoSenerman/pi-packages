---
issue: 356
issue_title: "Harden config pipeline against silently-dropped fields (follow-up to #332)"
---

# Retro: #356 — Harden config pipeline against silently-dropped fields

## Stage: Planning (2026-06-12)

### Session summary

Planned the two-part hardening from issue #356: retype `normalizePermissionSystemConfig`'s parameter from `unknown` to `UnifiedPermissionConfig` (so a future field declared on the runtime type but absent from the merge intermediate becomes a compile error), and add a full-pipeline seam test in a new `test/config-pipeline.test.ts`.
Investigation confirmed the issue author's flagged uncertainty was real: the retype only achieves its safety goal if `toRecord` and the `normalizeOptional*` coercion are also dropped (reading typed fields directly), which breaks ~6 test-only garbage-input cases and 2 `as unknown` call sites.
Operator chose the full retype and a new dedicated test file.

### Observations

- The defensive coercion in `normalizePermissionSystemConfig` is dead code for production — both call sites (`ConfigStore.refresh`, `ConfigStore.save`) already feed typed objects that passed through `normalizeUnifiedConfig` at the JSON boundary.
  The boundary's defensive parse is already fully tested in `test/config-loader.test.ts` (booleans lines 188–199; length fields 296–325), so the redundant `test/extension-config.test.ts` cases are pure deletions, not relocations.
- `config-store.ts` needs no edit — `PermissionSystemExtensionConfig` is structurally assignable to the all-optional `UnifiedPermissionConfig`, so `save(next)` compiles unchanged.
- Change is non-breaking: type-only + test changes; observable runtime behavior identical.
- Accepted minor ISP slack: the function reads 6/7 `UnifiedPermissionConfig` fields (never `permission`); narrowing to `Omit<..., "permission">` rejected as speculative since the issue prescribes the `UnifiedPermissionConfig` type and the compile-error property holds regardless.
- TDD ordering puts the seam regression test first (passes immediately, since #332 already fixed the loader) as a safety net before the refactor; the refactor is one atomic commit because the type change breaks tests and call sites at the type level.
- `config-modal.test.ts` call-site fix routes through `loadUnifiedConfig(configPath).config` instead of `JSON.parse(...) as unknown`, which mirrors the production load path more faithfully.
