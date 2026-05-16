---
issue: 5
issue_title: "Polling tools ignore the abort signal, preventing cancellation"
---

# Thread AbortSignal Through Polling Chains

## Problem Statement

All four polling tools (`ci_find`, `ci_watch`, `release_pr_find`, `release_watch`) receive an `AbortSignal` from Pi's `execute()` handler but discard it (parameter named `_signal`). The underlying library functions, `sleep()`, and `gh()`/`git()` have no signal awareness. As a result, pressing Escape to cancel a running tool has no effect until the poll loop finishes on its own via timeout or success.

## Goals

- Thread `AbortSignal` from every tool `execute()` through the full call chain to `runCommand()` and `sleep()`.
- `sleep()` must resolve immediately (rejecting with an `AbortError`) when the signal fires, rather than waiting for the full timeout.
- `gh()`, `git()`, and `ghJson()` must forward a signal to `runCommand()`, which already supports it via `spawn()`'s `signal` option.
- Polling lib functions (`findRun`, `watchRun`, `findReleasePR`, `watchRelease`) must short-circuit on abort, returning a structured error message.
- Non-polling tools (`ci_list`, `release_pr_merge`, `issue_close`) gain signal forwarding for their `gh`/`git` calls, allowing in-flight subprocesses to be killed on cancel.

## Non-Goals

- Adding cancellation to `listRuns` (no poll loop — a single `ghJson` call; signal forwarding to `runCommand` is sufficient).
- Changing the shape of `ToolResult` or `onProgress` callback signatures.
- Adding retry/timeout logic to one-shot tools (`release_pr_merge`, `issue_close`).
- Modifying `runCommand()` itself — it already accepts `signal` and passes it to `spawn()`.

## Background

### Current signal chain (broken)

```text
Tool execute(_toolCallId, params, _signal, onUpdate)
  └─ lib function (no signal param)
       └─ sleep(ms)                       // no signal
       └─ gh(...args) / git(...args)      // no signal
            └─ runCommand({cmd, args})    // signal not provided
```

### Target signal chain (fixed)

```text
Tool execute(_toolCallId, params, signal, onUpdate)
  └─ lib function({ ..., signal })
       └─ sleep(ms, signal)               // abort-aware
       └─ gh(...args, signal)             // forwards signal
            └─ runCommand({cmd, args, signal})
```

Key constraint from AGENTS.md: `src/lib/` must not import from `@earendil-works/pi-coding-agent`. The `signal` parameter is a standard `AbortSignal` (Web API / Node 15+), so this is safe — no Pi SDK types enter `src/lib/`.

### Architecture boundary

- `src/lib/process.ts` — add optional `signal` to `sleep()`.
- `src/lib/github.ts` — add optional `signal` to `gh()`, `git()`, `ghJson()`.
- `src/lib/ci.ts` — add optional `signal` to `FindRunArgs`, `WatchRunArgs`, and thread it into `sleep()`/`ghJson()` calls.
- `src/lib/release.ts` — add optional `signal` to `FindReleasePRArgs`, `WatchReleaseArgs`, and thread it. Also thread through `mergeReleasePR`'s `gh`/`git` calls.
- `src/lib/issue.ts` — add optional `signal` to `CloseIssueArgs` and thread it to `gh()`.
- `src/tools/*.ts` — rename `_signal` → `signal` and pass it to each lib function's args.

## Design Overview

### `sleep(ms, signal?)` — abort-aware

```typescript
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    }

    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
```

Key behaviors:

- If `signal` is already aborted at call time, rejects immediately.
- Otherwise, resolves normally after `ms`, or rejects on `abort`.
- The `clearTimeout` in the abort handler prevents pending timers from firing after abort.
- Uses `DOMException` with name `"AbortError"` for consistency with the web standard, falling back to `signal.reason` if provided.

### `gh()`, `git()`, `ghJson()` — signal parameter

All three gain an optional trailing `signal` parameter:

