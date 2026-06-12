---
issue: 368
issue_title: "Remove the `config-modal` controller reach-through"
---

# Retro: #368 — Remove the `config-modal` controller reach-through

## Stage: Planning (2026-06-12T00:00:00Z)

### Session summary

Planned the removal of the Law-of-Demeter reach-through in the `/permission-system show` handler (Phase 5 Step 7, Track D).
The plan collapses the controller's `permissionManager` + `session` fields into one `getActiveAgentConfigRules(): Ruleset` accessor, wired as a thin adapter closure in `index.ts`, and retires the `fallow` false-positive suppression on `PermissionSession.lastKnownActiveAgentName`.
The change is non-breaking (package-internal type, unchanged `show` output) and lands as one atomic refactor commit plus a separate doc commit marking the roadmap step complete.

### Observations

- Issue author is the operator (`gotgenes`); the proposed change is unambiguous and passes the `code-design` check (the accessor returns a value, so it is real encapsulation, not procedure-splitting) — skipped the `ask-user` gate.
- The retro for plan `0341` was the key prior-context find: `fallow`'s blind spot is object-literal wiring in `index.ts` (config-modal receives `session` as an object-literal property, not a traced positional arg).
  A named-interface attempt there did **not** satisfy `fallow`.
  The plan's premise is that moving the read into a real arrow-function body (`session.lastKnownActiveAgentName` inside the closure) makes it a directly traced property access — the one case `fallow` can follow — which is what makes retiring the suppression safe.
- The only empirical unknown is whether `fallow dead-code` actually stops flagging the getter; the plan carries a documented fallback (restore a single justified suppression) so the unknown does not block.
- The interface change breaks `index.ts` wiring and all four `config-modal.test.ts` controller literals at the type level in the same commit, so they fold into one TDD step per the AGENTS.md rule on constructed call sites.
- `getComposedConfigRules` always returns a `Ruleset` (never `undefined`), so the accessor needs no optionality and the existing empty-ruleset/`summarizeConfig` behavior is preserved.
