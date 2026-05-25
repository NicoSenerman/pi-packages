---
issue: 206
issue_title: "Decompose showAgentDetail (cognitive 33)"
---

# Retro: #206 — Decompose showAgentDetail (cognitive 33)

## Stage: Planning (2026-05-25T12:00:00Z)

### Session summary

Produced a 4-step plan to decompose `showAgentDetail` (cognitive 33) and `ejectAgent` (cognitive 20) in `ui/agent-config-editor.ts`.
The plan extracts two exported pure functions (`buildMenuOptions`, `buildEjectContent`) with dedicated unit tests, plus three closure-internal handlers (`handleEdit`, `handleDelete`, `handleReset`).

### Observations

- Three of the six action handlers (`ejectAgent`, `disableAgent`, `enableAgent`) were already extracted as closure functions — only Edit, Delete, and Reset were inlined in the dispatch chain.
- `buildMenuOptions` and `buildEjectContent` are ideal pure-function extractions: complex branching logic with no IO dependencies, previously untestable in isolation.
- The existing 18 integration tests through `showAgentDetail` provide a strong safety net — no risk of behavior regression during extraction.
- Chose to scope `ejectAgent` decomposition into this issue since the issue's outcome says "< 10 per function" and `ejectAgent` is at cognitive 20 in the same file.
- `disableAgent` and `enableAgent` were explicitly deferred — their cognitive complexity is manageable and decomposing them would add scope without meaningful benefit.

## Stage: Implementation — TDD (2026-05-25T11:55:00Z)

### Session summary

Completed all 4 TDD steps. 3 `refactor:` commits extract `buildMenuOptions`, the three inline handlers, and `buildEjectContent`; 1 `docs:` commit updates the architecture table.
Test count grew from 21 to 33 (+12 new unit tests for the two exported pure functions).

### Observations

- A `newText: null` bug in the Edit tool corrupted `agent-config-editor.ts` during step 1; recovered immediately by rewriting the file with `Write`.
- The test used `thinking: "auto"` which is not a valid `ThinkingLevel` — fixed by changing to `"low"` before the final commit; the type error was caught by `pnpm run check` after the TDD step.
- `buildMenuOptions` extracted cleanly with early-return style (no `let menuOptions` intermediate); the refactored function passes all 5 new unit tests and all 21 existing integration tests.
- `handleEdit`, `handleDelete`, and `handleReset` are closure-internal; they drop the outer `if (file)` guard since the menu only shows those options when `file` is defined.
- `buildEjectContent` extracted from `ejectAgent` reduces `ejectAgent` to a thin IO function (~10 lines); no behavior change verified by the existing eject integration tests.
