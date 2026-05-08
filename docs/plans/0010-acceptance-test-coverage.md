---
issue: 10
issue_title: "Expand acceptance test coverage with end-to-end pi CLI scenarios"
---

# Plan: Expand acceptance test coverage (Issue #10)

## Problem Statement

`test/acceptance.test.ts` spawns the real `pi` CLI in `--mode rpc`, loads the extension, and verifies a single `get_state` round-trip.
That smoke test catches load-time regressions (entrypoint shape, module resolution, `session_start` failures) without burning LLM credits, but it never drives a `tool_result` event end to end.
Issue #10 asks us to expand acceptance coverage so we also catch payload-shape drift, custom-tool dispatch regressions, EventBus channel regressions, and prompt-end batching regressions against the real Pi runtime — while keeping `pnpm test` deterministic, offline, and skippable for contributors without `pi` installed.

## Goals

- Add deterministic, non-LLM acceptance tests that exercise the formatter pipeline through the real `pi` CLI (RPC mode), covering at minimum:
  - the `bash` mutation path (snapshot tracker + shell mutation detector) driven by `{"type": "bash", ...}` RPC commands;
  - the `pi.events`-based `autoformat:touched` channel via a small companion extension loaded alongside ours;
  - the `customMutationTools` declarative path via a companion extension that registers a synthetic mutation tool and triggers it through an extension command (`/cmd`).
- Reuse the existing skip-when-`pi`-is-absent pattern so `pnpm test` stays green for contributors without Pi installed.
- Keep each acceptance test isolated to its own `cwd` and config, with no shared state between tests.
- Document an opt-in, env-gated path (`PI_AUTOFORMAT_LLM_TESTS=1`) for occasional LLM-backed scenarios — design only, no LLM calls in default CI.
- Resolve the `pi` binary from the locally-installed `@earendil-works/pi-coding-agent` devDependency rather than the global `PATH`, so the acceptance suite runs in CI under the existing `pnpm install --frozen-lockfile` step with no workflow changes.

## Non-Goals

- Running LLM-backed scenarios on every `pnpm test` invocation.
  These remain opt-in behind `PI_AUTOFORMAT_LLM_TESTS=1`; default CI must not require API keys.
- Adding new product features.
  This is a test-coverage change; the only production code touched would be small fixes to anything the new tests expose.
- Replacing the existing unit / integration tests.
  Acceptance tests are additive; they pin behavior at the Pi-runtime boundary, not inside our modules.
- Building a generic Pi-extension test harness.
  The fixtures live under `test/fixtures/` and exist solely to drive the autoformatter pipeline.
- Hardening Pi's RPC protocol or filing upstream requests beyond what this plan needs.

## Background

Relevant existing surface:

- `test/acceptance.test.ts` — current smoke test.
  Spawns `pi --mode rpc --no-tools --no-extensions --no-session -e <EXTENSION_PATH>`, writes JSON commands to stdin, parses JSON-per-line responses from stdout.
  Today it relies on `pi` being on `PATH` and skips when `spawnSync("pi", ["--help"]).status !== 0`; the new harness will resolve `pi` from `node_modules/.bin/pi` so the test runs whenever `pnpm install` has been done.
- `src/extension.ts` — `createAutoformatExtension` wires three real touched-file sources: built-in `write`/`edit` `tool_result` events, `customMutationTools` declared in config, and `pi.events.on(channel, …)` for the `autoformat:touched` (configurable) channel.
- `src/shell-mutation-detector.ts` — drives `bash` snapshot tracking (`SnapshotTracker`) plus argument parsing and wrapper matching for known mutation commands. The `bash` RPC command sends a real `tool_call` + `tool_result` pair through Pi.
- `src/custom-mutation-tools.ts` — `parseTouchedPayload` and `createCustomToolHandlers` accept either a `{ touched: string[] }` payload (event-bus path) or extract paths from configured custom tools.
- `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` — confirms RPC supports `prompt`, `bash`, `get_state`, and that `prompt` accepts extension commands (`/mycommand`) which execute immediately even without an LLM provider configured.
- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — confirms `pi.registerCommand(name, { handler })` lets a companion extension expose a slash command we can trigger over RPC.

Implications:

- Pi's RPC mode does not document a way to inject synthetic `tool_result` events directly.
  We therefore drive real events via two channels Pi already provides: the `bash` RPC command (real `bash` `tool_result`) and `prompt` with a slash command (lets a companion extension synthesize side effects).
- A companion extension is the cleanest way to exercise both `customMutationTools` and the `autoformat:touched` event-bus channel without an LLM.
- Multiple `-e` flags are supported (per `extensions.md`), so we can load `src/extension.ts` and a fixture extension in the same RPC session.

## Design Overview

### Test fixtures

Place small companion extensions under `test/fixtures/` so the production package never imports them:

```text
test/fixtures/
  event-bus-emitter.ts        # registers /emit-touched, calls pi.events.emit("autoformat:touched", { touched })
  custom-tool-emitter.ts      # registers a synthetic mutation tool + /trigger-custom-tool slash command
  formatter-recorder.sh       # POSIX shell script used as the formatter "command" so we can assert invocation
```

