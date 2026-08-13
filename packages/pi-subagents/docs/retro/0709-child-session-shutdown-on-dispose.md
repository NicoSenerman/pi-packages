---
issue: 709
issue_title: "pi-subagents: child disposal skips session_shutdown and leaks extension-owned processes"
---

# Retro: #709 — pi-subagents: child disposal skips `session_shutdown` and leaks extension-owned processes

## Stage: Planning (2026-08-13T17:55:00Z)

### Session summary

Verified the third-party bug report against the pinned SDK (`@earendil-works/pi-coding-agent@0.80.5`) and confirmed it is accurate: `AgentSession.dispose()` invalidates the extension runner without ever emitting `session_shutdown`, and pi-subagents does not use the `AgentSessionRuntime` path that would emit it.
Ran the `ask_user` direction gate (mandatory for a third-party issue) and got four decisions: fix as proposed, full await chain, bounded timeout, `fix:` with a behavior-change note.
Wrote `packages/pi-subagents/docs/plans/0709-child-session-shutdown-on-dispose.md` — a new `child-shutdown.ts` emitter plus async propagation through `SubagentSession` → `Subagent` → `SubagentManager` → `SessionLifecycleHandler`, in seven TDD steps.

### Observations

- **The fix is available on the public SDK surface.**
  `emitSessionShutdownEvent` is module-private in Pi and not re-exported from the package entry — checked both the installed `dist/` and the sibling `../pi` checkout on `main` — but `AgentSession.hasExtensionHandlers()` and `AgentSession.extensionRunner` are both public, so the three lines can be replicated.
  No deep import, no upstream dependency.
- **The ordering constraint is forced, not stylistic.**
  `AgentSession.dispose()` calls `extensionRunner.invalidate(...)`, and every `ctx` getter calls `assertActive()` and throws once invalidated.
  So a fire-and-forget emit followed by a synchronous `dispose()` would hand every shutdown handler a stale context — which is exactly why the "internal async, sync signatures" option was rejected in the `ask_user` gate.
- **Cross-package check paid off.**
  `pi-permission-system`'s `subagent-registry.ts:41` and `serving-registry.ts:93` already carry comments saying a child's `session_shutdown` must not wipe parent registrations, which is strong evidence the ecosystem anticipated this event firing in children and that the change is safe for the one known consumer.
- **Alternatives rejected.**
  Adopting `AgentSessionRuntime` for children (it emits shutdown for free) was rejected as disproportionate — the runtime also owns session replacement, UI context, and `/new`/`/fork`/`/resume` flows a child never uses.
  Filing a companion upstream Pi issue was offered and declined.
  A configurable `childShutdownTimeoutMs` setting was offered and declined in favor of a module constant.
- **Scope boundary held against [#617].**
  Shutting extensions down at child *completion* rather than *disposal* would release resources sooner but break resume, since retention deliberately outlives the run.
  The plan ties the emit to disposal and lists the completion-time variant as an Open Question with no issue filed.
- **No quantitative baseline was claimed.**
  The reporter's 25-pair / 221 MB figures are their measurement, not one reproduced here (it needs a configured stdio MCP server).
  The plan's verifiable assertion is deterministic and test-level instead: exactly one `session_shutdown` per disposed child, emitted before the runner is invalidated.
- **Lint hazard flagged up front.**
  `eslint.config.js` enables `recommendedTypeCheckedOnly`, so `no-floating-promises` and `no-misused-promises` are live.
  The plan keeps `sweep()` a synchronous function (so the `setInterval` callback still returns `void`) and requires an explicit `void promise.catch(debugLog)` at each fire-and-forget.
- **Three separate session mocks need the new runner stub** — `test/helpers/mock-session.ts`, its local counterpart inside `test/lifecycle/subagent-session.test.ts`, and (transitively, via a spread) `test/helpers/subagent-session-io.ts`.
  Step 2 of the TDD order lands that helper prep on its own so the type-forced steps that follow stay small.

## Stage: Implementation — TDD (2026-08-13T18:20:45Z)

### Session summary

Executed all seven TDD steps from the plan in order: a new bounded `child-shutdown.ts` emitter, extension-runner stubs on the session mocks, the shutdown-before-dispose wiring in `SubagentSession`, and then promise propagation up through `Subagent`, `SubagentManager`, and `SessionLifecycleHandler`, closing with the doc updates.
Seven commits, all green at each step; pi-subagents went from 1199 to 1229 tests (+30).
The `pre-completion-reviewer` returned **PASS**.

### Observations

- **The plan's file list held.**
  Two files it missed surfaced only through lint, not `tsc`: `test/tools/agent-tool.test.ts` and `test/tools/get-result-tool.test.ts` each had one bare `record.releaseSession();` that became a floating promise.
  `pnpm run check` passes on an un-awaited promise-returning call, so a `src/`-caller grep at plan time would not have found them — only `no-floating-promises` did.
  The general lesson: when a method becomes promise-returning, the blast radius is the lint rule's, not the type checker's.
- **`Promise.withResolvers<void>()` needs the repo's boilerplate disable.**
  It trips `@typescript-eslint/no-invalid-void-type` despite `allowInGenericTypeArguments: true`, and the codebase already carries a standard `eslint-disable-line` comment for it at six sites.
  Three of the new gating tests needed the same comment; the pre-commit hook caught it before the commit landed.
- **The retention sweep uses a bare `void`, not the plan's `void promise.catch(debugLog)`.**
  `Subagent.releaseSession()` routes through a new private `disposeQuietly()` that already swallows a failing teardown, so a `.catch` at the sweep call site would be unreachable.
  Preferring the honest bare `void` keeps the dead-code gate meaningful.
- **`index.ts` needed no edit, as predicted.**
  Its three `pi.on(...)` handlers are expression-bodied arrows that return the handler's value, and `ExtensionHandler` permits a `Promise<void>` return that Pi awaits — so making the lifecycle handlers async propagated the await into Pi's own emit loop with zero wiring change.
- **`session_start`'s reason for a child is `"startup"`, not `"new"`.**
  The README draft asserted `"new"` from intuition; checking `AgentSession`'s constructor showed `sessionStartEvent` defaults to `{ reason: "startup" }` and pi-subagents never overrides it.
  A documented event payload is worth verifying against the SDK rather than inferring from the event's meaning.
- **The architecture doc's `Total LOC` row is a raw `wc -l` of `src/**/*.ts`, not a fallow metric.**
  Reproduced the recorded 8,162/60 exactly from the plan commit's tree, which confirmed the method before updating it to 8,323/61.
  `fallow health` reports whole-package totals (23,774 lines, 144 files) and would have been the wrong source.
- **Tidy-First assessor found no blocking preparatory work.**
  It flagged the third mock layer (`subagent-session.test.ts`'s private `createSession`, which does not spread `createMockSession`) as a real but medium-sized consolidation, and correctly declined it as a prerequisite — the duplication this change added there was two lines.

[#617]: https://github.com/gotgenes/pi-packages/issues/617
