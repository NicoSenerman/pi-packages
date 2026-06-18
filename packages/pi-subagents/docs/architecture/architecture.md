# Architecture

This document describes the architecture of the pi-subagents fork: a focused, composable core with a stable API boundary that other extensions can build on.

## Design principles

1. **Narrow core** — the extension owns agent spawning, execution, and result retrieval.
   Everything else is a consumer.
2. **Composable by default** — other extensions can spawn agents, observe their lifecycle, and display their state without importing this package directly.
3. **Typed API boundary** — this package exports a `SubagentsService` interface and `Symbol.for()` accessors (`publishSubagentsService` / `getSubagentsService`).
   Consumers declare this package as an optional peer dependency and use dynamic import for compile-time types.
   The runtime bridge is `Symbol.for("@gotgenes/pi-subagents:service")` on `globalThis` — no separate API package.
4. **No time-based scheduling** — cron-style timed dispatch (upstream's `schedule.ts` subsystem) is removed from the core (#52).
   Timed dispatch is a separate concern that any extension can implement by calling `spawn()` on the published API.
   The max-concurrent admission gate is not scheduling in this sense — concurrency management stays in core.
5. **UI extraction is deferred** — the widget, conversation viewer, and `/agents` command menu stay in the core for now.
   They are the first candidate for extraction once the API boundary is proven stable.
6. **Snapshot, don't capture** — mutable parent state (ctx, session, model) is read once at spawn time and frozen into a `ParentSnapshot` data object.
   No live references survive past the spawn call.
7. **Subscribe, don't thread** — observation of agent progress uses direct session-event subscription, not callback parameters threaded through multiple layers.
8. **Construct complete** — objects are born with all their dependencies.
   If state isn't available yet, the object that needs it doesn't exist yet.
   No post-construction field writes from external code — if an object can't be instantiated ready-to-go, the prep work hasn't been done and the right dependencies haven't been identified.
9. **State owns its mutations** — mutable state lives in a class whose methods enforce valid transitions and invariants.
   Free functions that mutate module-scoped variables, closure-captured bags-of-functions, and external writes to shared interfaces are replaced by classes that encapsulate the state they manage.
10. **Open for extension, closed for modification** — pi-subagents is a minimal core that publishes events and a service API.
    Other packages (pi-permission-system, a future UI extension, hypothetical OTel integration) hook into these events to add permissions, rendering, or telemetry.
    Pi-subagents has zero knowledge of its consumers — dependency arrows point inward, never outward.

## Domain model

The extension is organized around six domains, each responsible for one aspect of managing agents.

```mermaid
flowchart TB
    subgraph config["Config domain"]
        direction TB
        AgentTypeRegistry["AgentTypeRegistry<br/>(registry of agent types)"]
        DefaultAgents["default-agents<br/>(built-in types)"]
        CustomAgents["custom-agents<br/>(user .md files)"]
        InvocationConfig["invocation-config<br/>(per-call merge)"]
    end

    subgraph session["Session domain"]
        direction TB
        SessionConfig["assembleSessionConfig<br/>(pure assembler)"]
        Prompts["prompts<br/>(system prompt)"]
        Context["context<br/>(parent history)"]
        Env["env<br/>(git/platform)"]
        ModelResolver["model-resolver<br/>(fuzzy match)"]
    end

    subgraph lifecycle["Lifecycle domain"]
        direction TB
        SubagentManager["SubagentManager<br/>(spawn, abort, collection)"]
        ConcurrencyLimiter["ConcurrencyLimiter<br/>(thunk admission gate)"]
        CreateSubagentSession["createSubagentSession<br/>(assembly factory)"]
        SubagentSession["SubagentSession<br/>(turn loop, steer, dispose)"]
        Subagent["Subagent<br/>(status, behavior: abort/steer/run lifecycle)"]
        ParentSnapshot["ParentSnapshot<br/>(frozen parent state)"]
        Workspace["workspace<br/>(provider seam: child cwd + teardown)"]
    end

    subgraph observation["Observation domain"]
        direction TB
        RecordObserver["record-observer<br/>(stats + live activity via events)"]
        Notification["notification<br/>(completion nudges)"]
    end

    subgraph tools["Tools domain"]
        direction TB
        AgentTool["subagent tool<br/>(dispatch)"]
        ResultRenderer["result-renderer<br/>(pure rendering)"]
        SpawnConfig["spawn-config<br/>(resolve params)"]
        FgRunner["foreground-runner"]
        BgSpawner["background-spawner"]
        GetResult["get_subagent_result"]
        Steer["steer_subagent"]
    end

    subgraph ui["UI domain"]
        direction TB
        Widget["agent-widget<br/>(live status)"]
        ConvViewer["conversation-viewer<br/>(session overlay)"]
        Menu["agent-menu<br/>(slash command)"]
    end

    AgentTool --> SubagentManager
    SubagentManager --> Subagent
    Subagent --> CreateSubagentSession & SubagentSession
    CreateSubagentSession --> SubagentSession
    CreateSubagentSession --> SessionConfig
    SessionConfig --> AgentTypeRegistry
    SessionConfig --> Prompts & Env
    AgentTypeRegistry --> DefaultAgents & CustomAgents
    RecordObserver -.->|subscribes| SubagentSession
    Widget -.->|polls| SubagentManager
    SubagentManager -.->|notifies| Widget
```

### Key domain types

```mermaid
classDiagram
    class Subagent {
        +id: string
        +type: SubagentType
        +description: string
        -state: SubagentState
        -execution: SubagentExecution
        +status: SubagentStatus
        +result?: string
        +error?: string
        +toolUses: number
        +lifetimeUsage: LifetimeUsage
        +subagentSession?: SubagentSession
        +notification?: NotificationState
        +markRunning() delegates
        +markCompleted() delegates
        +run()
        +resume(prompt, signal)
        +abort(): boolean
        +steer(message): Promise~boolean~
        +isSessionReady(): boolean
        +getConversation(): string | undefined
        +getContextPercent(): number | null
        +subscribeToUpdates(fn): unsub | undefined
        +messages: readonly unknown[]
        +completeRun(result)
        +failRun(err)
        +disposeSession()
    }

    class SubagentState {
        +status: SubagentStatus
        +result?: string
        +error?: string
        +startedAt: number
        +completedAt?: number
        +toolUses: number
        +lifetimeUsage: LifetimeUsage
        +compactionCount: number
        +markRunning() ... markStopped()
        +resetForResume()
        +incrementToolUses()
        +addUsage(delta)
        +incrementCompactions()
    }

    class SubagentExecution {
        +createSubagentSession(params)
        +snapshot: ParentSnapshot
        +prompt: string
        +baseCwd: string
        +observer?: SubagentLifecycleObserver
        +getRunConfig?()
        +getWorkspaceProvider?()
        +model?, maxTurns?, thinkingLevel?
        +parentSession?, signal?
    }

    class SubagentManager {
        +spawn(snapshot, type, prompt, config)
        +spawnAndWait(snapshot, type, prompt, config)
        +resume(id, prompt, signal)
        +getRecord(id): Subagent
        +listAgents(): Subagent[]
        +abort(id)
    }

    class AgentTypeRegistry {
        +resolveType(type): string
        +resolveAgentConfig(type): AgentConfig
        +reload()
        +getToolNamesForType(type): string[]
    }

    class ParentSnapshot {
        +cwd: string
        +systemPrompt: string
        +model: unknown
        +modelRegistry: unknown
        +parentContext?: string
    }

    class SubagentsService {
        +spawn(type, prompt, options?)
        +getRecord(id): SubagentRecord
        +listAgents(): SubagentRecord[]
        +abort(id)
        +steer(id, message)
        +waitForAll()
        +hasRunning(): boolean
    }

    SubagentManager --> Subagent : creates/manages
    Subagent --> SubagentState : owns (private)
    Subagent --> SubagentExecution : runs via (mandatory)
    SubagentManager --> ParentSnapshot : receives at spawn
    SubagentsService --> SubagentManager : wraps via adapter
    SubagentManager --> AgentTypeRegistry : resolves types
```

## Agent lifecycle

```mermaid
stateDiagram-v2
    [*] --> queued : spawn (background, at capacity)
    [*] --> running : spawn (foreground or under limit)
    queued --> running : capacity available
    running --> completed : all turns finished
    running --> error : unhandled exception
    running --> aborted : abort() called
    running --> stopped : max turns reached
    running --> steered : steer message injected
    steered --> running : continues with message
    completed --> running : resetForResume
    stopped --> running : resetForResume
    error --> running : resetForResume
    aborted --> running : resetForResume
    completed --> [*]
    error --> [*]
    aborted --> [*]
    stopped --> [*]

    note right of running
        markCompleted, markAborted,
        markSteered, and markError
        are no-ops when status is stopped
    end note
```

Note: `markStopped` always succeeds regardless of current status.
Other terminal transitions guard against overwriting `stopped` — once an agent is stopped, only `resetForResume` can return it to `running`.

## Execution flow

```mermaid
sequenceDiagram
    participant LLM as Parent LLM
    participant Tool as subagent tool
    participant Spawn as spawn-config
    participant Mgr as SubagentManager
    participant Ag as Subagent
    participant Factory as createSubagentSession
    participant Asm as assembleSessionConfig
    participant Sub as SubagentSession
    participant Child as Child session

    LLM->>Tool: subagent(type, prompt, ...)
    Tool->>Spawn: resolveSpawnConfig(params)
    Spawn-->>Tool: ResolvedSpawnConfig
    Tool->>Mgr: spawn(snapshot, type, prompt, config)
    Mgr->>Ag: run()
    Ag->>Factory: createSubagentSession(params, deps)
    Factory->>Asm: assembleSessionConfig(type, ctx, opts, env, registry, io)
    Asm-->>Factory: SessionConfig
    Factory->>Child: create session + bind extensions
    Factory-->>Ag: SubagentSession (born complete)
    Note over Ag: record-observer subscribes to session events
    Ag->>Sub: runTurnLoop(prompt, opts)
    Sub->>Child: prompt + drive turn loop
    Child-->>Sub: result text
    Sub-->>Ag: TurnLoopResult
    Ag-->>Mgr: update Subagent
    Mgr-->>Tool: Subagent
    Tool-->>LLM: formatted result
    Note over Mgr: disposeSession() fires `disposed` at cleanup (resume-detectable)
```

## Module organization

The extension has 62 source files organized into six domains plus entry-point wiring.
All eight domains have directories: `config/`, `session/`, `lifecycle/`, `observation/`, `service/`, `tools/`, `ui/`, and `handlers/`.
Issue #164 moved the 26 previously flat root-level files into five new domain directories, reducing the root to 5 files + 8 directories.

### Current layout

```text
src/
├── index.ts                        entry point, tool registration, event wiring
├── runtime.ts                      SubagentRuntime factory (session-scoped state)
├── types.ts                        shared type definitions
├── settings.ts                     SettingsManager (persistent operational settings)
├── debug.ts                        debug logging utility
├── layered-settings.ts             loadLayeredSettings helper (published as @gotgenes/pi-subagents/settings)
│
├── config/                         agent type definitions and resolution
│   ├── agent-types.ts              AgentTypeRegistry class
│   ├── default-agents.ts           built-in agent configs (general-purpose, Explore, Plan)
│   ├── custom-agents.ts            user-defined agent .md file loader
│   └── invocation-config.ts        per-call config merge
│
├── session/                        session assembly and preparation
│   ├── session-config.ts           pure assembler (main entry)
│   ├── prompts.ts                  system prompt building
│   ├── content-items.ts            shared message content parsing (tool-call names, assistant content)
│   ├── context.ts                  parent conversation extraction
│   ├── conversation.ts             render a session's messages as formatted text
│   ├── env.ts                      git/platform detection
│   ├── model-resolver.ts           fuzzy model name resolution
│   └── session-dir.ts              session directory derivation
│
├── lifecycle/                      agent execution and state tracking
│   ├── subagent-manager.ts         collection manager + observer wiring
│   ├── create-subagent-session.ts  assembly factory: session creation, binding, tool filtering
│   ├── subagent-session.ts         born-complete child session: turn loop, steer, dispose
│   ├── turn-limits.ts              normalizeMaxTurns (turn-count policy)
│   ├── subagent.ts                 owns full execution lifecycle (run, abort, steer)
│   ├── subagent-state.ts           lifecycle status + metrics value object (transitions, accumulators)
│   ├── run-listeners.ts            per-run observer-unsub and signal-detach handles
│   ├── workspace-bracket.ts        child workspace prepare/dispose lifecycle
│   ├── concurrency-limiter.ts       background admission gate: schedules run thunks FIFO against the limit
│   ├── parent-snapshot.ts          immutable spawn-time parent state
│   ├── child-lifecycle.ts          child-execution lifecycle event publisher
│   ├── workspace.ts                workspace provider seam (generative extension surface)
│   └── usage.ts                    token usage tracking
│
├── observation/                    progress tracking and notification
│   ├── record-observer.ts          session-event stats observer
│   ├── notification.ts             completion nudges
│   ├── notification-state.ts       per-agent notification tracking
│   ├── renderer.ts                 notification TUI component
│   ├── composite-subagent-observer.ts fans manager notifications out to multiple observers
│   └── subagent-events-observer.ts manager lifecycle observer (event emission + persistence + notification)
│
├── service/                        cross-extension API boundary
│   ├── service.ts                  SubagentsService interface + Symbol.for() accessors
│   └── service-adapter.ts          SubagentsServiceAdapter class wrapping SubagentManager
│
├── tools/                          LLM-facing tool implementations
│   ├── agent-tool.ts               subagent tool definition, validation, dispatch
│   ├── result-renderer.ts          pure per-status result rendering
│   ├── spawn-config.ts             pure config resolution
│   ├── foreground-runner.ts        foreground execution loop
│   ├── background-spawner.ts       background spawn setup
│   ├── get-result-tool.ts          get_subagent_result tool
│   ├── steer-tool.ts               steer_subagent tool
│   └── helpers.ts                  shared tool utilities
│
├── ui/                             user-facing presentation
│   ├── agent-widget.ts             above-editor live status widget
│   ├── widget-renderer.ts          pure rendering for widget
│   ├── agent-menu.ts               /agents slash command menu
│   ├── agent-config-editor.ts      agent detail/edit view (AgentConfigEditor class)
│   ├── agent-creation-wizard.ts    agent creation (AgentCreationWizard class)
│   ├── conversation-viewer.ts      scrollable session overlay
│   ├── message-formatters.ts       pure per-message-type formatters (extracted from conversation-viewer)
│   ├── agent-file-ops.ts           filesystem abstraction
│   ├── agent-file-writer.ts        overwrite-guard + write + reload + notify helper
│   └── display.ts                  pure formatters and shared types
│
└── handlers/                       event handlers
    ├── index.ts                    barrel re-export
    ├── interrupt.ts                turn_start handler — abort all subagents on parent interrupt (ESC)
    ├── lifecycle.ts                session_start, session_before_switch, session_shutdown
    └── tool-start.ts               tool_execution_start handler
```

### Observation model

Record statistics (tool uses, token usage, compaction counts) and live activity (active tools, response text, turn counts) are updated by `record-observer.ts`, which subscribes directly to session events.
This is the single per-child session subscription — all run state lives on the `Subagent` record.

The widget reads agent state by polling the records exposed via `SubagentManager.listAgents()` every 80 ms; that poll loop is now started by the manager's lifecycle notifications (the widget subscribes as a `SubagentManagerObserver` fanned out through `CompositeSubagentObserver`), not by inbound calls from the spawn tools.
The conversation viewer subscribes to session events via `Subagent.subscribeToUpdates()` and reads messages via `Subagent.messages` — no direct `AgentSession` reference (#277).

## Cross-extension architecture

```mermaid
flowchart TD
    subgraph core["@gotgenes/pi-subagents"]
        direction TB
        exports["SubagentsService API<br/>publish / getSubagentsService<br/>SubagentRecord, SubagentStatus"]
        engine["Tools: subagent, get_subagent_result,<br/>steer_subagent<br/>SubagentManager, createSubagentSession, SubagentSession"]
        ui_int["Internal UI: widget, viewer,<br/>/agents menu"]
    end

    core -- "Symbol.for on globalThis" --> sched["scheduling extension<br/>(hypothetical)"]
    core -- "Symbol.for on globalThis" --> subui["pi-subagents-ui<br/>(deferred)"]
    core -- "Symbol.for on globalThis" --> future["any future extension"]
```

Consumers call `getSubagentsService()?.spawn(...)` at runtime.
They declare this package as an optional peer dependency and use dynamic import for compile-time types.

### What the core owns

- The three tools: `subagent` (née `Agent`), `get_subagent_result`, `steer_subagent`.
- `SubagentManager` — spawn, abort, resume, collection management, observer wiring.
- `ConcurrencyLimiter` — background admission gate: schedules run thunks FIFO against a configurable concurrency limit.
- `createSubagentSession` — assembly factory: session creation and extension binding; returns a born-complete `SubagentSession`.
- `SubagentSession` — the born-complete child session: drives the turn loop (`runTurnLoop`/`resumeTurnLoop`), steers, and disposes (firing `disposed` at true session disposal, so resume executions are registry-detected).
- `child-lifecycle` — publishes the child-execution lifecycle (`spawning`, `session-created` before `bindExtensions()`, `completed`, `disposed`) on `pi.events`.
  Reactive consumers subscribe: `@gotgenes/pi-permission-system` registers each child session on `session-created` and unregisters it on `disposed`.
  This replaced the former outbound `permission-bridge` (#261, [ADR-0002]) — the core no longer looks up a named consumer.
- `workspace` — the single generative seam (#262, [ADR-0002]): a registered `WorkspaceProvider` supplies a child's cwd plus bracketed `dispose()` at run-start.
  With no provider, children run in the parent cwd (default unchanged); the git worktree strategy lives behind this seam in `@gotgenes/pi-subagents-worktrees` (#263, the seam's first consumer).
- `session-config` — pure configuration assembler (called by `createSubagentSession`).
- `SubagentRuntime` — session-scoped state bag with methods.
- `ParentSnapshot` — immutable snapshot of parent session state, captured once at spawn time.
- `record-observer` — session-event observer that updates record statistics without callback threading.
- Agent type registry — default agents, custom `.md` file loading.
- Prompt assembly, context extraction, skills, environment.
- Worktree isolation — evicted to `@gotgenes/pi-subagents-worktrees` via the workspace provider seam in Phase 16 (#263, [ADR-0002]); `git` no longer appears in the core.
- Token usage tracking.
- Session directory derivation and persisted `SessionManager` for subagent transcripts.
- Settings persistence.
- Internal UI (widget, conversation viewer, `/agents` menu) — these stay until the API boundary is proven, then move to a separate extension.

### What the core dropped

- **Scheduling** (`schedule.ts`, `schedule-store.ts`, `ui/schedule-menu.ts`) — removed (#52).
- **Ad-hoc RPC** (`cross-extension-rpc.ts`) — replaced by the typed `SubagentsService` published via `Symbol.for()` (#49).
- **Group join** (`group-join.ts`) — removed (#49).
- **Output file** (`output-file.ts`) — replaced by `session-dir.ts` + `SessionManager.create()` (#61).
- **Callback threading** — the three-layer `on*` callback chain was replaced by direct session-event subscriptions (#100).
- **Live `ctx` capture** — replaced by `ParentSnapshot`, an immutable data object captured once at spawn time (#99).

## SubagentsService

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
- `SpawnOptions` — `description`, `model`, `maxTurns`, `thinkingLevel`, `inheritContext`, `foreground`, `bypassQueue`.
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

These are fire-and-forget broadcast events — no request IDs, no reply channels.

## Target architecture

The long-term architectural direction is to make pi-subagents a **minimal orchestrator** with inverted dependencies.
The core spawns a child session derived from the parent, runs the turn loop, tracks and streams and collects the result, gates concurrency, supports resume, and **publishes its lifecycle**.
Everything else — permissions, worktree/workspace isolation, UI, telemetry — is an extension that attaches through one of two surfaces and never reaches into the core.

The rationale and the full reasoning chain that led here are recorded in [`docs/decisions/0002-extensions-on-a-minimal-core.md`](../decisions/0002-extensions-on-a-minimal-core.md).

### Two extension surfaces

Extensions attach through exactly two surfaces, distinguished by the direction of information flow.

1. **Lifecycle events (observational) — unlimited.**
   The core emits awaited, ordered events for the child-execution lifecycle (`spawning`, `session-created` pre-`bindExtensions`, `completed`, `disposed`).
   Any number of extensions subscribe; handlers return nothing.
   Reactive concerns live here: permission detection, telemetry, UI, notifications.
   Adding a reactive concern never modifies the core.
2. **Provider seams (generative) — rationed.**
   The rare concern that must _inject_ a value the core consumes synchronously registers a provider the core consults.
   Today there is exactly one: the **workspace provider** (returns the child's working directory plus bracketed setup/teardown).
   A provider seam is the only place the core is "open," so the list is kept as small as possible.

The discriminator when deciding how a concern attaches:

- It only needs to **know** what happened → subscribe to a lifecycle event (observational, unlimited).
- It must **return a value the core consumes** → register a provider (generative, rationed).

The governing rule — **no vacant hooks**: the architecture must _admit_ a seam without _shipping_ it until a concrete consumer exists.
A provider seam with no consumer is a speculative abstraction that taxes every reader and that `fallow` flags as dead.
Latent extensibility is the deliverable; a vacant hook is not.

The [first-principles refinement](#first-principles-refinement-and-the-deeper-target) below sharpens this two-surface split.
The awaited, behavior-affecting lifecycle events (notably `session-created` before `bindExtensions`) are _hooks_ — the child's own extension surface applied recursively, generative because the core waits on the handler before deciding what to do next.
The observational surface then carries only fire-and-forget broadcasts of immutable snapshots, which no consumer can use to change the core.

### Core responsibilities (keep)

- **Agent definitions** — name, model, thinking, system prompt, tools list.
- **Prompt composition** — system prompt assembly.
- **Session lifecycle** — create child sessions, bind extensions, run conversation loop, track results.
- **Concurrency management** — queue, abort, resume, max concurrency.
- **Recursion guard** — remove pi-subagents' own three tools from child sessions (prevent infinite nesting).
  With `isolated` removed (#264), children always load the parent's resources, so the guard is unconditional rather than gated on `cfg.extensions`.
  This is the core defending its own invariant, keyed off its own tool names — not policy.
- **Lifecycle events** — emit awaited, ordered events when child sessions spawn, are created, complete, and are disposed.
- **Workspace provider seam** — accept a registered `WorkspaceProvider` and consult it for the child's cwd; default to the parent's cwd when none is registered.
- **Service API** — publish `SubagentsService` via `Symbol.for()` for cross-extension access.

### Responsibilities to remove

- **Tool policy** (`disallowed_tools`) — access control belongs in pi-permission-system's `permission:` frontmatter.
- **Extension filtering** (`extensions: string[]` allowlist) — tool visibility is pi-permission-system's job.
- **Worktree isolation** (`worktree.ts`, `worktree-isolation.ts`, `GitWorktreeManager`, the `isolation: "worktree"` spawn mode) — environment policy, not core.
  Git worktrees are one _strategy_ for choosing the child's working directory; containers, throwaway tmpdirs, and remote sandboxes are others.
  Evicted to `@gotgenes/pi-subagents-worktrees` (#263), the first consumer of the workspace provider seam.
- **Extension lifecycle control** (`extensions: false`, `isolated`, `noSkills`) — removed in #264.
  Deny-at-use (the in-child permission layer blocking disallowed tool calls) covers what `isolated` pretended to do for tools.
  Prevent-load (refusing to bind an extension because of load-time side effects, cost, or true sandboxing) is genuinely generative and is left as a _latent_ (un-built) provider seam, added only if a real consumer needs it.

### Composition model

In the target state, pi-subagents publishes events and a provider seam; other packages hook in:

- **pi-permission-system** (observational) subscribes to child-session lifecycle events, detects subagent execution context in the child, and gates tool calls at runtime.
- **pi-subagents-worktrees** (generative) registers a `WorkspaceProvider` that prepares a git worktree at run-start and tears it down after, supplying the child's cwd.
- **pi-subagents-ui** (future, under reconsideration — see the [first-principles refinement](#first-principles-refinement-and-the-deeper-target)) subscribes to the broadcast and the query/behavior interfaces; whether the inherited widget, conversation viewer, and `/agents` menu survive is judged on our principles, not preserved by default.
- **Any future extension** (OTel, auditing, cost tracking) subscribes to the same events without pi-subagents knowing.

Composition test: install neither extension, only permissions, only workspaces, or both — the core is byte-for-byte identical in all four cases, and the two extensions never reference each other.

This is achieved across phases: Phase 14 (strip policy), Phase 16 (invert dependencies — extensions on a minimal core), and Phase 18 (reconsider UI).

### First-principles refinement and the deeper target

The two-surface model above is correct but coarse.
Pushing it against our own principles — construct complete, state owns its mutations, tell-don't-ask, dependency inversion — surfaces sharper boundaries that the current code draws through the middle of classes.
This subsection records the deeper target; the steps that realize it are sequenced in later phases.

#### `Subagent` is four conflated domains

The construction duality that motivates Phase 17 — a class that is simultaneously a passive record and an executor — is only the two most visible of four domains fused into one class.
Pulling each apart by asking "who changes this, how often, and who needs to know" surfaces:

1. **Lifecycle state** — status, result, error, timestamps.
   Owned by the subagent; transitions are rare and meaningful; the right outward shape is an immutable snapshot announced on change.
2. **Metrics** — tool uses, token usage, compaction count.
   These are not lifecycle state; they are a projection aggregated over the child session's event stream.
   `record-observer` already computes them — its only error is writing the aggregate back onto the subagent.
3. **The hook surface** — the points where an extension alters or augments the child before and around its run.
   This is the child session's own extension binding (see below), not data on the subagent.
4. **Result delivery** — whether the parent has consumed the result, when to nudge, how the result reaches the caller.
   The homeless `notification.resultConsumed` field belongs to this domain, not to execution.

The ~20 optional constructor fields and the runtime `run()` throws are the pressure these four domains exert on one class.
Separating them is what makes the Phase 17 steps fall out rather than fight back.

#### The subagent is a recursive Pi

A subagent is a child Pi session: created with `createAgentSession`, then `bindExtensions`.
Its extension surface is therefore Pi's extension surface applied recursively — not a bespoke event bus.
What the current doc calls "awaited, ordered lifecycle events" are not observations; they are **hooks**, structurally identical to Pi's own (`session_start`, `tool_execution_start`).
The tell is the awaiting: the core waits for the handler because the handler's completion changes what the core does next — an extension registers before the child binds.
A handler that can change subsequent behavior is generative, not observational, whatever we name the channel.

This splits the current "lifecycle events" surface cleanly in two:

1. **Broadcast** (observational, fire-and-forget) — "this happened; react if you want; you cannot change anything."
   Carries immutable snapshots for telemetry, notification, and any renderer.
   No consumer holds a live `Subagent`.
2. **Hooks** (generative, awaited, ordered) — the recursive Pi extension surface where workspace, permissions, and future concerns attach to the child.
   The `WorkspaceProvider` is one _typed_ hook; the general form is "be an extension of the child session."

The "no vacant hooks" rule still governs the generative side: admit the surface, ship a hook only when a real consumer exists.

#### Reactive versus discrete (not internal versus external)

The axis that decides push versus pull is whether a need is reactive or discrete — never whether the consumer is in-package or out.

- **Reactive** (ambient state that changes underneath you) → subscribe to the broadcast; be told.
  The state-owner announces; the consumer maintains its own read-model; nobody pulls.
- **Discrete** (a one-shot question: current value, full transcript) → pull a query.
  `get_subagent_result`, opening a transcript, and the external `SubagentsService.getRecord` are queries by nature and stay pull, in-package or not.

Behavior is a third interface: **tell by id, with outcomes**.
`steer` and `abort` own their own rules — a non-running agent rejects a steer from inside `steer`, not via a caller's status pre-check — so coordinators never ask-then-tell.

#### Consequences

Two consequences fall straight out, and both cut scope.

1. **The activity/metrics push tier is provisional.**
   Its only reactive consumer is the inherited widget.
   Treated from first principles, metrics are accumulated by an observer, exposed as a discrete query, and folded into the completion snapshot — so the high-frequency stream may not need to exist at all.
   We do not contort the core's event design to feed an inherited consumer.
2. **Phase 18 is "reconsider the UI," not "extract the UI."**
   The widget and `/agents` menu predate the fork; they are consumers to be judged on our principles, not requirements to preserve.
   If a UI survives, it survives as a reactive consumer of the broadcast and a caller of the query/behavior interfaces — built on our terms, possibly smaller, possibly removed.

#### Sibling packages follow the same discipline

`@gotgenes/pi-permission-system` is one of these hooks, and it is subject to the same scrutiny.
Its boundaries deserve the same first-principles treatment: surface its conflated domains, distinguish what it observes from what it injects, and prefer being told over asking.
The recursion principle means a consumer's internal design is not exempt because it lives in another package — the same axes (reactive versus discrete, hook versus broadcast, construct complete) apply across the seam.

#### How we find these boundaries

The boundaries above were not deduced top-down; they were surfaced by friction.
Each place the target got _harder_ to test marked a domain seam drawn through the middle of a class.
That method — testability friction as a boundary probe, with its limits — is recorded in the `improvement-discovery` skill so it outlives this phase.

## Current structural analysis

### Health metrics

| Metric                     | Value                                        |
| -------------------------- | -------------------------------------------- |
| Health score               | 78/100 (B)                                   |
| Total LOC                  | 7,751 (62 files, end of Phase 17)            |
| Dead code                  | 0 files, 0 exports                           |
| Maintainability index      | 90.8 (good)                                  |
| Avg cyclomatic complexity  | 1.4                                          |
| P90 cyclomatic complexity  | 2                                            |
| Production duplication     | 11 lines (1 internal clone group)            |
| Test duplication           | 28 clone groups, 503 lines (end of Phase 17) |
| Fallow refactoring targets | 0                                            |

### Dependency bag inventory

These interfaces carry hidden dependencies that obscure true coupling.
Bags with 10+ fields are the highest priority for decomposition.

| Interface                     | Fields                                                       | Consumers                                         | Severity  |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------- | --------- |
| `ResolvedSpawnConfig`         | 3 nested                                                     | foreground-runner, background-spawner, agent-tool | ✓ done    |
| `AgentSpawnConfig`            | 13 → 13 (ParentSessionInfo nested)                           | agent-manager (internal)                          | ✓ done    |
| `CreateSubagentSessionParams` | 6 (snapshot, type, cwd, parentSession, model, thinkingLevel) | create-subagent-session                           | ✓ done    |
| `TurnLoopOptions`             | 4 (maxTurns, defaultMaxTurns, graceTurns, signal)            | subagent-session                                  | ✓ done    |
| `SessionConfig`               | 6 (flat fields; extensions/noSkills/extras removed in #264)  | session-config (output of assembler)              | ✓ done    |
| `NotificationDetails`         | 10                                                           | notification                                      | Low (DTO) |
| `ResourceLoaderOptions`       | 10                                                           | create-subagent-session (SDK bridge)              | Low (SDK) |
| `SubagentSessionIO`           | split → `EnvironmentIO` (3) + `SessionFactoryIO` (5+1)       | create-subagent-session                           | ✓ done    |
| `CreateSessionOptions`        | 9                                                            | create-subagent-session (SDK bridge)              | Low (SDK) |
| `AgentToolDeps`               | 8                                                            | agent-tool                                        | ✓ done    |
| `AgentMenuDeps`               | 8                                                            | agent-menu                                        | ✓ done    |
| `ConversationViewerOptions`   | 8                                                            | conversation-viewer                               | Low       |
| `SubagentInit`                | 5 (id, type, description, invocation, execution, state)      | subagent (one production site)                    | ✓ done    |
| `SubagentExecution`           | 12 (4 mandatory: factory, snapshot, prompt, baseCwd)         | subagent (mandatory collaborator)                 | ✓ done    |

### Complexity hotspots

Functions with cyclomatic complexity ≥ 21 (critical threshold):

No functions remain above the critical threshold — all hotspots resolved in Phase 12. 6 functions remain at HIGH severity (CRAP ≥ 65); 13 at moderate.

### Churn hotspots

Files with highest commit frequency × complexity:

| Score | File                        | Commits | Trend          |
| ----- | --------------------------- | ------- | -------------- |
| 65.0  | `index.ts`                  | 128     | ▲ accelerating |
| 9.1   | `ui/agent-widget.ts`        | 13      | ▼ cooling      |
| 8.4   | `ui/conversation-viewer.ts` | 11      | ─ stable       |
| 6.4   | `runtime.ts`                | 12      | ─ stable       |
| 3.3   | `settings.ts`               | 4       | ─ stable       |
| 2.9   | `handlers/lifecycle.ts`     | 11      | ─ stable       |

Most files have cooled to stable after 13 phases of structural work.
`index.ts` remains the sole accelerating hotspot — expected as the wiring entry point for each refactoring phase.

### Production duplication

The prior clone group between `agent-runner.ts` and `message-formatters.ts` was resolved in #172.
The 20-line clone group between `agent-config-editor.ts` and `agent-creation-wizard.ts` was resolved in #217 — extracted into `ui/agent-file-writer.ts` (`writeAgentFile`).
One 11-line internal clone group remains within `agent-config-editor.ts` (lines 135–145 / 173–183).

### Session encapsulation debt (Law of Demeter) — resolved by [#277] ✔️

All consumer reach-throughs to the raw SDK `AgentSession` via `Subagent.session` have been eliminated.
`Subagent.session` is removed; `SubagentSession.session` is marked `@internal` (lifecycle use only).
The intent-revealing replacements added by [#277]:

| Reach-through                            | Sites                                                                              | Replacement                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| Steer buffer-or-deliver (was duplicated) | `service-adapter.ts`, `steer-tool.ts`                                              | `Subagent.steer(message)`                          |
| Conversation viewing                     | `get-result-tool.ts`, `agent-menu.ts`, `conversation-viewer.ts`                    | `Subagent.getConversation()` / `Subagent.messages` |
| Session-readiness guard                  | `agent-tool.ts`, `subagent-manager.ts`                                             | `Subagent.isSessionReady()`                        |
| Context-window stats                     | `steer-tool.ts`, `get-result-tool.ts`, `notification.ts`, `conversation-viewer.ts` | `Subagent.getContextPercent()`                     |
| Live updates (subscription)              | `conversation-viewer.ts`                                                           | `Subagent.subscribeToUpdates(fn)`                  |
| Observer callback session param          | `background-spawner.ts`, `foreground-runner.ts`                                    | `subagent.subagentSession` (narrowed callback)     |
| Session disposal                         | `subagent-manager.ts`                                                              | `SubagentSession.dispose()` — resolved by [#265]   |

### Proposed bag decompositions

#### ResolvedSpawnConfig (15 fields → 3 value objects)

This bag mixes three concerns: who the agent is, how it should run, and how it should be displayed.
Each consumer uses a different subset.

```typescript
/** Who this agent is — type resolution result. */
interface SpawnIdentity {
  subagentType: string;
  rawType: SubagentType;
  fellBack: boolean;
  displayName: string;
}

/** How the agent should run — execution parameters. */
interface SpawnExecution {
  prompt: string;
  description: string;
  model: Model<any> | undefined;
  effectiveMaxTurns: number | undefined;
  thinking: ThinkingLevel | undefined;
  inheritContext: boolean;
  runInBackground: boolean;
  agentInvocation: AgentInvocation;
}

/** How the agent is presented — display metadata. */
interface SpawnPresentation {
  modelName: string | undefined;
  agentTags: string[];
  detailBase: Pick<AgentDetails, ...>;
}
```

`foreground-runner` and `background-spawner` primarily consume `SpawnExecution` + `SpawnIdentity`.
`agent-tool` uses all three to build the `AgentSpawnConfig` and the result text.
After decomposition, each consumer declares its real dependencies explicitly.

#### AgentSpawnConfig — ParentSessionInfo extracted (done, [#166][166])

The `parentSessionFile`, `parentSessionId`, and `toolCallId` fields were grouped into `ParentSessionInfo`:

```typescript
/** Parent session identity — always travel together from the tool boundary. */
export interface ParentSessionInfo {
  parentSessionFile?: string;
  parentSessionId?: string;
  toolCallId?: string;
}
```

`AgentSpawnConfig` now carries `parentSession?: ParentSessionInfo` instead of three flat optional fields.

#### RunOptions (12 fields → extract RunContext) — done ([#169][169]), updated by [#231]

`RunContext` was extracted and nested as `RunOptions.context` in #169.
Issue #231 moved the two static dependencies (`exec`, `registry`) to `RunnerDeps` on `ConcreteAgentRunner`, leaving `RunContext` with only per-call fields:

```typescript
/** Per-call execution context — fields that vary per spawn. */
export interface RunContext {
  cwd?: string;
  parentSession?: ParentSessionInfo;
}
```

The remaining `RunOptions` fields (`model`, `maxTurns`, `signal`, `thinkingLevel`, `defaultMaxTurns`, `graceTurns`, `onSessionCreated`) are genuine execution parameters.
`RunOptions` now has 9 fields: 1 nested `context: RunContext` (2 per-call fields) plus 8 flat execution fields.

#### SessionConfig (11 fields → extract ToolFilterConfig) — done ([#168][168])

The tool-filtering cluster (`toolNames`, `disallowedSet`, `extensions`) was extracted into `ToolFilterConfig` and nested as `SessionConfig.toolFilter`.
`filterActiveTools` now accepts a single `ToolFilterConfig` argument instead of three positional parameters.
`SessionConfig` reduced from 10 to 8 top-level fields.

#### RunnerIO (9 methods → 2 focused interfaces) — done ([#167][167])

The IO boundary was split into two focused interfaces:

```typescript
/** Environment discovery — detect runtime context and resolve directories. */
export interface EnvironmentIO {
  detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
  getAgentDir: () => string;
  deriveSessionDir: (
    parentSessionFile: string | undefined,
    effectiveCwd: string,
  ) => string;
}

/** Session factory — create SDK objects for a child agent session. */
export interface SessionFactoryIO {
  createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  createSessionManager: (cwd: string, sessionDir: string) => SessionManagerLike;
  createSettingsManager: (cwd: string, agentDir: string) => SettingsManager;
  createSession: (
    opts: CreateSessionOptions,
  ) => Promise<{ session: AgentSession }>;
  assemblerIO: AssemblerIO;
}

/** Backward-compatible intersection of the two focused interfaces. */
export type RunnerIO = EnvironmentIO & SessionFactoryIO;
```

`RunnerIO` is kept as a type alias for the intersection.
All existing consumers satisfy both sub-interfaces via structural typing with no call-site changes.

## Phase 11 (complete)

Phase 11 converted all closure factories to classes, eliminating adapter closure density in `index.ts`.
Four layers: SessionContext typing → runtime query methods → interface alignment → class conversions → index.ts simplification.
See [phase-11-closure-to-class.md](history/phase-11-closure-to-class.md) for details.

## Phase 12 (complete)

Phase 12 decomposed the three remaining high-complexity UI functions and extracted shared test fixtures.
All four steps are closed: [#205], [#206], [#207], [#208].

## Phase 13 (complete)

Phase 13 addressed remaining closure factories, the last fallow refactoring target, oversized methods, production duplication, SDK boundary coupling, and test clone families.
All six steps are closed: [#214], [#215], [#216], [#217], [#218], [#219].
See [phase-13-remaining-smells.md](history/phase-13-remaining-smells.md) for details.

## Phase 14 (complete)

Phase 14 removed tool and extension policy enforcement from pi-subagents, eliminating overlap with pi-permission-system.
All four steps are closed: [#237], [#238], [#239], [#242].
See [phase-14-strip-policy.md](history/phase-14-strip-policy.md) for details.

[#237]: https://github.com/gotgenes/pi-packages/issues/237
[#238]: https://github.com/gotgenes/pi-packages/issues/238
[#239]: https://github.com/gotgenes/pi-packages/issues/239
[#242]: https://github.com/gotgenes/pi-packages/issues/242

## Phase 15 (complete)

Phase 15 evolved `Agent` from a passive state machine (`AgentRecord`) into an object that owns its entire execution lifecycle.
Before Phase 15, `AgentManager` orchestrated everything: calling the runner, handling session creation, wiring observers, and cleaning up worktrees — reaching into Agent 10+ times across `spawn()` and `startAgent()`.
After Phase 15, Agent is born complete with all dependencies and configuration, owns `run()` and `resume()`, and manages its own observer and worktree lifecycle.
All six steps are closed: [#227], [#228], [#231], [#229], [#230], [#232].
See [phase-15-domain-model-evolution.md](history/phase-15-domain-model-evolution.md) for details.

## Phase 16 (complete)

Phase 16 inverted the core's outbound dependencies: worktree isolation joined permissions as an _extension_ on a minimal core, leaving pi-subagents a pure child-session orchestrator.
The core now attaches extensions through exactly two surfaces — observational lifecycle events (unlimited) and rationed generative provider seams (today only the workspace provider) — and has zero knowledge of its consumers.
The "runner" concept is gone: `createSubagentSession()` returns a born-complete `SubagentSession` that owns turn driving, steering, and disposal, and `Subagent.run()` is coordination, not assembly.
The decision and the full reasoning chain are recorded in [ADR-0002]; the two-surface extension model is described under [Target architecture](#target-architecture).
All five steps are closed: [#261], [#262], [#263], [#264], [#265].
The earlier "agent collaborator architecture" framing (#256 superseded, #257 parked, #258 and #259 closed not-planned) was abandoned; its structural win was reached cleanly via the workspace seam.
See [phase-16-invert-dependencies.md](history/phase-16-invert-dependencies.md) for details.

## Phase 17 (complete)

Phase 17 consolidated the core's remaining structural debt before the UI reconsideration (Phase 18).
The `Subagent` record/executor duality was resolved by extracting `SubagentState` (status, result, timestamps, metrics) into a private owned value object and making `SubagentExecution` a mandatory constructor collaborator — eliminating ~20 optional fields and the two "not configured for execution" runtime throws.
The concurrency queue was replaced with a thunk-based `ConcurrencyLimiter` that knows nothing about agents or IDs.
Run collaborators (`RunListeners`, `WorkspaceBracket`) were extracted from the 455-LOC `Subagent` class.
The inline `SubagentManagerObserver` literal was promoted to `SubagentEventsObserver`, making its three concerns (event emission, record persistence, notification dispatch) unit-testable in isolation.
Widget delegation and the post-construction `runtime.widget =` write were removed from `SubagentRuntime` by dissolving the notification→widget cycle via `AgentWidget.seedFinishedAgents`.
Lifecycle, UI/tools, and cross-package test fixture clones were consolidated.
`loadLayeredSettings<T>` was extracted to `src/layered-settings.ts` and published via the `@gotgenes/pi-subagents/settings` subpath export, eliminating the 23-line production clone with `pi-subagents-worktrees`.
All nine steps are closed: [#381], [#373], [#374], [#375], [#376], [#377], [#378], [#379], [#380].
[#412] unified the overlapping session-mock builders identified during Step 7.
[#415] migrated `pi-subagents-worktrees` to `loadLayeredSettings` after the Step 9 published release.
See [phase-17-core-consolidation.md](history/phase-17-core-consolidation.md) for the full findings, step outcomes, dependency diagram, and tracks.

## Phase 18 Reconsider UI from first principles

After 17 phases the core is in very good shape: health 78/100 (B), zero dead code, zero fallow refactoring targets, average cyclomatic 1.4.
The one structural debt that remains is not spread thin across the core — it is concentrated in a single place: the UI's live-streaming state (the "activity tier") is woven into the core's runtime, spawn tools, the LLM-facing `subagent` tool, and the notification path.
This is the entanglement the [first-principles refinement](#first-principles-refinement-and-the-deeper-target) predicted — "the activity/metrics push tier is provisional; its only reactive consumer is the inherited widget" — observed in the code.
Disentangling it is what lets the core reach a great state, and it is the prerequisite to any "reconsider the UI" decision: today the UI cannot be a clean consumer because the core does its streaming bookkeeping for it.

### Findings

Six findings tell one story — the activity tier has metastasized out of the UI and into the core.

1. **UI state lives on the core runtime.**
   `SubagentRuntime.agentActivity: Map<string, AgentActivityTracker>` puts a UI streaming-state map on the core composition root.
   `SubagentRuntime` owns session-scoped lifecycle state; `AgentActivityTracker` (active tools, response text, turn count) is pure rendering state the core never reads.
   Category C (coupling).
2. **Core spawn tools wire UI streaming.**
   `foreground-runner.ts` and `background-spawner.ts` construct `AgentActivityTracker`, call `subscribeUIObserver` (a second session subscription parallel to the core's own `record-observer`), call `setSession`, and populate or delete the activity map and drive the widget (`ensureTimer`, `update`, `markFinished`).
   Their own doc comments list "AgentActivityTracker creation, UI observer subscription" as responsibilities.
   Category C (mixed responsibility, parameter relay).
3. **The LLM-facing tool depends on the widget.**
   `AgentTool` takes a 4-method `widget` dependency plus `runtime.agentActivity` and calls `this.widget.setUICtx(ctx.ui)`.
   Every `AgentTool` unit test must stub the widget and the activity map (`createToolDeps`), although the tool's real concern is dispatch — testability friction marking a domain seam.
   Category C/D.
4. **Two parallel observers split the run-metric domain.**
   Each child session gets two subscriptions: `record-observer` accumulates `SubagentState` (tool uses, usage, compactions) and `ui-observer` accumulates `AgentActivityTracker` (active tools, response text, turn count).
   `turnCount` is a genuine run metric that lives only in the UI tracker, so `notification.ts` and the foreground result text reach into the tracker to recover it.
   Category C (anemic split, duplication).
5. **A core observation concern reaches into UI state.**
   `NotificationManager` holds the activity map and reads `turnCount`/`maxTurns` from it to build notification details, and deletes entries from it.
   Category C (Law of Demeter).
6. **The public event contract is both vacant and incomplete.**
   `SUBAGENT_EVENTS.ACTIVITY = "subagents:activity"` is declared in the service surface and the doc's lifecycle-events table but is never emitted anywhere — a vacant hook the doc's own "no vacant hooks" rule forbids.
   Meanwhile three emitted channels (`subagents:failed`, `subagents:compacted`, `subagents:created`) are absent from the constant map.
   Category A/E.

### Health metrics

| Metric                                   | Value                                                              |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Health score                             | 78/100 (B)                                                         |
| Source LOC                               | 7,751 (62 files)                                                   |
| Dead code                                | 0 files, 0 exports                                                 |
| Maintainability index                    | 90.9 (good)                                                        |
| Avg cyclomatic complexity                | 1.4                                                                |
| P90 cyclomatic complexity                | 2                                                                  |
| Fallow refactoring targets               | 0                                                                  |
| Production duplication                   | 11 lines (1 internal clone group in `agent-config-editor.ts`)      |
| Test duplication                         | 28 clone groups, 503 lines                                         |
| Activity-tier modules slated for removal | `ui-observer.ts` (61) + `agent-activity-tracker.ts` (84) = 145 LOC |

### Steps

The spine (Steps 1–5) removes the activity-tier entanglement, leaving the core a pure orchestrator whose run state lives in one place and whose UI is a reactive consumer of broadcast events plus discrete queries.
Steps 6–7 are independent hygiene.
Step 8 is the user-driven UI reconsideration the disentangled core finally makes possible — a decision about the UI's distribution once it is substitutable, not optional.

The deeper target in the [first-principles refinement](#first-principles-refinement-and-the-deeper-target) — metrics as a pure observer projection rather than mutable fields — is deliberately **not** forced here.
Folding the live activity onto the record (the single owner of run state, consistent with Phase 17's `SubagentState`) removes the duplication without inventing the asynchronous-observation seam the `improvement-discovery` skill warns is essential, not structural.

1. **✅ Fold run metrics and live activity onto the core record (pure addition) — complete (v16.5.0).**
   ([#420]) Target: `lifecycle/subagent-state.ts`, `observation/record-observer.ts`, `lifecycle/subagent.ts`.
   Extend the single owned run-state value object with `turnCount`, active tools, and response text; have the already-subscribed `record-observer` handle `turn_end`, `tool_execution_start`, `message_start`, `message_update`; expose read-only `turnCount`/`maxTurns`/`activeTools`/`responseText` getters on `Subagent`.
   `AgentActivityTracker` still exists; nothing reads the new getters yet (tidy-first).
   Smell: Category C. Outcome: `Subagent` is the single home for all run state; getters available for migration.
   Landed: `SubagentState` owns `turnCount`/`activeTools`/`responseText` plus their transition methods; `record-observer` populates them on a single subscription; `Subagent` exposes the four read-only getters; +27 tests (1031 → 1058).
2. **✅ Migrate every activity reader to the record getters — complete.**
   ([#421]) Target: `ui/widget-renderer.ts`, `ui/conversation-viewer.ts`, `ui/agent-menu.ts`, `tools/foreground-runner.ts`, `observation/notification.ts`.
   Switch each reader from `AgentActivityTracker` to the record getters added in Step 1 (widget-renderer reads activity off `listAgents()`; viewer/menu drop the `activity` param; notification reads `turnCount`/`maxTurns` off the record).
   Smell: Category C (Law of Demeter).
   Outcome: no consumer references `AgentActivityTracker`.
   Landed: `WidgetAgent` folds the live-activity fields and a `contextPercent` projection; `AgentWidget` projects records; `ConversationViewer`, `AgentsMenuHandler`, `buildDetails`, and `buildNotificationDetails` read off the record; `NotificationSystem.cleanupCompleted` removed; `SubagentEventsObserver` returns early on consumed results; +8 tests (1058 → 1066).
3. **✅ Delete `AgentActivityTracker` and `ui-observer`; drop the activity map from the runtime and spawn tools — complete.**
   ([#422]) Target: `ui/agent-activity-tracker.ts` (delete), `ui/ui-observer.ts` (delete), `runtime.ts`, `tools/foreground-runner.ts`, `tools/background-spawner.ts`.
   The spawn tools stop constructing trackers, subscribing, and populating maps; `SubagentRuntime.agentActivity` is removed.
   Smell: Category A + C. Outcome: −145 LOC, one session subscription per child, runtime holds zero UI state.
   Landed: deleted `agent-activity-tracker.ts` (84) + `ui-observer.ts` (61) and their unit suites; dropped the `agentActivity` parameter from `runForeground`/`spawnBackground`, the `AgentActivityAccess` interface, and the `AgentToolRuntime`/`SubagentRuntime` activity-map fields; the foreground `observer.onSessionCreated` keeps `recordRef`/`fgId` binding and `widget.ensureTimer`; −34 tests (1066 → 1032).
4. **✅ Make the widget self-drive from lifecycle events — complete.**
   ([#423]) Target: `ui/agent-widget.ts`, `observation/composite-subagent-observer.ts` (new), `index.ts`.
   The widget starts/stops its timer in response to started/created/completed notifications instead of tool calls; spawn tools no longer call `ensureTimer`/`update`/`markFinished`.
   Smell: Category C (coupling direction).
   Outcome: the widget is a reactive consumer; no inbound calls from core spawn tools.
   Landed: `AgentWidget implements SubagentManagerObserver` (starts the 80 ms loop on `onSubagentStarted`/`onSubagentCreated`, re-renders on `onSubagentCompleted`/`onSubagentCompacted`); a new `CompositeSubagentObserver` fans the manager's single observer slot out to `[eventsObserver, widget]` (wired in `index.ts`, keeping `SubagentManager` unchanged); dropped the `widget` parameter and `ForegroundWidgetDeps`/`BackgroundWidgetDeps` interfaces from both spawners, deleted `AgentWidget.markFinished` (redundant with `seedFinishedAgents`), made `ensureTimer` private, and narrowed `AgentToolWidget` to `setUICtx`; +11 tests (1032 → 1043, then −4 with the dropped spawner widget-driving tests → 1039).
5. **Drop the widget and activity-map dependencies from the `subagent` tool.**
   ([#424]) Target: `tools/agent-tool.ts`, `test/helpers/make-deps.ts`.
   `AgentTool` loses its `widget` and `agentActivity` constructor params (UICtx capture stays in `ToolStartHandler`); `createToolDeps` sheds the widget and map stubs.
   Smell: Category C/D.
   Outcome: the LLM tool depends only on manager/runtime/settings/registry; fixture drops 2 fields.
6. **Reconcile the public event contract.**
   ([#425]) Target: `service/service.ts`, this document's lifecycle-events table.
   Remove the vacant `ACTIVITY` channel (or emit a real broadcast for it) and add the emitted `failed`/`compacted`/`created` channels so declared constants match emitted events.
   Smell: Category A/E.
   Outcome: declared channels equal emitted channels; no vacant hook.
7. **Consolidate residual test clone families.**
   ([#426]) Target: `test/settings.test.ts` + `test/layered-settings.test.ts`, `test/lifecycle/create-subagent-session.test.ts`, `test/ui/agent-config-editor.test.ts`.
   Extract shared fixtures for the clone families fallow reports that the spine does not already rewrite.
   Smell: Category D. Outcome: test clone groups drop below 15.
8. **Reconsider the UI direction (first-principles ADR).**
   ([#427]) Target: `docs/decisions/`, `ui/`.
   The spine already made the UI _substitutable_; this step decides its _distribution_, not whether the experiment is possible.
   The goal is **substitutable, not optional**: a human needs some surface, but the specific UI is replaceable — the way Pi ships a default TUI built on the same public API any extension targets.
   The disentangled core stays byte-for-byte identical whether or not a given UI consumer is installed (the composition test), so a replacement UI is a downstream concern even though _some_ UI is not.
   Unlike the worktrees provider seam (generative, rationed — one provider the core consults), the UI is an observational consumer (unlimited, the core never waits on it) reading the broadcast-plus-query surface, which is why packaging it is the secondary question and decoupling it was the real win.
   Two standing concerns are the evidence this decision weighs and the better boundaries the reconsideration is meant to surface:
   - **Truncated transcript.**
     The conversation viewer shows a truncated view, yet `Subagent.messages` already exposes the full history and the core already persists each child as a standard Pi session JSONL (`outputFile`) — the limit is the bespoke overlay's rendering, not data access.
   - **Foreground widget redundancy.**
     In foreground the tool's inline `onUpdate` stream already shows progress, so the above-editor widget duplicates it; the widget earns its keep only for background agents — a per-mode judgment the fused UI cannot vary.
   Candidate redesign to record: replace the bespoke overlay with "open the child session in the same viewer Pi uses for any session," following the recursive-Pi insight and the already-persisted session file.
   Judge the widget, conversation viewer, and `/agents` menu per component — keep, shrink, extract to `@gotgenes/pi-subagents-ui`, or remove — and capture the decision in an ADR that gateways Phase 19.
   Smell: Category E (organization / boundary).
   Outcome: a recorded per-component decision motivated by the two concerns; the inherited UI is substitutable and no longer preserved by default.

### Step dependency diagram

```mermaid
flowchart TB
    S1["1 — Fold metrics + activity onto record (#420) ✅"]
    S2["2 — Migrate readers to record getters (#421) ✅"]
    S3["3 — Delete tracker + ui-observer, drop activity map (#422) ✅"]
    S4["4 — Widget self-drives on events (#423) ✅"]
    S5["5 — Drop widget dep from subagent tool (#424)"]
    S6["6 — Reconcile public event contract (#425)"]
    S7["7 — Consolidate test clone families (#426)"]
    S8["8 — Reconsider UI direction, ADR (#427)"]

    S1 --> S2 --> S3 --> S4 --> S5 --> S8
    S6
    S7
```

### Parallel tracks

- **Track A — Disentangle the activity tier (spine):** Steps 1, 2, 3.
  Strictly ordered; each is a safe lift-and-shift over the previous.
- **Track B — Decouple widget and tool wiring:** Steps 4, 5.
  Begins once the activity map is gone (Step 3).
- **Track C — Public-contract hygiene:** Step 6.
  Independent; can land any time.
- **Track D — Test consolidation:** Step 7.
  Independent; can land any time.
- **Track E — UI reconsideration:** Step 8.
  Gated on the spine and Track B (the UI must be a clean consumer first).

## Refactoring history

Phases 1–5, 7–17 are complete.
Phase 6 (UI extraction to a separate package) is deferred → Phase 18.
Detailed records are preserved in per-phase history files:

| Phase | Title                                               | Status              | History                                                                              |
| ----- | --------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| 1     | Export SubagentsService API boundary                | Complete            | [phase-1-api-boundary.md](history/phase-1-api-boundary.md)                           |
| 2     | Remove scheduling subsystem                         | Complete            | [phase-2-remove-scheduling.md](history/phase-2-remove-scheduling.md)                 |
| 3     | Remove group-join, RPC; replace output-file         | Complete            | [phase-3-remove-rpc-groupjoin.md](history/phase-3-remove-rpc-groupjoin.md)           |
| 4     | Implement and publish SubagentsService              | Complete            | [phase-4-implement-service.md](history/phase-4-implement-service.md)                 |
| 5     | Decompose index.ts                                  | Complete            | [phase-5-decompose-index.md](history/phase-5-decompose-index.md)                     |
| 6     | Extract UI to separate package                      | Deferred → Phase 18 | —                                                                                    |
| 7     | Encapsulation and dependency narrowing              | Complete            | [phase-7-encapsulation.md](history/phase-7-encapsulation.md)                         |
| 8     | Testability, display extraction, menu decomposition | Complete            | [phase-8-testability.md](history/phase-8-testability.md)                             |
| 9     | Observation consolidation, ctx elimination          | Complete            | [phase-9-observation-ctx.md](history/phase-9-observation-ctx.md)                     |
| 10    | Domain organization, bag decomposition, complexity  | Complete            | [phase-10-structural-decomposition.md](history/phase-10-structural-decomposition.md) |
| 11    | Closure factories to classes                        | Complete            | [phase-11-closure-to-class.md](history/phase-11-closure-to-class.md)                 |
| 12    | Complexity reduction and test fixture extraction    | Complete            | [phase-12-complexity-test-fixtures.md](history/phase-12-complexity-test-fixtures.md) |
| 13    | Remaining structural smells                         | Complete            | [phase-13-remaining-smells.md](history/phase-13-remaining-smells.md)                 |
| 14    | Strip policy from core                              | Complete            | [phase-14-strip-policy.md](history/phase-14-strip-policy.md)                         |
| 15    | Domain model evolution                              | Complete            | [phase-15-domain-model-evolution.md](history/phase-15-domain-model-evolution.md)     |
| 16    | Invert dependencies (extensions on a minimal core)  | Complete            | [phase-16-invert-dependencies.md](history/phase-16-invert-dependencies.md)           |
| 17    | Core consolidation                                  | Complete            | [phase-17-core-consolidation.md](history/phase-17-core-consolidation.md)             |
| 18    | Reconsider UI (first principles)                    | In progress         | this document, [Phase 18](#phase-18-reconsider-ui-from-first-principles)             |

### Structural refactoring issues

| Phase                | Issue                                                      | Summary                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation           | #69, #71, #76, #80                                         | SubagentRuntime, pure assembler, cwd injection, config consolidation                                                                                                                           |
| Core decomposition   | #84, #72, #87, #70                                         | WorktreeManager, AgentManager DI, runtime methods, handler extraction                                                                                                                          |
| Interface polish     | #66, #77                                                   | SDK types, projectAgentsDir                                                                                                                                                                    |
| Features             | #61                                                        | JSONL session transcripts                                                                                                                                                                      |
| AgentManager         | #98, #99, #100, #102                                       | Record state machine, ParentSnapshot, session-event observation, test factory                                                                                                                  |
| Encapsulation        | #108, #109, #110, #111, #112, #113, #114, #115, #116, #118 | Registry, settings, activity tracker, record lifecycle, observer, spawn options, deps narrowing, tool split, type housekeeping                                                                 |
| Testability          | #131, #132, #133, #134, #135, #136                         | Shared fixtures, session-config IO, runner SDK boundary, as-any reduction, display extraction, menu decomposition                                                                              |
| Observation/ctx      | #144, #145, #146, #147, #148                               | Observation consolidation, execute decomposition, UI context, text wrapping injection, widget rendering split                                                                                  |
| Phase 10             | #164, #165, #166, #167, #168, #169, #170, #171, #172       | Domain directories, ResolvedSpawnConfig, ParentSessionInfo, RunnerIO split, ToolFilterConfig, RunContext, buildContentLines, renderResult, content-items                                       |
| Phase 11             | #192, #193, #194, #195, #196                               | SessionContext, runtime queries, interface alignment, tool classes, runner/menu classes, index.ts simplification                                                                               |
| Phase 12             | #205, #206, #207, #208                                     | renderWidgetLines, showAgentDetail, widget update, shared test fixtures                                                                                                                        |
| Phase 13             | #214, #215, #216, #217, #218, #219                         | Closure-to-class, buildParentContext, startAgent decomp, overwrite guard, settings SDK, test duplication                                                                                       |
| Phase 14             | #237, #238, #239, #242                                     | Remove disallowed_tools, remove extensions filtering, collapse filterActiveTools, rename Agent to subagent                                                                                     |
| Phase 15             | #227, #228, #231, #229, #230, #232                         | Agent domain model, async startAgent, runner self-contained, Agent.run(), ConcurrencyQueue, Agent.resume()                                                                                     |
| Phase 16             | #261, #262, #263, #264, #265                               | Lifecycle events (retire permission-bridge), WorkspaceProvider seam, extract worktrees package, remove isolated, born-complete execution / dissolve runner                                     |
| Phase 16 (abandoned) | #256 (superseded), #257 (parked), #258, #259 (not planned) | Agent collaborator architecture — replaced by the inversion approach above ([ADR-0002])                                                                                                        |
| Phase 17             | #381, #373, #374, #375, #376, #377, #378, #379, #380       | ConcurrencyLimiter, SubagentState, run-start encapsulation, run collaborators, events observer, widget decoupling, lifecycle test fixtures, UI/tools test fixtures, settings-loader extraction |
| Phase 17 (follow-on) | #412, #415                                                 | Session-mock builder unification, worktrees settings-helper migration                                                                                                                          |

The remaining open issue is #22 (parent-session resolution), a cross-extension track that does not gate the structural work.

## Relationship with upstream

This fork (`@gotgenes/pi-subagents` in the [gotgenes/pi-packages] monorepo) is a hard fork of [tintinweb/pi-subagents].
The decomposition diverges materially from upstream's direction.

The three upstream PRs (#71, #72, #73) remain open.
If they land, upstream gains the peer-dep fix and the two RepOne patches.
This fork continues independently regardless.

Upstream fixes and ideas are cherry-picked when they align with this fork's scope.
The upstream test suite is run periodically as a regression canary for the session assembly core.

[earendil-works/pi#4207]: https://github.com/earendil-works/pi/issues/4207
[gotgenes/pi-packages]: https://github.com/gotgenes/pi-packages
[tintinweb/pi-subagents]: https://github.com/tintinweb/pi-subagents
[166]: https://github.com/gotgenes/pi-packages/issues/166
[167]: https://github.com/gotgenes/pi-packages/issues/167
[168]: https://github.com/gotgenes/pi-packages/issues/168
[169]: https://github.com/gotgenes/pi-packages/issues/169
[#205]: https://github.com/gotgenes/pi-packages/issues/205
[#206]: https://github.com/gotgenes/pi-packages/issues/206
[#207]: https://github.com/gotgenes/pi-packages/issues/207
[#208]: https://github.com/gotgenes/pi-packages/issues/208
[#214]: https://github.com/gotgenes/pi-packages/issues/214
[#215]: https://github.com/gotgenes/pi-packages/issues/215
[#216]: https://github.com/gotgenes/pi-packages/issues/216
[#217]: https://github.com/gotgenes/pi-packages/issues/217
[#218]: https://github.com/gotgenes/pi-packages/issues/218
[#219]: https://github.com/gotgenes/pi-packages/issues/219
[#227]: https://github.com/gotgenes/pi-packages/issues/227
[#228]: https://github.com/gotgenes/pi-packages/issues/228
[#229]: https://github.com/gotgenes/pi-packages/issues/229
[#230]: https://github.com/gotgenes/pi-packages/issues/230
[#231]: https://github.com/gotgenes/pi-packages/issues/231
[#232]: https://github.com/gotgenes/pi-packages/issues/232
[#261]: https://github.com/gotgenes/pi-packages/issues/261
[#262]: https://github.com/gotgenes/pi-packages/issues/262
[#263]: https://github.com/gotgenes/pi-packages/issues/263
[#264]: https://github.com/gotgenes/pi-packages/issues/264
[#265]: https://github.com/gotgenes/pi-packages/issues/265
[#277]: https://github.com/gotgenes/pi-packages/issues/277
[#373]: https://github.com/gotgenes/pi-packages/issues/373
[#374]: https://github.com/gotgenes/pi-packages/issues/374
[#375]: https://github.com/gotgenes/pi-packages/issues/375
[#376]: https://github.com/gotgenes/pi-packages/issues/376
[#377]: https://github.com/gotgenes/pi-packages/issues/377
[#378]: https://github.com/gotgenes/pi-packages/issues/378
[#379]: https://github.com/gotgenes/pi-packages/issues/379
[#380]: https://github.com/gotgenes/pi-packages/issues/380
[#381]: https://github.com/gotgenes/pi-packages/issues/381
[#412]: https://github.com/gotgenes/pi-packages/issues/412
[#415]: https://github.com/gotgenes/pi-packages/issues/415
[#420]: https://github.com/gotgenes/pi-packages/issues/420
[#421]: https://github.com/gotgenes/pi-packages/issues/421
[#422]: https://github.com/gotgenes/pi-packages/issues/422
[#423]: https://github.com/gotgenes/pi-packages/issues/423
[#424]: https://github.com/gotgenes/pi-packages/issues/424
[#425]: https://github.com/gotgenes/pi-packages/issues/425
[#426]: https://github.com/gotgenes/pi-packages/issues/426
[#427]: https://github.com/gotgenes/pi-packages/issues/427
[ADR-0002]: ../decisions/0002-extensions-on-a-minimal-core.md