`formatter-recorder.sh` writes its argv plus `cwd` to a file the test can read after the flush.
Using a real on-disk recorder keeps the test independent of mocking — it asserts what Pi actually invoked.

### Shared RPC harness

Extract the `runRpcSession(...)` helper currently inline in `test/acceptance.test.ts` into `test/helpers/rpc.ts` so all acceptance tests share one implementation.
The helper accepts an optional `extraExtensions: string[]` so each test can load its companion fixture alongside `src/extension.ts`.

```typescript
// test/helpers/rpc.ts
export type RpcResponse = {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  data?: unknown;
};

export type RpcEvent = { type: string; [key: string]: unknown };

export async function runRpcSession(options: {
  cwd: string;
  commands: object[];
  extraExtensions?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  responses: RpcResponse[];
  events: RpcEvent[];
  stderr: string;
  exitCode: number | null;
}>;
```

### Per-test scaffolding

Each acceptance test creates its own temp `cwd`, writes:

- `.pi/extensions/pi-autoformat/config.json` configuring formatters whose `command` points at `formatter-recorder.sh` (or a small Node runner script copied next to the temp dir);
- one or more files matching the chain extensions, so the formatter actually has something to run on.

After the RPC session closes, the test reads the recorder log and asserts:

- which formatter command ran;
- which absolute paths were passed in argv;
- per-test invariants (e.g. the snapshot tracker only emitted files that actually changed during the bash command).

### Scenarios

1. `bash` shell-mutation acceptance.
   - `commands: [{type: "bash", command: "node -e 'fs.writeFileSync(\"out.ts\", ...)'"}]` followed by an explicit `agent_end` trigger (we already flush on `agent_end`; for the bash-only scenario we trigger the prompt-end flush by sending a `prompt` with a no-op slash command provided by a tiny "flush trigger" fixture, or by closing stdin and asserting the `session_shutdown` flush — pick whichever is more deterministic during TDD).
   - Asserts the recorder ran on `out.ts` exactly once.

2. `customMutationTools` acceptance.
   - Loads `custom-tool-emitter.ts` via `-e`. The companion registers a tool whose name is also listed in `customMutationTools` config; the slash command `/trigger-custom-tool` calls `pi.sendMessage()`-style hooks that produce a real `tool_result` for that tool with a `{touched: [...]}` payload.
   - If we cannot trigger a real registered tool without an LLM, fall back to a slash command that emits the synthetic `tool_result` via a documented hook; if no such hook exists, drop this scenario into Open Questions and rely on the EventBus path for v1.
   - Asserts the recorder ran on the declared file.

3. `autoformat:touched` EventBus acceptance.
   - Loads `event-bus-emitter.ts` via `-e`. Slash command `/emit-touched <path>` calls `pi.events.emit("autoformat:touched", { touched: [absolutePath] })`.
   - Test sends `{type: "prompt", message: "/emit-touched out.ts"}`, then triggers a flush as in (1).
   - Asserts the recorder ran on `out.ts`.

4. LLM-gated scenario (design only; not implemented in this plan unless trivial).
   - Skipped unless `process.env.PI_AUTOFORMAT_LLM_TESTS === "1"` and a provider env var is present.
   - Sends a real `prompt` and asserts the recorder ran on the file the agent edited.
   - Documented in `docs/testing.md` (new), not enabled in CI.

### Resolving the `pi` binary

`@earendil-works/pi-coding-agent` is already a devDependency and ships a `pi` bin, so `pnpm install` produces a working `node_modules/.bin/pi`.
The new harness resolves that path explicitly instead of relying on the global `PATH`:

```typescript
// test/helpers/rpc.ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const PI_BIN = resolve("node_modules/.bin/pi");
export const piAvailable = existsSync(PI_BIN);
```

Benefits:

- CI runs the acceptance suite with no workflow changes — `pnpm install --frozen-lockfile` already provides `pi`.
- The Pi version is pinned by `pnpm-lock.yaml`, so CI and local runs use the same binary.
- Contributors who ran `pnpm install` immediately get the acceptance suite; no separate global install.

### Skip semantics

`describeIfPi` becomes a safety net rather than the default contributor experience: it skips only when `node_modules/.bin/pi` is missing (e.g. someone forgot `pnpm install`).
LLM-gated scenarios add a second guard on `PI_AUTOFORMAT_LLM_TESTS` and the relevant API key.

## Module-Level Changes

- `test/helpers/rpc.ts` — new. Extracted RPC harness. Adds `extraExtensions`, `env`, and event/response separation.
- `test/acceptance.test.ts` — updated to import from `test/helpers/rpc.ts`. Behavior unchanged.
- `test/acceptance-bash-mutation.test.ts` — new. Scenario (1).
- `test/acceptance-event-bus.test.ts` — new. Scenario (3).
- `test/acceptance-custom-tool.test.ts` — new. Scenario (2). May be deferred if the no-LLM trigger turns out infeasible (see Open Questions).
- `test/fixtures/event-bus-emitter.ts` — new companion extension.
- `test/fixtures/custom-tool-emitter.ts` — new companion extension.
- `test/fixtures/formatter-recorder.sh` — new helper script (executable, POSIX `sh`).
- `docs/testing.md` — new. Documents acceptance-test layout, the `node_modules/.bin/pi` resolution behavior, skip semantics, and the env-gated `PI_AUTOFORMAT_LLM_TESTS` design.
- `README.md` — small "Testing" pointer to `docs/testing.md`.

