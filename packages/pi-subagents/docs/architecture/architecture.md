# Architecture

This document describes the planned decomposition of the pi-subagents fork into a focused, composable core with a stable API boundary that other extensions can build on.

## Design principles

1. **Narrow core** — the extension owns agent spawning, execution, and result retrieval.
   Everything else is a consumer.
2. **Composable by default** — other extensions can spawn agents, observe their lifecycle, and display their state without importing this package directly.
3. **Typed API boundary** — this package exports a `SubagentsService` interface and `Symbol.for()` accessors (`publishSubagentsService` / `getSubagentsService`).
   Consumers declare this package as an optional peer dependency and use dynamic import for compile-time types.
   The runtime bridge is `Symbol.for("@gotgenes/pi-subagents:service")` on `globalThis` — no separate API package.
4. **No scheduling** — in-process scheduling is removed from the core.
   Scheduling is a separate concern that any extension can implement by calling `spawn()` on the published API.
5. **UI extraction is deferred** — the widget, conversation viewer, and `/agents` command menu stay in the core for now.
   They are the first candidate for extraction once the API boundary is proven stable.

## Current state

The extension is ~6,100 LOC across 35 focused modules with a typed `SubagentsService` API boundary.
The `index.ts` entry point is ~270 lines; the rest is decomposed into domain modules.

```text
index.ts (274 LOC)       — entry point, tool registration, event wiring
agent-manager.ts (499)   — lifecycle, concurrency, queue
agent-runner.ts (512)    — session creation, turn loop, tool filtering
session-config.ts (243)  — pure session-config assembler
agent-types.ts (138)     — type registry (defaults + custom .md files)
types.ts (126)           — shared type definitions
runtime.ts (94)          — SubagentRuntime factory (session-scoped state)

prompts.ts               — system prompt assembly
context.ts               — parent conversation extraction
memory.ts                — persistent MEMORY.md per agent
skill-loader.ts          — preload .pi/skills into prompts
env.ts                   — git/platform detection

worktree.ts              — git worktree isolation
usage.ts                 — token usage tracking
model-resolver.ts        — fuzzy model name resolution
invocation-config.ts     — merge tool params with agent config
session-dir.ts           — subagent session directory derivation
settings.ts              — persistent operational settings

service.ts               — SubagentsService interface + Symbol.for() accessors
service-adapter.ts       — SubagentsService implementation wrapping AgentManager

tools/agent-tool.ts      — Agent tool definition + execute
tools/get-result-tool.ts — get_subagent_result tool
tools/steer-tool.ts      — steer_subagent tool
tools/helpers.ts         — shared tool utilities

handlers/lifecycle.ts    — session_start, session_before_switch, session_shutdown
handlers/tool-start.ts   — tool_execution_start handler

notification.ts          — completion nudges, custom message renderer
renderer.ts              — notification TUI component

ui/agent-widget.ts       — above-editor live status widget
ui/agent-menu.ts         — /agents slash command menu
ui/conversation-viewer.ts — scrollable session overlay

default-agents.ts        — embedded default agent configs (general-purpose, Explore, Plan)
custom-agents.ts         — user-defined agent .md file loader
debug.ts                 — debug logging utility
```

### Coupling today

The widget reads agent state by holding a direct reference to `SubagentRuntime` and polling a shared mutable `Map<string, AgentActivity>` every 80 ms. The conversation viewer subscribes directly to `AgentSession` objects.

Cross-extension consumers use the typed `SubagentsService` API published via `Symbol.for("@gotgenes/pi-subagents:service")` on `globalThis`.
The ad-hoc RPC layer and untyped `Symbol.for("pi-subagents:manager")` have been removed.

## Target state

