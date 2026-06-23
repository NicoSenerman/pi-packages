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
