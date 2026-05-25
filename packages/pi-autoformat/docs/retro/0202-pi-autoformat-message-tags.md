---
issue: 202
issue_title: "Use `pi-autoformat` tag in all user-visible messages"
---

# Retro: #202 — Use `pi-autoformat` tag in all user-visible messages

## Stage: Planning (2026-05-25T20:00:00Z)

### Session summary

Identified four sites in `extension.ts` that use the bare `autoformat` tag instead of the full `pi-autoformat` extension ID.
Wrote a four-step TDD plan covering the status key, status line label, and steering message prefixes.
Confirmed that `AUTOFORMAT_EXTENSION_ID` is already imported in `extension.ts` and can be reused directly.

### Observations

- Investigated whether `customType: "autoformat-steering"` and the `autoformat:touched` EventBus channel should also change; decided against it — `customType` follows the same no-prefix convention as `subagent-notification` in pi-subagents, and the EventBus channel is internal.
- The `Autoformatted` word in `buildLegacySuccessMessage` is not a tag — it's sentence-initial prose already wrapped by `reportMessage` which prefixes with `[pi-autoformat]`.
- Roughly 13 test assertions in `extension.test.ts` need updating; all are straightforward string replacements.

## Stage: Implementation — TDD (2026-05-25T14:20:00Z)

### Session summary

Completed all four TDD cycles: two red/green pairs for the status key and status line label, then two more for the steering message prefixes.
All 296 tests pass; no test count delta (existing tests updated, no new tests added).
Also added a `fallow-ignore-next-line unused-type` suppression on the pre-existing `ExtensionApiLike` false positive to clear the dead-code gate.

### Observations

- `AUTOFORMAT_STATUS_KEY` was set directly to `AUTOFORMAT_EXTENSION_ID` (the constant, not a new string literal), and `formatStatusLine` uses a template literal `` `${AUTOFORMAT_EXTENSION_ID}:` ``.
- `buildSteeringMessageContent` prefixes now use `` `[${AUTOFORMAT_EXTENSION_ID}]` `` template literals for both the success and failure paths.
- The `fallow dead-code` gate was already failing before this change (`ExtensionApiLike` unused-type export).
  The suppression syntax requires `unused-type` (singular) with no trailing comment text — fallow parses every word after the directive as a rule name token.

## Stage: Final Retrospective (2026-05-25T14:30:00Z)

### Session summary

Issue #202 was completed across a single session covering planning, TDD implementation, and shipping.
The four TDD cycles were clean with no deviations from the plan.
The only friction was a fallow dead-code gate divergence between local and CI environments that required one follow-up commit.

### Observations

#### What went well

- The user's interactive exploration during issue creation (checking `customType` conventions across sibling packages) produced a well-scoped issue that avoided unnecessary changes to `autoformat:touched` and `autoformat-steering`.
- Reusing `AUTOFORMAT_EXTENSION_ID` instead of new string literals kept the change DRY and consistent with the existing `reportMessage` function.

#### What caused friction (agent side)

- `missing-context` — Ran `pnpm fallow dead-code` from `packages/pi-autoformat/` during the TDD post-checks instead of from the repo root.
  This detected 21 entry points (vs 170 in CI), flagging `ExtensionApiLike` as unused.
  I added a `fallow-ignore-next-line unused-type` suppression that passed locally but became a stale suppression in CI, causing a pipeline failure.
  Impact: one extra commit (8d3648a) and a CI retry cycle (~3 minutes).
- `missing-context` — Used incorrect fallow suppression syntax (`unused-types` plural, with trailing comment text).
  Fallow parses every word after the directive as a separate rule name token, producing 12 stale suppression warnings.
  Impact: added friction but caught and fixed before commit (no rework).

#### What caused friction (user side)

- No friction from the user side — the issue was well-scoped and the interactive exploration of `customType` conventions provided useful context upfront.

### Changes made

1. `.pi/prompts/tdd-plan.md` — Added "from the repo root" to the fallow dead-code gate step, with a one-sentence rationale about entry point divergence.
