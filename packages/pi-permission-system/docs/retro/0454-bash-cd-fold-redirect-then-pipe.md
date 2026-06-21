---
issue: 454
issue_title: "Bash external_directory gate: cd-fold projection drops the running directory across a redirect-then-pipe, causing false external-path prompts"
---

# Retro: #454 — Recover bash operator precedence so a `cd` fold persists across a redirect-then-pipe

## Stage: Planning (2026-06-21T00:00:00Z)

### Session summary

Planned the fix for `BashProgram.externalPaths` over-prompting when a leading current-shell `cd` precedes a redirect-then-pipe statement (`pnpm x 2>&1 | tail`).
Confirmed the root cause by dumping the tree-sitter-bash AST and verifying real bash semantics with `bash -c`: the parser mis-groups `cd a/b && pnpm x 2>&1 | tail` as `(cd a/b && pnpm x 2>&1) | tail`, burying the current-shell `cd` inside a `pipeline` node that the walker's `default` case treats as non-folding.
The plan adds a `pipeline` case to `walkForCandidates` that folds the first stage's leading current-shell commands while keeping the terminal piped command and downstream stages as non-folding subshells.

### Observations

- The author is `gotgenes` (the operator), and the expected behavior is dictated by real bash precedence (`|` binds tighter than `&&`), so the `ask-user` gate was skipped — there is no operator-facing ambiguity.
- Verified the fail-closed boundary empirically: `bash -c 'cd a/b && cd c 2>&1 | tail; pwd'` ends in `a/b`, not `a/b/c` — the terminal `cd` is the real pipe stage (subshell) and must **not** fold.
  Folding it would under-flag a later escape (a fail-open regression), so the plan treats the terminal command of the first stage specially (`foldListExceptTerminal`) and pins it with a dedicated test.
- Classified as a non-breaking `fix:` — it removes false-positive external-directory prompts; no default, config, or output shape changes.
- Not part of any architecture-roadmap batch → ship independently.
- The change is internal to `bash-program.ts`: `externalPaths(cwd): string[]` is unchanged, so no consumer, test import, or `SKILL.md` reference moves.
  The design-review checklist found no structural smell (no shared-interface widening, no new threaded parameter); the three new helpers each return an `EffectiveBase` (real behavior, not procedure-splitting).
- The #452 A3 never-weaker invariant pins the bash *command* gate (`commands()`), a different slice than `externalPaths`, so the metamorphic test is untouched; the #307/#418 fail-closed projection invariant is the one at risk and is guarded by the new terminal-`cd` test.
