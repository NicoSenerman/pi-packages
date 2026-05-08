---
issue: 2
issue_title: "Support optional detailed formatter output in reports"
---

# Retro: #2 — Support optional detailed formatter output in reports

## Final Retrospective (2026-05-02T02:15:00Z)

### Session summary

Triaged the open backlog, picked issue #2, planned (`docs/plans/0016-detailed-formatter-output-on-failure.md`), implemented across ten TDD cycles, and shipped `2.3.0`.
Added an opt-in `formatterOutput` config object that surfaces a failed formatter run's `stderr` (or `stdout + stderr`) with tail-preserving byte/line truncation; defaults preserve prior concise reporting.
While testing, the user reported an "Unexpected runtime error: ... `fgColors`" warning above the editor that traced to a latent `this`-binding bug in `themed()` from the plan-0002 work; landed a regression test plus fix (`6ba7576`, `6a6ec16`) in the same release.

### Observations

#### What went well

- Backlog triage at the start was useful as a standalone workflow — `gh issue list` → ranked recommendation → user pick.
  The format ("top picks / defer / recommendation") gave the user a real choice without forcing a single answer.
- Plan-number selection caught a small alignment hazard preemptively: `0002` was taken (mismatched with issue #2), `0005` was the next free slot, but I picked `0016` to keep `0015` reserved for issue #15.
  Tiny detail; the kind of thing only worth noting because it would have been irritating to fix later.
- TDD execution was clean — ten cycles, every commit landed green.
  Step 9's truncation e2e test was already green when written, which surfaced as evidence the helper-module boundary (`src/formatter-output-report.ts`) was at the right level: unit tests had already covered the corners.
- The mid-session `fgColors` bug investigation was textbook: read the user's symptom, traced through our `themed()` helper, opened `pi-mono`'s `Theme` class, identified the destructured-method `this`-loss pattern, then took the user's correction ("Other way around, I want to put the test in that should fail") and ran proper red→green TDD on the fix.
- The "outstanding changes" moment after committing the plan was a nice meta-confirmation: the autoformat extension itself reformatted the plan file we'd just written, exactly as advertised.
  Folded as a single `docs: apply autoformat to plan 0016` follow-up.

#### What caused friction (agent side)

- `missing-context` (user-caught, latent) — The test stubs throughout `test/extension.test.ts` use `theme: { fg: (_name, text) => text }`, a plain function that doesn't depend on `this`.
  Pi's real `Theme.fg` is an instance method that reads `this.fgColors`.
  The shape mismatch hid a `this`-binding bug from plan-0002's `themed()` helper for a full release cycle until the user surfaced it from running against their custom catppuccin theme.
  Impact: one user-reported warning in production, one regression test (`6ba7576`), one fix commit (`6a6ec16`).
  Diagnosis required reading `pi-mono/packages/coding-agent/src/modes/interactive/theme/theme.ts` — the same external repo flagged in the #1 retro as missing from the agent's onboarding context.
- `premature-convergence` (self-identified, low-impact) — On the `formatterOutput` config shape (single boolean vs object with knobs), I judged the issue's "Follow-up ideas" unambiguous and skipped the `ask_user` gate.
  The shape landed fine, but a 30-second sanity check would have been cheap insurance for a permanent config surface.
  No rework, no change of direction.
  Impact: added confidence cost; no commit churn.
- `scope-drift` (sanctioned, worth noting) — The `themed()` `this`-binding fix is unrelated to issue #2.
  The user explicitly directed the fix during the session, and the close comment flagged it as out-of-scope-but-found-while-testing.
  Combining the fix into release `2.3.0` was kinder to the user (one push, one release) but slightly conflates the release notes.
  No rework; flagged here so the pattern is visible.

#### What caused friction (user side)

- The `pi-mono` repo at `~/development/pi/pi-mono` is the canonical reference for Pi's runtime API surface (`ExtensionApi`, `Theme`, etc.).
  This is the second consecutive retro where reading `pi-mono` was decisive — first to discover `setStatus`/`theme.fg` (#1 retro), now to diagnose a `this`-binding bug rooted in that same surface.
  The path lives in one head; surfacing it once in `AGENTS.md` would have eliminated a redirection in #1 and accelerated diagnosis in #2.
  Framed as opportunity, not criticism: low-cost, high-payoff context to write down.

### Changes made

1. Added this retro file at `docs/retro/0016-detailed-formatter-output-on-failure.md`.
2. Added a one-line `pi-mono` pointer at the end of `AGENTS.md` § Notes for Agents — then **reverted it** in the same retro commit after a follow-up question surfaced that Pi publishes `@earendil-works/pi-coding-agent` to npm.
   The right fix is to depend on the published types package, not to point agents at a sibling git checkout.
3. Opened issue #22 ("Depend on `@earendil-works/pi-coding-agent` for runtime types instead of duck-typing") to track the typing refactor.
   The duck-typed `*Like` aliases in `src/extension.ts` are what let the `theme.fg` `this`-binding bug ship; switching to real types from the published Pi package would have caught it at compile time.
   Tracked as a follow-up rather than implemented inline because the change touches `package.json`, `src/extension.ts`, and several test files — over the retro's scope budget.