```typescript
export async function gh(...args: string[], signal?: AbortSignal): Promise<string>
export async function git(...args: string[], signal?: AbortSignal): Promise<string>
export async function ghJson<T>(...args: string[], signal?: AbortSignal): Promise<T>
```

Wait — a variadic `...args` signature with a trailing optional parameter is not valid TypeScript (rest parameters must come last and can't be followed by another parameter). Instead, the cleanest approach is an options bag or explicit last parameter.

**Decided: use explicit last parameter**. The `args` rest parameter stays, and `signal` is added as an `AbortSignal | undefined` at the end of the argument list. Callers that don't pass a signal are unaffected.

Actually, TypeScript does not allow a required-or-optional parameter after a rest parameter. The clean fix is to use an options-style final parameter:

```typescript
export async function gh(args: string[], signal?: AbortSignal): Promise<string>
```

But this is a breaking change to the public API of `gh()` and would require updating every call site. Instead, **use an overload approach**: keep the old `gh(...args: string[])` signature for backward-compat and add a new overload. Actually this is unnecessarily complex.

The simplest approach: change the `gh()` / `git()` / `ghJson()` functions to accept `RunCommandOptions`-style, or keep the spread syntax but thread `signal` through the `RunCommandOptions` object internally.

**Final decision: change the `gh`, `git`, `ghJson` signatures to accept an options object for signal.**

No — this is over-engineering. A simpler approach: change the internal implementation of `gh()` / `git()` to build a `RunCommandOptions` object with an optional `signal`, and have each function accept an optional `signal` parameter. But rest parameters can't be followed by other parameters.

**Practical solution**: Change `gh`, `git`, `ghJson` to use a single options parameter instead of a spread:

```typescript
interface GhOptions {
  args: string[];
  signal?: AbortSignal;
}

export async function gh(options: GhOptions): Promise<string>
```

This is a breaking API change for internal callers, but all callers are within this project. The test mocks for `runCommand` won't need changes since they mock at the `runCommand` level.

Actually, the simplest and least disruptive approach: make `signal` part of the `args` parsing. Since `AbortSignal` is a non-string, we can detect it:

```typescript
export async function gh(...argsAndSignal: [...string[], AbortSignal?]): Promise<string> {
```

But TypeScript doesn't support this pattern cleanly.

**Final decision (cleanest):** Keep `gh(...args: string[])` as-is and extract `signal` from the `RunCommandOptions` that are already being constructed internally. Instead of modifying the `gh` signature, **modify the internal call path so that lib functions that need to pass a signal call `runCommand` directly** or we pass it through an options parameter.

The cleanest minimal-impact approach is to make `gh`, `git`, and `ghJson` accept an **optional final `AbortSignal` parameter** by converting them from rest-parameter signatures to explicit arrays:

```typescript
export async function gh(args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand({
    cmd: "gh",
    args,
    signal,
  });
  // ...
}
```

This IS a breaking change to `gh()`'s call sites — but all call sites are internal and easily updated. Tests mock `runCommand`, not `gh`, so test impact is minimal.

**Chosen approach**: Convert `gh()`, `git()`, `ghJson()` from `...args: string[]` to `(args: string[], signal?: AbortSignal)`. Update all internal call sites. This is a `feat!:` change (breaking internal API), but since these are all internal module boundaries, it's safe and contained.

### Polling function abort handling

When `signal` is provided and aborts during a poll loop:

- **`sleep()`** rejects with an `AbortError`. The polling function catches this and returns a structured message (not an exception) indicating abort.
- **`ghJson()` / `gh()` / `git()`** calls will cause `runCommand()` to reject (child killed by signal). Polling functions should catch this and return a structured abort message.

The convention: polling functions (`findRun`, `watchRun`, `findReleasePR`, `watchRelease`) return a **string** on normal completion or timeout. On abort, they should also return a string (not throw), so the tool wrapper can return it as a normal `ok()` result. This is consistent with how timeouts are handled.

Example abort return:

```text
aborted: cancelled by user
  retries: 3
  elapsed: 45s
```

### Non-polling tools (`mergeReleasePR`, `closeIssue`, `listRuns`)

These use `gh()`/`git()`/`ghJson()` for a single call. When the signal fires, `runCommand()` kills the subprocess, which causes the `gh()`/`git()` call to reject with an error. The tool wrapper's `catch` block already converts this to an `err()` result. No special handling needed — signal forwarding to `runCommand` is sufficient.

### `mergeReleasePR` returns `ToolResult`

This function already returns `{ content, isError }`. On abort, the subprocess reject will propagate to the tool wrapper's `catch`, which returns `err(…)`. No structural change needed.

## Module-Level Changes

### `src/lib/process.ts`

- Add optional `signal?: AbortSignal` parameter to `sleep()`.
- Implement abort-aware logic: check `signal.aborted` upfront, register `addEventListener("abort", …)`, `clearTimeout` on abort.

### `src/lib/github.ts`

- Change `gh()` signature from `(...args: string[])` to `(args: string[], signal?: AbortSignal)`.
- Change `git()` signature from `(...args: string[])` to `(args: string[], signal?: AbortSignal)`.
- Change `ghJson()` signature from `<T>(...args: string[])` to `<T>(args: string[], signal?: AbortSignal)`.
- Thread `signal` into the `runCommand()` call in each function.
- Update `detectRepo()` internal calls to `ghJson()` and `git()` to pass `args` as array.

### `src/lib/ci.ts`

- Add `signal?: AbortSignal` to `FindRunArgs` and `WatchRunArgs`.
- In `findRun`: thread `signal` to `sleep()` and `ghJson()` calls. Catch abort (AbortError or signal.aborted check) and return a structured abort message.
- In `watchRun`: thread `signal` to `sleep()` and `ghJson()` calls. Catch abort and return structured abort message.
- `listRuns` and `ListRunsArgs` — no changes needed (single-shot, no polling).

### `src/lib/release.ts`

- Add `signal?: AbortSignal` to `FindReleasePRArgs`, `WatchReleaseArgs`, and `MergeReleasePRArgs`.
- In `findReleasePR`: thread `signal` to `sleep()` and `ghJson()`. Catch abort, return structured abort message.
- In `watchRelease`: thread `signal` to `sleep()`, `git()`, `gh()`. Catch abort, return structured abort message.
- In `mergeReleasePR`: thread `signal` to `gh()` and `git()` calls.
- Export `MergeMethod` is unchanged.

### `src/lib/issue.ts`

- Add `signal?: AbortSignal` to `CloseIssueArgs`.
- In `closeIssue`: thread `signal` to `gh()` call.

### `src/progress.ts`

- No changes. The `onProgress` callback is already a plain `(line: string) => void` — no signal involvement.

### `src/tools/ci-find.ts`

- Rename `_signal` → `signal` in `execute()`. Pass `signal` to `findRun` args.

### `src/tools/ci-watch.ts`

- Rename `_signal` → `signal`. Pass `signal` to `watchRun` args.

### `src/tools/ci-list.ts`

- No changes. YAGNI — `listRuns` is single-shot.

### `src/tools/release-pr-find.ts`

- Rename `_signal` → `signal`. Pass `signal` to `findReleasePR` args.

### `src/tools/release-watch.ts`

- Rename `_signal` → `signal`. Pass `signal` to `watchRelease` args.

### `src/tools/release-pr-merge.ts`

- Rename `_signal` → `signal`. Pass `signal` to `mergeReleasePR` args.

### `src/tools/issue-close.ts`

- Rename `_signal` → `signal`. Pass `signal` to `closeIssue` args.

### `tests/lib/process.test.ts`

- Add tests for `sleep()` with abort: signal already aborted, signal aborts mid-sleep, signal not provided (backward compat).

### `tests/lib/github.test.ts`

- Update all `gh()`, `git()`, `ghJson()` calls to use `args: string[]` format.
- Add tests verifying `signal` is forwarded to `runCommand()`.

### `tests/lib/ci.test.ts`

- Update `mockGhJson()` call sites to use array args format for `runCommand` internals.
- Add tests for abort during `findRun` and `watchRun` — verify they return structured abort messages.
- Add tests verifying `signal` is threaded to `sleep()` and `ghJson()`.

### `tests/lib/release.test.ts`

- Update call sites for `gh`/`git` array-args format.
- Add tests for abort during `findReleasePR` and `watchRelease`.
- Add tests verifying `signal` is threaded in `mergeReleasePR`.

### `tests/lib/issue.test.ts`

- Update `closeIssue` call sites.
- Add test verifying `signal` is forwarded to `gh()`.

## Test Impact Analysis

### New unit tests enabled by this change

1. **`sleep()` abort tests** — previously impossible because `sleep()` had no signal parameter. Now we can test: immediate abort, abort mid-sleep, no-signal backward compat, cleanup of listeners.
1. **Polling abort propagation** — we can now write focused tests that verify `findRun`/`watchRun`/`findReleasePR`/`watchRelease` catch abort and return structured messages, without needing time-based integration tests.
1. **`gh()`/`git()` signal forwarding** — we can verify that an `AbortSignal` passed to `gh()` reaches `runCommand()`.

### Existing tests that need updating

1. **`tests/lib/github.test.ts`** — every `gh()`, `git()`, `ghJson()` call changes from spread to array syntax. The assertions on `mockRunCommand` calls also change from `{ cmd: "gh", args: ["run", "list"] }` to include `signal: undefined`.
1. **`tests/lib/ci.test.ts`** — `mockGhJson()` uses `runCommand`, which is already mocked. Call sites for `ghJson` internals change to array args. The `mockRunCommand` assertions for `ghJson` calls need updating.
1. **`tests/lib/release.test.ts`** — same as ci.test.ts; `mockRunCommand` assertions need updating for the new `gh`/`git` array-args and `signal` parameter.

### Existing tests that stay as-is

- `tests/lib/config.test.ts` — no `gh`/`git`/`sleep` dependencies.
- `tests/lib/process.test.ts` (existing `runCommand` and `sleep` tests) — backward compat is preserved; the new signal parameter is optional.

## TDD Order

### Step 1: `sleep()` abort support

**Red**: Write tests for `sleep(ms, signal)` in `tests/lib/process.test.ts`:

- Already-aborted signal rejects immediately with `AbortError`.
- Signal aborts mid-sleep — rejects with `AbortError`, timer is cleaned up.
- No signal — resolves after `ms` (existing test, ensure it still passes).
- After abort, the `setTimeout` timer does not fire (use `vi.useFakeTimers` to verify `clearTimeout` was called).

**Green**: Implement `sleep(ms, signal?)` in `src/lib/process.ts`.

**Commit**: `feat: add abort-aware sleep() (#5)`

### Step 2: `gh()`/`git()`/`ghJson()` signal parameter

**Red**: Add tests in `tests/lib/github.test.ts` verifying `signal` is forwarded to `runCommand`. Update existing call-site assertions to match the new `(args, signal?)` parameter shape.

**Green**: Change signatures in `src/lib/github.ts` from `...args` to `(args, signal?)`. Update `detectRepo()` internal calls. Update all assertions in github.test.ts.

**Commit**: `feat!: gh/git/ghJson accept AbortSignal via args array (#5)`

This is a breaking change to the internal API of `gh()`, `git()`, `ghJson()`.

### Step 3: Update existing `ci.test.ts` and `release.test.ts` call sites for `gh`/`git` new signature

**Red/Green together**: Update test file call sites and `mockRunCommand` assertions. Since `mockRunCommand` is mocked, the `ghJson`/`gh`/`git` calls still work, but the `args` shape in `runCommand` calls changes. Verify all existing tests pass with the new signature.

**Commit**: `test: update ci/release test assertions for gh signal parameter (#5)`

### Step 4: Polling lib functions — add `signal` parameter and abort handling

**Red**: Add tests in `tests/lib/ci.test.ts` for abort in `findRun` and `watchRun`:

- `findRun` returns structured abort message when signal fires during sleep.
- `watchRun` returns structured abort message when signal fires during poll interval.
- Signal is threaded to `ghJson()` and `sleep()` in both functions.

Add tests in `tests/lib/release.test.ts` for abort in `findReleasePR` and `watchRelease`:

- `findReleasePR` returns structured abort message.
- `watchRelease` returns structured abort message.
- Signal is threaded to `ghJson()`, `git()`, and `sleep()`.

**Green**: Add `signal?: AbortSignal` to `FindRunArgs`, `WatchRunArgs`, `FindReleasePRArgs`, `WatchReleaseArgs`. Thread signal to `sleep()` and `ghJson()`/`gh()`/`git()` calls. Add abort detection: check `signal.aborted` at loop top, catch `AbortError` from `sleep()` and `runCommand()` rejections.

**Commit**: `feat: thread AbortSignal through polling functions (#5)`

### Step 5: Non-polling lib functions — add `signal` parameter

**Red**: Add test in `tests/lib/release.test.ts` verifying `mergeReleasePR` threads signal to `gh()` and `git()`. Add test in `tests/lib/issue.test.ts` verifying `closeIssue` threads signal to `gh()`.

**Green**: Add `signal?: AbortSignal` to `MergeReleasePRArgs` and `CloseIssueArgs`. Thread signal to `gh()`/`git()` calls.

**Commit**: `feat: thread AbortSignal through mergeReleasePR and closeIssue (#5)`

### Step 6: Tool wrappers — forward `signal`

**Red**: No new tests needed (tool wrappers are thin and tested lightly per AGENTS.md).

**Green**: In each tool wrapper (`ci-find.ts`, `ci-watch.ts`, `release-pr-find.ts`, `release-watch.ts`, `release-pr-merge.ts`, `issue-close.ts`), rename `_signal` → `signal` and pass it to the lib function's args object. Leave `ci-list.ts` unchanged (no polling, no signal forwarding needed yet).

**Commit**: `feat: forward AbortSignal from tool wrappers to lib functions (#5)`

### Step 7: Type-check and full test suite

**Green**: Run `pnpm run build` and `pnpm vitest run` to verify everything compiles and passes.

**Commit**: (already included in Step 6; only a separate commit if type fixes are needed)

## Risks and Mitigations

| Risk                                                                                                                 | Mitigation                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking change to `gh()`/`git()`/`ghJson()` signatures affects all internal call sites                              | All call sites are internal; update them all in Step 2/3. No external consumers.                                                                                                                        |
| `AbortSignal` listener leak in `sleep()` if promise resolves normally before abort                                   | `addEventListener("abort", …, { once: true })` + `clearTimeout` in both resolve and abort paths ensure cleanup.                                                                                         |
| `sleep()` rejects with `AbortError` during a poll loop — polling function must catch and return a message, not throw | All polling functions wrap `await sleep()` in try/catch, checking for `AbortError` / `signal.aborted` to return a structured string.                                                                    |
| `ghJson()` / `git()` calls reject when subprocess is killed by signal — must propagate gracefully                    | `runCommand()` already rejects on `child.on("error")`. The polling `catch` block checks for abort and returns a message. For non-polling tools, the tool wrapper's `catch` already converts to `err()`. |
| Test complexity from fake timers for abort                                                                           | Use `vi.useFakeTimers()` only in `sleep()` abort tests (Step 1). Polling tests use mocked `sleep()` that rejects on demand, avoiding timer complexity.                                                  |

## Open Questions

- Should `ci_list` also accept `signal` for consistency? **Deferred** — single-shot call; can add later if needed.
- Should `mergeReleasePR` abort handling differ from simple signal forwarding (e.g., Git lock cleanup)? **Deferred** — let the subprocess be killed and let Git handle its own cleanup; `runCommand()` already handles signal-propagated kills.
