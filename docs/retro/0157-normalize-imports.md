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

## Stage: Implementation — Build (2026-05-23T14:35:00Z)

### Session summary

All five packages migrated in one session across five commits.
Each package received: directory rename where applicable (`tests/` → `test/`), updated `tsconfig.json` with `paths`, a `vitest.config.ts` with `resolve.alias`, `.js` suffix removal, and cross-boundary import rewrites to `#src/*` / `#test/*`.
All 2737 tests pass across all five packages post-migration.

### Observations

- `pi-permission-system` had three-level deep imports (`../../../src/`) in `test/handlers/gates/*.test.ts` — the sed pass needed three separate patterns (`../src/`, `../../src/`, `../../../src/`).
  These are now all `#src/`.
- `pi-subagents` had `vi.mock("...")` and `await import("...")` dynamic paths with `.js` suffixes that needed separate sed rules beyond the static import patterns; `vi.importActual` also needed manual fixing.
- `pi-colgrep` surfaced a **pre-existing TypeScript 6 narrowing bug** in `test/lib/reindex.test.ts` that was hidden because `test/` was not in `tsconfig.json` `include`.
  After `resolveExec = undefined`, TypeScript 6's control-flow narrowing treats subsequent `resolveExec?.()` calls as type `never` (even across `await` points).
  Fixed by casting: `resolveExec = undefined as (() => void) | undefined` — this preserves the union type and defeats TS6's narrowing.
  An `const ref = { fn: ... }` wrapper did NOT work — TS6 narrows object properties through assignments too.
- Biome reformatted two files in `pi-github-tools` and several in `pi-permission-system` after the import rewrites changed line lengths (multi-line named imports collapsed to single line).
  `pnpm exec biome check --write .` handled these cleanly.
- The `#test/*` alias was added to all packages but only used in `pi-subagents` (for `test/tools/*.test.ts` → `#test/helpers/*` imports from nested dirs).
  Other packages either don't have nested test dirs or don't cross-reference them.

## Stage: Final Retrospective (2026-05-23T15:00:00Z)

### Session summary

Reviewed the full issue #157 lifecycle across three sessions (planning, build, ship).
All five packages migrated cleanly with zero test regressions.
Identified one prompt bug (`lint:fix` reference) and fixed it.

### Observations

#### What went well

- The mechanical sed-based approach for `.js` stripping and import rewriting was safe and efficient across ~400 import lines.
  The regex scoping (`from "..."` context) avoided all false positives on string literals containing `.js`.
- Per-package commits with `pnpm run check && pnpm run test` verification after each phase kept CI green throughout.
  The plan's sequencing rationale paid off — no cross-package breakage.
- The planning session's research into Vite/Vitest `resolve.alias` vs `tsconfig.json` `paths` prevented a build-time failure.
  The dual-site config pattern (`tsconfig.json` for tsc + `vitest.config.ts` for runtime) was correct on first use.

#### What caused friction (agent side)

- `rabbit-hole` — The planning session spent ~15 tool calls spelunking through `node_modules/` files trying to determine whether Vite 8 auto-reads `tsconfig.json` `paths`, when checking the Vitest docs directly would have resolved the question in one call.
  Impact: added friction but no rework — the user intervened with the docs URLs.
- `missing-context` — The plan only accounted for two levels of relative import depth (`../src/`, `../../src/`) but `pi-permission-system` had `../../../src/` paths in `test/handlers/gates/`.
  Impact: one additional sed pattern during build; no rework.
- `rabbit-hole` — Spent ~5 minutes trying a ref-object wrapper to defeat TS6 narrowing in `pi-colgrep` before falling back to a type assertion cast.
  The ref-object approach failed because TS6 narrows object properties through assignments too.
  Impact: minor time cost, no rework — fixed in the same commit.
- `missing-context` — The plan acknowledged the `#`-prefix aligns with Node.js subpath imports but only configured `tsconfig.json` `paths` and `vitest.config.ts` `resolve.alias`, never adding `package.json` `"imports"`. jiti (Pi's runtime) does NOT read `tsconfig.json` `paths` — confirmed via unjs/jiti#166.
  Without `"imports"`, `pi-permission-system` failed to load at Pi runtime because 37 `src/` files use `#src/*`.
  Impact: post-ship bug report, one additional fix commit.

#### What caused friction (user side)

- The issue body claimed "Vitest resolves `paths` from `tsconfig.json` via its Vite/esbuild pipeline, so no extra config should be needed."
  This turned out to be incorrect.
  Sharing the Vitest docs URLs earlier (or noting the uncertainty in the issue) would have avoided the `node_modules` spelunking.

### Changes made

1. `.pi/prompts/build-plan.md`: replaced nonexistent `pnpm run lint:fix` reference with `pnpm exec biome check --write .`.
2. `.pi/prompts/tdd-plan.md`: same fix — replaced `pnpm run lint:fix` with `pnpm exec biome check --write .`.

### Post-retro fix

3. `packages/pi-permission-system/package.json` (and 4 other packages): added `"imports"` field mapping `#src/*` → `./src/*` and `#test/*` → `./test/*`. jiti does NOT read `tsconfig.json` `paths` (confirmed via unjs/jiti#166 — pi0 states "tsconfig and other external configs are not infered").
   Node.js subpath imports via `package.json` `"imports"` are the mechanism jiti respects.
   Without this, `pi-permission-system` failed to load at Pi runtime because 37 `src/` files import from `#src/*`.
   Also fixed `pi-permission-system`'s `"files"` field which still referenced the old `"tests"` directory name.
