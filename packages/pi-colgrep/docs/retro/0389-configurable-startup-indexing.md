---
issue: 389
issue_title: "pi-colgrep always starts indexing on startup"
---

# Retro: #389 — pi-colgrep always starts indexing on startup

## Stage: Planning (2026-06-12T00:15:50Z)

### Session summary

Planned the response to a third-party feature request (graelo) that pi-colgrep blocks Pi startup by indexing eagerly on `session_start`.
Confirmed the direction with the operator via three `ask_user` gates and produced `packages/pi-colgrep/docs/plans/0389-configurable-startup-indexing.md` with six TDD cycles.
The agreed approach is "both": run the startup index in the background (non-blocking) and make it disable-able via a `config.json` boolean `indexOnStartup` (default `true`, non-breaking).

### Observations

- The issue's `pkg:pi-subagents` label is wrong; the body and content are unambiguously about `pi-colgrep`.
  Filed the plan under `packages/pi-colgrep/`.
- Key realization: the colgrep CLI's `search` already auto-indexes on demand, so lazy indexing is free; the extension's `await reindexer.runNow()` on `session_start` is the only blocking cost.
- Operator-driven refinements beyond the raw proposal: (1) background + disable-able, not a trigger-policy enum; (2) gate the existing write/edit auto-reindex on whether an index already exists, checked **once** at startup via `colgrep status`, not per edit; (3) warn once per session when skipping; (4) flip the `indexExists` gate when the user manually runs `/colgrep-reindex`.
  Operator also chose the name `indexExists` over `indexEstablished`.
- Found a real concurrency gap to fix before backgrounding: `reindexer.runNow()` neither assigns `inflightPromise` (so `shutdown()` cannot await a fire-and-forget run) nor guards against a concurrent `runNow()` (so `/colgrep-reindex` mid-startup would launch a second `colgrep init`).
  Cycle 3 closes both via a coalescing `startRun()`.
- Verified empirically: `colgrep status <path>` exits `0` whether or not an index exists and has no `--json`; index existence must be parsed from stdout (`No index found` is the stable negative signal).
  Captured this as the `indexExistsFromStatus` pure predicate.
- Config module mirrors the `pi-github-tools` / `pi-subagents-worktrees` convention (global `<agentDir>/extensions/pi-colgrep/config.json` + project `<cwd>/.pi/extensions/pi-colgrep/config.json`, project wins), which matches graelo's suggested path.
  No `package-pi-colgrep` skill file exists despite the AGENTS.md reference, so no internal-docs update is needed.
- Classified non-breaking: default `indexOnStartup: true` preserves eager indexing (now non-blocking); write/edit gating is transparent for default users because the startup index sets `indexExists = true`.

## Stage: Implementation — TDD (2026-06-12T01:26:47Z)

### Session summary

Implemented all six TDD cycles from the plan across 6 `feat`/`docs` commits.
Added `src/lib/config.ts` (the `indexOnStartup` loader) and `src/lib/index-status.ts` (the `colgrep status` index-existence probe), hardened `src/lib/reindex.ts` so `runNow()` coalesces concurrent runs and tracks its in-flight promise, made the `session_start` startup index fire-and-forget gated on config, and gated the write/edit auto-reindex on a once-per-session `indexExists` probe with a one-time skip notice and a flip on `/colgrep-reindex`.
Test count went 87 → 116 (+29); full suite, `check`, `lint`, and `fallow dead-code` all green.

### Observations

- Two intentional deviations from the plan's literal cycle boundaries: (1) the `colgrep status` probe assertion was implemented in Cycle 5 alongside its consumer rather than Cycle 4, to keep Cycle 4 free of a write-only variable (biome `noUnusedVariables`); (2) the extension-level "`shutdown()` awaits the backgrounded startup index" behavior is covered by the Cycle 3 reindexer unit test rather than a duplicate extension-level test.
- Existing `session_start` tests used one blanket `mockResolvedValue` for every `exec` call; the new `colgrep status` probe returns `""` under that mock, which `indexExistsFromStatus` reads as "index exists" (`true`), so the legacy `tool_result` scheduling tests kept passing unchanged.
- Extension tests mock `#src/lib/config` via a `vi.hoisted` `loadConfig` stub so `indexOnStartup` is controllable without touching the filesystem; the real `getAgentDir()` and path builders run but their output is ignored by the mocked loader.
- The "non-blocking" assertion is expressed by holding the `init` exec and checking that `session_start` returns with the indexing status still set (not cleared) — a clean proxy for "the handler didn't await the build".
- The status-clear test needed draining: with fire-and-forget startup, the status-clear runs after the handler returns, so the test now triggers `session_shutdown` (which awaits the in-flight run via the Cycle 3 hardening) before asserting.
- Pre-completion reviewer verdict: PASS — ready for `/ship-issue`.
  No WARN findings.
  Reviewer noted the pre-existing duplicated inline `exec` wrapper literal in `extension.ts` is not introduced by this PR.

