---
issue: 333
issue_title: "Permission prompt for chained bash commands only shows the triggering sub-command, hiding the rest of the chain from the user"
---

# Retro: #333 — Permission prompt for chained bash commands only shows the triggering sub-command, hiding the rest of the chain from the user

## Stage: Planning (2026-06-09T01:34:25Z)

### Session summary

Planned a localized bug fix for `formatAskPrompt` in `src/permission-prompts.ts`: the bash branch ignores the raw `input` and prompts only with the matched sub-command, hiding the rest of a chained command.
The plan appends a `(full command: '...')` suffix when the raw `input.command` differs from `result.command`, using the existing `toRecord` / `getNonEmptyString` helpers from `src/common.ts`.

### Observations

- The fix is fully isolated to one branch of one function; `input` is already forwarded by the call site in `src/handlers/gates/tool.ts` (`tcc.input`), so no wiring change is needed.
- Existing bash tests pass `input` as `undefined`, which normalises to `null` via `toRecord` + `getNonEmptyString` — they stay green and serve as the "no chain context" case.
- The `fullCommand !== subCommand` guard is the key behavior decision: it suppresses the suffix for single (non-chained) commands so prompts don't get noisier.
- No schema, config, README, or architecture-doc changes — behavior-preserving prompt-text fix, single TDD cycle (`fix:`).
- The issue's proposed code was treated as a spec only after confirming the referenced helpers exist and the call site already supplies `input`; no ambiguity remained, so `ask_user` was skipped.

## Stage: Implementation — TDD (2026-06-09T01:48:55Z)

### Session summary

Completed the single TDD cycle: added 6 new tests to `test/permission-prompts.test.ts` covering chain-present, no-chain, `undefined` input, missing `command`, empty `command`, and qualifier-ordering cases, then implemented the two-line bash-branch change in `src/permission-prompts.ts`.
Test count went from 23 to 29 in the target file, and from 1894 to 1900 across the full suite.
All deterministic checks (`check`, `lint`, `test`, `fallow dead-code`) passed before and after the change.

### Observations

- No deviations from the plan: the fix was exactly the two helpers + `fullCommandInfo` conditional described in Design Overview.
- Four of the six new tests were green immediately (the suppress-suffix cases); only the two `toBe` assertions exercising the suffix string were red — the minimal red set confirmed the right code path was untested.
- Pre-completion reviewer returned **PASS** with no warnings.
