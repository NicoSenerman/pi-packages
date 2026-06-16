---
issue: 380
issue_title: "Resolve the cross-package settings-loader duplication"
---

# Retro: #380 — Resolve the cross-package settings-loader duplication

## Stage: Planning (2026-06-16T00:00:00Z)

### Session summary

Planned the resolution of the 23-line cross-package production clone between `src/settings.ts` and `@gotgenes/pi-subagents-worktrees`'s `src/config.ts`.
Issue #380 posed a binary: extract a shared loader vs. document-and-suppress.
The operator chose extraction, delivered as a dedicated subpath export `@gotgenes/pi-subagents/settings`, sequenced as two stages (this plan lands the helper in pi-subagents; a follow-up migrates worktrees).
The plan is a single-package TDD plan in `packages/pi-subagents/docs/plans/0380-extract-layered-settings-loader.md`.

### Observations

- The issue is the operator's own (author `gotgenes` == gh user), so the "Proposed change" was a hypothesis.
  Used `ask_user` twice: first to confirm Option 1 vs Option 2 (operator picked extract, then asked for explicit for/against), then to pin API placement (`./settings` subpath, recommended) and release sequencing (two-stage, follow-up for worktrees).
- Key mechanism finding that shaped the framing: fallow's `code-duplication` suppression is **file-scoped only** (`// fallow-ignore-file code-duplication`) — there is no line-level next-line directive, contrary to the issue's "rationale on the line above" phrasing for Option 2.
  This would have mattered had Option 2 been chosen.
- The shared idiom is the read-sanitize-warn-merge mechanism; the per-package `sanitize` (numeric ceilings vs `string[]`) is the genuinely-different part.
  A generic `loadLayeredSettings<T>({ sanitize, warnLabel, filename, agentDir, cwd })` is a clean extraction with no discriminator parameter.
- Honest Outcome caveat captured in the plan: because worktrees keeps its copy until the follow-up, `fallow:dupes` may still report a residual (or dissolve below `min-lines: 5`, since the generic helper's tokens diverge).
  Definitive elimination is the follow-up's outcome, not a hard gate on this plan.
- Followed the `0270-type-consumable-public-surface.md` plan as the template for the `.d.ts`-bundle + `verify:public-types` machinery; the new subpath extends that rather than introducing a new mechanism.
- `loadSettings`'s `process.cwd()` default is dropped per the code-design "no `process.*` in library functions" rule; the sole caller (`SettingsManager.load`) already passes `this.cwd` (verified by grep).
- The worktrees-migration follow-up issue should be created at ship time and back-referenced from the architecture Step 9 roadmap entry.

## Stage: Implementation — TDD (2026-06-16T16:00:00Z)

### Session summary

Completed all 4 TDD steps from the plan: added `src/layered-settings.ts` with 15 unit tests, refactored `settings.ts` to delegate through the helper (removing `readSettingsFile` and `globalPath`), published the `@gotgenes/pi-subagents/settings` subpath export with a rolled `dist/settings.d.ts` and extended `verify:public-types` harness, and recorded the decision in the architecture doc.
Test count grew from 1015 to 1030 (+15).
Pre-completion reviewer returned **PASS**.
Follow-up issue [#415] created for the worktrees migration.

### Observations

- The plan's "Outcome caveat" resolved favourably: `pnpm fallow:dupes --skip-local` no longer reports the `settings.ts` ↔ `config.ts` pair after the extraction.
  The parametrised helper's token sequence diverged enough that the contiguous identical run dropped below the reporting threshold — a better outcome than the plan's hedged prediction.
- ESLint's pre-commit hook removed `!` non-null assertions from `spy.mock.calls[0]![0]` in the test file (typed `vi.spyOn` mock calls are non-optional tuples; the assertions were redundant).
  Staged the auto-fix into the same commit without issue.
- The `rollup.dts.config.mjs` array-of-configs approach worked without incident: both bundles (`dist/public.d.ts` and `dist/settings.d.ts`) are self-contained and `verify:public-types` confirmed both probes type-check against the packaged tarball.
- The `satisfies LayeredSettingsSource<SubagentsSettings>` annotation at the `loadSettings` call site serves double duty: validates the object literal and keeps `LayeredSettingsSource` referenced for fallow dead-code (fallow confirmed: 0 issues).
- Follow-up issue [#415] created before the TDD stage notes were written (operator requested it during the session); architecture doc updated with the `[#415]` reference and link definition.
