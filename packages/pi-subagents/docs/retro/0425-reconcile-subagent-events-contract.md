---
issue: 425
issue_title: "pi-subagents: reconcile the public SUBAGENT_EVENTS contract with emitted channels"
---

# Retro: #425 — pi-subagents: reconcile the public SUBAGENT_EVENTS contract with emitted channels

## Stage: Planning (2026-06-18T00:00:00Z)

### Session summary

Planned Phase 18 Step 6: reconcile the public `SUBAGENT_EVENTS` constant map in `src/service/service.ts` with the agent-lifecycle channels the core actually emits.
The plan removes the vacant `ACTIVITY` constant (breaking) and adds `FAILED`, `COMPACTED`, `CREATED`, and `STEERED`, then updates the architecture doc's lifecycle-events table.
Two TDD steps: a `feat!:` constant-map reconciliation pinned from both sides (declaration test + existing emission tests), and a `docs:` table update.

### Observations

- This is the operator's own issue (author `gotgenes` matches the gh CLI user), so the proposed change was treated as the working hypothesis.
- Two genuine design choices were surfaced via `ask_user` and resolved: (1) remove `ACTIVITY` rather than emit a real broadcast — the activity tier was already deleted in Phase 18 Steps 1–3, so there is no streaming-progress source; (2) declare all four emitted agent-lifecycle channels including `subagents:steered` (from `steer-tool.ts`), not just the three named in the issue body, so declared == emitted is fully true for the lifecycle bus.
- Classified as **breaking**: removing a key from the exported `SUBAGENT_EVENTS` `as const` map breaks any consumer referencing `SUBAGENT_EVENTS.ACTIVITY` at the type level.
  Plan uses `feat!:` with a `BREAKING CHANGE:` footer; the footer notes there is no replacement for `ACTIVITY`.
- Scope boundaries decided: config-domain events (`subagents:settings_loaded`/`settings_changed`) and the child-session seam events (`subagents:child:*`) stay out of `SUBAGENT_EVENTS` — separate domains with their own constant homes. `subagents:record` is an `appendEntry`, not a `pi.events.emit`, so it is not a channel constant.
- Corrected a stale doc artifact found during planning: the architecture lifecycle-events table listed `subagents:completed` as `{ id, type, status, result?, error? }`, but `buildEventData` emits `{ id, type, description, result, error, status, toolUses, durationMs, tokens? }`.
  The plan fixes this in the same doc step.
- Public-surface gate: the plan requires running `verify:public-types` in the code step before committing, since `SUBAGENT_EVENTS` is rolled into `dist/public.d.ts`.
- Value-only reconciliation — no new collaborator, no dependency-wiring change — so the `design-review` checklist surfaces nothing actionable; noted in the plan rather than run as a separate gate.
- Next step: `/tdd-plan` (the change has a red→green test cycle).
