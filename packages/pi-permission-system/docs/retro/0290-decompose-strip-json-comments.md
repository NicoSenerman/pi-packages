---
issue: 290
issue_title: "Reduce stripJsonComments complexity in config-loader.ts"
---

# Retro: #290 — Reduce stripJsonComments complexity in config-loader.ts

## Stage: Planning (2026-05-31T15:14:25Z)

### Session summary

Produced a numbered implementation plan to lower `stripJsonComments` cognitive complexity (31 → < 15) by replacing the five-flag single-loop scanner with a stateless dispatcher delegating to three private consume helpers (`consumeLineComment`, `consumeBlockComment`, `consumeString`), each returning a `ScanSegment` value.
The plan is behavior-preserving, adds direct unit tests for the already-exported `stripJsonComments`, and is structured as three TDD commits (`test:` pin contract → `refactor:` dispatcher → `docs:` architecture update).

### Observations

- Chose the issue's consume-helper option over the mode-discriminant step-function option: a `step(state, char)` function would mutate a shared state bag (output-argument smell) and re-encode the same five flags, so it relocates rather than removes the interleaving.
  Each consume helper returns a value and owns one JSONC sub-grammar — genuine decomposition per the `code-design` heuristics.
  Did not invoke `ask_user` — the choice is resolvable by project design principles and the change is small and reversible.
- `stripJsonComments` is `export`ed and consumed by both `config-loader.ts` (`loadUnifiedConfig`) and `policy-loader.ts`, but had no dedicated unit test — Step 1 pins its full contract directly before the refactor, so the new tests pass against today's implementation and act as the behavior-preservation net.
- No exports change and no symbol is renamed, so no `index.ts` barrel, package skill, or other doc needs updating — only `docs/architecture/architecture.md` (Phase 2 Step 5, findings row 5, worst-CRAP-risk line, metrics).
- `design-review` skill judged not applicable: the change is one self-contained pure function with no shared-interface or layer-wiring impact.
- Block-comment scan is planned to switch from a character loop to `indexOf("*/")` (behavior-identical, including the unterminated-to-EOF branch) — flagged as a risk with a dedicated test.
- markdownlint is not installed locally (`markdownlint-cli2` not found; no `.markdownlint*` config); relied on the `markdown-conventions` skill. `rumdl fmt` ran in the pre-commit hook and passed.

## Stage: Implementation — TDD (2026-05-31T15:23:14Z)

### Session summary

Completed all 3 TDD steps: pinned 14 direct unit tests for `stripJsonComments` (Step 1), replaced the five-flag scanner with the stateless dispatcher + three consume helpers (Step 2), and updated `docs/architecture/architecture.md` to mark Phase 2 Step 5 complete (Step 3).
Test count: 1614 → 1628 (+14).
A `style:` cleanup commit was added after the pre-completion review to fix helper ordering.

### Observations

- Step 1 required two assertion corrections: (1) the space before `//` is emitted verbatim, so the expected output was `'{ \n"k": 1}'` not `'{\n"k": 1}'`; (2) the combined JSONC round-trip test had a stray `,` after a stripped block comment rendering the output invalid JSON — restructured the document so comments are inline on value lines.
  Both caught before the step 1 commit; the pre-existing implementation was never at fault.
- ESLint auto-fixed bracket notation to dot notation (`parsed["debugLog"]` → `parsed.debugLog`) during the pre-commit hook; accepted the change.
- The `refactor:` commit placed the three consume helpers *before* `stripJsonComments`, inverting the stepdown rule (plan said "placed directly below `stripJsonComments`").
  The pre-completion reviewer flagged this as WARN; fixed in a `style:` commit (`4ff870a1`) after the review.
- `fallow health --targets` confirmed `config-loader.ts` / `stripJsonComments` no longer appears as a refactoring target after the refactor; architecture doc updated accordingly (targets 4 → 3).
- Pre-completion reviewer: **WARN** (one finding — stepdown order, resolved before final commit).
  All deterministic checks PASS.
