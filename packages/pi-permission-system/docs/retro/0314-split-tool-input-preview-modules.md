---
issue: 314
issue_title: "Split tool-input-preview.ts into cohesive modules"
---

# Retro: #314 — Split `tool-input-preview.ts` into cohesive modules

## Stage: Planning (2026-06-02T00:00:00Z)

### Session summary

Produced a numbered plan to extract the three prompt formatters (`formatEditInputForPrompt`, `formatWriteInputForPrompt`, `formatReadInputForPrompt`) plus `getPromptPath` into a new `src/tool-input-prompt-formatters.ts`, leaving text utilities, `serializeToolInputPreview`, and the three limit constants in `tool-input-preview.ts`.
Audited every importer of the four moved symbols and confirmed the only production consumer is `tool-preview-formatter.ts`; the remaining importers (`builtin-tool-input-formatters.ts`, three test files) touch only retained symbols.
Confirmed via `fallow health --targets` that `tool-input-preview.ts` is the sole refactoring target (medium, 6 dependents).

### Observations

- The plan folds the extraction, the `tool-preview-formatter.ts` import repoint, and both test-file edits into a single `refactor:` commit, following the [#282] retro lesson: removing exports breaks every importer at the type level in the same commit, so the split is not buildable if staged separately.
- This is a cohesion split by concern, not statement-level procedure-splitting — each moved function is already a complete, independently-tested pure function returning a value, and the four form one cohesive concern (rendering tool input for a permission prompt).
- Dependency direction is strictly one-way: `tool-input-prompt-formatters.ts` imports `countTextLines`/`formatCount` from `tool-input-preview.ts`; no cycle, since the utilities never reference a formatter after the move.
- After the move, `tool-input-preview.ts` loses its `./common` import entirely (`getNonEmptyString`/`toRecord` were used only by the moved functions) — flagged in the plan to avoid an unused-import lint failure.
- No barrel (`src/index.ts`) re-exports these symbols, so no barrel update and no speculative-re-export dead-code risk; all four new exports are consumed by `tool-preview-formatter.ts`.
- Behavior-preserving, so no new red test is planned — the relocated describe blocks plus the existing suite are the regression net.
  Test Impact Analysis records that the extraction unlocks no new unit tests and makes none redundant.
- Skipped `ask_user`: the issue's proposed change is unambiguous.
  Design-review checklist found no introduced smells (no new collaborator threading, no output arguments, no LoD reach-through).
- Docs updates target `architecture.md` (module listing, `Refactoring targets` 1 → 0, finding #2 resolved, roadmap step 1 ✅) and `v3-architecture.md` module listing, as a separate `docs:` commit.

[#282]: https://github.com/gotgenes/pi-packages/issues/282
