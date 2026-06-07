---
issue: 338
issue_title: "Collapse the index.ts closure bags into object references"
---

# Retro: #338 — Collapse the `index.ts` closure bags into object references

## Stage: Planning (2026-06-06T00:00:00Z)

### Session summary

Produced the implementation plan for Phase 4 Step 5 (Track B): collapsing the `index.ts` adapter closures into direct collaborator references now that Steps 2–4 made config a store, the logger an injectable object, and `PermissionManager` / `SessionRules` single shared instances.
The plan reshapes the deps interfaces on `ConfigStore`, `PermissionForwarder`, `PermissionPrompter`, the RPC handlers, the command controller, and `PermissionSession`, unifying all logging on the single `SessionLogger` object via new narrow `ReviewLogger` / `DebugReviewLogger` seams.
Seven commit cycles (six `refactor:` consumer migrations + one `docs:` metric update), each folding the consumer interface change, its test updates, and the matching `index.ts` wiring into one commit.

### Observations

- Two design forks were surfaced via `ask_user`.
  Decision 1: the logger's `getConfig` and `notify` forward-reference closures stay as idiomatic forward-reference closures (the pi-subagents pattern) — no setter methods, objects instantiated complete.
  Decision 2: include `ConfigStore` and `PermissionForwarder` in the deps-shrinking scope (the issue's step-2 list omitted them, but their closures must collapse to hit the target).
- The roadmap's "≤ 8" target for `index.ts` is not reachable under the no-setter direction: the two logger cycle closures are a permanent idiomatic floor.
  Realistic budget after this step is 11 (6 `pi.on` + 2 `toolRegistry` + 2 logger cycle + 1 transitional `canRequestPermissionConfirmation`), dropping to 10 after Step 6 ([#339]).
  The plan updates the architecture metric to 20 → 11 with a budget breakdown rather than leaving the optimistic ≤ 8.
- `canRequestPermissionConfirmation` is deliberately left as a closure: collapsing it would require injecting `subagentRegistry` into `PermissionSession` only to extract it again in Step 6's `PromptingGateway`.
  Avoided that churn.
- Forwarder cleanup is a genuine win beyond closure removal: merging the duplicated top-level `writeReviewLog` with the io `logger` into one `logger` retires the [#316] duplication.
- Verified no import cycle (`yolo-mode` imports only `extension-config` + `types`; `config-store` does not import the forwarder) and that `ConfigStoreLogger` / `ForwardedPermissionLogger` are referenced only in historical plan/retro docs, not in `.pi/skills/`.
- Largest single cycle is the forwarder + io-logger rename (cycle 4): only 4 internal `io.ts` call sites, but ~28 `writeReviewLog` references in `permission-prompter.test.ts` make cycle 2 the heaviest test-churn step.

[#316]: https://github.com/gotgenes/pi-packages/issues/316
[#339]: https://github.com/gotgenes/pi-packages/issues/339

## Stage: Implementation — TDD (2026-06-06T21:54:00Z)

### Session summary

Executed all seven TDD cycles: six `refactor:` consumer migrations (cycles 1–6) plus one `docs:` metric update (cycle 7).
The suite remained at 86 test files / 1815 tests throughout (0 delta); all 1815 pass green.
All planned interface changes landed — `ConfigStoreLogger` and `ForwardedPermissionLogger` deleted; `ReviewLogger` / `DebugReviewLogger` introduced; `index.ts` closure count confirmed at 11.

### Observations

- Cycle 1 (`ConfigStore`): the batch edit for `config-store.ts` failed on the first attempt because the batch validator matched `oldText` against the original file (before any in-batch edits applied) but one `oldText` contained a context line that had already been mutated by an earlier entry in the same batch.
  Re-read the exact line text via `Read` at offset, then split the batch to avoid the overlapping-context issue.
- Cycle 4 (`PermissionForwarder` + io logger): `io.ts` had 8 `ForwardedPermissionLogger` occurrences spread across function parameter signatures after the first Edit batch ran.
  Used `sed -i ''` for the bulk rename rather than 8 individual `Edit` entries — faster and less error-prone for a mechanical global replace with no ambiguity.
- Cycle 5 (`config-modal`): `Ruleset` was used in test controller objects but not yet imported.
  Added the import alongside the other changes in the same commit — caught by `pnpm run check` before commit.
- `test/composition-root.test.ts` listed in the plan but not modified: the existing "gate session-approval visible to RPC check" test already covers the injected-object behavior through the real factory; no new assertion was needed.
  Noted as a minor deviation.
- One stray unused import (`Rule` in `permission-event-rpc.ts`) surfaced at lint time after cycle 3; fixed as a `style:` commit since it was separated from the originating commit by later commits.
- Pre-completion reviewer: **PASS** — all deterministic checks green, no structural concerns, architecture.md Mermaid diagrams valid.
