---
issue: 288
issue_title: "Extract shared test fixtures to cut permission-system test duplication"
---

# Retro: #288 — Extract shared test fixtures to cut permission-system test duplication

## Stage: Planning (2026-05-31T00:00:00Z)

### Session summary

Produced a numbered migration plan for extracting duplicated test setup in `pi-permission-system/test/` into focused `test/helpers/` modules.
Grounded the clone families in a live `fallow dupes` run (122 groups, 9.1%) and confirmed the divergent `makeCheckResult` defaults across `gates/runner`, `gates/bash-path`, and `tool-call` copies.
Plan is a pure test refactor (no `src/` changes); next step is `/build-plan` since cycles are migrate → full-suite-green → commit, not red→green.

### Observations

- Three user-confirmed design decisions via `ask_user`: no co-located helper tests (transitive coverage), focused files by concern (mirror `pi-subagents/test/helpers/`), and a single neutral-default `makeCheckResult` with explicit per-call overrides.
- The divergent `makeCheckResult` defaults are the main correctness risk — `bash-path` uses `toolName: "path"`/`source: "special"`/`origin: "global"`; `runner` adds `matchedPattern: "*"`.
  Migration must pass each site's original fields as explicit overrides.
- Watch the testing-skill trap: do not annotate mock-bag factories (`makeHandler`, `makeRunnerDeps`) with the production interface, or `.mockReturnValue` access is erased.
- Keep the regression-guard import in `external-directory-integration.test.ts` — it intentionally fails the load if a message helper is removed.
- `permission-system.test.ts` is 2839 lines; only the targeted intra-file `createManager`/config clones are in scope — leave `withIsolatedSubagentEnv` and env handling untouched.
- Step 5 (lifecycle setup) and the ext-dir block's final home are flagged as open questions to settle during implementation.
- Initial `Write` hit an external-directory denial from a wrong absolute path (`/Users/chris/development/pi/pi-permission-system/...`); the repo root is `pi-packages`.
  Use repo-relative paths.
