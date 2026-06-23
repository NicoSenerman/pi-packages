---
issue: 462
issue_title: "pi-subagents: upgrade /subagent-sessions renderer to Pi per-entry TUI components"
---

# Retro: #462 — pi-subagents: upgrade /subagent-sessions renderer to Pi per-entry TUI components

## Stage: Planning (2026-06-22T00:00:00Z)

### Session summary

Planned Phase 19 Step 4a: swap the `/subagent-sessions` renderer from `serializeConversation` plain text to Pi's per-entry TUI components behind the existing `TranscriptSource` seam.
Verified the SDK surface (per-entry components, `parseSkillBlock`, `getMarkdownTheme`, `ToolDefinition`, `AgentSession.getToolDefinition`) and mirrored Pi's own `renderSessionContext`/`rebuildChatFromMessages` mapping.
Wrote a four-step TDD plan at `packages/pi-subagents/docs/plans/0462-navigation-renderer-tui-components.md` and committed it.

### Observations

- Three design decisions were surfaced via `ask_user` and locked by the operator:
  1. **Rebuild-on-change** (mirror Pi's `rebuildChatFromMessages`) over incremental `updateContent`/`updateResult` — the seam exposes only a full `getMessages()` snapshot plus a coarse `onChange`, so incremental would still diff snapshots while replicating Pi's `pendingTools` streaming state machine for marginal benefit.
  2. **Keep the lightweight `◍ describeActivity` text indicator** — this absorbs the high-frequency streaming text, so the persisted component tree only changes at message granularity, which is what keeps rebuild-on-change cheap.
  3. **Wire real tool definitions** — the operator flagged a dependency-inversion risk ("can't `SubagentManager` track this?").
     Resolved dependency-safely: the SDK `AgentSession` already exposes `getToolDefinition(name)`, so a new read accessor on `SubagentSession`/`Subagent` (mirroring the existing `agentMessages` accessor) surfaces it through the record and onto the `TranscriptSource` seam — arrows stay inward, no `SubagentManager` bookkeeping.
- Key structural move: the component renderer must leave the pure `session-navigation.ts` (per-entry components need `TUI`/`cwd`/`markdownTheme`) and live in the SDK/TUI `session-navigator.ts`.
  The pure module sheds `renderTranscriptLines`/`serializeConversation` entirely, becoming selection + sourcing only.
- The `renderTranscriptLines` removal, overlay rewrite, `session-navigation.ts` edits, `index.ts` `cwd` wiring, and test updates must land in **one commit** (TDD step 3) — removing the export breaks the overlay and its tests at the type level.
- Non-breaking internal renderer swap; `Release: independent` per the roadmap.
  Step 4a gates Step 5 ([#442]) for rendering parity but is not part of any release batch.
- Follow-up [#463] (Step 4b, file-snapshot source) already exists and is open — referenced as a Non-Goal, nothing new to file.
- Parity is defined as *using Pi's own components*, not byte-equality with the bespoke viewer; `custom`-role messages are skipped (the bespoke viewer never rendered them either), noted as an Open Question.

## Stage: Implementation — TDD (2026-06-22T21:30:00Z)

### Session summary

Executed all four planned TDD steps: the `getToolDefinition` read accessor on `SubagentSession`/`Subagent`, the seam method on `TranscriptSource`/`NavigableSubagent`, the per-entry component renderer + overlay rewrite + `cwd` wiring, and the architecture doc flip (Step 4a `✅`).
The renderer now mounts Pi's interactive components into a cached `Container` rebuilt on source change, mirroring Pi's `renderSessionContext`.
Test count went from 1084 to 1088 (+4 net: +4 accessor/seam tests, +3 new navigator tests, −3 removed `renderTranscriptLines` tests), all green; one post-review `test:` commit pins invariant #423.

### Observations

- The production code (`session-navigation.ts`, `session-navigator.ts`, `index.ts`) type-checked clean on the first `tsc` run — the SDK message-union narrowing (`switch (message.role)`), component construction, and `updateResult(toolResultMessage)` all resolved without casts.
  `SessionMessage` (= the SDK `AgentMessage` union) narrows by `role` even though `@earendil-works/pi-agent-core` is not a direct dependency.
- Two deviations from the plan's Module-Level Changes, both intentional: (1) `src/types.ts` was *not* changed — `ToolDefinition` is imported directly from `@earendil-works/pi-coding-agent` in each consumer rather than re-exported through the barrel (avoids a speculative re-export `fallow` would flag); (2) `test/helpers/mock-session.ts` gained a `getToolDefinition` stub (needed for the step-1 accessor tests, not listed in the plan).
- Pi's per-entry components read a *global* interactive theme initialized by `initTheme()`; Pi does this at startup, but tests had to call `initTheme(undefined, false)` in `beforeAll`.
  An early probe with `AssistantMessageComponent` passed without it, but `UserMessageComponent`/`ToolExecutionComponent` throw `"Theme not initialized"` — so the global-theme dependency is component-specific and only surfaced once the broader role set was exercised.
- `setComplete`'s `TruncationResult` param requires more fields than `BashExecutionMessage` carries, so the bash component is completed with `undefined` truncation info (command + output still render).
  Pi's own JS passes `{ truncated: true }` but that path is untyped.
- Pre-completion reviewer verdict: **WARN** (no failures; 3 non-blocking findings).
  Reviewer warnings: (1) `package-pi-subagents/SKILL.md` UI module count is stale (10 listed vs 13 actual) — predates this issue, plan left it deliberately; (2) `addMessageComponents` mutates the received `pendingTools` accumulator (output-argument pattern) — intentional, mirrors Pi's own `renderedPendingTools` local and was plan-reviewed; (3) invariant #423 held and is type-enforced but lacked an explicit spy pin — **addressed** by the follow-up `test:` commit asserting the handler never calls `record.getToolDefinition` directly.
