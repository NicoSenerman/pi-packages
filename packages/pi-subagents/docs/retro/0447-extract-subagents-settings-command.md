---
issue: 447
issue_title: "pi-subagents: extract subagent settings to a focused /subagents-settings command"
---

# Retro: #447 — pi-subagents: extract subagent settings to a focused /subagents-settings command

## Stage: Planning (2026-06-20T00:00:00Z)

### Session summary

Produced a numbered TDD plan for Phase 19 Step 2: a purely additive extraction of `AgentsMenuHandler.showSettings` into a standalone `SubagentsSettingsHandler` registered as the `/subagents-settings` command.
Confirmed the command name against the closed spike (#446) and its ADR-0004 addendum (Criterion 4), and verified `SettingsManager` already structurally satisfies the new narrow manager interface so it can be passed directly.
The plan ships independently (roadmap `Release: independent`).

### Observations

- The extraction is a faithful verbatim lift — `showSettings` already had zero coupling beyond `this.settings` and `ui`, so the design-review checklist came back clean (100% field usage on both new narrow interfaces, no LoD/output-arg smells).
  Classified as a genuine collaborator extraction, not procedure-splitting.
- Declared two narrow interfaces owned by the new module: `SubagentsSettingsManager` (shape-identical to the doomed `AgentMenuSettings` but with no import from `agent-menu.ts`) and `SubagentsSettingsUI` (drops `confirm`/`editor`/`custom` from `MenuUI` — ISP).
- Strictly additive: `agent-menu.ts` is untouched, and its settings tests stay as-is because the in-menu path keeps shipping until Step 5 (#442) deletes the file.
  Removing them now would drop coverage of a live surface.
- Preserved the single-selection-then-return semantics of `showSettings` verbatim (no re-show loop) — flagged a settings re-show loop as a deferred UX open question.
- Two small TDD steps (handler+tests, then `index.ts` registration); noted they may fold into one commit since the export and its sole call site are tiny, with `pnpm run check` required right after the wiring step.
- No third-party `ask_user` gate needed — issue filed by the operator (`gotgenes`), direction fixed by ADR-0004, design unambiguous.

## Stage: Implementation — TDD (2026-06-20T14:30:00Z)

### Session summary

Implemented Phase 19 Step 2 in two TDD cycles plus a doc-sync commit: added `SubagentsSettingsHandler` (with narrow `SubagentsSettingsManager` and `SubagentsSettingsUI` interfaces) lifted verbatim from `AgentsMenuHandler.showSettings`, then registered the `/subagents-settings` command in `index.ts`.
Test count went 1051 → 1062 (+11, one new file `test/ui/subagents-settings.test.ts`).
Full suite, `tsc`, root lint, and `fallow dead-code` all green.

### Observations

- The lift was clean: `SettingsManager` already exposed all six members of the new narrow manager interface, so the `index.ts` wiring passed `settings` directly with zero adapter — `pnpm run check` confirmed structural satisfaction.
- `makeMenuUI` from `ui-stubs.ts` was reused as the UI stub without modification — its wider shape (`confirm`/`editor`/`custom`) structurally satisfies the narrower `SubagentsSettingsUI`, so no new helper was needed.
- Kept the two cycles as separate commits rather than folding them; the export and its sole call site were small enough that either would have been valid.
- Deviation from plan: flipped `✅` on the architecture Step 2 heading and its Mermaid node now (the plan had flagged this as a ship-time open question).
  Applied per the `/tdd-plan` template's roadmap-completion rule; verified the diagram still renders via `mmdc`.
  The phase status row was left unchanged (only 1 of 7 steps done).
- `agent-menu.ts` was not touched (verified by the reviewer via `git log`), preserving the additive-only constraint.
- Pre-completion reviewer: WARN.
  Reviewer warnings: one non-blocking finding — `.pi/skills/package-pi-subagents/SKILL.md` records `ui/` as 10 modules (now 11); the plan intentionally deferred this coarse-summary update to a later Phase 19 doc-sync.
  No FAILs; all deterministic checks PASS, verbatim-lift fidelity and ISP of both narrow interfaces confirmed.