```text
  ┌────────────────────────────────────────────────────────┐
  │  @gotgenes/pi-subagents  (this package)                 │
  │                                                        │
  │  Exports:                                              │
  │    SubagentsService interface                           │
  │    publishSubagentsService() / getSubagentsService()    │
  │    SubagentRecord, SubagentStatus, LifetimeUsage types  │
  │    SUBAGENT_EVENTS constants                            │
  │                                                        │
  │  Core:                                                 │
  │    Agent + get_subagent_result + steer_subagent tools  │
  │    AgentManager, agent-runner, agent-types             │
  │    publishSubagentsService(impl)  ← called at init     │
  │                                                        │
  │  Internal UI (widget, viewer, /agents menu)            │
  │  ← moves to pi-subagents-ui later                     │
  └──────────────────────┬─────────────────────────────────┘
                         │ Symbol.for("@gotgenes/pi-subagents:service")
                         │
       ┌─────────────────┼──────────────────┐
       │                 │                  │
       ▼                 ▼                  ▼
  ┌─────────┐    ┌──────────────┐    ┌──────────────┐
  │ pi-     │    │ pi-subagents │    │ any future   │
  │ schedule│    │ -ui          │    │ extension    │
  │ (other  │    │ (deferred)   │    │              │
  │  ext)   │    └──────────────┘    └──────────────┘
  └─────────┘
       │
       │  getSubagentsService()?.spawn(...)
       │  (optional peer dep + dynamic import for types)
       ▼
```

### What the core owns

- The three tools: `Agent`, `get_subagent_result`, `steer_subagent`.
- `AgentManager` — spawn, queue, abort, resume, concurrency control.
- `agent-runner` — session creation, turn loop, tool filtering, extension binding (Patches 2 and 3).
- `session-config` — pure configuration assembler (extracted from `agent-runner`).
- `SubagentRuntime` — session-scoped state bag with methods.
- Agent type registry — default agents, custom `.md` file loading.
- Prompt assembly, context extraction, memory, skills, environment.
- Worktree isolation.
- Token usage tracking.
- Session directory derivation and persisted `SessionManager` for subagent transcripts.
- Settings persistence.
- Internal UI (widget, conversation viewer, `/agents` menu) — these stay until the API boundary is proven, then move to a separate extension.

### What the core drops

- **Scheduling** (`schedule.ts`, `schedule-store.ts`, `ui/schedule-menu.ts`) — 612 LOC removed.
  The `schedule` parameter is removed from the `Agent` tool schema.
  Any extension that wants scheduling can implement it by calling `getSubagentsService()?.spawn(...)` on a timer.
- **Ad-hoc RPC** (`cross-extension-rpc.ts`) — replaced by the typed `SubagentsService` published via `Symbol.for()`.
  The untyped event-bus RPC channels are removed.
- **Group join** (`group-join.ts`) — 141 LOC removed.
  The grouped notification batching adds complexity for a marginal UX improvement.
  Individual completion notifications are sufficient.
