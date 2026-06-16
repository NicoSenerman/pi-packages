---
issue: 411
issue_title: "Render read_session / read_parent_session output compactly with Ctrl-O expansion"
---

# Retro: #411 — Render read_session / read_parent_session output compactly with Ctrl-O expansion

## Stage: Planning (2026-06-15T00:00:00Z)

### Session summary

Produced a numbered implementation plan for compact, `Ctrl-O`-expandable rendering of `read_session` and `read_parent_session`.
The plan keeps the model-facing `content` unchanged and adds a pure, tested summary layer (`entry-summary.ts`) plus a thin, theme-coupled `renderResult`/`renderCall` glue in `index.ts`, populating a `details` discriminated union read by the renderer.

### Observations

- Issue author is the operator (`gotgenes`), so the proposed change is the working hypothesis.
  Despite three `pkg:*` labels (`pi-permission-system`, `pi-subagents`, `pi-session-tools`), the change touches only `pi-session-tools` — single-package plan in `packages/pi-session-tools/docs/plans/`.
- Confirmed the mechanism against the Pi source: `defineTool` supports `renderResult(result, options, theme, context)` with `options.expanded` driven by the `app.tools.expand` (`Ctrl-O`) keybinding.
  The expand hint is **not** auto-added — tools build their own with `keyHint`/`keyText` (both exported from `@earendil-works/pi-coding-agent`).
- In-repo precedent is `pi-colgrep`: `execute` stores a count in `details`, `renderResult` switches on `options.expanded`.
  Its `renderResult` glue is untested because `keyHint`/`keyText` reach global keybinding/theme state — the plan follows the same split (pure `summarizeEntries`/`formatSummaryText` tested; renderer glue verified manually).
- `ask_user` resolved the one genuine design decision the issue itself flagged: collapsed summary shows **total + per-type breakdown**; the `read_parent_session` error/empty rows render as a **short status line that expands to the same message** (modeled as a `SessionToolDetails` discriminated union: `transcript` vs `status`).
- Change is **non-breaking** — `content` is unchanged and `details` is not visible to the model, only to the TUI and session persistence.
- New dependency `@earendil-works/pi-tui` (peer `>=0.75.0`, dev `0.79.1`) matches sibling packages; the plan folds it into the rendering step with the `pnpm-lock.yaml` update and flags `pnpm fallow dead-code` before pushing.
- Next step is `/tdd-plan` (the plan has red→green test cycles for the pure summary layer and the `details` wiring).
