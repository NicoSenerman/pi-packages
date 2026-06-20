---
issue: 452
issue_title: "Bash permission gates silently fail after model changes, denial events, or session compaction git add/commit/push/gh pr create bypass all rules"
---

# Retro: #452 — Make the bash permission gate fail closed instead of silently allowing

## Stage: Planning (2026-06-20T00:00:00Z)

### Session summary

Planned a defense-in-depth, fail-closed hardening of the bash permission gate in response to a third-party bug report (`k0valik`) with a detailed-but-speculative log analysis.
Decomposed the single reported "bug" into four confirmable code defects (A1–A4) plus one unreproducible asymmetry (C), verified each against source and the Pi SDK, and produced a five-step TDD plan filed at `packages/pi-permission-system/docs/plans/0452-bash-gate-fail-closed-hardening.md`.

### Observations

- The keystone finding is A1: the SDK's `emitToolCall` (`runner.js`) calls `await handler(event, ctx)` with **no** try/catch, unlike `emitUserBash` directly below it.
  A thrown `handleToolCall` therefore yields no block and the command runs ungated with no trace — this is what turns every other latent error into a silent bypass.
- A2: `parserPromise ??= initParser()` in `bash-program.ts` caches a *rejected* promise forever; `config.loaded` does not re-run the factory module, matching "stays broken until process restart."
- A3: `resolveBashCommandCheck`'s empty-commands fallback resolves the whole string, so `cd X && git push` rides a permissive top-level `*: allow`.
  When parse succeeds the chain splits correctly, so the bypass is only reachable via empty-parse.
- A4: the shipped example config sets `bash.*: ask` (safe); the reporter's config omitted it, inheriting the permissive top-level `*`.
- Ruled out three of the reporter's theories from source (handler deregistration — contradicted by `rm` staying gated; mid-parse tree-sitter corruption — single-threaded synchronous parse; denial poisoning state — no such code path).
- Could **not** reconcile the `git`-bypasses-while-`rm`-gated asymmetry (C) from static reading; scoped it as diagnosable-on-recurrence rather than guessing a fix.
- Operator decisions via `ask_user` (third-party issue gate): defense-in-depth scope; fallback fails closed to `ask`; emit a non-fatal config warning for the footgun; single plan covering A1–A4 + observability.
- Behavior-changing pieces (A1 block-on-error, A3 ask-on-unparseable) are treated as breaking (`fix!:` + `BREAKING CHANGE:` footer) with a verified opt-out remediation (`"bash": { "*": "allow" }`).
- Release: ship independently (not in any roadmap batch).
- Next: `/tdd-plan` — the plan is test-cycle driven (five red→green→commit steps).
