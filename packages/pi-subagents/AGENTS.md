# AGENTS.md

## Project Purpose

Pi extension that adds Claude Code-style autonomous subagent dispatch to the Pi coding agent.

This package is a friendly fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).
It carries a small number of patches needed for downstream consumers (notably [RepOne](https://github.com/Tiny-IG-Software/repone)) that intend to use it as a normal Pi extension dependency:

1. **Peer-dep rename** — peer dependencies point at `@earendil-works/pi-*` (the active scope) rather than the deprecated `@mariozechner/pi-*` scope.
2. **Patch 2 (post-bind active-tool re-filter)** — `runAgent` re-runs the active-tool filter after `session.bindExtensions(...)` so extension-registered tools land in the child's active tool set. Without this, the `extensions: string[]` allowlist branch is functionally dead for extension tools.
3. **Patch 3 (active_agent tag)** — `runAgent` prepends `<active_agent name="${agentConfig.name}"/>` to every assembled child system prompt so `@gotgenes/pi-permission-system` can resolve per-agent `permission:` frontmatter inside the child.

See `docs/decisions/0001-deferred-patches.md` for a fourth patch (mirror parent resource paths) that was scoped out, and the rationale for not opening upstream PRs yet.

## Implementation Priorities

- Keep scope tight — this fork stays as close to upstream as possible.
- Maintain compatibility with upstream's public API.
- Keep the patch set minimal and clearly identified in the code (search for `Patch 2 (RepOne` / `Patch 3 (RepOne` comments).
- Track the upstream `tintinweb/pi-subagents` repository for fixes and incorporate them as merges or cherry-picks.
- When in doubt about whether a change should land here or be proposed upstream, prefer upstream.

## Code Style

Formatting is handled by Biome (`biome check`, `biome format`). The repo intentionally does not use Prettier — a top-level `.prettierignore` blocks any harness with project-level write-time Prettier formatting from reformatting files here.

## Testing

The fork preserves upstream's full `vitest` suite (362 tests) plus tests added for Patches 2 and 3.
All tests must pass before publishing.
Use `vi.hoisted(...)` for module-level mocks, matching the existing patterns in `test/agent-runner.test.ts`.

## Notes for Agents

When working in this package:

1. The two RepOne-specific patches are clearly marked in source — search for `// Patch 2 (RepOne` or `// Patch 3 (RepOne` to find them.
2. Do not introduce a third or fourth patch without first documenting the rationale in `docs/decisions/`.
3. Upstream PRs to `tintinweb/pi-subagents` for Patches 2 and 3 are deferred pending production validation in RepOne — see `docs/decisions/0001-deferred-patches.md`.
4. When syncing with upstream (rare), reapply the peer-dep rename and the two patches; the upstream `vitest` suite is the canary that nothing regressed.

## Architecture

### Module Dependency Graph

```text
index.ts ──wires──> agent-manager.ts ──calls──> agent-runner.ts
    │                    │                       ├── prompts.ts
    │                    ├── worktree.ts          ├── context.ts
    │                    ├── usage.ts             ├── memory.ts
    │                    └── schedule.ts          ├── skill-loader.ts
    ├── tools (Agent,             │                  └── env.ts
    │   get_subagent_result,      └── schedule-store.ts
    │   steer_subagent)
    ├── ui/
    │   ├── agent-widget.ts
    │   ├── conversation-viewer.ts
    │   └── schedule-menu.ts
    ├── agent-types.ts ──uses──> default-agents.ts, custom-agents.ts
    ├── settings.ts
    ├── cross-extension-rpc.ts
    ├── group-join.ts
    ├── model-resolver.ts
    ├── invocation-config.ts
    ├── types.ts
    └── output-file.ts
```

### Module Descriptions

#### Core engine

| Module             | Responsibility                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`         | Extension entry point. Registers tools, the `/agents` command, lifecycle hooks, the agent widget, the scheduler, notification rendering, batch grouping, RPC handlers, and settings persistence.                       |
| `agent-manager.ts` | Manages agent lifecycle: spawn, resume, abort. Enforces a configurable concurrency limit (default 4) by queuing excess background agents.                                                                              |
| `agent-runner.ts`  | Core execution engine. Creates agent sessions, assembles system prompts, binds extensions, applies active-tool filtering (Patch 2), injects `<active_agent>` tag (Patch 3), runs the agent loop, and collects results. |
| `types.ts`         | Shared type definitions: `AgentConfig`, `AgentRecord`, `SubagentType`, `JoinMode`, `MemoryScope`, `IsolationMode`, etc.                                                                                                |

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

#### Scheduling

| Module              | Responsibility                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `schedule.ts`       | Timer-driven dispatcher for scheduled subagents. Supports cron, interval, and one-shot formats. |
| `schedule-store.ts` | File-backed persistence for scheduled jobs. Session-scoped, PID-locked, atomic writes.          |

#### UI

| Module                      | Responsibility                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `ui/agent-widget.ts`        | Persistent widget showing running/completed agents with animated spinners and live stats. |
| `ui/conversation-viewer.ts` | Live conversation overlay for viewing an agent's full session.                            |
| `ui/schedule-menu.ts`       | `/agents → Scheduled jobs` submenu for listing and cancelling scheduled jobs.             |