## Stage: Final Retrospective (2026-06-12T02:22:10Z)

### Session summary

Shipped issue #389 end-to-end across four stages (Planning, TDD, Ship, post-ship docs): `pi-colgrep` startup indexing is now non-blocking and disable-able via an `indexOnStartup` config, released as `pi-colgrep-v1.5.0`.
The ship stage was clean (CI green, issue closed, release-please `UNSTABLE`-no-checks case handled correctly).
After shipping, the user asked to bring docs up to date and add an architecture document like sibling packages have; that produced `packages/pi-colgrep/docs/architecture/architecture.md` (plus a `README.md` index and a `release-please-config.json` exclude-path).

### Observations

#### What went well

- The three planning-stage `ask_user` gates turned a vague third-party request into a precisely-scoped design: the operator's "do both" answer, the gate-on-existing-index refinement, warn-once, and the `indexExists` naming all came from that dialogue rather than from guessing.
- Empirical CLI verification during planning (`colgrep status` exit codes, no `--json`, the `No index found` signal) meant the `indexExistsFromStatus` predicate was correct on first implementation — no rework in TDD.
- Incremental verification: `pnpm run check` / `biome` ran right after the interface-touching cycles (3, 4, 5), not just at the end, so the `runNow()` signature change and the config-mock wiring were validated before each commit.
- Mermaid diagrams in the new architecture doc were validated with `mmdc` (all three rendered) before committing, per the `mermaid` skill.

#### What caused friction (agent side)

- `other` (tool-schema misuse) — the first two `Edit` attempts on `test/extension.test.ts` included a non-schema `endText` property and were rejected.
  Impact: 2 wasted tool calls, no code rework; fixed on the third attempt by splitting into two clean edits.
- `missing-context` — the architecture document was user-caught, not agent-proposed.
  The plan and the pre-completion reviewer both noticed `pi-colgrep` had no `docs/architecture/` and explicitly concluded "nothing to update," treating absence as a terminal skip even though the change added two modules plus a reindexer state machine and two sibling packages maintain architecture docs.
  Impact: one extra user request post-ship; cleanly handled, no rework.

#### What caused friction (user side)

- None blocking.
  The architecture-doc ask is better read as an opportunity (below) than a user-side friction: the workflow's architecture-doc checks are existence-gated, so the user reasonably had to initiate.

### Follow-ups (not implemented here)

- `packages/pi-colgrep/AGENTS.md` references a `package-pi-colgrep` skill that does not exist.
  Creating that skill (architecture summary, testing notes, priorities — mirroring `package-pi-subagents`) is substantive work; suggest a dedicated issue + `/plan-issue` rather than an inline retro change.

### Changes made

1. Recorded this Final Retrospective entry in `packages/pi-colgrep/docs/retro/0389-configurable-startup-indexing.md`.
2. No prompt or `AGENTS.md` changes: the user declined the proposed architecture-doc-absence nudge for `.pi/prompts/plan-issue.md`.
3. Created the previously-missing `package-pi-colgrep` skill at `.pi/skills/package-pi-colgrep/SKILL.md` (follow-up promoted to inline work at the user's request).
   It mirrors the `package-pi-github-tools` template (intro, architecture file tree, `Exec`-seam SDK boundary, implementation priorities, the `colgrep` CLI facts, configuration, and testing patterns) and points to `docs/architecture/architecture.md` for the full design.
   This resolves the stale reference in `packages/pi-colgrep/AGENTS.md`.
