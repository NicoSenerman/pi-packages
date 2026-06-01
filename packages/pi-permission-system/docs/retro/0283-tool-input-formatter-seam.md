---
issue: 283
issue_title: "Formatter extension seam for custom tool input previews"
---

# Retro: #283 — Formatter extension seam for custom tool input previews

## Stage: Planning (2026-05-31T00:00:00Z)

### Session summary

Produced a numbered implementation plan for the tool input formatter seam.
Confirmed both prerequisites (`#282` extract `ToolPreviewFormatter`, `#266` configurable limits) are shipped/closed, then designed a persistent `ToolInputFormatterRegistry`, a seam-first dispatch in `formatToolInputForPrompt`, a `registerToolInputFormatter` method on `PermissionsService`, and a reference built-in MCP input summarizer registered through the public seam.

### Observations

- Despite the dual `pkg:` label, the user confirmed this is **pi-permission-system only** — pi-subagents would reach outward to register, violating its "arrows point inward" principle, so the plan is filed in the package's `docs/plans/` beside `#266`/`#282` rather than the repo-root `docs/plans/`.
- `ToolPreviewFormatter` is constructed **fresh per tool call** (from `this.session.config`), so the formatter registry cannot be instance state on it — it must be owned by the extension factory (`index.ts`) and threaded in.
  This shaped the whole design.
- The seam convention follows pi-subagents' `registerWorkspaceProvider(provider): () => void` (single provider, throws on duplicate, identity-guarded disposer).
  Adopted the same: one formatter per tool name, duplicate `register` throws.
- Reference built-in decision: user chose the **MCP summarizer keyed to `mcp`** over a fictional `batch` tool.
  Important catch — MCP calls take an early-return branch in `formatAskPrompt` and never reach `formatToolInputForPrompt`, so the built-in needs a **second integration point** in the MCP branch (and changes existing MCP prompt tests).
  Captured as a dedicated TDD step.
- Precedence: registered formatter checked first for any tool; `undefined` falls through to the existing switch (user-selected).
  Lets extensions override even built-in tool previews.
- Made the new `PermissionGateHandler` constructor parameter **optional** so `makeHandler` and the two `external-directory-*.test.ts` handler constructions compile unchanged — only `index.ts` passes the shared registry.
  Minimizes test churn.
- Open questions deferred to implementation: whether to try/catch a throwing registrant, exact MCP summary wording, and whether to record this as a formal architecture roadmap phase.
  Flagged writing a disposable exploratory check against a real MCP payload before finalizing `formatMcpInputForPrompt`.
- Next step: `/tdd-plan` (this plan has red→green→commit cycles).

## Stage: Implementation — TDD (2026-05-31T21:05:00Z)

### Session summary

All five TDD steps completed across six commits (steps 1–4 plus a docs step plus a WARN fix).
Test count grew from 1628 to 1656 (+28), across 73 test files (up from 71).
Full suite, type check, lint, and `fallow dead-code` all pass.

### Observations

- **`ToolPreviewFormatter` is constructed fresh per call**, not held as instance state, so the formatter registry has to be owned by the extension factory (`index.ts`) and threaded in as an optional 4th constructor parameter on `PermissionGateHandler`.
  Making it optional left `makeHandler` and the two `external-directory-*.test.ts` constructions untouched — only `index.ts` passes the real registry.
- **MCP branch bypass** was the main design surprise.
  `formatAskPrompt`'s MCP early-return never called `formatToolInputForPrompt`, so the built-in MCP summarizer needed a deliberate second integration point there.
  Adding `case "mcp": return "";` to the switch was also necessary — without it, when a custom formatter declines, the switch default serialises the raw MCP event to JSON and appends it to the prompt.
- **Truncation test correction**: the initial test for "truncates the full summary when it exceeds the limit" used a single 200-char string value, but `renderArgValue` caps string values at 60 chars, so the total never reached the 160-char summary limit.
  Fixed by using three long-valued arguments so the joined summary exceeds 160 chars.
- `service.test.ts` had two inline `PermissionsService` literals that don't go through `makeService`; `tsc` caught them after adding the new interface method — both needed `registerToolInputFormatter: vi.fn()` added.
- **Pre-completion reviewer verdict: WARN** — one finding: `docs/architecture/architecture.md` still said "exposes two methods" after `registerToolInputFormatter` was added.
  Fixed in a follow-up `docs:` commit before closing.
- Deferred (Open Questions from the plan): try/catch guard on misbehaving formatters and the exact wording of the MCP summary prefix — settled on `with key: value, ...` format which reads naturally in the prompt.
  No follow-up issue needed for these; they are implementation details documented in the code.
