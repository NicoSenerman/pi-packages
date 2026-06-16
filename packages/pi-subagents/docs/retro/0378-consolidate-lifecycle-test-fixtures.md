---
issue: 378
issue_title: "Consolidate lifecycle test fixtures"
---

# Retro: #378 — Consolidate lifecycle test fixtures

## Stage: Planning (2026-06-15T00:00:00Z)

### Session summary

Planned Phase 17 Step 7 — consolidating the lifecycle test clone families into shared/file-local helpers.
Produced `docs/plans/0378-consolidate-lifecycle-test-fixtures.md` with a six-step lift-and-shift TDD order and committed it.

### Observations

- The issue body is stale relative to `main`: it cites five families across six files (including `concurrency-queue.test.ts` and a 766-LOC `subagent-manager.test.ts`).
  Measuring with `fallow dupes -r packages/pi-subagents` against today's `main` shows **four** lifecycle families — Steps 1–6 already removed the queue (`concurrency-queue.test.ts` → `concurrency-limiter.test.ts`) and the `subagent.test.ts`/`concurrency-limiter.test.ts` families.
  The plan is written against the measured current state, not the issue snapshot.
- Design call: promote to `test/helpers/` only the genuinely cross-file duplication (the `createSubagentSession`-test mock-session builder, shared by `create-subagent-session.test.ts` and `create-subagent-session-extension-tools.test.ts` — `createFactorySession`).
  The manager and `subagent-session` families are intra-file (fallow recommends same-file extraction), so they get file-local helpers.
  Force-promoting intra-file families to `test/helpers/` would manufacture cross-file coupling that does not exist.
- Resisted extracting the `io.createSession.mockResolvedValue(...)` + `createSubagentSession(...)` invoke pair into a helper — two lines with per-test varying overrides; wrapping the system-under-test call would be procedure-splitting, not design improvement.
- Invariants at risk flagged: Step 1/Step 3's "every spawned agent has a `promise` at spawn" (pinned by the queued-promise test) and Step 3's "zero external `.promise`/`.notification` writes outside `subagent.ts`" (grep-verifiable).
  `arrangeQueuedPair()` must return the queued id; Step 4 folds in a re-grep.
- Baseline: package test duplication 669 lines / 3.3% across 20 files; the four lifecycle families total ~122 lines, so Step 7 alone should land below the 600-line goal (~547).
  Flagged as an Open Question pending the Step 6 `fallow dupes` measurement.
- Not breaking — test-only, no `src/`, public-surface, or behavior change.
