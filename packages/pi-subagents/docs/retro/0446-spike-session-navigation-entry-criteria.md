---
issue: 446
issue_title: "pi-subagents: spike — resolve ADR-0004 session-navigation entry criteria"
---

# Retro: #446 — pi-subagents: spike — resolve ADR-0004 session-navigation entry criteria

## Stage: Planning (2026-06-20T00:00:00Z)

### Session summary

Planned the Phase 19 Step 1 spike that answers the four ADR-0004 session-navigation entry criteria and records them as an ADR-0004 addendum.
Confirmed the release is independent and that the only committed artifact is the addendum.
The plan lives at `packages/pi-subagents/docs/plans/0446-spike-session-navigation-entry-criteria.md`; next stage is `/build-plan` (docs/spike deliverable, no committed TDD cycles).

### Observations

- Operator owns the issue (`gotgenes` == gh user), so the "Proposed change" is the working hypothesis.
  Used `ask_user` once to resolve two method ambiguities: spike method = **automated observed test (vitest)**, committed artifact = **ADR addendum only** (the vitest harness is throwaway, discarded).
- Gathered the SDK evidence up front so the addendum's expected answers are grounded: `switchSession` is a full active-session takeover that tears down the current runtime via `session_shutdown` (so it threatens the root's in-flight turn); `ReplacedSessionContext` exposes `sendUserMessage` (switch makes the child interactive); `loadEntriesFromFile`/`parseSessionEntries` read entries without switching; `Subagent.outputFile` already exposes the child JSONL path; sibling commands use flat hyphenated names (`agents`, `colgrep-reindex`, `permission-system`).
- Expected recommendations the spike will confirm: read-only `loadEntriesFromFile` transcript (resolves root-continuity by construction), command-first parallel-agent selection (widget gesture deferred), and `/subagents-settings` (reject the ADR's tentative `/subagents:settings`).
- `setBeforeSessionInvalidate` is a **host** runtime seam (`agent-session-runtime`/`interactive-mode`), not on the extension command context — noted in Background so Step 4 does not assume the extension can call it.
- No production code changes and no invariants at risk; the read-only path was chosen partly to keep transcript rendering out of core (preserving the Phase 18 spine invariants `[#422]`–`[#425]`).

[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#425]: https://github.com/gotgenes/pi-packages/issues/425
