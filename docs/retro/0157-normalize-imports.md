---
issue: 157
issue_title: "Normalize imports: add path aliases and drop .js suffixes"
---

# Retro: #157 — Normalize imports: add path aliases and drop .js suffixes

## Stage: Planning (2026-05-23T14:30:00Z)

### Session summary

Explored all five affected packages to measure the actual scope of `.js` suffix removals and cross-boundary import rewrites.
Verified through Vite/Vitest docs that `tsconfig.json` `paths` are **not** auto-read by Vite — both `tsconfig.json` `paths` (for `tsc`) and `vitest.config.ts` `resolve.alias` (for runtime) must be set in each package.
Wrote and committed the cross-package plan at `docs/plans/0157-normalize-imports.md`.

### Observations

- `pi-subagents` is by far the largest target: ~323 `.js` suffixes across `src/` and `test/`, plus ~200 cross-boundary import rewrites.
  Mechanical sed pass scoped to `from "...foo.js"` patterns is safe — string literals containing `.js` do not match the import regex.
- Vite 8 + Vitest 4 do **not** auto-resolve `tsconfig.json` `paths`.
  The `resolve.alias` approach (object form: `"#src" → resolved src/ path`) works for prefix-style aliases and is the correct hook.
  Three packages (`pi-subagents`, `pi-permission-system`, `pi-github-tools`) need new `vitest.config.ts` files; two (`pi-autoformat`, `pi-colgrep`) need `resolve.alias` added to existing configs.
- `pi-permission-system`'s `tsconfig.json` includes a stale `"index.ts"` entry (the file does not exist); remove it in the same edit as the `tests/` → `test/` rename.
- `pi-colgrep`'s `tsconfig.json` omits `"test"` from `include` — a pre-existing gap that must be fixed to get type checking on test files.
- Single-level `../sibling` imports inside `src/` subdirectories (e.g., `forwarded-permissions/` → `../active-agent`) are intentional neighbours and are left relative per the Non-Goals section.
- Recommended execution order: `pi-github-tools` → `pi-permission-system` → `pi-subagents` → `pi-colgrep` → `pi-autoformat` (heaviest-first for the rename+alias work, lightest last).
