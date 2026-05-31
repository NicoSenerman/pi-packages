---
issue: 289
issue_title: "Decompose bash-path-extractor.ts: shared token rejection + collect* complexity"
---

# Retro: #289 — Decompose `bash-path-extractor.ts`

## Stage: Planning (2026-05-31T13:44:10Z)

### Session summary

Produced a 4-cycle TDD plan for Phase 2 Step 4: extract the shared token-rejection prelude and pure classifiers into a new `bash-token-classification.ts` module, then reduce the two `collect*` walker hotspots.
The plan is behavior-preserving — existing `bash-external-directory.test.ts` integration suites stay unmodified — with new unit tests added only for the extracted classifiers.

### Observations

- The file has exactly two exports (`extractExternalPathsFromBashCommand`, `extractTokensForPathRules`); every other symbol is private, and a grep across `src/`, `test/`, and the package SKILL confirmed no external consumer of the internals.
  This gave the extraction zero external blast radius.
- Two design forks were surfaced via `ask_user`.
  Chosen: (1) a new `bash-token-classification.ts` module with public API + dedicated unit tests (over keeping helpers private in-file), and (2) converting `collect*` to return-based `string[]` (over preserving the mutated `tokens` accumulator).
- Validated each extraction against the `code-design` "returns a value / owns state / gives behavior to data" test: `rejectNonPathToken` returns a boolean and removes a genuine clone; `classifyPatternCommandFlag` returns a discriminated-union directive (moves the flag decision onto data); the return-based conversion removes an output-argument pattern rather than relocating statements.
- Kept `rejectNonPathToken` and `classifyPatternCommandFlag` private to avoid a `fallow` dead-export flag — only the two classifiers (consumed by the walker) are exported.
- Flagged the Biome/ESLint assertion conflict up front: the `consume-arg` directive variant carries a non-optional `nextArgAction` so the `switch` narrows without `!` or `as`.
- The `collect*` return-based conversion must land in a single commit (Step 3) because the mutual recursion and shared accumulator break at the type level if split.

## Stage: Implementation — TDD (2026-05-31T14:40:31Z)

### Session summary

All 4 TDD cycles completed: new `bash-token-classification.ts` module with 43 unit tests (Step 1), clone removal by importing classifiers from the new module (Step 2), walker refactor to return-based `string[]` with four extracted helpers (Step 3), and architecture doc update marking Phase 2 Step 4 complete (Step 4).
A post-reviewer `style:` commit addressed two WARNs: removed an unreachable `token.startsWith("~/")` branch in `classifyTokenAsRuleCandidate` (covered by the earlier `includes("/")` check) and reordered the module to put exports first per the stepdown rule.
Test count: 1571 → 1614 (+43).

### Observations

- Pre-completion reviewer returned **PASS** with two WARNs: (1) the unreachable `~/` branch copied verbatim from the original classifier; (2) private `rejectNonPathToken` preceding the exported classifiers against the "Public API first" convention.
  Both were addressed in a `style:` commit before shipping.
- Step 3 required exactly one atomic commit as planned — the mutual recursion between `collectPathCandidateTokens` and `collectPatternCommandTokens` meant their signatures had to change together.
  The `PatternCommandFlagDirective` discriminated union worked cleanly: the `switch` on `directive.kind` narrows `nextArgAction` without any `!` or `as` casts, avoiding the Biome/ESLint assertion conflict flagged in the plan.
- `collectRedirectTokens` was simplified to use `ARG_NODE_TYPES.has(child.type)` (replacing the inline four-way `||` check), confirmed identical after comparing the original set literal to `ARG_NODE_TYPES`.
- `fallow dead-code` passed cleanly: both exported classifiers are consumed by `bash-path-extractor.ts`; private helpers (`rejectNonPathToken`, `classifyPatternCommandFlag`) carry no export risk.
