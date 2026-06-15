---
issue: 389
issue_title: "pi-colgrep always starts indexing on startup"
---

# Background, disable-able startup indexing for pi-colgrep

## Problem Statement

pi-colgrep indexes on `session_start` by calling `await reindexer.runNow()`, which runs `colgrep init -y .`.
Because Pi awaits `session_start` handlers, this blocks startup until indexing completes.
In a directory with many files — not necessarily code the operator ever intends to search semantically — the index build delays full startup and access to other extensions.

The external contributor (graelo) asks for a setting or a default change so indexing does not always run eagerly on startup.
They suggest trigger rules (in a git repo, well-known directories, only on first colgrep call) in a config file at `${PI_AGENT_DIR}/extensions/pi-colgrep/config.json`.

This is a third-party feature request, so the direction was confirmed with the operator before planning.
The agreed direction is **both**: kick the startup index off in the background (non-blocking) so it never delays startup, and make startup indexing disable-able via config — while closing the fire-and-forget concurrency gaps so we never double-index.

## Goals

- Run the startup index in the **background**: `session_start` kicks off the index without awaiting it, so Pi startup is not blocked.
- Make startup indexing **disable-able** via a `config.json` boolean `indexOnStartup`, read from a global and a project path (project overrides global), matching the sibling-package config convention.
- Default `indexOnStartup` to `true` — backward-compatible (eager indexing stays on, just non-blocking).
  This change is **not breaking**: the out-of-the-box default still indexes.
- Close the fire-and-forget safety gaps in the reindexer so a backgrounded `runNow()` is awaited by `shutdown()` and a concurrent `runNow()` (e.g. `/colgrep-reindex` mid-startup) coalesces instead of running a second `colgrep init`.
- Probe index existence **once** at `session_start` (via `colgrep status`) and gate the write/edit auto-reindex on it: when no index exists, skip the proactive reindex and warn **once per session**.
- Flip the gate when an index appears: `/colgrep-reindex` (or the backgrounded startup index) sets the session `indexExists` flag so subsequent write/edit reindexes resume.

## Non-Goals