No `.github/workflows/*.yml` change is needed: the existing `pnpm install --frozen-lockfile` step already provides `pi` via the devDependency.

No production source under `src/` is expected to change.
If the new tests expose a real bug, that bug is fixed in its own commit on the same branch.

## TDD Order

1. **Refactor the RPC harness (red → green).**
   Move `runRpcSession` into `test/helpers/rpc.ts`; add `extraExtensions` and an `events` array in the result.
   Resolve `PI_BIN` from `node_modules/.bin/pi` and key `piAvailable` off `existsSync(PI_BIN)` instead of `spawnSync("pi", ["--help"])`.
   Update `test/acceptance.test.ts` to use the new harness; the existing test must still pass.
   Commit: `test: extract shared rpc harness and resolve pi from node_modules`.

2. **Bash mutation acceptance (red → green).**
   Add `test/fixtures/formatter-recorder.sh`. Add `test/acceptance-bash-mutation.test.ts` that writes a project config pointing at the recorder, sends a `bash` RPC command that creates `out.ts`, triggers a flush, and asserts the recorder log.
   Commit: `test: add acceptance coverage for bash-driven mutation flush`.

3. **EventBus channel acceptance (red → green).**
   Add `test/fixtures/event-bus-emitter.ts` and `test/acceptance-event-bus.test.ts`. Drive `/emit-touched` via `prompt`, trigger a flush, assert.
   Commit: `test: add acceptance coverage for autoformat:touched event bus`.

4. **Custom-tool acceptance (red → green) — conditional.**
   Add `test/fixtures/custom-tool-emitter.ts` and `test/acceptance-custom-tool.test.ts`. If the no-LLM trigger path proves infeasible during TDD, capture the finding in Open Questions and skip this cycle.
   Commit: `test: add acceptance coverage for customMutationTools dispatch`.

5. **Documentation (green → docs).**
   Add `docs/testing.md` describing the `node_modules/.bin/pi` resolution, skip semantics, and the env-gated LLM scenario design.
   Update `README.md` to point at it.
   Commit: `docs: document acceptance-test layout and pi binary resolution`.

## Risks and Mitigations

- **RPC has no synthetic-tool-result injection.**
  Mitigation: drive real events via `bash` RPC and slash-command-emitted EventBus events.
  The custom-tool scenario degrades gracefully: if no non-LLM trigger exists, mark it deferred and rely on the EventBus path until an LLM-gated test fills the gap.

- **Spawning `pi` is slow and platform-sensitive.**
  Mitigation: keep per-test timeout generous (10 s default, configurable per test), parallelize sparingly (Vitest runs files in parallel — these tests get their own files for `cwd` isolation), and continue skipping when `pi` is absent.

- **Formatter recorder script is not portable to Windows.**
  Mitigation: use a tiny Node script (`formatter-recorder.mjs`) instead of `.sh` if Windows support matters.
  Default plan picks the script flavor that matches the maintainer's CI; fallback is documented in `docs/testing.md`.

- **Companion extensions drift from Pi's API.**
  Mitigation: keep them tiny (≤ 30 lines each), import from the same `@earendil-works/pi-coding-agent` types the production extension uses, and exercise them in CI so any drift fails fast.

- **Snapshot tracker false negatives.**
  The `bash` scenario depends on the snapshot tracker's globs matching the test file.
  Mitigation: explicitly configure `shellMutationDetection.snapshotGlobs` in the project config the test writes, so the test pins the configured contract rather than the default.

## Open Questions

- Should `formatter-recorder` be a POSIX shell script or a Node script?
  Resolved during execution: chose `formatter-recorder.mjs` (Node) for portability.

## Execution Notes

- Step 2 (bash mutation acceptance) and step 4 (`customMutationTools` acceptance) were **deferred** during execution.
  Empirical probing (and Pi's `docs/rpc.md`) confirmed that the RPC `bash` command does not emit `tool_call` / `tool_result` events; it only stores a `BashExecutionMessage` for the next prompt's LLM context.
  Likewise, slash commands run extension code directly without going through tool dispatch, so a fixture extension cannot synthesize a `tool_result` event for a registered custom tool.
  Both scenarios therefore require a real LLM-driven tool invocation and have been moved into the future LLM-gated suite documented in `docs/testing.md`.
- The plan's example payload `{ touched: string[] }` for the EventBus channel was incorrect.
  The real contract handled by `parseTouchedPayload` is `{ path: string }` or `{ paths: string[] }`; the fixture and test now use `{ paths }`.
- macOS resolves `/var` to `/private/var` via realpath.
  The acceptance test calls `realpathSync` on its temp `cwd` so assertions on the recorder's `process.cwd()` match what Pi spawns the formatter with.
