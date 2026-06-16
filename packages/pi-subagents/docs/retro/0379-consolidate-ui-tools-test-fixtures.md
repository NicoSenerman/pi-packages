---
issue: 379
issue_title: "Consolidate UI and tools test fixtures"
---

# Retro: #379 — Consolidate UI and tools test fixtures

## Stage: Planning (2026-06-16T00:00:00Z)

### Session summary

Produced a 9-step lift-and-shift plan for Phase 17 Step 8 — consolidating the non-lifecycle test clone families.
Measured the live baseline (`fallow dupes -r packages/pi-subagents`: 32 clone groups / 512 lines / 2.49%, seven families) and characterized each family by reading all seven test files, classifying each as genuine cross-file duplication (one) versus intra-file (six).

### Observations

- The only genuine cross-file duplication is the `ResolvedSpawnConfig` builder shared by `foreground-runner.test.ts` and `background-spawner.test.ts` (`dup:80ee2004`) — the one promotion to `test/helpers/` (`make-spawn-config.ts`).
  Everything else fallow scores same-file, so it stays file-local or moves into a describe-scoped `beforeEach`, per Step 7's ([#378]) discipline.
- The plan's central constraint is Step 7's hard-won lesson: never wrap the system-under-test **act** in a helper to chase a duplication metric.
  Every extracted helper returns a value (`createResolvedSpawnConfig`, `disabledConfig`, `exploreConfig`, `createManagerStub`, `spawnAndWaitRegistering`) or seeds `beforeEach`; the acts stay inline.
  Added an "Invariants at risk" grep check to enforce this at review.
- Scope was genuinely ambiguous and resolved via `ask_user`: the issue body names six files, but fallow reports a seventh non-lifecycle family in `test/service/service-adapter.test.ts` (four near-identical `SubagentManagerLike` stubs).
  Operator chose to include service-adapter (seven files total) and to **not** bind a numeric group target — acceptance is "each named family consolidated, resulting fallow numbers reported."
  My `ask_user` prompt incorrectly claimed the architecture roadmap's Step 8 `Targets` lists service-adapter; it does not (it lists the six issue-body files).
  The plan corrects this and notes service-adapter was added in planning.
- The roadmap's stated Step 8 outcome ("clone groups 44 → ≤ 25; overall duplication ≤ 0.6%") predates Steps 1–7 and does not match the current fallow metric (2.49%); flagged as an Open Question rather than treated as binding.
- Non-Goals call out the two residual lifecycle families (Step 7 left them as the visible act), the 11-line production clone inside `src/ui/agent-config-editor.ts` (test-only issue), and the three overlapping session-mock builders ([#412]).
- `ResolvedSpawnConfig` is deeply nested (`identity`/`execution`/`presentation` with mirrored scalars).
  Designed the shared builder to take **flat** options and assemble the nested structure internally — sidesteps the `Partial<T>` deep-merge trap and encapsulates the mirroring (`agentInvocation.runInBackground`, `presentation.detailBase`) the hand-built copies duplicate.

[#378]: https://github.com/gotgenes/pi-packages/issues/378
[#412]: https://github.com/gotgenes/pi-packages/issues/412
