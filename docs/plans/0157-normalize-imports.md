---
issue: 157
issue_title: "Normalize imports: add path aliases and drop .js suffixes"
---

# Normalize imports across the monorepo

## Problem Statement

Import paths across the five packages are inconsistent in three ways.
First, test files (and some nested `src/` files) use fragile multi-level relative paths like `../../src/agent-types` that break on any directory restructuring.
Second, `pi-subagents` appends `.js` to every relative import (~323 instances), while the other packages are mixed or already clean — this is unnecessary noise since `moduleResolution: "Bundler"` resolves `.ts` files directly.
Third, two packages (`pi-github-tools`, `pi-permission-system`) use a `tests/` directory while three others use `test/`, creating an inconsistency with the Vitest default and community convention.

## Goals

- Rename `tests/` → `test/` in `pi-github-tools` and `pi-permission-system`.
- Add `#src/*` and `#test/*` path aliases to each package's `tsconfig.json` (for type checking).
- Add matching `resolve.alias` entries to each package's `vitest.config.ts` (for test runtime resolution).
- Remove all `.js` suffixes from relative imports across all five packages.
- Rewrite cross-boundary relative imports (`../src/*`, `../../src/*`) to use `#src/*` aliases.
- Rewrite intra-test helper imports (`../helpers/*`) in nested test dirs to use `#test/*` aliases.
- All five packages pass `pnpm run check` and `pnpm run test` after migration.

## Non-Goals

- Adding path aliases to `src/`-to-`src/` sibling imports at the same directory level (e.g., `"../active-agent"` inside `forwarded-permissions/` stays relative — these are natural neighbours, not cross-boundary reaches).
- Migrating package-to-package imports (those use npm specifiers, not relative paths).
- Adding aliases for production bundling (`exports` in `package.json`) — this codebase uses `noEmit: true` and is never bundled.
- Changing the test framework, formatter, or any behaviour.

## Background

- All packages extend `tsconfig.base.json` which sets `moduleResolution: "Bundler"` and `noEmit: true`.
  Path aliases defined in `tsconfig.json` `paths` satisfy TypeScript's type checker but are **not** automatically read by Vite/Vitest.
  Vitest inherits Vite's `resolve.alias` config, which must be set explicitly in `vitest.config.ts` (documented at vitest.dev/config — `resolve.alias` lives at the top level, outside the `test` property).
- `pi-autoformat` already imports without `.js` suffixes and its `test/` files use `../src/foo` (no alias yet).
  Its `vitest.config.ts` sets `test.include: ["test/**/*.test.ts"]` — the established local pattern.
- `pi-colgrep` already has a `test/` directory but its `tsconfig.json` `include` list omits `"test"` — a pre-existing gap to fix alongside this work.
- `pi-subagents`, `pi-permission-system`, and `pi-github-tools` have no `vitest.config.ts`; they rely on Vitest's built-in defaults.
  Creating one per package is the correct hook for `resolve.alias`.
- The `#`-prefix convention aligns with Node.js subpath imports (package.json `"imports"` field) and is clearly distinguishable from bare npm specifiers and relative paths.

## Design Overview

### Path alias strategy

Two config sites are needed per package:

```jsonc
// packages/<pkg>/tsconfig.json — satisfies tsc
{
  "compilerOptions": {
    "paths": {
      "#src/*": ["./src/*"],
      "#test/*": ["./test/*"]
    }
  }
}
```

```typescript
// packages/<pkg>/vitest.config.ts — satisfies vitest runtime
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "#src": path.resolve(import.meta.dirname, "src"),
      "#test": path.resolve(import.meta.dirname, "test"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

Vite's prefix alias replaces `#src` with the resolved `src/` directory, so `#src/agent-types` resolves to `<pkg>/src/agent-types.ts` at runtime.

### Import rewrite targets

| Package                | `.js` removals      | Cross-boundary rewrites                                     |
| ---------------------- | ------------------- | ----------------------------------------------------------- |
| `pi-subagents`         | ~323 (src + test)   | ~135 test→src, ~44 deep test→src, ~20 test→test helper      |
| `pi-permission-system` | 0                   | ~132 test→src, ~37 src `../../` (handlers/gates → src root) |
| `pi-github-tools`      | 0                   | ~8 test→src                                                 |
| `pi-colgrep`           | ~13 src, ~8 test    | ~8 test→src                                                 |
| `pi-autoformat`        | 2 (dynamic imports) | ~32 test→src                                                |

For `pi-permission-system`, the `src/handlers/gates/*.ts` files reach `../../permission-events`, `../../types`, `../../path-utils`, etc.
These are genuine cross-subdirectory reaches and benefit from `#src/` aliases.
Sibling-directory imports within `src/` (e.g., `"../active-agent"` from inside `src/forwarded-permissions/`) are one level of `..` and stay relative — they are cohesive subdirectory neighbours.

### Sequencing rationale

Each package is migrated independently and in a separate commit set so CI stays green after every merge.
Within a package, the sequence is:

1. Rename `tests/` → `test/` (if applicable) and update `tsconfig.json`.
2. Create or update `vitest.config.ts` with `resolve.alias`.
3. Strip `.js` suffixes (mechanical sed pass).
4. Rewrite cross-boundary imports to `#src/*` / `#test/*`.
5. Verify: `pnpm run check && pnpm run test`.

## Module-Level Changes

### Cross-package (all five)

No shared module changes — each package is self-contained.

### `pi-github-tools`

- `tests/` → `test/` (directory rename).
- `tsconfig.json`: `"tests"` → `"test"` in `include`; add `paths`.
- New `vitest.config.ts` with `resolve.alias` and `test.include`.

