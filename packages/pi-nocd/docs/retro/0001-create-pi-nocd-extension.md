---
issue_title: "Create pi-nocd extension (prevent cd-prefixing the CWD)"
---

# Retro: pi-nocd — Create cd-prefix-prevention extension

## Stage: Final Retrospective (2026-06-15T04:10:00Z)

### Session summary

Created `@gotgenes/pi-nocd`, a new Pi extension that hooks `before_agent_start` and appends a `# Working Directory` block forbidding `cd`-into-cwd command prefixes, using the resolved `ctx.cwd`.
The work spanned design, full package scaffolding, a rationale correction prompted by the user, the full publish path (bootstrap publish, release-please, npm), and double-load prevention in local settings.
Three latent gaps surfaced during shipping — a wrong rationale, an unused copied dependency, and a hardcoded publish script that silently skipped the new package.

### Observations

#### What went well

- The investigation into Pi's `system-prompt.ts` and `pi-anthropic-auth`'s `system-prompt-shaping.ts` was conclusive: it correctly traced that Pi emits a `Current working directory: <path>` footer *after* the `PI_DEFAULT_PROMPT_TERMINATOR`, so the shaping (which only rewrites the preamble span) preserves it.
  Cross-checking against the live session's own system prompt was a clean confirmation step.
- The `appendWorkingDirectoryPrompt` idempotency guard (skip if the `# Working Directory` heading is already present) was a sensible defensive choice for chained `before_agent_start` handlers.

#### What caused friction (agent side)

- `missing-context` (user-caught) — The extension's rationale (in `README.md`, `working-directory-prompt.ts`, and `index.ts`) was written on the unverified assumption that "the agent never sees the resolved path."
  Pi actually emits the resolved CWD and `pi-anthropic-auth` preserves it; the real gap was the missing *prohibition*, not the path.
  The user had pointed me to `~/development/pi/pi/packages/agent/` early, but I only read Pi's prompt source after the user's probing question.
  Impact: a correction round across three files; the code stayed correct but the justification was rewritten.
- `missing-context` (CI-caught) — `@earendil-works/pi-ai` was copied wholesale into `devDependencies`/`peerDependencies` from `pi-session-tools`, but `pi-nocd` registers no tools and never imports `Type`, so it is unused.
  Impact: the `fallow dead-code` CI gate failed on the first push; required a `--amend` + `--force-with-lease` and an extra CI cycle.
  Running `pnpm fallow dead-code` locally before pushing would have caught it.
- `missing-context` (self-identified during investigation) — `scripts/publish-released.sh` iterates a hardcoded package list to decide what to publish, and `pi-nocd` was not in it.
  `release-please-config.json` and `.release-please-manifest.json` were updated, but the publish script was not, so the `1.0.0` release was tagged and GitHub-released yet never published to npm (the job found no match and exited `0`).
  Impact: highest-impact friction — silent publish skip, a diagnostic dig through CI logs, a `fix(ci)` commit, and an out-of-band manual publish of `1.0.0`.
- `scope-drift` (user-caught) — The "full package" was delivered without wiring it into the local `.pi/settings.json`, so it was inert until the user asked.
  Impact: minor; one extra prompt and step.

#### What caused friction (user side)

- The wrong-rationale issue (friction 1) could have been pre-empted: the user knew Pi already states the CWD and that `pi-anthropic-auth` only strips the preamble.
  Sharing that constraint at design time (rather than as a confirming question after the rationale was written) would have avoided the correction round.
  Framed as opportunity, not criticism — the probing question was exactly the right intervention once the gap existed.

### Diagnostic details

- **Unused-tool detection** — For the wrong-rationale friction, no subagent was needed; reading Pi's `system-prompt.ts` before authoring the rationale would have sufficed.
  For the publish-script gap, an `Explore` pass on "how are packages published" during scaffolding could have surfaced `scripts/publish-released.sh` and its hardcoded list.
- **Feedback-loop gap analysis** — `pnpm run check`, `test`, and `lint` were run incrementally after each change, but `pnpm fallow dead-code` (part of the CI gate) was not run locally before the first push, which is what caused the CI failure.
- **Model-performance correlation** and **escalation-delay tracking** — no subagents were dispatched and no error sequence exceeded a couple of tool calls; nothing notable.

### Follow-ups (not implemented in this retro)

- Make `scripts/publish-released.sh` derive the package list dynamically (e.g. from the `RELEASES` payload's `paths_released`) so a new package can never be silently skipped again.
  This is a behavioral script change — open a GitHub issue and run `/plan-issue` rather than landing it in the retro.

### Changes made

1. Added `packages/pi-nocd/docs/retro/0001-create-pi-nocd-extension.md` (this file).
2. Replaced the single `exclude-paths` sentence in `AGENTS.md` with a four-item new-package wiring checklist covering `release-please-config.json`, `.release-please-manifest.json`, `scripts/publish-released.sh`, and `.pi/settings.json`, preserving the existing docs-subdirectory guidance.
3. Added a pre-push `pnpm fallow dead-code` rule to `AGENTS.md`.
