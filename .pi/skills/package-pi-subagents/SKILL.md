---
name: package-pi-subagents
description: |
  Package-specific context for @gotgenes/pi-subagents.
  Load when working on code, tests, or docs in packages/pi-subagents/.
---

# pi-subagents

Pi extension that adds Claude Code-style autonomous subagent dispatch to the Pi coding agent.

This package is a **hard fork** of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).
The fork diverges intentionally from upstream with material scope reduction and a typed API boundary.
See `docs/architecture/architecture.md` for the full decomposition plan and `docs/decisions/0001-deferred-patches.md` (superseded) for the original thin-patch rationale.

The fork carries three original patches from the thin-patch era, still present in the codebase:

1. **Peer-dep rename** — peer dependencies point at `@earendil-works/pi-*` (the active scope) rather than the deprecated `@mariozechner/pi-*` scope.
2. **Patch 2 (post-bind active-tool re-filter)** — `runAgent` re-runs the active-tool filter after `session.bindExtensions(...)` so extension-registered tools land in the child's active tool set.
3. **Patch 3 (active_agent tag)** — `runAgent` prepends `<active_agent name="${agentConfig.name}"/>` to every assembled child system prompt so `@gotgenes/pi-permission-system` can resolve per-agent `permission:` frontmatter inside the child.

Upstream PRs for these patches ([#71](https://github.com/tintinweb/pi-subagents/pull/71), [#72](https://github.com/tintinweb/pi-subagents/pull/72), [#73](https://github.com/tintinweb/pi-subagents/pull/73)) are open but the fork continues independently regardless.

## Implementation Priorities

- Follow the phased plan in `docs/architecture/architecture.md`.
- Narrow core — the extension owns agent spawning, execution, and result retrieval; everything else is a consumer.
- Typed API boundary — export `SubagentsService` via `Symbol.for()` accessors so other extensions can spawn agents without importing this package directly (done, #48).
- Remove scheduling subsystem (done); ad-hoc RPC and group-join (done); output-file porting to Pi session format tracked in #61.
- Cherry-pick upstream fixes when they align with this fork's scope; do not track upstream as a merge target.

## Code Style

Formatting is handled by Biome (`biome check`, `biome format`).
The repo intentionally does not use Prettier — a top-level `.prettierignore` blocks any harness with project-level write-time Prettier formatting from reformatting files here.

## Testing

The fork preserves upstream's full `vitest` suite (362 tests) plus tests added for Patches 2 and 3.
All tests must pass before publishing.
Use `vi.hoisted(...)` for module-level mocks, matching the existing patterns in `test/agent-runner.test.ts`.

## Notes for Agents

When working in this package:

1. The two RepOne-specific patches are marked in source — search for `// Patch 2 (RepOne` or `// Patch 3 (RepOne` to find them.
2. New features and removals follow the phase plan in `docs/architecture/architecture.md`. Document architectural decisions in `docs/decisions/`.
3. The upstream test suite is run periodically as a regression canary for the `agent-runner` core.
4. Modules marked `← removing` or `← replacing` in the architecture doc's current-state listing are slated for deletion — do not add features to them.

## Architecture

### Module Dependency Graph

```text
index.ts ──wires──> agent-manager.ts ──calls──> agent-runner.ts
    │                    │                       ├── prompts.ts
    │                    ├── worktree.ts          ├── context.ts
    │                    └── usage.ts             ├── memory.ts
    ├── service.ts (public API)                   ├── skill-loader.ts
    ├── service-adapter.ts ──wraps──> agent-manager  └── env.ts
    ├── tools (Agent,
    │   get_subagent_result,
    │   steer_subagent)
    ├── ui/
    │   ├── agent-widget.ts
    │   └── conversation-viewer.ts
    ├── agent-types.ts ──uses──> default-agents.ts, custom-agents.ts
    ├── settings.ts
    ├── model-resolver.ts
    ├── invocation-config.ts
    ├── types.ts
    └── output-file.ts
```

### Module Descriptions

#### Public API

| Module               | Responsibility                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `service.ts`         | Public entry point (`exports` in `package.json`). Defines `SubagentsService` interface, `SubagentRecord`, `SpawnOptions`, accessor functions (`publish/get/unpublishSubagentsService`), and `SUBAGENT_EVENTS` constants. |
| `service-adapter.ts` | `createSubagentsService()` factory. Wraps `AgentManager` via narrow `AgentManagerLike` interface. Handles string model resolution, record serialization (allowlist), and session gating.                                 |

#### Core engine

| Module             | Responsibility                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`         | Extension entry point. Registers tools, the `/agents` command, lifecycle hooks, the agent widget, notification rendering, and settings persistence.                                                                    |
| `agent-manager.ts` | Manages agent lifecycle: spawn, resume, abort. Enforces a configurable concurrency limit (default 4) by queuing excess background agents.                                                                              |
| `agent-runner.ts`  | Core execution engine. Creates agent sessions, assembles system prompts, binds extensions, applies active-tool filtering (Patch 2), injects `<active_agent>` tag (Patch 3), runs the agent loop, and collects results. |
| `types.ts`         | Shared type definitions: `AgentConfig`, `AgentRecord`, `SubagentType`, `MemoryScope`, `IsolationMode`, etc.                                                                                                            |

#### Agent configuration

| Module              | Responsibility                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `agent-types.ts`    | Unified agent type registry. Merges embedded defaults with user-defined agents from `.pi/agents/*.md`.             |
| `default-agents.ts` | Embedded default agent configurations (`general-purpose`, `Explore`, `Plan`).                                      |
| `custom-agents.ts`  | Loads user-defined agent `.md` files from project and global directories. Parses frontmatter for config overrides. |

#### Prompt assembly

| Module            | Responsibility                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `prompts.ts`      | Builds the system prompt for each agent from its config. Supports `replace` and `append` modes. |
| `context.ts`      | Extracts parent conversation history for `inherit_context` mode.                                |
| `memory.ts`       | Manages persistent per-agent `MEMORY.md` files scoped to user, project, or local directories.   |
| `skill-loader.ts` | Preloads named skills from `.pi/skills`, `.agents/skills`, and global directories.              |
| `env.ts`          | Detects environment info (git repo, branch, platform) for agent system prompts.                 |

#### Execution support

| Module                 | Responsibility                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `worktree.ts`          | Git worktree isolation. Creates temporary worktrees so agents work on isolated repo copies. |
| `usage.ts`             | Token usage tracking. Defines `LifetimeUsage` shape and provides accumulator operators.     |
| `model-resolver.ts`    | Resolves model strings to model instances. Tries exact match first, then fuzzy match.       |
| `invocation-config.ts` | Merges per-call tool parameters with agent config defaults for the final invocation config. |
| `output-file.ts`       | Streaming JSONL output file for agent transcripts.                                          |

#### UI

| Module                      | Responsibility                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `ui/agent-widget.ts`        | Persistent widget showing running/completed agents with animated spinners and live stats. |
| `ui/conversation-viewer.ts` | Live conversation overlay for viewing an agent's full session.                            |
