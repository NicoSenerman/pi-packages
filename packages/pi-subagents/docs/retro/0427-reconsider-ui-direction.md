---
issue: 427
issue_title: "pi-subagents: reconsider the UI direction from first principles (ADR)"
---

# Retro: #427 — pi-subagents: reconsider the UI direction from first principles (ADR)

## Stage: Planning (2026-06-18T00:00:00Z)

### Session summary

Planned the Phase 18 Step 8 decision-only ADR for the pi-subagents UI direction.
Two `ask_user` rounds with the operator (their own issue) settled a per-component decision and surfaced a key SDK finding — Pi's `switchSession(sessionPath)` — that reshapes the conversation-viewer direction.
The plan writes `docs/decisions/0004-reconsider-ui-direction.md` plus an architecture-doc update; no `src/`/`test/` changes (implementation deferred to a separately-planned Phase 19).

### Observations

- **Decision-only ADR → `/build-plan`, not `/tdd-plan`.**
  The operator chose to record decisions and defer all code to Phase 19, so the plan has a docs-only Build Order, no test cycles.
- **Per-component decisions recorded:**
  (A) foreground widget shrinks to background-agents-only;
  (B) conversation viewer replaced by native session navigation (remove the bespoke `ConversationViewer`);
  (C) `/agents` menu dissolved — **remove** both agent-management surfaces outright (creation wizard and agent-types config editor; managing definitions belongs in an editor/IDE or a Pi agent, not the menu), re-home running-agent visibility onto the widget + session navigation, extract settings to a focused `/subagents:settings` command;
  (D) distribution = keep surviving UI in-core (substitutable, _not_ extracted to `@gotgenes/pi-subagents-ui`).
- **Key SDK finding — `switchSession`.**
  `@earendil-works/pi-coding-agent@0.79.1` exposes `ExtensionActions.switchSession(sessionPath, { withSession })`.
  It is a _full active-session takeover_ (fires `session_before_switch`/`session_shutdown`, invalidates the current context), and the switched-to session is interactive (`ReplacedSessionContext.sendUserMessage`).
  A read-only alternative exists: `loadEntriesFromFile`/`parseSessionEntries` render a transcript without switching.
  These tensions are recorded as Phase 19 spike gates rather than pretend-resolved — the ADR commits to the _direction_ (native session machinery over a bespoke renderer), not the _mechanism_.
- **Operator-raised open questions (now Phase 19 entry criteria):** root-continuity during a session switch, view-only vs interactive, parallel-agent navigation gesture, settings command namespace, and confirming the creation-wizard's value is covered by "generate via a Pi agent" before deleting it.
- **Release:** ship independently — Phase 18 carries no `Release:` batch tag; this issue completes the phase.
- **Numbering:** plan `0427`, ADR `0004` (next free in `docs/decisions/`).

## Stage: Implementation — Build (2026-06-18T20:05:00Z)

### Session summary

Executed the decision-only ADR plan in two docs steps: wrote `docs/decisions/0004-reconsider-ui-direction.md` (per-component decisions A–D plus Phase 19 entry criteria) and updated `docs/architecture/architecture.md` (Step 8 + phase row marked `✅` complete, `S8` Mermaid node `✅`, ADR-0004 Landed line gateway-ing Phase 19).
No `src/`/`test/`/`.ts` files were touched, so the type-check and suite were correctly skipped; `pnpm run lint` is green.

### Observations

- **Decision-only ADR held to scope:** four docs files total (ADR, arch doc, plan, retro); zero runtime change, matching the plan's Non-Goals.
- **Pre-completion reviewer: PASS.**
  One non-blocking WARN — architecture design-principle #5 still read "UI extraction is deferred … first candidate for extraction," which ADR-0004's Decision D now contradicts.
- **Reviewer warning addressed in-session:** rewrote principle #5 to "UI is an in-core, substitutable consumer" pointing at ADR-0004 (commit `1c445ed4`), rather than deferring it to Phase 19 — it lived in the same doc and directly conflicted with the just-landed ADR.
- **Lint gotcha:** the relative ADR link from `docs/architecture/` needs `../decisions/…` (the Step 8 Landed line already had it); an initial `decisions/…` tripped `MD057` and was fixed by amend.
  Also note `pnpm … lint | tail -N` masks the pipeline exit status — check `PIPESTATUS`/run lint unpiped to gate `&&` chains.
- **Commit count:** 4 build/doc commits for this stage (`17b0546a`, `7b1d9316`, `1c445ed4` for the ADR + arch doc; planning commits `12e7814a`/`e4895548`/`f1e65a14` predate this stage).
