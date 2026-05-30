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
