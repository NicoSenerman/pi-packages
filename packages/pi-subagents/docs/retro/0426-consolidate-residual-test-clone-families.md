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
