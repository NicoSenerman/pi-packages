---
issue: 91
issue_title: "Auto-reindex on session start and file mutations"
---

# Auto-reindex on session start and file mutations

## Problem Statement

The colgrep index can become stale during a session as the agent modifies files via `write` and `edit` tools.
Currently, there is no automatic mechanism to keep the index current — the user would have to manually reindex.
This plan adds automatic index management so the first search in a session hits a warm index and subsequent file mutations trigger a debounced reindex to keep results fresh.

## Goals

- On `session_start`, run `colgrep init -y .` to warm or update the index.
- On successful `tool_result` for `write` and `edit` tools, schedule a debounced reindex.
- Debounce reindex requests with ~4 seconds of quiet time.
- Queue at most one reindex behind an in-flight reindex (no concurrent reindex processes).
- Show indexing status in the footer via `ctx.ui.setStatus()`.
- Register a `/colgrep-reindex` command for manual index refresh.
- Keep reindex logic in a separate module from tool execution.
- Log errors to stderr without throwing — indexing failures must not block the agent.

## Non-Goals

- Skill/prompt guidance for colgrep usage (issue #92).
- Reindexing on `bash` tool results that may mutate files — detecting file mutations from shell commands is complex and out of scope.
- Customizable debounce timing or reindex timeout via config.

## Background

### Package state

Issue #90 (closed) implemented the `colgrep` search tool with availability checking, CLI argument building, result formatting, and TUI rendering.
The extension currently:

1. Registers the `colgrep` tool in the extension function.
2. Runs an availability check on `session_start` and warns if colgrep is absent.

### Existing architecture

```text
extension.ts
  ├── registerColGrep(pi, deps)  →  tools/colgrep.ts  →  lib/search.ts
  │                                                     ├── lib/args.ts
  │                                                     └── lib/format.ts
  └── session_start handler      →  lib/availability.ts
```

Key modules:

- `src/lib/exec.ts` — narrow `Exec` type used by all library modules.
- `src/lib/availability.ts` — `AvailabilityState` with `available` flag and `refresh()` method.
- `src/extension.ts` — extension entrypoint that wires the tool and `session_start` handler.

### Pi SDK patterns

- `pi.on("tool_result", handler)` receives `ToolResultEvent` with `toolName`, `isError`, `input`, and `content`.
- `ctx.ui.setStatus(key, text | undefined)` sets a persistent footer status line (keyed, so multiple extensions coexist).
- `pi.registerCommand(name, { description, handler })` registers a slash command.
- `ExtensionCommandContext` (command handler ctx) extends `ExtensionContext` with session control methods.

### Sibling package conventions

- pi-autoformat uses `ctx.ui.setStatus("autoformat", text)` for footer status, with feature detection (`typeof ctx.ui.setStatus === "function"`).
- pi-permission-system uses `ctx.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, undefined)` to clear status.
- Both use a constant for the status key.
- pi-subagents and pi-permission-system use `pi.registerCommand()` for slash commands.

## Design Overview

### Reindex module

A new `src/lib/reindex.ts` module encapsulates all reindex orchestration: debouncing, in-flight tracking, queuing, and execution.
It is SDK-free — it accepts an `Exec` function and a status callback for UI updates.

The reindex operation runs `colgrep init -y .` via the injected `exec` function.

### State machine

The reindexer has three states:

```text
idle  →  running  →  idle
                  →  running+queued  →  running (drain queue)  →  idle
```

- **idle**: no reindex in progress; a `schedule()` call starts the debounce timer.
- **running**: a reindex is in flight; new `schedule()` calls set a queued flag.
- **running+queued**: a reindex is in flight with a pending follow-up; when the current run finishes, the queued reindex starts immediately (no debounce — the quiet period already elapsed).

### Debouncing

`schedule()` resets a debounce timer (4 seconds).
When the timer fires, the reindex runs.
If `schedule()` is called again while the timer is pending, the timer resets.
If a reindex is already in flight, the call sets the queued flag instead.

### Reindexer interface

```typescript
interface ReindexStatusCallback {
  (status: string | undefined): void;
}

interface Reindexer {
  /** Schedule a debounced reindex. Safe to call repeatedly. */
  schedule(): void;
  /** Run a reindex immediately, bypassing debounce. Returns when complete. */
  runNow(): Promise<void>;
  /** Cancel pending timers and wait for any in-flight reindex. */
  shutdown(): Promise<void>;
}
```

The factory function:

```typescript
function createReindexer(deps: {
  exec: Exec;
  cwd: string;
  onStatus: ReindexStatusCallback;
  debounceMs?: number;
  timeoutMs?: number;
}): Reindexer;
```

- `onStatus` is called with status text when indexing starts, and `undefined` when it completes or fails.
- `debounceMs` defaults to 4000.
- `timeoutMs` defaults to 300000 (5 minutes).

### Status feedback

The `onStatus` callback bridges the reindexer to `ctx.ui.setStatus()`.
Status messages follow the issue spec:

- `"colgrep: indexing…"` — during a session-start reindex.
- `"colgrep: indexing… (queued updates)"` — when a scheduled reindex is queued behind an in-flight one.
- `"colgrep: indexing failed"` — on error, shown briefly before clearing.
- Status is cleared (`undefined`) on completion.

The status key is `"colgrep"`, matching the tool name convention used by sibling packages.

### Event wiring

In `extension.ts`:

1. On `session_start`: if colgrep is available, create a `Reindexer` instance (stored per-session) and call `runNow()`.
   The reindexer's `onStatus` wraps `ctx.ui.setStatus("colgrep", text)`.
2. On `tool_result`: if the event is a successful `write` or `edit` (`!event.isError` and `toolName === "write" || "edit"`), call `reindexer.schedule()`.
3. On `session_shutdown`: call `reindexer.shutdown()` to cancel pending timers.

The reindexer is created once per session (in `session_start`) so its `cwd` and `onStatus` are bound to the session context.
Before the first `session_start`, no reindexer exists and `tool_result` handlers are no-ops.

### Manual command

Register `/colgrep-reindex` via `pi.registerCommand()`.
The handler calls `reindexer.runNow()` and shows a success notification via `ctx.ui.notify("ColGrep index updated.", "info")` on completion.
If colgrep is unavailable, it shows a warning notification.
If no reindexer exists yet (pre-session), it creates a one-shot reindex via `exec`.

### Error handling

- Reindex errors are logged to `console.error` and surfaced as a brief status message.
- Errors never throw from event handlers — they are caught and logged.
- The `runNow()` promise resolves (not rejects) on failure, with the error logged internally.

### Consumer call-site sketch

The `tool_result` handler in `extension.ts`:

```typescript
pi.on("tool_result", async (event, _ctx) => {
  if (event.isError) return;
  if (event.toolName !== "write" && event.toolName !== "edit") return;
  reindexer?.schedule();
});
```

This follows Tell-Don't-Ask: the handler tells the reindexer to schedule without querying its state.
The reindexer internally decides whether to debounce, queue, or no-op.

## Module-Level Changes

### New files

1. `src/lib/reindex.ts` — `createReindexer()` factory, `Reindexer` interface, debounce/queue/execute logic.
   No SDK imports — accepts `Exec` and a status callback.
2. `test/lib/reindex.test.ts` — unit tests for the reindexer with fake timers and mocked exec.

### Modified files

1. `src/extension.ts` — add `tool_result` handler, create reindexer in `session_start`, register `/colgrep-reindex` command, add `session_shutdown` handler.

## Test Impact Analysis

1. The reindexer is entirely new code in a new module — all tests are new.
   The reindexer's pure state-machine logic (debounce, queue, in-flight tracking) is directly testable via Vitest fake timers and a mocked `exec`.
2. No existing tests become redundant — the existing tests cover the search tool, not reindexing.
3. The existing `test/tools/colgrep.test.ts` and `test/lib/*.test.ts` tests stay as-is — they test the search path, which is orthogonal to reindexing.

## TDD Order

### Cycle 1 — reindexer: basic reindex execution

1. RED: `test/lib/reindex.test.ts` — test that `runNow()` calls `exec("colgrep", ["init", "-y", "."])` with the configured `cwd` and `timeout`, calls `onStatus` with indexing text before and `undefined` after, and resolves on success.
2. GREEN: `src/lib/reindex.ts` — implement `createReindexer()` with `runNow()`.

- Commit: `feat: add reindexer with immediate execution (#91)`

### Cycle 2 — reindexer: error handling

1. RED: add tests that `runNow()` calls `onStatus("colgrep: indexing failed")` on exec failure (non-zero exit and thrown error), logs to `console.error`, and resolves without throwing.
2. GREEN: add error handling to `runNow()`.

- Commit: `feat: handle reindex errors gracefully (#91)`

### Cycle 3 — reindexer: debounced scheduling

1. RED: add tests using `vi.useFakeTimers()` that `schedule()` starts a debounce timer (4s default), multiple rapid `schedule()` calls reset the timer, and the reindex runs once after the debounce period elapses.
   Test that `onStatus` is called appropriately.
2. GREEN: implement `schedule()` with `setTimeout` debounce logic.

- Commit: `feat: add debounced reindex scheduling (#91)`

### Cycle 4 — reindexer: in-flight queuing

1. RED: add tests that when `schedule()` is called while a reindex is in flight, the request is queued (not dropped), and a second reindex runs after the first completes.
   Test that concurrent reindexes do not run (only one at a time).
   Test that the queued status message is shown.
2. GREEN: implement the in-flight check and queue flag in `schedule()` and the drain logic in the run-completion path.

- Commit: `feat: queue reindex behind in-flight run (#91)`

### Cycle 5 — reindexer: shutdown

1. RED: add tests that `shutdown()` cancels a pending debounce timer, that `shutdown()` waits for an in-flight reindex to complete, and that `schedule()` after `shutdown()` is a no-op.
2. GREEN: implement `shutdown()` with timer cancellation and in-flight await.

- Commit: `feat: add reindexer shutdown (#91)`

### Cycle 6 — extension wiring: session_start reindex

1. RED: add tests in a new or existing extension-level test file that verify on `session_start` when colgrep is available, a reindex runs (`exec` is called with `colgrep init -y .`), and status is set/cleared via `setStatus`.
   Test that when colgrep is unavailable, no reindex runs.
2. GREEN: update `src/extension.ts` to create a reindexer in the `session_start` handler and call `runNow()`.

- Commit: `feat: reindex on session start (#91)`

### Cycle 7 — extension wiring: tool_result trigger

1. RED: add tests that the `tool_result` handler calls `schedule()` on the reindexer for successful `write` and `edit` events, and does nothing for `isError: true`, other tool names, or when colgrep is unavailable.
2. GREEN: add the `tool_result` handler to `src/extension.ts`.

- Commit: `feat: schedule reindex on write/edit tool results (#91)`

### Cycle 8 — extension wiring: manual command

1. RED: add tests that `/colgrep-reindex` command runs `runNow()` and shows a success notification, shows a warning when colgrep is unavailable, and handles errors gracefully.
2. GREEN: add `pi.registerCommand("colgrep-reindex", ...)` to `src/extension.ts`.

- Commit: `feat: register /colgrep-reindex manual command (#91)`

### Cycle 9 — extension wiring: session_shutdown cleanup

1. RED: add a test that `session_shutdown` calls `reindexer.shutdown()`.
2. GREEN: add the `session_shutdown` handler to `src/extension.ts`.
   Run `pnpm -C packages/pi-colgrep run check`, `lint`, and `test` to verify everything passes.

- Commit: `feat: clean up reindexer on session shutdown (#91)`

## Risks and Mitigations

| Risk                                                                                  | Mitigation                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `colgrep init -y .` may not be the correct command or may change across versions      | Verify empirically during implementation; the `-y` flag skips confirmation prompts. If the command differs, the fix is a one-line change in `reindex.ts`.                                                       |
| Long-running reindexes on large codebases block the 5-minute timeout                  | The timeout is generous (5 minutes) as the issue specifies. On timeout, the exec promise rejects, the error is logged, and the next reindex can proceed.                                                        |
| Fake timers interact poorly with async exec mocks in tests                            | Use `vi.useFakeTimers()` with `shouldAdvanceTime: false` and manually control timer advancement. Use `vi.advanceTimersByTimeAsync()` (not `vi.runAllTimersAsync()` — that loops infinitely with `setInterval`). |
| `ctx.ui.setStatus` may not be available on older Pi runtimes                          | Feature-detect with `typeof ctx.ui.setStatus === "function"` before calling, following pi-autoformat's pattern. The `onStatus` callback in the reindexer handles this at the wiring layer.                      |
| Multiple sessions could create multiple reindexers racing                             | Each reindexer is bound to a session's `cwd`. The `session_shutdown` handler calls `shutdown()` to clean up. A new `session_start` creates a fresh reindexer.                                                   |
| The `tool_result` handler fires before the reindexer is created (pre-`session_start`) | Guard with `reindexer?.schedule()` — the optional chain makes pre-session events no-ops.                                                                                                                        |

## Open Questions

- Should the reindex debounce also cover `bash` tool results that may run file-mutating commands (e.g., `mv`, `cp`, `sed`)?
  The issue explicitly scopes triggers to `write` and `edit` only.
  Detecting file mutations from bash is unreliable.
  Defer unless user feedback suggests coverage gaps.
- Should `runNow()` in the `/colgrep-reindex` command bypass a debounce timer that is already ticking?
  Yes — manual invocation should be immediate regardless of debounce state.
  `runNow()` is designed for this: it cancels any pending timer and runs immediately.