- Git-repo or well-known-directory trigger heuristics (graelo's other suggestions).
  A single `indexOnStartup` boolean plus the index-existence gate covers the reported pain without a policy enum.
  Revisit if users ask for finer control.
- A config key to disable write/edit reindexing independently of index existence — the existence gate already suppresses proactive indexing in opted-out directories.
- Changing the colgrep CLI's own auto-index-on-search behavior — leaving it intact is what makes lazy indexing correct (a real `colgrep` search still builds/refreshes the index on demand).
- Customizable debounce or timeout config (already deferred in issue #91).
- Changing the `Reindexer` public interface (`schedule` / `runNow` / `shutdown` stay as-is).

## Background

### Current wiring (`src/extension.ts`)

`session_start`:

1. `await availability.refresh(exec)` — runs `colgrep --version` (fast).
2. If unavailable, notify and return.
3. Create the per-session `reindexer` (`createReindexer`).
4. `await reindexer.runNow()` — runs `colgrep init -y .` and **blocks** until done.

`tool_result` (successful `write`/`edit`): `reindexer?.schedule()` — debounced reindex.
`session_shutdown`: `await reindexer?.shutdown()`.
`/colgrep-reindex` command: `runNow()` on the session reindexer (or a one-shot).

### Reindexer (`src/lib/reindex.ts`)

A SDK-free factory with in-flight tracking and a queued follow-up:

- `runNow()` calls `runReindex()` directly.
  It does **not** assign `inflightPromise`, and it does **not** check `inFlight` — so a second `runNow()` while one is running starts a concurrent `colgrep init`, and `shutdown()` cannot await a backgrounded `runNow()` (it only awaits `inflightPromise`, which `runNow` never sets).
- `schedule()` debounces (4 s); while a run is in flight it sets a `queued` flag instead of starting a second run; the drain path assigns `inflightPromise = runReindex()`.
- `shutdown()` clears the debounce timer and awaits `inflightPromise`.

These two gaps (no `inflightPromise` for `runNow`, no concurrency guard) are exactly the "double-index because we fired and forget" race; they must be closed before backgrounding the startup index.

### colgrep CLI facts (verified empirically)

- `colgrep search` auto-indexes if the index is missing or stale — lazy indexing is already supported by the CLI.
- `colgrep status <path>` exits `0` whether or not an index exists; it has **no** `--json`.
  Non-indexed output contains the literal `No index found`.
  Indexed output is a `Project:` / `Model:` / `Index:` block.
  Index existence must therefore be parsed from stdout, not from the exit code.
- `colgrep init -y .` builds/updates the index (the reindex command, unchanged).

### Sibling config convention

`pi-github-tools` (`src/lib/config.ts`) and `pi-subagents-worktrees` (`src/config.ts`) both:

- Read a global file under `<agentDir>/extensions/<EXTENSION_ID>/config.json` and a project file under `<cwd>/.pi/extensions/<EXTENSION_ID>/config.json`.
- Merge project over global.
- Treat a missing file as silent `{}`; a malformed file warns to stderr and falls back.
- Get `agentDir` from `getAgentDir()` (exported by `@earendil-works/pi-coding-agent`).

The new config module mirrors this exactly with `EXTENSION_ID = "pi-colgrep"`, matching graelo's suggested path.

### AGENTS.md constraints

- `src/` library modules stay SDK-free and must not read `process.*`; `config.ts` and `index-status.ts` accept their inputs (paths, `exec`, stdout) as parameters.
  `getAgentDir()` is called in the SDK-consuming `session_start` handler, not inside a library function.
- `@typescript-eslint/require-await` is enabled for `src/`: the index-existence parse is a pure (non-async) function; only the thin exec wrapper is async.
- No `package-pi-colgrep` skill file exists, so there is no internal-docs skill to update.

## Design Overview

### Config module (`src/lib/config.ts`)

Pure, fs-at-the-edge, mirroring `pi-github-tools/src/lib/config.ts`:

```typescript
export const EXTENSION_ID = "pi-colgrep";

export interface ColGrepConfig {
  indexOnStartup: boolean;
}

export function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID, "config.json");
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json");
}

export function loadConfig(options: {
  globalConfigPath: string;
  projectConfigPath: string;
}): ColGrepConfig;
```

- `normalizeConfig(raw)` returns `Partial<ColGrepConfig>`, accepting `indexOnStartup` only when it is a boolean.
- `loadConfig` merges global then project and resolves the default: `indexOnStartup: merged.indexOnStartup ?? true`.
- Missing file → silent `{}`; malformed JSON → `console.warn("[pi-colgrep] Ignoring malformed config at <path>: <reason>")` then `{}`.

### Index-existence probe (`src/lib/index-status.ts`)

Pure parse plus a thin async wrapper:

```typescript
/** True unless colgrep status reports no index for the project. */
export function indexExistsFromStatus(stdout: string): boolean {
  return !stdout.includes("No index found");
}

export async function checkIndexExists(exec: Exec, cwd: string): Promise<boolean> {
  try {
    const result = await exec("colgrep", ["status", cwd, "--color", "never"], {
      cwd,
      timeout: 5000,
    });
    if (result.code !== 0) return false;
    return indexExistsFromStatus(result.stdout);
  } catch {
    return false;
  }
}
```

Negative detection (`No index found`) is the documented, stable signal; on any exec failure we degrade to `false` (treat as "no index", which only suppresses proactive reindexing — a real search still auto-indexes).

### Reindexer hardening (`src/lib/reindex.ts`)

Interface unchanged.
Internals:

- Extract a `startRun()` that coalesces: if a run is in flight, return the existing `inflightPromise`; otherwise assign `inflightPromise = runReindex()` and return it.
- `runNow()` becomes `return startRun()` — so a backgrounded (un-awaited) `runNow()` is tracked in `inflightPromise`, and a concurrent `runNow()` (e.g. `/colgrep-reindex` during the startup index) coalesces onto the in-flight run instead of launching a second `colgrep init`.
- `runReindex()` already clears `inflightPromise = undefined` and `inFlight = false` on completion, and the drain path already reassigns `inflightPromise`; `shutdown()` already awaits `inflightPromise`, so it now correctly waits for a backgrounded startup index.

Because `runReindex()` sets `inFlight = true` synchronously before its first `await`, the coalescing check is race-free: by the time `startRun()` assigns `inflightPromise`, `inFlight` is already observable to a second synchronous caller.

### Extension wiring (`src/extension.ts`)

Session-scoped closure state, reset at the top of each `session_start`:

```typescript
let reindexer: Reindexer | undefined;
let indexExists = false;
let skipWarned = false;
```

`session_start`:

1. `await availability.refresh(exec)`; if unavailable, notify and return (unchanged).
2. `const config = loadConfig({ globalConfigPath: getGlobalConfigPath(getAgentDir()), projectConfigPath: getProjectConfigPath(ctx.cwd) });`
3. Create the `reindexer` (as today); reset `skipWarned = false`.
4. `indexExists = await checkIndexExists(exec, ctx.cwd);` (fast — reads index metadata, does not scan files).
5. If `config.indexOnStartup`: call `reindexer.runNow()` **without `await`** (fire-and-forget) and set `indexExists = true` (we are building one).
   If `!config.indexOnStartup`: leave `indexExists` as the probe result.

`tool_result` (successful `write`/`edit`):

```typescript
if (event.isError) return;
if (event.toolName !== "write" && event.toolName !== "edit") return;
if (!indexExists) {
  if (!skipWarned) {
    skipWarned = true;
    ctx.ui.notify(
      "colgrep: skipping auto-reindex — no index for this directory. " +
        "Run /colgrep-reindex to build one.",
      "info",
    );
  }
  return;
}
reindexer?.schedule();
```

The skip warning fires at most once per session (`skipWarned`), so editing many files in an opted-out directory is quiet after the first notice.

`/colgrep-reindex` command: on a successful `runNow()`, set `indexExists = true` (flip the gate) so subsequent write/edit reindexes resume.
This is the "flip the setting if the user manually reindexes" behavior — and `/colgrep-reindex` is the index-building command the operator asked about.

`session_shutdown`: `await reindexer?.shutdown()` (unchanged) — now also awaits a backgrounded startup index thanks to the reindexer hardening.

### Non-blocking startup, concretely

`session_start` still `await`s two fast probes (`colgrep --version`, `colgrep status`), but no longer awaits `colgrep init`.
Calling `runNow()` synchronously runs `runReindex()` up to its first `await exec(...)` — so the `colgrep init` exec is launched, `inFlight`/`inflightPromise` are set, and the handler then returns immediately while the build runs in the background.

### Design-review notes

- The `Reindexer` interface gains no fields; the change is internal.
- `loadConfig` takes a 2-field options bag, both used.
- `indexExists` / `skipWarned` are extension-owned closure state, not output arguments written into an injected dependency.
- No Law-of-Demeter chains or parameter relays are introduced.

No structural smells; all changes are inline in this plan's scope.

## Module-Level Changes

### New files

1. `src/lib/config.ts` — `EXTENSION_ID`, `ColGrepConfig`, `getGlobalConfigPath`, `getProjectConfigPath`, `normalizeConfig`, `loadConfig`.
2. `src/lib/index-status.ts` — `indexExistsFromStatus` (pure) and `checkIndexExists` (async wrapper).
3. `test/lib/config.test.ts` — config loader unit tests (temp files).
4. `test/lib/index-status.test.ts` — parse + wrapper unit tests (mocked `exec`).

### Modified files

1. `src/lib/reindex.ts` — extract `startRun()`, make `runNow()` coalesce and track `inflightPromise`.
   No interface change.
2. `test/lib/reindex.test.ts` — add cases for `runNow()` coalescing and `shutdown()` awaiting a backgrounded `runNow()`.
3. `src/extension.ts` — load config, probe index existence, background-fire the startup index when `indexOnStartup`, gate write/edit reindex on `indexExists` with a one-time skip warning, flip `indexExists` on manual reindex.
4. `test/extension.test.ts` — update existing `session_start` tests for non-blocking behavior; add config-gating, probe, skip-warning, and flip-on-manual-reindex tests.
5. `README.md` — document the `indexOnStartup` config (paths, default `true`, behavior, `/colgrep-reindex`).

No `docs/architecture/` files exist in this package, and no `package-pi-colgrep` skill file exists, so neither needs updating.
No `release-please-config.json` change (no new package or docs subdir).

## Test Impact Analysis

1. New lower-level tests this enables:
   - `config.ts` is a pure loader — fully unit-testable with temp files (missing, malformed, explicit `false`, project-over-global, non-boolean rejected, default `true`).
   - `indexExistsFromStatus` is a pure string parse — testable against the real `No index found` and `Project:`/`Index:` fixtures captured from the CLI.
   - `checkIndexExists` degradation (non-zero exit, thrown exec) is testable with a mocked `exec`.
   - Reindexer coalescing and shutdown-tracking are testable with the existing fake-timer harness.
2. Existing tests that change (not removed):
   - The `session_start` tests in `test/extension.test.ts` currently `await` the handler and assert the status is cleared after.
     With non-blocking startup the handler resolves before `colgrep init` finishes, so these tests must `await` the backgrounded run's completion (drain the reindexer) before asserting the cleared status.
     They still validate that startup indexing runs — now asserting it is non-blocking.
3. Tests that stay as-is:
   - All search-path tests (`test/tools/colgrep.test.ts`, `test/lib/{args,format,search}.test.ts`) — orthogonal to indexing.
   - `availability.test.ts` — unchanged.
   - The existing `tool_result` / `/colgrep-reindex` / `session_shutdown` tests stay, extended (not replaced) for gating and flip-on-reindex.

## TDD Order

### Cycle 1 — config loader

1. RED: `test/lib/config.test.ts` — missing file → `{ indexOnStartup: true }`; explicit `false` honored; non-boolean `indexOnStartup` ignored (default `true`); malformed JSON warns and defaults; project overrides global; path builders produce the expected global/project paths.
2. GREEN: `src/lib/config.ts`.

- Commit: `feat: add colgrep config loader with indexOnStartup (#389)`

### Cycle 2 — index-existence probe

1. RED: `test/lib/index-status.test.ts` — `indexExistsFromStatus` returns `false` for the `No index found` fixture and `true` for the `Project:`/`Index:` fixture; `checkIndexExists` returns `false` on non-zero exit and on a thrown exec, `true` on indexed stdout.
2. GREEN: `src/lib/index-status.ts`.

- Commit: `feat: add colgrep index-existence probe (#389)`

### Cycle 3 — reindexer hardening

1. RED: `test/lib/reindex.test.ts` — two concurrent `runNow()` calls run `colgrep init` only once (coalesced) and both resolve when it finishes; `shutdown()` awaits a backgrounded (un-awaited) `runNow()` before resolving.
2. GREEN: extract `startRun()` in `src/lib/reindex.ts`; `runNow()` coalesces and tracks `inflightPromise`.
   Verify existing reindex tests still pass.

- Commit: `feat: coalesce concurrent reindex runs and track in-flight promise (#389)`

### Cycle 4 — extension: background, config-gated startup index

1. RED: `test/extension.test.ts` — with `indexOnStartup` true (mock `#src/lib/config`), `session_start` launches `colgrep init` (exec called) and the handler resolves without waiting for it to finish (non-blocking); with `indexOnStartup` false, no `colgrep init` runs on startup; the index-existence probe (`colgrep status`) runs once.
   Update the existing `session_start` status-clearing assertions to drain the backgrounded run first.
2. GREEN: in `src/extension.ts`, load config via `getAgentDir()` + `ctx.cwd`, create the reindexer, probe `indexExists`, and fire-and-forget `runNow()` gated on `indexOnStartup`.

- Commit: `feat: run startup index in background, gated by indexOnStartup (#389)`

### Cycle 5 — extension: gate write/edit reindex + warn-once + flip on manual reindex

1. RED: `test/extension.test.ts` — when `indexExists` is true, a successful `write`/`edit` schedules a reindex; when false, it skips and notifies exactly once (a second skip does not re-notify); after `/colgrep-reindex` succeeds, a subsequent `write`/`edit` schedules a reindex (gate flipped); `session_shutdown` awaits the backgrounded startup index.
2. GREEN: add the `indexExists` / `skipWarned` gating in the `tool_result` handler and the flip in the `/colgrep-reindex` handler.
   Run `pnpm -C packages/pi-colgrep run check`, `lint`, and `test`.

- Commit: `feat: gate write/edit reindex on existing index with one-time skip warning (#389)`

### Cycle 6 — docs

1. GREEN (docs-only): update `README.md` with a "Configuration" section documenting `indexOnStartup` (default `true`, non-blocking background index), the global/project `config.json` paths, the index-existence gate behavior, and `/colgrep-reindex` as the manual index command.

- Commit: `docs: document colgrep indexOnStartup configuration (#389)`

## Risks and Mitigations

| Risk                                                                       | Mitigation                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `colgrep status` output format changes across versions, breaking the parse | Parse the stable negative signal `No index found`; on any exec failure degrade to `false` (only suppresses proactive reindex — a real search still auto-indexes). One-line fix if the string changes. |
| First search races an in-flight backgrounded startup index                 | The colgrep CLI serializes its own index access and auto-indexes on search; the reindexer coalescing prevents a second concurrent `colgrep init`.                                                     |
| Backgrounded `runNow()` produces an unhandled rejection                    | `runNow()`/`runReindex()` resolve on failure (errors logged internally), never reject — safe to leave un-awaited.                                                                                     |
| Skip warning becomes noisy across many edits                               | `skipWarned` limits it to one `info` notice per session.                                                                                                                                              |
| Existing `session_start` tests assume blocking completion                  | Cycle 4 updates them to drain the backgrounded run before asserting cleared status.                                                                                                                   |
| `getAgentDir()` reads global state, hurting testability                    | It is called only in the SDK-consuming `session_start` handler; `config.ts` stays pure (paths injected). Extension tests mock `#src/lib/config`.                                                      |

## Open Questions

- Should a future config add finer trigger policy (git-only, allow/deny dir lists)?
  Deferred — the boolean plus existence gate resolves the reported pain; revisit on demand.
- Should `indexExists` be re-probed mid-session (e.g. after a `colgrep clear`)?
  Out of scope — `/colgrep-reindex` and a real search both re-establish the index; the gate only suppresses proactive work.
