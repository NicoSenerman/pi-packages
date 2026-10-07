# PORT-REPORT — pi-subagents upstream → 19.3.1-piru.1 (2026-10-07)

Base: upstream gotgenes/pi-packages `packages/pi-subagents` @ 23.2.0
(extracted read-only at /tmp/upstream/pi-subagents-gotgenes). Our base was
19.3.1 with fork subsystems (pitui observation, spawn-model picker,
parent-snapshot stash). This was a curated subset port, NOT a resync — both
copies (pi-rust-tui/extensions + pi-packages/packages) are byte-identical
excluding .git/node_modules/dist.

## LANDED

1. **Composed prompt-tail cut (#1009 ⊕ fork stash)** — `src/session/prompts.ts`
   `inheritParentPrompt()`: cuts the session-resolved tail in all three shapes
   (footer-anchored, section-anchored, unanchored catalogue), excises the
   parent's `<tools>`/`<rules>` pair when section-shaped (#1009), drops
   `<project_context>` for relocated children, cuts trailing extension blocks
   after the tail, honors ≥0.86-similarity `<skills>`/`<cwd>` anchors (#958 /
   21.7.4 analogue). Still pipes through the fork's `withoutOwnStaticSections`,
   `withoutRecursionGuardedToolLines`, `withoutContradictoryCwdFooter`; the
   per-turn stash in `parent-snapshot.ts` (forceSystemPrompt-freeze leak guard)
   is untouched and complementary.
   Semantic change (upstream #640, deliberate): agreeing footers are now cut
   too — the fork's footer tests were updated accordingly.
2. **Resume plumbing** — `waitUntilSettled()` now returns `WaitOutcome`
   (`settled`/`unsettled`/`superseded`); `resume()` manages the observer
   lifecycle; `onResumeStarted` observer hook; once-only
   `notifyRunFinished`/`notifyResumeFinished`; `_runKind` so aborting a resume
   doesn't fire the fresh-run channel. Resume-race guards (#987/#1015 family)
   in `subagent-state.ts` / `subagent-manager.ts`.
3. **`tools: none`** parsed in `src/config/custom-agents.ts` (21.4.2).
4. **Turn-budget config plumbing** — `max_turns` frontmatter → `maxTurns` in
   invocation config and session (23.0 data flow; enforcement hooks present
   in session lifecycle).
5. **Provider-error handling** in `subagent-session.ts` (21.4.5/21.4.6 family).
6. Widget/service/observer adjustments (agent-widget, widget-renderer,
   notification, subagent-events-observer, service, service-adapter,
   agent-tool, get-result-tool) matching the lifecycle changes.

## SKIPPED (deliberate)

- **Child ask-parent / notify_parent tools (21.2–21.3)** — new child-facing
  message channel; intersects the fork's observation stack; needs design time.
- **`tools:` naming `codemode`/`tool_search`/`mcp__server__tool` (22.0)** —
  needs verification against piru's actual tool registry names.
- **Session-viewer upgrades + /reload persistence (23.1–23.2)** — UI surface.
- **Full turn-budget UX/semantics (23.0)** — breaking; only config plumbing
  landed.
- **SDK-floor items requiring Pi 1.0-only APIs** — fork still supports the
  older host surface; flagged by the porter.

## TESTS

- Both copies: `env -u PITUI_BRIDGE -u PI_SUBAGENT_SESSION npx vitest run`
  → 1291/1292 pass.
- The one failure, `bridge-command-watcher > routes an abort line appended
  after seedOffset via the live watcher`, is a PRE-EXISTING load-dependent
  flake: it fails identically on HEAD (verified via detached worktree of
  9e2887e1) and passes standalone. Not port-caused.
- `test/handlers/lifecycle.test.ts` now stubs `PI_SUBAGENT_SESSION=""` in
  beforeEach — shells spawned inside a piru main session inherit
  `PI_SUBAGENT_SESSION=1`, which made the widget-clear test host-env dependent.
- Two `waitUntilSettled` tests updated for the `WaitOutcome` return.
