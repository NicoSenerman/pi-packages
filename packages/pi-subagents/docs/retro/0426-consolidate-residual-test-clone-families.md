---
issue: 426
issue_title: "pi-subagents: consolidate residual test clone families"
---

# Retro: #426 — pi-subagents: consolidate residual test clone families

## Stage: Planning (2026-06-18T17:48:42Z)

### Session summary

Produced a numbered plan (`docs/plans/0426-consolidate-residual-test-clone-families.md`) for consolidating the residual test clone families in four named `pi-subagents` test files.
Ran `fallow dupes` to enumerate the live clone groups: 24 test clone groups package-wide, of which the four target files (`test/settings.test.ts` + `test/layered-settings.test.ts`, `test/lifecycle/create-subagent-session.test.ts`, `test/ui/agent-config-editor.test.ts`) contribute exactly 10 — consolidating them lands at 14, below the issue's `<15` target.
The plan is a test-only refactor verified by the existing suite staying green plus a falling fallow clone count; the follow-up is `/build-plan` (no red→green behavior cycles).

### Observations

- Release: ship independently — the Phase 18 roadmap step 7 carries no `Release: batch` tag and is explicitly "independent of the disentanglement spine."
- The `testing` skill's rule "do not wrap the system-under-test call in a helper to eliminate a duplication-metric clone" drove the design: consolidate *arrange* only, keep every `loadSettings`/`createSubagentSession`/`showAgentDetail` act written out.
  For `agent-config-editor` menu cases, `it.each` is the right tool — it keeps the act visible in the table body rather than hiding it in a helper.
- Three independent consolidations: (1) a new shared `test/helpers/tmp-settings-dirs.ts` fixture for the cross-file settings tmp-dir scaffolding (with paired self-test, per the `test/helpers/*.test.ts` convention); (2) file-local `arrangeFactory`/`defaultDeps` for the `create-subagent-session` post-bind-guard block; (3) `it.each` table + hoisted `filePath` for `agent-config-editor`.
- Scope deliberately excludes: the production clone in `src/ui/agent-config-editor.ts` (test-only issue), the cross-package `vitest.config.ts` clone, the `5d8dbd48` group spanning `subagent-manager.test.ts` ↔ `subagent.test.ts` (neither is a target file), and all other non-target test clone families.
- Key risk flagged for build: removing inline `writeGlobal`/`writeProject` may orphan fs imports (`mkdtempSync`/`rmSync`/`mkdirSync`/`writeFileSync`/`tmpdir`/`join`); Biome `noUnusedImports` is warning-level, so step 4 runs `pnpm fallow dead-code` as the backstop.
- Markdown lint gotcha hit during planning: bare `#N` inline mentions are fine, but reference-style `[#N]` link defs trip `MD053` unless a matching bracket reference exists in the body — kept only the `[#427]` cross-link def.

## Stage: Implementation — Build (2026-06-18T18:14:01Z)

### Session summary

Executed all four refactor steps plus the architecture doc-flip across four commits.
Extracted two shared test fixtures (`test/helpers/tmp-settings-dirs.ts`, `test/helpers/capture-warn.ts`, each with a paired self-test) and table-drove the `create-subagent-session` post-bind and `agent-config-editor` menu/confirm-remove cases into `it.each`.
Dropped pi-subagents test clone groups from 24 to 14 (below the `<15` target); full suite green at 1047 tests (was 1038), type check and lint clean, `fallow dead-code` clean.

### Observations

- Pre-completion reviewer: PASS (deterministic checks, assertion-strength preservation, act-visibility, and no-coverage-drop all verified).
- Deviation 1 — the settings fixture exposes a `dispose()` method instead of the plan's separate `disposeSettingsDirs()` function (Tell-Don't-Ask; the fixture disposes itself).
- Deviation 2 — added `test/helpers/capture-warn.ts` (`captureWarn`) beyond the plan's tmp-dir-only fixture.
  The plan's Step 1 verify listed clone group `4003c0e7` (the `console.warn` spy try/finally boilerplate) as expected-gone, but the tmp-dir fixture alone did not address it; the warn-capture helper does, and migrating the spy tests in both files cleared it.
  Squarely within the issue's "extract shared fixtures for the clone families" intent.
- Deviation 3 — Step 2's first pass (arrange helpers only) left a transient arrange+assert clone (`62899223`) between the two adjacent post-bind membership tests; folding the three membership cases into one `it.each` with a strong `toEqual` (replacing the prior `toContain` checks) cleared it.
- Used destructure-to-locals in `settings.test.ts`/`layered-settings.test.ts` (e.g. `({ globalDir: agentDir, projectDir: cwd, ... } = dirs)`) rather than the plan's `dirs.X` member-access sketch — keeps the existing terse test bodies unchanged and lowers edit risk.
- Dropped one brittle `captureWarn` self-test ("suppresses real stderr") that was actually exercising `vi.spyOn`'s restore-to-original semantics with nested spies, not the helper's behavior.
- The risk flagged at planning (orphaned `node:fs`/`node:os` imports after removing inline `writeGlobal`/`writeProject`) materialized only in `layered-settings.test.ts` (`mkdtempSync`/`rmSync`/`tmpdir`/`vi` became unused); removed them, and `fallow dead-code` confirmed clean.
