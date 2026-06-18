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

## Stage: Implementation — TDD (2026-06-18T00:00:00Z)

### Session summary

Executed both planned TDD steps in two commits: a `feat!:` reconciling the `SUBAGENT_EVENTS` constant map (removed `ACTIVITY`, added `FAILED`/`COMPACTED`/`CREATED`/`STEERED`) pinned by an expanded `service.test.ts` assertion plus an explicit "no vacant `ACTIVITY`" check, then a `docs:` update to the lifecycle-events table and the Phase 18 Step 6 roadmap entry.
Full suite green at 1038 tests (+1 from the planning baseline of 1037); `check`, root `lint`, `verify:public-types`, and `fallow dead-code` all pass.

### Observations

- No deviations from the plan's design.
  The only mid-stream addition was the extra `"ACTIVITY" in SUBAGENT_EVENTS` falsity assertion, which strengthens the breaking-removal coverage beyond what the plan sketched.
- The breaking change went smoothly: `SUBAGENT_EVENTS.ACTIVITY` had no live consumers, so removal broke only the one service test that asserted it — folded into the same `feat!:` step as planned.
- Ran `verify:public-types` before committing Step 1 (public-surface gate); the rolled `dist/public.d.ts` regenerated cleanly with the narrowed `as const` literal types.
- `git diff` since the last tag (`pi-subagents-v16.6.0`) lists files from prior unreleased issues #422/#423/#424; scoped the pre-completion reviewer to #425's two commits to avoid noise.
- Pre-completion reviewer: WARN (1 non-blocking finding).
  The Phase 18 Mermaid node `S6` was missing the `✅` mark carried by completed nodes S1–S5; fixed by appending `✅` to the node label and amended into the unpushed `docs:` commit.
  All other checklist items PASS or SKIP (no acceptance-criteria section; `service.ts` was not a target of any prior Phase 18 step, so no cross-step invariant at risk).
- Next step: `/ship-issue`.
