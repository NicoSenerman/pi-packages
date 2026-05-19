# Architecture

This document describes the planned decomposition of the pi-subagents fork into a focused, composable core with a stable API boundary that other extensions can build on.

## Design principles

1. **Narrow core** — the extension owns agent spawning, execution, and result retrieval.
   Everything else is a consumer.
2. **Composable by default** — other extensions can spawn agents, observe their lifecycle, and display their state without importing this package directly.
3. **Typed API boundary** — this package exports a `SubagentsAPI` interface and `Symbol.for()` accessors (`publishSubagentsAPI` / `getSubagentsAPI`).
   Consumers declare this package as an optional peer dependency and use dynamic import for compile-time types.
   The runtime bridge is `Symbol.for()` on `globalThis` — no separate API package.
4. **No scheduling** — in-process scheduling is removed from the core.
   Scheduling is a separate concern that any extension can implement by calling `spawn()` on the published API.
5. **UI extraction is deferred** — the widget, conversation viewer, and `/agents` command menu stay in the core for now.
   They are the first candidate for extraction once the API boundary is proven stable.

## Current state

The extension is a 6,300 LOC monolith organized into well-factored internal modules but with no public API contract.
The subsystems are:

```text
index.ts (1,894 LOC) — entry point, tool registration, event wiring
agent-manager.ts      — lifecycle, concurrency, queue
agent-runner.ts       — session creation, turn loop, tool filtering
agent-types.ts        — type registry (defaults + custom .md files)
types.ts              — shared type definitions

prompts.ts            — system prompt assembly
context.ts            — parent conversation extraction
memory.ts             — persistent MEMORY.md per agent
skill-loader.ts       — preload .pi/skills into prompts
env.ts                — git/platform detection

worktree.ts           — git worktree isolation
usage.ts              — token usage tracking
model-resolver.ts     — fuzzy model name resolution
invocation-config.ts  — merge tool params with agent config
output-file.ts        — JSONL transcript streaming
settings.ts           — persistent operational settings

cross-extension-rpc.ts — RPC over pi.events                  ← replacing
group-join.ts         — batch completion notifications

ui/agent-widget.ts       — above-editor live status widget
ui/conversation-viewer.ts — scrollable session overlay
```

### Coupling today

The widget reads agent state by holding a direct reference to `AgentManager` and polling a shared mutable `Map<string, AgentActivity>` every 80 ms. The conversation viewer subscribes directly to `AgentSession` objects.

Cross-extension consumers use an ad-hoc RPC layer over `pi.events` (`subagents:rpc:spawn`, `subagents:rpc:stop`, `subagents:rpc:ping`) with per-request reply channels and untyped envelopes.

There is also a `Symbol.for("pi-subagents:manager")` export on `globalThis` that exposes `{ waitForAll, hasRunning, spawn, getRecord }`, but it is undocumented and untyped.

## Target state

```text
  ┌────────────────────────────────────────────────────────┐
  │  @earendil-works/pi-subagents  (this package)          │
  │                                                        │
  │  Exports:                                              │
  │    SubagentsAPI interface                              │
  │    publishSubagentsAPI() / getSubagentsAPI()           │
  │    SubagentRecord, SubagentStatus, LifetimeUsage types │
  │    Event channel constants                             │
  │                                                        │
  │  Core:                                                 │
  │    Agent + get_subagent_result + steer_subagent tools  │
  │    AgentManager, agent-runner, agent-types             │
  │    publishSubagentsAPI(impl)  ← called at init         │
  │                                                        │
  │  Internal UI (widget, viewer, /agents menu)            │
  │  ← moves to pi-subagents-ui later                     │
  └──────────────────────┬─────────────────────────────────┘
                         │ Symbol.for("pi:service:subagents")
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
       │  getSubagentsAPI()?.spawn(...)
       │  (optional peer dep + dynamic import for types)
       ▼
```

### What the core owns

