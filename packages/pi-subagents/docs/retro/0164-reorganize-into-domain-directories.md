---
issue: 164
issue_title: "refactor(pi-subagents): reorganize source into domain directories"
---

# Retro: #164 — refactor(pi-subagents): reorganize source into domain directories

## Stage: Planning (2026-05-23T00:00:00Z)

### Session summary

Read issue #164, confirmed #157 (import normalization) was a prerequisite and had been completed.
Explored the full `src/` and `test/` structure, mapped every relative import in the 26 files to be moved, and produced a four-commit plan that moves files domain-by-domain in dependency order.

### Observations

- Issue #157 removed `.js` suffixes and introduced `#src/*` aliases in `test/` files.
  This makes the reorganization cleaner: test imports are flat `#src/agent-manager` → `#src/lifecycle/agent-manager` with no depth variation.
- `lifecycle/` and `observation/` have a circular dependency (`agent-manager` ↔ `record-observer`), so they must be moved in a single commit (Step 3).
  All other domains can be committed independently.
- `vitest.config.ts` uses `"test/**/*.test.ts"` — test files in new subdirectories are
  auto-discovered without config changes.
- Three UI test files (`conversation-viewer.test.ts`, `display.test.ts`,
  `widget-renderer.test.ts`) are misplaced at `test/` root; left out of scope for this issue.
- No `default-agents.test.ts`, `context.test.ts`, or `execution-state.test.ts` exist —
  those src modules have no dedicated test files.
- The import tables in the plan enumerate every path change; `pnpm run check` will catch
  any missed update before each commit.
