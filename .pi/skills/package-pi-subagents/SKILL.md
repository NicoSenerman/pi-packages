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
2. New features and removals follow the phase plan in `docs/architecture/architecture.md`.
   Document architectural decisions in `docs/decisions/`.
3. The upstream test suite is run periodically as a regression canary for the `agent-runner` core.
4. Modules marked `← removing` or `← replacing` in the architecture doc's current-state listing are slated for deletion — do not add features to them.

## Architecture

See `docs/architecture/architecture.md` for the full architecture document with Mermaid diagrams, domain model, structural analysis, and improvement roadmap.
Refactoring history is preserved in `docs/architecture/history/` (one file per completed phase).

### Domain organization

The extension is organized into six domains (53 files, 8,218 LOC):

| Domain      | Directory                                                                                                                                            | Modules | Responsibility                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Config      | `agent-types.ts`, `default-agents.ts`, `custom-agents.ts`, `invocation-config.ts`                                                                    | 4       | Agent type registry, built-in/custom configs, per-call merge                                         |
| Session     | `session-config.ts`, `prompts.ts`, `context.ts`, `memory.ts`, `skill-loader.ts`, `env.ts`, `model-resolver.ts`, `session-dir.ts`                     | 8       | Pure session assembly: prompts, context, memory, skills, environment, model resolution               |
| Lifecycle   | `agent-manager.ts`, `agent-runner.ts`, `agent-record.ts`, `parent-snapshot.ts`, `execution-state.ts`, `worktree.ts`, `worktree-state.ts`, `usage.ts` | 8       | Spawn, queue, abort, resume, turn loop, status state machine, worktree isolation                     |
| Observation | `record-observer.ts`, `notification.ts`, `notification-state.ts`, `renderer.ts`                                                                      | 4       | Session-event stats, completion nudges, notification rendering                                       |
| Tools       | `tools/`                                                                                                                                             | 8       | LLM-facing tools: Agent, get_subagent_result, steer_subagent, spawn-config, result-renderer, helpers |
| UI          | `ui/`                                                                                                                                                | 10      | Widget, conversation viewer, /agents menu, creation wizard, config editor, display helpers           |
| Service     | `service.ts`, `service-adapter.ts`                                                                                                                   | 2       | Cross-extension API boundary via Symbol.for()                                                        |

Entry point (`index.ts`), runtime (`runtime.ts`), shared types (`types.ts`), settings (`settings.ts`), debug (`debug.ts`), and event handlers (`handlers/`) sit at the root.

### Module dependency flow

```text
tools/ → AgentManager → agent-runner → session-config → [prompts, memory, skills, env]
                                                          ↑
                                               AgentTypeRegistry → [default-agents, custom-agents]

record-observer ─subscribes─→ AgentSession ←─subscribes─ ui-observer
widget ─polls─→ AgentActivityTracker map
service-adapter ─wraps─→ AgentManager
```