- The three tools: `Agent`, `get_subagent_result`, `steer_subagent`.
- `AgentManager` — spawn, queue, abort, resume, concurrency control.
- `agent-runner` — session creation, turn loop, tool filtering, extension binding (Patches 2 and 3).
- Agent type registry — default agents, custom `.md` file loading.
- Prompt assembly, context extraction, memory, skills, environment.
- Worktree isolation.
- Token usage tracking.
- Settings persistence.
- Internal UI (widget, conversation viewer, `/agents` menu) — these stay until the API boundary is proven, then move to a separate extension.

### What the core drops

- **Scheduling** (`schedule.ts`, `schedule-store.ts`, `ui/schedule-menu.ts`) — 612 LOC removed.
  The `schedule` parameter is removed from the `Agent` tool schema.
  Any extension that wants scheduling can implement it by calling `getSubagentsAPI()?.spawn(...)` on a timer.
- **Ad-hoc RPC** (`cross-extension-rpc.ts`) — replaced by the typed `SubagentsAPI` published via `Symbol.for()`.
  The untyped event-bus RPC channels are removed.
- **Group join** (`group-join.ts`) — 141 LOC removed.
  The grouped notification batching adds complexity for a marginal UX improvement.
  Individual completion notifications are sufficient.
- **Output file** (`output-file.ts`) — 96 LOC removed.
  JSONL transcript streaming is a consumer concern; a separate extension can subscribe to lifecycle events and write transcripts.

### Estimated impact

| Subsystem removed | LOC removed | LOC removed from index.ts |
| ----------------- | ----------- | ------------------------- |
| Scheduling        | 612         | ~200                      |
| Ad-hoc RPC        | 80          | ~50                       |
| Group join        | 141         | ~100                      |
| Output file       | 83          | ~50                       |
| **Total**         | **~916**    | **~400**                  |

After removal and `index.ts` decomposition, the core shrinks from ~6,300 to ~5,400 LOC, and `index.ts` shrinks from ~1,894 to ~1,300 LOC.

## SubagentsAPI

The `SubagentsAPI` interface, accessor functions, and serializable types are exported directly from this package (`@earendil-works/pi-subagents`).
No separate API package is needed.

Consumers declare this package as an optional peer dependency:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-subagents": ">=2.0.0"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-subagents": { "optional": true }
  }
}
```

At runtime, consumers use dynamic import for type-safe access to the accessor functions:

```typescript
const { getSubagentsAPI } = await import("@earendil-works/pi-subagents");
const api = getSubagentsAPI();
if (api) {
  api.spawn("Explore", "Check for stale TODOs");
}
```

Pi's extension loader creates a fresh `jiti` instance per extension with `moduleCache: false`, so module-scoped singletons don't survive across extensions.
The accessor functions use `Symbol.for()` on `globalThis`, which is process-global by spec, to bridge this gap.
The dynamic import provides compile-time types; the `Symbol.for()` key is the actual runtime channel.

### Interface

```typescript
/** The public API surface published by pi-subagents. */
export interface SubagentsAPI {
  /**
   * Spawn an agent. Returns the agent ID immediately.
   * The agent runs in the background unless options.foreground is true.
   */
  spawn(type: string, prompt: string, options?: SpawnOptions): string;

  /** Get a snapshot of an agent's current state. */
  getRecord(id: string): SubagentRecord | undefined;

  /** List all tracked agents, most recent first. */
  listAgents(): SubagentRecord[];

  /** Abort a running or queued agent. Returns false if not found. */
  abort(id: string): boolean;

  /** Send a steering message to a running agent. */
  steer(id: string, message: string): Promise<boolean>;

  /** Wait for all running and queued agents to complete. */
  waitForAll(): Promise<void>;

  /** Whether any agents are running or queued. */
  hasRunning(): boolean;
}

