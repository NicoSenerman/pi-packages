---
issue: 307
issue_title: "Project a running effective working directory across cd's onto bash path candidates"
---

# Retro: #307 — Project a running effective working directory across cd's onto bash path candidates

## Stage: Planning (2026-06-01T00:00:00Z)

### Session summary

Produced the implementation plan for projecting a stateful effective working directory onto bash external-directory path candidates, retiring the single `leadingCdTarget` model.
The plan lands in three `feat:` TDD steps (Tier 1 sequential current-shell `cd` fold, Tier 2 subshell / brace-group / pipeline / background scoping, conservative unknown-base bail) plus a docs step.
Two disposable `web-tree-sitter` AST probes de-risked every descent decision before any plan text was committed, per the [#306] / [#308] retro lesson.

### Observations

- Key load-bearing insight: the strict `classifyTokenAsPathCandidate` only admits absolute, `~/`, and `..`-containing tokens, and absolute / `~/` tokens are base-independent.
  So the effective-cwd projection only ever changes resolution of `..`-relative candidates, and `pathTokens()` (which never resolves against a base) is provably unaffected.
  This narrowed the whole behavior surface — and the test surface — dramatically.
- Two genuine design decisions were surfaced via `ask_user` and answered by the owner: scope = Tier 1 + Tier 2 together (not Tier 1 only), and unknown-base policy = conservative (flag relative candidates) rather than today's fall-back-to-`cwd`.
  Both choices push toward least-privilege and shaped the plan structure.
- Deliberate deviation from the [#308] forward note: that plan speculated #307 would add `pathCandidates` / `effectiveCwd` fields to `BashCommand`.
  The plan instead keeps the path-candidate walk as its own derivation of the shared single parse, because the cwd-frame grouping descends into brace groups and substitution interiors and folds `cd` state, whereas `commands()` emits brace groups whole and nested commands as separate rule units — different descent semantics that would force a discriminator (the wrong abstraction).
  This still honors [#308]'s one-parse anti-drift goal.
- AST probe findings that shaped the walk: `list` nests left-associatively (must recurse children in source order), and background `&` is an anonymous operator token *after* the command it backgrounds (distinguishable from `&&` / `||` / `;` for the fold guard).
- The escape-to-`cwd` fallback in `computeEffectiveResolveBase` is dropped in favor of faithful tracking; this is what closes the missed-escape example (`cd nested/deep && cd .. && cat ../../etc/passwd`).
  Two `leading cd prefix` characterization tests assert the retired model in their comments but pass by coincidence on loose `length > 0` assertions — the plan re-frames and strengthens them in step 1.
- All changes are private to `bash-program.ts` plus its two test files and one architecture-doc line; no gate signatures, facades, config, or schema change.

[#306]: https://github.com/gotgenes/pi-packages/issues/306
[#308]: https://github.com/gotgenes/pi-packages/issues/308
