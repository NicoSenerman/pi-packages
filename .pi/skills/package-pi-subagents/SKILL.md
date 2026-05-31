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

The fork carries two original patches from the thin-patch era, still present in the codebase:

1. **Peer-dep rename** — peer dependencies point at `@earendil-works/pi-*` (the active scope) rather than the deprecated `@mariozechner/pi-*` scope.
2. **Patch 3 (active_agent tag)** — `assembleSessionConfig` prepends `<active_agent name="${agentConfig.name}"/>` to every assembled child system prompt so `@gotgenes/pi-permission-system` can resolve per-agent `permission:` frontmatter inside the child.

Note: Patch 2 (post-bind active-tool re-filter) was simplified in Phase 14 (#239).
The two-pass pre-bind/post-bind filter dance is gone.
A single post-bind call applies the `EXCLUDED_TOOL_NAMES` recursion guard after `bindExtensions`.

Upstream PRs for these patches ([#71](https://github.com/tintinweb/pi-subagents/pull/71), [#72](https://github.com/tintinweb/pi-subagents/pull/72), [#73](https://github.com/tintinweb/pi-subagents/pull/73)) are open but the fork continues independently regardless.

## Implementation Priorities

- Follow the phased plan in `docs/architecture/architecture.md`.
- **Open for extension, closed for modification** — pi-subagents is a minimal core that publishes events and a service API.
  Other packages hook into these to add permissions, rendering, or telemetry.
  Pi-subagents has zero knowledge of its consumers — dependency arrows point inward, never outward.
- Narrow core — the extension owns agent spawning, execution, and result retrieval; everything else is a consumer.
- **No policy enforcement** — tool restrictions, skill access control, and extension filtering belong in `@gotgenes/pi-permission-system`, not in this package.
  The `disallowed_tools` frontmatter field and `extensions: string[]` allowlist were removed in Phase 14 (#237, #238, #239).
  Users should use `permission:` frontmatter for tool restrictions.
- Typed API boundary — export `SubagentsService` via `Symbol.for()` accessors so other extensions can spawn agents without importing this package directly (done, #48).
- Remove scheduling subsystem (done); ad-hoc RPC and group-join (done); output-file porting to Pi session format tracked in #61.
- Cherry-pick upstream fixes when they align with this fork's scope; do not track upstream as a merge target.

### Architectural direction

The target architecture is documented in `docs/architecture/architecture.md` under "Target architecture."
The key phases are:

- **Phase 14** — Strip policy from core: remove `disallowed_tools`, `extensions` filtering, collapse `filterActiveTools` (#237, #238, #239). ✅ Complete
- **Phase 15** — Domain model evolution: `AgentRecord` → `Agent` with behavior, async `startAgent`, observer pattern, `ConcurrencyQueue` (#227–#232).
- **Phase 16** — Invert dependencies (extensions on a minimal core, ADR 0002): emit child-session lifecycle events and retire `permission-bridge.ts` (#261); add the `WorkspaceProvider` seam (#262); extract worktrees to `@gotgenes/pi-subagents-worktrees` (#263, supersedes #256); remove `isolated`/`extensions: false`/`noSkills` (#264); born-complete child execution, dissolve the runner (#265).
  The earlier "agent collaborator architecture" framing was abandoned.
- **Phase 17** — Extract UI to a separate package.

## Code Style

Formatting is handled by Biome (`biome check`, `biome format`).
The repo intentionally does not use Prettier — a top-level `.prettierignore` blocks any harness with project-level write-time Prettier formatting from reformatting files here.

## Build

This package is otherwise ship-source (Pi runs `./src/index.ts` directly), but it carries the repo's only build step: a type-declaration bundle for the public API surface (ADR 0003).
`pnpm run build:types` runs `rollup -c rollup.dts.config.mjs` (`rollup-plugin-dts`) to roll `src/service/service.ts` into a single self-contained `dist/public.d.ts` — internal `#src/*` types inlined, peer-dep types kept external.
The bundle is gitignored, regenerated at `prepack`, and shipped via the `package.json` `files` allowlist; `exports["."].types` points at it while `exports["."].default` serves the `.ts` source.
Never commit `dist/`.
`pnpm run verify:public-types` (`scripts/verify-public-types.sh`, also a CI step) packs the tarball and type-checks a throwaway consumer against it — run it after any change to the public surface, the `exports` map, or the rollup config.
Sibling packages consume this one from the **published** registry release (the repo sets `linkWorkspacePackages: false`), not via a workspace symlink — a symlink resolves `exports.types` to the gitignored, unbuilt `dist/public.d.ts`.
See `@gotgenes/pi-subagents-worktrees` for the pattern.

## Testing

The fork preserves upstream's full `vitest` suite (362 tests) plus tests added for Patch 3.
All tests must pass before publishing.
Use `vi.hoisted(...)` for module-level mocks, matching the existing patterns in `test/lifecycle/subagent-session.test.ts`.

## Notes for Agents

When working in this package:

1. New features and removals follow the phase plan in `docs/architecture/architecture.md`.
   Document architectural decisions in `docs/decisions/`.
2. The upstream test suite is run periodically as a regression canary for the session assembly core.
3. Modules marked `← removing` or `← replacing` in the architecture doc's current-state listing are slated for deletion — do not add features to them.

## Architecture

See `docs/architecture/architecture.md` for the full architecture document with Mermaid diagrams, domain model, structural analysis, and improvement roadmap.
Refactoring history is preserved in `docs/architecture/history/` (one file per completed phase).

### Domain organization

The extension is organized into six domains (56 files):

| Domain      | Directory                                                                                                                                                                                                   | Modules | Responsibility                                                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config      | `agent-types.ts`, `default-agents.ts`, `custom-agents.ts`, `invocation-config.ts`                                                                                                                           | 4       | Agent type registry, built-in/custom configs, per-call merge                                                                                                                      |
| Session     | `session-config.ts`, `prompts.ts`, `context.ts`, `conversation.ts`, `env.ts`, `model-resolver.ts`, `session-dir.ts`                                                                                         | 7       | Pure session assembly: prompts, context, conversation rendering, environment, model resolution                                                                                    |
| Lifecycle   | `subagent-manager.ts`, `create-subagent-session.ts`, `subagent-session.ts`, `turn-limits.ts`, `subagent.ts`, `concurrency-queue.ts`, `parent-snapshot.ts`, `child-lifecycle.ts`, `workspace.ts`, `usage.ts` | 10      | Spawn, abort, resume, scheduling, session assembly factory, born-complete turn loop, status state machine, per-subagent behavior, child-lifecycle events, workspace provider seam |
| Observation | `record-observer.ts`, `notification.ts`, `notification-state.ts`, `renderer.ts`                                                                                                                             | 4       | Session-event stats, completion nudges, notification rendering                                                                                                                    |
| Tools       | `tools/`                                                                                                                                                                                                    | 8       | LLM-facing tools: Agent, get_subagent_result, steer_subagent, spawn-config, result-renderer, helpers                                                                              |
| UI          | `ui/`                                                                                                                                                                                                       | 10      | Widget, conversation viewer, /agents menu, creation wizard, config editor, display helpers                                                                                        |
| Service     | `service.ts`, `service-adapter.ts`                                                                                                                                                                          | 2       | Cross-extension API boundary via Symbol.for()                                                                                                                                     |

Entry point (`index.ts`), runtime (`runtime.ts`), shared types (`types.ts`), settings (`settings.ts`), debug (`debug.ts`), and event handlers (`handlers/`) sit at the root.

### Module dependency flow

```text
tools/ → SubagentManager → Subagent → createSubagentSession → session-config → [prompts, memory, skills, env]
                                           ↓                                    ↑
                                     SubagentSession            AgentTypeRegistry → [default-agents, custom-agents]

record-observer ─subscribes─→ AgentSession ←─subscribes─ ui-observer
widget ─polls─→ AgentActivityTracker map
service-adapter ─wraps─→ SubagentManager
```
