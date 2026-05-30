---
issue: 267
issue_title: "Finish the inversion: retire inbound subagent-registration surface from PermissionsService"
---

# Retro: #267 — Finish the inversion: retire inbound subagent-registration surface from `PermissionsService`

## Stage: Planning (2026-05-30T00:00:00Z)

### Session summary

Produced a cross-package implementation plan to remove `registerSubagentSession` / `unregisterSubagentSession` (and the orphaned `SubagentSessionInfo` re-export) from `@gotgenes/pi-permission-system`'s `PermissionsService`, now that [#261] inverted registration to event subscription.
The plan covers the interface/impl/test removal in one breaking (`feat!:`) commit plus two doc-reconciliation commits, and ends with a full refresh of the stale `@gotgenes/pi-subagents` `README.md`.

### Observations

- Prerequisite [#261] and the related [#265] are both **closed/implemented** — the event subscriber (`subscribeSubagentLifecycle`) and publisher (`child-lifecycle.ts`) are live, so this issue is a clean removal of dead inbound surface, not a mechanism change.
- The `SubagentSessionInfo` re-export from `service.ts` becomes dead public surface once the methods go (barrel-discipline rule); `pi-subagents` declares its own `ChildSessionCreatedEvent` and does not import it, so removal is safe.
- Single object-literal construction site in `index.ts` + excess-property checking on the two test literals means the interface change and all call-site/test updates must land in **one** commit.
- The user raised a **load-order** concern (pi-subagents vs. pi-permission-system).
  Investigated and dismissed: subscription happens at extension load, emission only at child-spawn runtime, so load always precedes emission regardless of order.
  Both `.pi/settings.json` and `~/.pi/agent/settings.json` already list `pi-permission-system` before `pi-subagents` (subscriber before publisher) — no settings edit needed, and those files are not a deliverable of this issue.
  Captured as a considered-and-dismissed item in the plan's Risks section.
- Scope decision via `ask_user`: the user chose a **full refresh** of the `pi-subagents` README (not bridge-only), so the plan also corrects the Phase 16 file-tree drift (`agent-runner.ts` / `agent-record.ts` dissolved by [#265], `worktree.ts` moved to `@gotgenes/pi-subagents-worktrees` by [#263]).
  Flagged as an open question to split out if it balloons beyond a listing correction.
- Cross-package plan → lives in top-level `docs/plans/` (both `pkg:*` labels present).

[#261]: https://github.com/gotgenes/pi-packages/issues/261
[#263]: https://github.com/gotgenes/pi-packages/issues/263
[#265]: https://github.com/gotgenes/pi-packages/issues/265

## Stage: Implementation — TDD (2026-05-30T20:10:00Z)

### Session summary

Completed all three TDD steps from the plan: (1) removed `registerSubagentSession` / `unregisterSubagentSession` from `PermissionsService` plus their `index.ts` implementation, `SubagentSessionInfo` re-export, and the two delegation tests — one `feat!:` commit with all related call-site/test changes bundled; (2) reconciled pi-permission-system docs (`cross-extension-api.md`, `subagent-integration.md`, `architecture.md`); (3) refreshed the stale `@gotgenes/pi-subagents` `README.md` (permission-integration section, Deviation #4, full file-tree refresh).
Test count: 1512 → 1510 in pi-permission-system (two delegation tests removed); all other packages unchanged.
All deterministic checks pass: `pnpm run check`, `pnpm run lint`, `pnpm -r run test`, `pnpm fallow dead-code`.

### Observations

- **Pre-existing lint failure** in `docs/architecture/architecture.md` (unused `[#283]` reference) blocked the green baseline; fixed as a separate cleanup commit before step 1.
- **Single-commit constraint held**: interface removal + `index.ts` literal + `test/service.test.ts` cleanup all landed in one commit — TypeScript excess-property checking enforces this.
- **Edit-tool overlap**: the first attempt to edit `test/service.test.ts` failed because edits 2 and 3 targeted adjacent regions; merged into a single contiguous replacement on the second attempt.
- **Relative-link bug**: the initial doc edit wrote `subagent-integration.md` (bare filename) in `docs/architecture/architecture.md`; lint (MD057) caught it; corrected to `../subagent-integration.md` in the same commit.
- **Historical plan preserved**: `docs/plans/0221-subagent-session-registry.md` retains references to the removed methods — appropriate, as archival plans are records of decisions, not current-state docs.
- **SKILL.md straggler**: pre-completion reviewer (verdict: WARN) flagged a stale "removal tracked in #267" sentence in `.pi/skills/package-pi-permission-system/SKILL.md`; removed in a follow-up `docs:` commit.
  No other warnings.

## Stage: Final Retrospective (2026-05-30T21:00:00Z)

### Session summary

Shipped #267 end-to-end across four stages (plan → TDD → ship → retro): removed the inbound `registerSubagentSession` / `unregisterSubagentSession` surface from `PermissionsService`, reconciled three pi-permission-system docs, and refreshed the `@gotgenes/pi-subagents` `README.md`.
Released `pi-permission-system` 7.4.1 → 8.0.0 (breaking) and `pi-subagents` 13.2.0 → 13.2.1 (docs) via release-please PR #284.
A notably clean session: one breaking `feat!:` commit plus doc commits, no rework, CI green on first push.

### Observations

#### What went well

- **Load-order investigation (novel win)**: the user raised a load-order concern during planning; instead of accepting the framing or mechanically editing settings, the agent traced the actual event lifecycle (load-time subscription vs. runtime emission) to prove ordering is irrelevant, then confirmed both settings files already list `pi-permission-system` before `pi-subagents`.
  Prevented an unnecessary, misleading change and produced a documented Risks entry.
- **`ask_user` scope gate (planning)**: the bridge-only vs. full-README-refresh question cleanly surfaced a real scope boundary (#263/#265 drift) rather than guessing; the user chose full refresh.
- **Pre-completion reviewer earned its keep**: it caught the stale `SKILL.md` sentence that the TDD grep-sweep missed — a real straggler, fixed before ship rather than landing on `main`.
- **Incremental verification**: `check` / `lint` / `test` / `fallow` ran after the code step and `lint` after each doc step, not just at the end; the pre-existing `[#283]` lint failure was handled as a separate baseline-cleanup commit per the prompt.

#### What caused friction (agent side)

- `missing-context` — the TDD straggler-sweep grep covered `src/`, `test/`, and specific doc files but not `.pi/skills/package-*/SKILL.md`, so the stale `package-pi-permission-system` skill reference slipped past the sweep and was only caught by the reviewer.
  Impact: one extra `docs:` commit; no `main` breakage (caught at WARN).
  Self-identified?
  No — reviewer-caught.
- `other` (tool mechanics) — first `Edit` to `test/service.test.ts` was rejected because two edits targeted adjacent/overlapping regions; merged into one contiguous replacement on retry.
  Impact: one retry, no rework.
- `missing-context` (minor) — the first architecture-doc edit used a bare relative link `subagent-integration.md` from `docs/architecture/`; markdownlint MD057 caught it; fixed to `../subagent-integration.md` within the same commit.
  Impact: one extra edit, no separate commit.

#### What caused friction (user side)

- None.
  The load-order concern was raised early and as a question, which is the ideal collaboration shape — it prompted a verification rather than a correction after the fact.

### Diagnostic details

- **Model-performance correlation** — one subagent dispatch (`pre-completion-reviewer`, 171.6s, 30 tool uses) on judgment-heavy doc/code review; appropriate model for the task, no mismatch.
- **Feedback-loop gap** — verification cadence was incremental and healthy; the only gap was *scope*, not *timing*: the removed-symbol sweep omitted `.pi/skills/`.
  Other lenses (escalation-delay, unused-tool) found nothing notable — no error sequence exceeded two tool calls.

### Changes made

1. `.pi/prompts/plan-issue.md` — extended the removed-symbol grep-sweep guidance (Module-Level Changes) to include `.pi/skills/package-*/SKILL.md`, closing the blind spot that let a stale skill reference slip past the TDD sweep.