export interface SpawnOptions {
  description?: string;
  model?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  isolated?: boolean;
  inheritContext?: boolean;
  foreground?: boolean;
  /** Skip the concurrency queue — start immediately. */
  bypassQueue?: boolean;
  isolation?: "worktree";
}
```

### Accessor pattern

```typescript
const KEY = Symbol.for("pi:service:subagents");

export function publishSubagentsAPI(api: SubagentsAPI): void {
  (globalThis as any)[KEY] = api;
}

export function getSubagentsAPI(): SubagentsAPI | undefined {
  return (globalThis as any)[KEY];
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
// package.json:
// "peerDependencies": { "@earendil-works/pi-subagents": ">=2.0.0" }
// "peerDependenciesMeta": { "@earendil-works/pi-subagents": { "optional": true } }

export default function (pi) {
  pi.on("session_start", async (event, ctx) => {
    let getSubagentsAPI;
    try {
      ({ getSubagentsAPI } = await import("@earendil-works/pi-subagents"));
    } catch {
      return; // pi-subagents not installed
    }
    const api = getSubagentsAPI();
    if (!api) return;

    setInterval(() => {
      api.spawn("Explore", "Check for stale TODOs", {
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
    let getSubagentsAPI;
    try {
      ({ getSubagentsAPI } = await import("@earendil-works/pi-subagents"));
    } catch {
      return;
    }
    const record = getSubagentsAPI()?.getRecord(id);
    if (record?.result) {
      fs.appendFileSync("agent-log.jsonl", JSON.stringify(record) + "\n");
    }
  });
}
```

## index.ts decomposition

The 1,894-line `index.ts` is decomposed into focused modules:

```text
src/
├── index.ts                  ← slimmed entry point: init, tool registration
├── tools/
│   ├── agent-tool.ts         ← Agent tool definition + execute
│   ├── result-tool.ts        ← get_subagent_result tool
│   └── steer-tool.ts         ← steer_subagent tool
├── notifications.ts          ← completion nudges, custom renderer
├── activity-tracker.ts       ← AgentActivity map + callback factory
├── agents-command.ts         ← /agents slash command menu
├── api-adapter.ts            ← SubagentsAPI implementation wrapping AgentManager
└── (existing modules unchanged)
```

Each extracted module receives narrow constructor-injected dependencies rather than closing over module-level state.

## Phase plan

### Phase 1: Export `SubagentsAPI` from this package

Add the `SubagentsAPI` interface, serializable types, and `Symbol.for()` accessor functions as public exports of this package.
No behavioral changes to the core yet.

### Phase 2: Remove scheduling ✓ (done — issue #52)

Deleted `schedule.ts`, `schedule-store.ts`, `ui/schedule-menu.ts`.
Removed the `schedule` parameter from the `Agent` tool schema.
Removed scheduler setup and lifecycle hooks from `index.ts`.

### Phase 3: Remove group-join, output-file, ad-hoc RPC

Delete `group-join.ts`, `output-file.ts`, `cross-extension-rpc.ts`.
Simplify `index.ts` to use direct individual notifications.
Emit lifecycle events on `pi.events` for external consumers.

### Phase 4: Implement and publish `SubagentsAPI`

Wire `api-adapter.ts` to wrap `AgentManager` and call `publishSubagentsAPI()` at extension init.
Resolve model strings inside the adapter (fixing upstream [tintinweb/pi-subagents#60]).

### Phase 5: Decompose `index.ts` ✓ (done — issue #54)

Extracted tools, notifications, activity tracking, and the `/agents` command into separate modules.
`src/index.ts` shrank from ~1,619 lines to ~265 lines.

### Phase 6 (future): Extract UI to `@earendil-works/pi-subagents-ui`

Move `ui/agent-widget.ts`, `ui/conversation-viewer.ts`, the `/agents` command, notifications, and activity tracking to a separate extension that consumes `SubagentsAPI` + lifecycle events.
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

3. **gotgenes/pi-packages#76** — Inject `cwd` into `AgentManager`
   - Replace the `process.cwd()` call in `dispose()` with a constructor parameter.
   - A small, mechanical prerequisite for Issue #72.

4. **gotgenes/pi-packages#80** — Consolidate `getConfig` / `getAgentConfig` into a single resolution path
   - Replace the two overlapping lookup functions with a single `resolveAgentConfig(type): AgentConfig` that handles the unknown-type fallback internally.
   - Eliminates the duplicated fallback chain exposed by #71 and simplifies test mock setup.

### Phase 2: Core decomposition

These build on Phase 1 and should land after it.

4. **gotgenes/pi-packages#72** — Dependency-inject `AgentManager`'s collaborators
   - Introduce `AgentRunner` and `WorktreeManager` interfaces and inject them into `AgentManager`.
   - Removes direct imports of `agent-runner.ts` and `worktree.ts` from `agent-manager.ts`.

5. **gotgenes/pi-packages#70** — Extract event handlers into `src/handlers/`
   - Move the four inline lambdas (`session_start`, `session_before_switch`, `session_shutdown`, `tool_execution_start`) into named handler modules.
   - Requires Issue #69 because handlers need the `SubagentRuntime` as their deps bag.
   - Target: `src/index.ts` ≤150 lines.

### Phase 3: Interface polish

Small cleanups that are safest after the structural changes settle.

6. **gotgenes/pi-packages#66** — Replace `as any` casts with proper SDK types
   - Type-only change in the tool/menu factory dep interfaces.
   - Best done after Issues #69 and #70 when the interfaces are stable.

7. **gotgenes/pi-packages#77** — Add `projectAgentsDir` to `AgentMenuDeps`
   - Remove the inline `process.cwd()` lambda from the menu handler.

### Phase 4: Features and cross-cutting concerns

8. **gotgenes/pi-packages#61** — Port transcript logging to Pi's official JSONL session format
   - Feature work that should happen after structural refactoring is complete so the output-file subsystem has a stable home.

9. **gotgenes/pi-packages#22** — Parent-session resolution for `nicobailon/pi-subagents` children
   - Cross-extension issue that spans `pi-permission-system` and `pi-subagents`.
   - Requires coordination on env-var conventions.
   - Not blocked by the structural refactor but logically separate from it.

### Dependency graph

```text
#69 (SubagentRuntime) ✓ ─┬─► #70 (handler extraction)
                        │
                        └─► #72 (AgentManager DI) ──(optional)──► #70

#71 (pure assembler) ✓ ──► #80 (consolidate getConfig/getAgentConfig)

#76 (cwd injection) ────► #72

#80 (config lookup) ────(independent, simplifies #72 and test mocks)

#66 (type casts) ◄─────(after structural changes settle)
#77 (projectAgentsDir) ◄─(after #66 or parallel)

#61 (transcript format) ◄(after structural refactor)
#22 (parent session) ◄──(cross-extension, independent)
```

### Recommended order

The recommended sequence is:

```text
#69 ✓ → #71 ✓ → #80 → #76 → #72 → #70 → #66 → #77 → #61
```

Issue #80 slots after #71 because it cleans up the redundant lookup that #71 exposed, and simplifies mock setup for subsequent issues.
Issue #22 is a parallel cross-extension track and does not gate the structural work.

## Relationship with upstream

This fork ([earendil-works/pi-subagents]) is now a hard fork of [tintinweb/pi-subagents].
The decomposition diverges materially from upstream's direction.

The three upstream PRs (#71, #72, #73) remain open.
If they land, upstream gains the peer-dep fix and the two RepOne patches.
This fork continues independently regardless.

Upstream fixes and ideas are cherry-picked when they align with this fork's scope.
The upstream test suite is run periodically as a regression canary for the agent-runner core.

[earendil-works/pi#4207]: https://github.com/earendil-works/pi/issues/4207
[earendil-works/pi-subagents]: https://github.com/earendil-works/pi-subagents
[tintinweb/pi-subagents]: https://github.com/tintinweb/pi-subagents
