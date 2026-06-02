---
issue: 318
issue_title: "Introduce an McpTargetList value object in mcp-targets.ts"
---

# Retro: #318 — Introduce an `McpTargetList` value object in `mcp-targets.ts`

## Stage: Planning (2026-06-02T00:00:00Z)

### Session summary

Produced the implementation plan for replacing the `pushTarget` closure in `src/mcp-targets.ts` with an `McpTargetList` value object that owns the ordered-uniqueness invariant.
This is Track C / Step 5 of the architecture roadmap (Finding 4).
The change is behavior-preserving — the existing `test/mcp-targets.test.ts` is the regression guard and candidate ordering is unchanged.

### Observations

- The design is unambiguous per the issue; only one decision needed surfacing: whether `McpTargetList` is exported with direct unit tests or kept module-private.
  Confirmed with the user via `ask_user` — chose **export + direct unit tests**, mirroring the existing `parseQualifiedMcpToolName` (exported + tested) precedent in the same module.
  This adds a new red→green cycle (Step 1) documenting the invariant in isolation.
- Both Non-Goals from the issue were preserved in the plan: no MCP-naming command methods on the list (keeps ordering+uniqueness separate from the `${server}_${tool}` spelling), and no `McpInvocation`/`deriveTargets()` class (a one-shot transform in a class costume).
- Sole production consumer is `src/input-normalizer.ts` (line 106), which spreads the result — so `toArray()` returning a defensive copy (`[...this.targets]`) instead of the live array is behavior-preserving and strictly safer.
- The two private helpers (`pushMcpToolPermissionTargets`, `addDerivedMcpServerTargets`) already took a `pushTarget` callback, so swapping it for an injected `McpTargetList` is a clean DIP-friendly substitution with no LoD / output-argument / reverse-search concerns.
- Grep confirmed no `src/`, `test/`, or skill file references the changed symbols beyond `input-normalizer` and the two test files; the architecture doc (Finding 4 / Step 5) is the only doc needing an update.
- TDD order is 3 cycles: (1) `test:` add `McpTargetList` + tests, (2) `refactor:` rewrite dispatch, (3) `docs:` mark roadmap Step 5 done.
  Next step is `/tdd-plan`.