### `pi-permission-system`

- `tests/` → `test/` (directory rename).
- `tsconfig.json`: `"tests"` → `"test"` in `include`; remove stale `"index.ts"` entry; add `paths`.
- New `vitest.config.ts` with `resolve.alias` and `test.include`.
- `src/handlers/gates/*.ts`: rewrite `../../` imports to `#src/`.

### `pi-subagents`

- `tsconfig.json`: add `paths`.
- New `vitest.config.ts` with `resolve.alias` and `test.include`.
- All `src/**/*.ts`: strip `.js` suffixes.
- All `test/**/*.ts`: strip `.js` suffixes; rewrite `../src/` and `../../src/` to `#src/`; rewrite `../helpers/` (from nested dirs) to `#test/helpers/`.

### `pi-colgrep`

- `tsconfig.json`: add `"test"` to `include`; add `paths`.
- `vitest.config.ts`: add `resolve.alias` (file already exists).
- `src/**/*.ts`: strip `.js` suffixes.
- `test/**/*.ts`: strip `.js` suffixes; rewrite `../../src/` to `#src/`.

### `pi-autoformat`

- `tsconfig.json`: add `paths`.
- `vitest.config.ts`: add `resolve.alias` (file already exists).
- `test/**/*.ts`: rewrite `../src/` to `#src/`; strip `.js` from dynamic imports.

## Test Impact Analysis

1. **New tests enabled**: None — this is purely a mechanical refactor.
   No new logic is introduced.
2. **Tests that become simpler**: All test files gain clearer import lines.
   Fragile `../../src/` reaches become unambiguous `#src/` specifiers.
3. **Tests that stay as-is**: All tests remain structurally unchanged; only the import specifier strings change.
   Mocks, fixtures, and assertions are untouched.
4. **Risk of silent breakage**: If the `vitest.config.ts` alias is missing or wrong, tests fail with `Cannot find module '#src/...'`.
   This surfaces immediately on `pnpm run test` — no silent failure mode.

## TDD Order

There is no meaningful red/green cycle here — every step is a mechanical rewrite verified by `pnpm run check && pnpm run test`.
The plan uses the `refactor:` prefix for import-only changes and `feat:` for new config files.

### Phase 1 — `pi-github-tools`

1. Rename `tests/` → `test/`.
   Update `tsconfig.json` (`include`, `paths`).
   Create `vitest.config.ts`.
   Rewrite imports.
   Verify.
   Commit: `refactor(pi-github-tools): normalize imports and rename tests/ to test/ (#157)`

### Phase 2 — `pi-permission-system`

1. Rename `tests/` → `test/`.
   Update `tsconfig.json` (`include`, remove stale `"index.ts"`, add `paths`).
   Create `vitest.config.ts`.
   Rewrite `src/handlers/gates/*.ts` cross-dir imports to `#src/`.
   Rewrite test→src imports to `#src/`.
   Verify.
   Commit: `refactor(pi-permission-system): normalize imports and rename tests/ to test/ (#157)`

### Phase 3 — `pi-subagents`

1. Add `paths` to `tsconfig.json`.
   Create `vitest.config.ts`.
   Strip `.js` from all `src/` imports.
   Strip `.js` from all `test/` imports.
   Rewrite test cross-boundary imports to `#src/` and `#test/`.
   Verify.
   Commit: `refactor(pi-subagents): normalize imports — drop .js and add path aliases (#157)`

### Phase 4 — `pi-colgrep`

1. Add `"test"` to `tsconfig.json` include, add `paths`.
   Add `resolve.alias` to `vitest.config.ts`.
   Strip `.js` from `src/` and `test/` imports.
   Rewrite test→src imports to `#src/`.
   Verify.
   Commit: `refactor(pi-colgrep): normalize imports — drop .js and add path aliases (#157)`

### Phase 5 — `pi-autoformat`

1. Add `paths` to `tsconfig.json`.
   Add `resolve.alias` to `vitest.config.ts`.
   Rewrite `test/` imports from `../src/*` to `#src/*`.
   Strip `.js` from dynamic imports.
   Verify.
   Commit: `refactor(pi-autoformat): normalize imports — add path aliases (#157)`

## Risks and Mitigations

| Risk                                                                                          | Mitigation                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitest does not auto-read `tsconfig.json` paths                                               | Explicitly configure `resolve.alias` in `vitest.config.ts` alongside `tsconfig.json` `paths`.                                                                     |
| Sed-based `.js` strip accidentally edits `.js` string literals                                | Review diff; string literals like `".js": [...]` or `addTouchedPath("/repo/c.js")` contain `"` but not `from "...js"` — regex `from "(\.\.\/[^"]+)\.js"` is safe. |
| `pi-permission-system` `tsconfig.json` stale `"index.ts"` entry causes tsc error after rename | Remove it in the same tsconfig edit; `index.ts` does not exist in the package.                                                                                    |
| Large-scale import rewrite introduces a typo that silently resolves to the wrong file         | `pnpm run check` (tsc) catches wrong-module imports; every test file touched is re-run.                                                                           |
| Renaming `tests/` breaks any CI path references                                               | Search `.github/workflows/` and package scripts — all use `pnpm run test` not hardcoded directory paths; safe.                                                    |

## Open Questions

- Whether to also alias `src/`-to-`src/` single-level relative imports (e.g., `"./agent-types"` within `pi-subagents/src/`) — deferred; they are unambiguous and do not cause navigation friction.
- Whether `pi-colgrep`'s `test/` directory should be included in the published package check or remain dev-only — out of scope; tsconfig `include` change here is for type checking only.
