---
issue: 165
issue_title: "refactor(pi-subagents): decompose ResolvedSpawnConfig (15 fields)"
---

# Retro: #165 — decompose ResolvedSpawnConfig (15 fields)

## Stage: Planning (2026-05-24T13:41:41Z)

### Session summary

Produced a 5-step TDD plan to decompose the 15-field `ResolvedSpawnConfig` into three nested sub-interfaces (`SpawnIdentity`, `SpawnExecution`, `SpawnPresentation`).
Also improved skill descriptions for `colgrep` and `markdown-conventions` to signal decision-relevant content rather than tool reference material.

### Observations

- The proposed decomposition in the issue aligns well with actual field usage patterns — no adjustments needed.
- `modelName` and `agentTags` are never accessed by external consumers; they're intermediate computation exposed on the return type.
  Keeping them on `SpawnPresentation` is harmless and aids debuggability.
- Step 1 (interface change + return restructure) will break type checking for all consumers simultaneously.
  The plan addresses this by landing steps 1–4 in rapid succession on the same branch.
- Both test files have `makeConfig()` factories that must be updated in lock-step with their respective source files.
- Issue #164 (directory reorganization) is closed, so import paths are already in their final `#src/<domain>/` form.

## Stage: Implementation — TDD (2026-05-24T14:32:58Z)

### Session summary

Completed all 4 TDD cycles plus full-suite verification in one session.
The decomposition touched 7 files (4 source, 3 test) and kept the test count flat at 805 — no new tests needed for a pure structural refactor.

### Observations

- The `Partial<ResolvedSpawnConfig>` spread pattern in `makeConfig` factories doesn't deep-merge into nested sub-objects.
  Two tests (`foreground-runner.test.ts` and `background-spawner.test.ts`) used flat field overrides (`{ fellBack: true }`, `{ description: "my task" }`) that silently stopped working after nesting.
  Fixed by writing out the full nested sub-object at the override call site.
  Future factories for nested config types should either deep-merge or avoid the `Partial<T>` spread pattern — see the `testing` skill's warning about this.
- Step 1 breaking all consumers simultaneously was handled smoothly by completing all steps before pushing, as planned.
  No transitional alias was needed.
- The `background-spawner.test.ts` description-override test was the only unexpected friction point — the flat spread issue wasn't caught by the plan.