- **Output file** (`output-file.ts`) — replaced by `session-dir.ts` + `SessionManager.create()` (#61).
  Subagent transcripts are now written in Pi's official JSONL session format via the SDK's `SessionManager`, nested under the parent session directory.

### Estimated impact (realized)

| Subsystem              | Status         | LOC impact                                 |
| ---------------------- | -------------- | ------------------------------------------ |
| Scheduling             | Removed (#52)  | −612                                       |
| Ad-hoc RPC             | Removed (#49)  | −080                                       |
| Group join             | Removed (#49)  | −141                                       |
| Output file            | Replaced (#61) | −83 (replaced by 38-line `session-dir.ts`) |
| index.ts decomposition | Done (#54)     | 1,894 → 274                                |

The codebase is now ~6,100 LOC across 35 modules.
The `index.ts` entry point is 274 lines.

## SubagentsService (done — #48)

The `SubagentsService` interface, accessor functions, and serializable types are exported from `@gotgenes/pi-subagents` via the `./service` export map entry.
No separate API package is needed.

Consumers declare this package as an optional peer dependency:

```json
{
  "peerDependencies": {
    "@gotgenes/pi-subagents": ">=5.0.0"
  },
  "peerDependenciesMeta": {
    "@gotgenes/pi-subagents": { "optional": true }
  }
}
```

At runtime, consumers use dynamic import for type-safe access to the accessor functions:

```typescript
const { getSubagentsService } = await import("@gotgenes/pi-subagents");
const svc = getSubagentsService();
if (svc) {
  svc.spawn("Explore", "Check for stale TODOs");
}
```

Pi's extension loader creates a fresh `jiti` instance per extension with `moduleCache: false`, so module-scoped singletons don't survive across extensions.
The accessor functions use `Symbol.for("@gotgenes/pi-subagents:service")` on `globalThis`, which is process-global by spec, to bridge this gap.
The dynamic import provides compile-time types; the `Symbol.for()` key is the actual runtime channel.

### Interface

See `src/service.ts` for the canonical definition.
Key types:

- `SubagentsService` — `spawn`, `getRecord`, `listAgents`, `abort`, `steer`, `waitForAll`, `hasRunning`.
- `SubagentRecord` — serializable agent snapshot (no live session objects).
- `SpawnOptions` — `description`, `model`, `maxTurns`, `thinkingLevel`, `isolated`, `inheritContext`, `foreground`, `bypassQueue`, `isolation`.
- `SUBAGENT_EVENTS` — channel constants for `pi.events` subscriptions.

### Accessor pattern

```typescript
const SERVICE_KEY = Symbol.for("@gotgenes/pi-subagents:service");

export function publishSubagentsService(service: SubagentsService): void {
  (globalThis as Record<symbol, unknown>)[SERVICE_KEY] = service;
}

export function getSubagentsService(): SubagentsService | undefined {
  return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as
    | SubagentsService
    | undefined;
}
```

If Pi gains a native service registry ([earendil-works/pi#4207]), these accessors can be updated to delegate to `pi.registerService()` / `pi.getService()` internally while keeping the same consumer API.

### Lifecycle events

The core emits events on `pi.events` that any extension can observe:

| Channel               | Payload                                     | When                 |
| --------------------- | ------------------------------------------- | -------------------- |
| `subagents:started`   | `{ id, type, description }`                 | Agent begins running |
| `subagents:completed` | `{ id, type, status, result?, error? }`     | Agent finishes       |
| `subagents:activity`  | `{ id, toolName?, textDelta?, turnCount? }` | Streaming progress   |

These replace the ad-hoc RPC channels.
They are fire-and-forget broadcast events — no request IDs, no reply channels.

### Consumer example: scheduling extension

```typescript
export default function (pi) {
  pi.on("session_start", async (event, ctx) => {
    let getSubagentsService;
    try {
      ({ getSubagentsService } = await import("@gotgenes/pi-subagents"));
    } catch {
      return; // pi-subagents not installed
    }
    const svc = getSubagentsService();
    if (!svc) return;

    setInterval(() => {
      svc.spawn("Explore", "Check for stale TODOs", {
        bypassQueue: true,
      });
    }, 60 * 60 * 1000);
  });
}
```

### Consumer example: transcript extension

```typescript
export default function (pi) {
  pi.events.on("subagents:completed", async (data) => {
    const { id } = data as { id: string };
    let getSubagentsService;
    try {
      ({ getSubagentsService } = await import("@gotgenes/pi-subagents"));
    } catch {
      return;
    }
    const record = getSubagentsService()?.getRecord(id);
    if (record?.result) {
      fs.appendFileSync("agent-log.jsonl", JSON.stringify(record) + "\n");
    }
  });
}
```

## index.ts decomposition (done — #54, #69, #70)

The original 1,894-line `index.ts` has been decomposed into focused modules:

```text
src/
├── index.ts (274)            ← slimmed entry point: init, tool registration
├── runtime.ts (94)           ← SubagentRuntime: session-scoped state + methods
├── tools/
│   ├── agent-tool.ts (626)   ← Agent tool definition + execute
│   ├── get-result-tool.ts    ← get_subagent_result tool
│   ├── steer-tool.ts         ← steer_subagent tool
│   └── helpers.ts            ← shared tool utilities
├── handlers/
│   ├── lifecycle.ts          ← session_start, session_before_switch, session_shutdown
│   └── tool-start.ts         ← tool_execution_start handler
├── notification.ts           ← completion nudges, custom renderer
├── renderer.ts               ← notification TUI component
├── ui/agent-menu.ts (677)    ← /agents slash command menu
├── service-adapter.ts        ← SubagentsService implementation wrapping AgentManager
└── (existing domain modules unchanged)
```

Each extracted module receives narrow constructor-injected dependencies rather than closing over module-level state.
Handlers call methods on narrow runtime interfaces — no raw field writes, no `widget!` reach-throughs.

## Phase plan

### Phase 1: Export `SubagentsService` from this package ✓ (done — #48)

Added the `SubagentsService` interface, serializable types, `Symbol.for()` accessor functions, and `SUBAGENT_EVENTS` constants as public exports.
Wired `service-adapter.ts` to wrap `AgentManager` and call `publishSubagentsService()` at extension init.

### Phase 2: Remove scheduling ✓ (done — issue #52)

Deleted `schedule.ts`, `schedule-store.ts`, `ui/schedule-menu.ts`.
Removed the `schedule` parameter from the `Agent` tool schema.
Removed scheduler setup and lifecycle hooks from `index.ts`.

### Phase 3: Remove group-join, ad-hoc RPC; replace output-file ✓ (done — #49, #61)

Deleted `group-join.ts`, `cross-extension-rpc.ts` (#49).
Replaced `output-file.ts` with `SessionManager.create()` + `session-dir.ts` (#61).
Simplified `index.ts` to use direct individual notifications.
Lifecycle events emitted on `pi.events` for external consumers.

### Phase 4: Implement and publish `SubagentsService` ✓ (done — #48)

Wired `service-adapter.ts` to wrap `AgentManager` and call `publishSubagentsService()` at extension init.
Model strings are resolved inside the adapter.

### Phase 5: Decompose `index.ts` ✓ (done — #54, #69, #70, #87)

Extracted tools, notifications, activity tracking, event handlers, and the `/agents` command into separate modules.
Created `SubagentRuntime` factory to hold session-scoped state.
`src/index.ts` shrank from ~1,894 lines to ~274 lines.

### Phase 6 (future): Extract UI to `@gotgenes/pi-subagents-ui`

Move `ui/agent-widget.ts`, `ui/conversation-viewer.ts`, the `/agents` command, notifications, and activity tracking to a separate extension that consumes `SubagentsService` + lifecycle events.
This phase is deferred until the API boundary is proven stable in production.

## Structural refactoring roadmap (post-#54)

The Issue #54 decomposition created focused modules but left several structural cleanup opportunities on the table.
The following issues track the work needed to bring `pi-subagents` to the same level of testability and composability as `pi-permission-system`.

### Phase 1: Foundation

These issues are independent of each other and can land in any order.
Together they eliminate module-scope mutable state, create a testable functional core, and simplify the agent-types API.

1. **gotgenes/pi-packages#69** ✓ — Create `SubagentRuntime`
   - Move `defaultMaxTurns`, `graceTurns`, `agentActivity`, `currentCtx`, and widget references out of closure/module scope into a single factory-constructed object.
   - This unblocks handler extraction (Issue #70) by giving handlers a concrete deps bag instead of closure variables.

2. **gotgenes/pi-packages#71** ✓ — Extract pure agent-session assembler from `agent-runner.ts`
   - Split `runAgent()` into a pure configuration assembler (~200 lines) and an IO shell (~200 lines).
   - The assembler becomes independently testable without mocking the Pi SDK.

3. **gotgenes/pi-packages#76** ✓ — Inject `cwd` into `AgentManager`
   - Replaced the `process.cwd()` call in `dispose()` with a constructor parameter.

4. **gotgenes/pi-packages#80** ✓ — Consolidate `getConfig` / `getAgentConfig` into a single resolution path
   - Replaced the two overlapping lookup functions with a single `resolveAgentConfig(type): AgentConfig` that handles the unknown-type fallback internally.
   - Eliminated the duplicated fallback chain exposed by #71 and simplified test mock setup.

### Phase 2: Core decomposition

These build on Phase 1 and should land after it.

1. **gotgenes/pi-packages#84** ✓ — Extract `GitWorktreeManager` class from `worktree.ts`
   - Added `WorktreeManager` interface and `GitWorktreeManager` class that captures `cwd` at construction.
   - Prerequisite for #72 — separated the real-object extraction from the DI refactor.

2. **gotgenes/pi-packages#72** ✓ — Dependency-inject `AgentManager`'s collaborators
   - Defined `AgentRunner` interface (execution boundary) and `ResumeOptions` type in `agent-runner.ts`.
   - Converted `AgentManager` constructor from 6 positional parameters to an `AgentManagerOptions` bag with injected `AgentRunner` and `WorktreeManager`.
   - Removed all runtime imports of `agent-runner.ts` and `worktree.ts` from `agent-manager.ts` (only `import type` remains).
   - Migrated all tests from `vi.mock()` module stubs to `vi.fn()` interface stubs.

3. **gotgenes/pi-packages#87** ✓ — Evolve `SubagentRuntime` from data bag to object with methods
   - Added session-context methods (`setSessionContext`, `clearSessionContext`) and widget delegation methods (`setUICtx`, `onTurnStart`, `markFinished`, `updateWidget`, `ensureTimer`).
   - Prerequisite for #70 — without runtime methods, extracted handlers would move LoD violations and output-argument smells into handler classes.

4. **gotgenes/pi-packages#70** ✓ — Extract event handlers into `src/handlers/`
   - Moved the four inline lambdas (`session_start`, `session_before_switch`, `session_shutdown`, `tool_execution_start`) into `SessionLifecycleHandler` and `ToolStartHandler` classes.
   - Handlers call methods on narrow runtime interfaces — no raw field writes, no `widget!` reach-throughs.

### Phase 3: Interface polish ✓ (done)

1. **gotgenes/pi-packages#66** ✓ — Replace `as any` casts with proper SDK types
   - Typed tool/menu factory dep interfaces with `ExtensionContext`, `AgentSession`, `SpawnOptions`, etc.

2. **gotgenes/pi-packages#77** ✓ — Add `projectAgentsDir` to `AgentMenuDeps`
   - Removed the inline `process.cwd()` lambda from the menu handler.

### Phase 4: Features and cross-cutting concerns

1. **gotgenes/pi-packages#61** ✓ — Port transcript logging to Pi's official JSONL session format
   - Replaced `output-file.ts` with `SessionManager.create()` + `session-dir.ts`.
   - Subagent sessions are persisted under `<parent-session-dir>/<parent-session-basename>/tasks/` with `parentSession` header linking.

2. **gotgenes/pi-packages#22** — Parent-session resolution for `nicobailon/pi-subagents` children
   - Cross-extension issue that spans `pi-permission-system` and `pi-subagents`.
   - Requires coordination on env-var conventions.
   - Not blocked by the structural refactor but logically separate from it.

### Dependency graph

```text
#69 (SubagentRuntime) ✓ ──► #87 (runtime methods) ✓ ─┬─► #70 (handler extraction) ✓
                                                   │
#71 (pure assembler) ✓                              │
#80 (config lookup) ✓                               │
#76 (cwd injection) ✓                               │
#84 (WorktreeManager) ✓                             │
#72 (AgentManager DI) ✓ ────────────────────────────┘──(optional)──► #70

#66 (type casts) ✓
#77 (projectAgentsDir) ✓

#61 (transcript format) ✓
#22 (parent session) ◄──(cross-extension, independent)
```

### Recommended order

The recommended sequence is:

```text
#69 ✓ → #71 ✓ → #80 ✓ → #76 ✓ → #84 ✓ → #72 ✓ → #87 ✓ → #70 ✓ → #66 ✓ → #77 ✓ → #61 ✓
```

All structural refactoring phases are complete.
The remaining open issue is #22 (parent-session resolution), a cross-extension track that does not gate the structural work.

## Relationship with upstream

This fork (`@gotgenes/pi-subagents` in the [gotgenes/pi-packages] monorepo) is now a hard fork of [tintinweb/pi-subagents].
The decomposition diverges materially from upstream's direction.

The three upstream PRs (#71, #72, #73) remain open.
If they land, upstream gains the peer-dep fix and the two RepOne patches.
This fork continues independently regardless.

Upstream fixes and ideas are cherry-picked when they align with this fork's scope.
The upstream test suite is run periodically as a regression canary for the agent-runner core.

[earendil-works/pi#4207]: https://github.com/earendil-works/pi/issues/4207
[gotgenes/pi-packages]: https://github.com/gotgenes/pi-packages
[tintinweb/pi-subagents]: https://github.com/tintinweb/pi-subagents
