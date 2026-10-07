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

## FOLLOW-UP FIX (same day): PI_SUBAGENT_SESSION daemon-env leak

The child marker was restored only around `bindExtensions`; a throw in
`loader.reload()` / `createSession()` (e.g. a broken extension file — exactly
today's torn-plannotator/ask-user-parse incident) escaped before the finally,
leaving the shared parent daemon permanently marked as a child: parent-only
extensions disabled, widget silenced, every spawned tool shell inheriting
`PI_SUBAGENT_SESSION=1`. The whole creation window now sits inside one
try/finally. Regression tests cover bind-throw and reload-throw restore paths
(create-subagent-session.test.ts; 1294/1294 green on both copies).

## WAVE 2 (same day, later): 21.2–23.2 feature ports

Upstream reference this time: `git archive` of pi-packages `upstream/main` @ 23.2.0
(`gotgenes/pi-packages`), extracted at /tmp/upstream-subs.

LANDED:

1. **Child→parent channel (#858 / 21.2–21.3)** — `session/ask-parent-tool.ts` +
   `notify-parent-tool.ts` (verbatim, `typebox`→`@sinclair/typebox`). Child gets
   `ask_parent` (records the question; carrier renders the exact resume call;
   answer = `subagent` with `resume: <id>`) and, when `midRunUpdates` is on
   (default), `notify_parent` (one-way, 2000-char cap). State gains
   `pendingQuestion` + the exactly-once `runUpdates` ledger
   (`recordUpdate`/`markUpdateAnnounced`), carried into `SettledOutcome` and
   superseded-run records. Question-ending children hold their workspace for the
   resume; failures clear the question. Carriers: NEW
   `observation/outcome-addenda.ts` (`renderQuestionAffordance`,
   `renderRunUpdates`, `currentResumeRefusal`) appended by the foreground result,
   the background completion nudge, and `get_subagent_result`. Live delivery:
   `NotificationManager.sendUpdate` with parent-run withholding, `subagents:update`
   lifecycle event, `subagent-update` message type. New setting `midRunUpdates`
   (default on; `/subagents:settings` toggle row).
2. **`tools:` naming (#1006 / 22.0)** — `session/mcp-tool-patterns.ts` (verbatim):
   `mcp__<server>__*` patterns expand against the parent's registered tool names
   at spawn. `session/builtin-extensions.ts` (guarded-lazy variant): a child whose
   allowlist names `codemode`, `tool_search`, or an `mcp__*` tool loads pi's
   corresponding built-in extension; factories resolve per-call and are skipped on
   hosts predating them. Factory: `listParentToolNames` dep (wired to
   `pi.getAllTools()`).
3. **Session-viewer UX (21.8–23.2)** — new Transcript-pane navigator (imported
   wholesale: `ui/session-navigator.ts`, `session-navigation.ts`,
   `ui/labeled-rule.ts`, `persisted-record.ts`, ADRs 0007/0012, upstream tests +
   `test/helpers/transcript-fixtures.*` synced). Keybinding-following paging,
   mouse wheel, labeled-rule chrome (name/model/thinking), content-sized height,
   fullscreen overlay float; earlier runs survive `/reload` in
   `/subagents:sessions`. Subagent exposes `model`/`thinkingLevel`; display gains
   `ModelIdentity`/`formatModel`/`modelLabel`.
4. **Turn-budget engine (#1021/#1022 / 22.0–23.0, BREAKING)** —
   `lifecycle/turn-limits.ts`: `TurnBudgetTracker` + phases + MIN_MAX_TURNS=2.
   `subagent-session` run/resume loops enforce budgets with a wrap-up warning;
   resumed runs get a FRESH budget; `TurnLoopResult.turnBudget` replaces the
   old `{aborted, steered}` engine fields (the `steered` status stays in the
   union and renderers for legacy persisted records — nothing new produces it).
   Exhausted runs mark `aborted` and dispose the workspace even with a pending
   question. One status vocabulary everywhere: `renderStatusLabel` /
   `renderStatusNote` / `renderTurnBudget` back the nudge, the foreground note,
   and the result-report stats ("Turns: used/max").
   **Settings breaking:** `graceTurns` REMOVED → `wrapUpTurns` (default 2; a
   settings file still naming `graceTurns` gets a console warning and the value
   is stripped, never applied). `defaultMaxTurns` clamp floor is now 2.

DEV PIN: test/dev SDK moved 0.80.5 → 1.0.0 (node_modules vendored 1.0.0 +
transitives by flat copy; package.json pins updated, peers `>=1.0.0`).

WATCHER FLAKE, ROOT-CAUSED (was the known `bridge-command-watcher` flake):
`watchFile` captures its baseline stat asynchronously; an append landing BEFORE
that capture makes every later poll see no change — the command was lost
(~10% reproduction in isolation). `start()` now schedules a second
content-based drain one poll interval out, gated on `active` so a stopped
sibling test watcher stays quiet. Full suite: 3× green beforehand, 1465/1465 +
20/20 isolation runs after.

TESTS: 1465/1465 across 79 files. Forks' own piru-era coverage (subagent/
manager lifecycle, settings UI, ask-user ports earlier today) kept and updated
to the new semantics rather than replaced.

NOT YET: exit-hang repro (bisect deferred — pi-side prompt-flow only, not a
pi-subagents blocker); `workspaceNotice` carrier addendum (upstream's
workspace-notice layer) — the fork brackets workspaces without notice plumbing;
port iff a workspace provider needs it.
