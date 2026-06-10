---
issue: 382
issue_title: "pi-permission-system: external_directory base permission doesn't auto-detect or allow overrides for pi docs directory when installed via npm on Windows"
---

# Retro: #382 — Windows case-insensitive `external_directory` matching and Pi-install auto-detect

## Stage: Planning (2026-06-10T00:00:00Z)

### Session summary

Traced the reported bug to a Windows-only path-comparison asymmetry: the path under test is canonicalized and lowercased on `win32` (`normalizePathForComparison` / `canonicalNormalizePathForComparison`), but infra-dir containment (`isPathWithinDirectory`, case-sensitive `startsWith`) and config-pattern matching (`compileWildcardPattern`, case-sensitive `RegExp`) keep native case — so both the infrastructure auto-allow and explicit `external_directory` overrides silently fail.
Produced `docs/plans/0382-windows-external-directory-case-insensitive.md` with a 6-step TDD order covering `path.relative` containment, case/separator-folded path-surface matching, and Pi-install auto-detect via `getPackageDir()`.

### Observations

- The user steered the design with two questions ("is there a builtin node path library?"
  / "how does pi handle this itself?").
  Confirmed `path.win32.relative` folds case natively, and Pi's own idiom (`getCwdRelativePath`, `getPiDocsClassification` in `packages/coding-agent/src/utils/paths.ts` and `core/tools/read.ts`) is `relative()` + `..`/absolute check with no manual lowercasing — adopted as the containment approach.
- `path.matchesGlob` was rejected: its `*` does not cross separators and it is case-sensitive even on `win32`, so it would change the established `*`→`.*` semantics without fixing the case bug.
- Two `ask_user` calls settled scope: (1) comparison fix **plus** pi-API auto-detect, (2) adopt `path.relative` broadly; a follow-up picked `getPackageDir()` (whole Pi install dir) over docs-only paths.
- Key dependency constraint: `getPackageDir()` / `getDocsPath()` are only re-exported from `@earendil-works/pi-coding-agent`'s entry point as of `v0.79.0` (commit `eb43bd44`); the installed devDependency `0.75.4` exports only `getAgentDir` + `VERSION`.
  The plan therefore bumps the peer floor `>=0.75.0` → `>=0.79.0` (the reporter runs `0.79.1`).
- Testability decision: stubbing `process.platform` does **not** switch Node's top-level `path` functions to `win32`, so production code selects `path.win32`/`path.posix` from an injected, defaulted `platform` parameter and tests pass `"win32"` + `C:\…` paths.
  This also satisfies the AGENTS.md "no `process.platform` inside library functions" guidance.
- `evaluate` in `rule.ts` is the single surface-aware matching site; folding is scoped to a new exported `PATH_SURFACES` set (`PATH_BEARING_TOOLS` ∪ `{ external_directory, path }`) so `bash`/`skill`/`mcp` stay case-sensitive.
- Classified as a non-breaking `fix:` — POSIX behavior is unchanged and the peer bump does not alter runtime behavior/config on upgrade.
- Deferred (non-goals): removing the now-redundant `win32` lowercasing in `normalizePathForComparison`, and dissolving `subagent-context.ts`'s duplicate containment helper.

## Stage: Implementation — TDD (2026-06-10T19:17:00Z)

### Session summary

Implemented the Windows case-insensitive path-matching fix across 7 commits (6 TDD cycles + 1 docs): `path.relative`-based containment in `isPathWithinDirectory`, `WildcardMatchOptions` (case-insensitive + Windows-separator folding) on the matcher, case-insensitive infra-read auto-allow, path-surface case folding in `evaluate` via a new `PATH_SURFACES` set, an optional `piPackageDir` on `computeExtensionPaths`, and `getPackageDir()` wiring at the composition root (with the `@earendil-works/pi-coding-agent` / `pi-tui` floor bump `>=0.75.0` → `>=0.79.0`, devDeps `0.79.1`).
Test count went from 1902 to 1921 (+19); full suite, `check`, `lint`, and `fallow dead-code` all green.

### Observations

- Pre-completion reviewer: PASS.
- Reviewer warnings: one non-blocking WARN — `evaluateFirst` / `evaluateMostRestrictive` delegate to `evaluate` without exposing `platform`, so they are not unit-testable for Windows case-folding on a POSIX CI (runtime behavior is correct because `process.platform` is `win32` in production; the Windows path is covered compositionally by the `evaluate`-level tests).
  Left as-is; a future change could thread `platform` through them if dedicated Windows coverage is wanted.
- Deviation 1: did **not** thread `platform` into `isPathOutsideWorkingDirectory` (the plan suggested it).
  Its internal `isPathWithinDirectory` call already captures the runtime platform via the default param, and the `win32` path there is not unit-testable on a POSIX CI because `canonicalizePath` splits on `/`.
  Avoided an untested parameter.
- Deviation 2: reordered the plan's steps — the `wildcard-matcher` options had to land **before** `isPiInfrastructureRead` consumed them (the plan listed infra-read first and the matcher options later).
  A real dependency-ordering correction.
- Deviation 3: skipped the plan's brittle end-to-end external-directory gate integration test (Red C).
  Flipping `process.platform` does not switch Node's `path.win32` dispatch on a POSIX runner, and the gate's `canonicalNormalizePathForComparison` only lowercases on real `win32`, so a darwin-runner integration test would be unreliable.
  Coverage is provided by the composed unit tests at the `evaluate` / wildcard / `path-utils` levels.
- The `pnpm install` after the dep bump printed "Already up to date" but did update `pnpm-lock.yaml` (+205 lines adding `0.79.1`); verified the installed `index.d.ts` re-exports `getPackageDir` before wiring `index.ts`.
