---
issue: 57
issue_title: "feat: structured debug logging for silenced catch blocks"
---

# Retro: #57 — structured debug logging for silenced catch blocks

## Final Retrospective (2026-05-19T10:30:00Z)

### Session summary

Added `src/debug.ts` with `debugLog` and `isDebug()`, then threaded `debugLog` into ~20 silent `catch` blocks across 9 files.
All 7 TDD cycles went green on the first pass with no rework.
Shipped as `pi-subagents-v5.1.0`, then followed up with a `refactor:` commit converting `DEBUG` (module-level constant) to `isDebug()` (function getter) during the retro.

### Observations

#### What went well

- The plan's "Non-Goals" section correctly excluded `usage.ts` and `settings.ts` before implementation started, and a post-TDD `grep -rn 'catch\s*{'` confirmed only those two in-scope-excluded files remained. Closing the loop with a verification query is worth repeating.
- The scope of the change was so well-defined (the issue listed exact file names) that no `ask_user` call was needed during planning.

#### What caused friction (agent side)

- `missing-context` — When loading the `ask-user` skill I guessed `.pi/skills/ask-user/SKILL.md` before reading the actual `<location>` tag in `AGENTS.md`, triggering an ENOENT error and a follow-up `find` call.
  Impact: 2 extra tool calls, no rework.
  (self-identified)

- `other` — The plan's TDD Order step 1 stated *"the test skill documents this pattern"* for `vi.resetModules()` + dynamic import when testing module-level env constants — but the testing skill does not have that entry.
  The aspiration was recorded rather than verified.
  During the retro, the user's question ("should that be a function getter instead?") led to a better outcome: replace the module-level constant with `isDebug()` so `vi.stubEnv()` alone works, consistent with how every other `process.env` read in this codebase is structured.
  Impact: one retro-phase `refactor:` commit; the approach shipped in `v5.1.0` was technically correct but unnecessarily complex to test.

#### What caused friction (user side)

- The initial issue proposal chose the module-level-constant pattern (common in Node.js tooling like the `debug` package).
  A note in the issue or plan about preferring function-based env reads for testability would have caught this at design time rather than post-ship.
  That said, the retro question was efficient — a single targeted redirect resolved it cleanly.

### Changes made

1. `packages/pi-subagents/src/debug.ts` — replaced `export const DEBUG` with `export function isDebug()`.
2. `packages/pi-subagents/test/debug.test.ts` — simplified to static import + `vi.stubEnv()` only; removed all `vi.resetModules()` + dynamic `import()` calls.
3. `.pi/skills/testing/SKILL.md` — added bullet: prefer reading `process.env` inside functions; `vi.stubEnv()` alone is insufficient for module-level constants.
