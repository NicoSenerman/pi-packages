# @gotgenes/pi-subagents

A [pi](https://pi.dev) extension that brings **Claude Code-style autonomous sub-agents** to pi.
Spawn specialized agents that run in isolated sessions — each with its own tools, system prompt, model, and thinking level.
Run them in foreground or background, steer them mid-run, resume completed sessions, and define your own custom agent types.

> **Fork notice:** This package is a friendly fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), published to npm as `@gotgenes/pi-subagents`.
> It carries a small number of patches on top of upstream — peer-dep migration to `@earendil-works/pi-*`, a post-`bindExtensions` active-tool re-filter, and an `<active_agent>` system-prompt tag for permission resolution.
> See [Deviations from upstream](#deviations-from-upstream) at the bottom of this README for details.
>
> **Status:** Early release.

<img width="600" alt="pi-subagents screenshot" src="https://github.com/gotgenes/pi-subagents/raw/main/media/screenshot.png" />

<https://github.com/user-attachments/assets/8685261b-9338-4fea-8dfe-1c590d5df543>

## Features

- **Claude Code look & feel** — same tool names, calling conventions, and UI patterns (`subagent`, `get_subagent_result`, `steer_subagent`) — feels native
- **Parallel background agents** — spawn multiple agents that run concurrently with automatic queuing (configurable concurrency limit, default 4) and individual completion notifications
- **Live widget UI** — persistent above-editor widget with animated spinners, live tool activity, token counts, and colored status icons
- **Conversation viewer** — select any agent in `/agents` to open a live-scrolling overlay of its full conversation (auto-follows new content, scroll up to pause)
- **Custom agent types** — define agents in `.pi/agents/<name>.md` with YAML frontmatter: custom system prompts, model selection, thinking levels, tool restrictions
- **Mid-run steering** — inject messages into running agents to redirect their work without restarting
- **Session resume** — pick up where an agent left off, preserving full conversation context
- **Graceful turn limits** — agents get a "wrap up" warning before hard abort, producing clean partial results instead of cut-off output
- **Case-insensitive agent types** — `"explore"`, `"Explore"`, `"EXPLORE"` all work.
  Unknown types fall back to general-purpose with a note
- **Fuzzy model selection** — specify models by name (`"haiku"`, `"sonnet"`) instead of full IDs, with automatic filtering to only available/configured models
- **Context inheritance** — optionally fork the parent conversation into a sub-agent so it knows what's been discussed
- **Persistent agent memory** — three scopes (project, local, user) with automatic read-only fallback for agents without write tools
- **Git worktree isolation** — run agents in isolated repo copies; changes auto-committed to branches on completion
- **Skill preloading** — inject named skills into agent system prompts, discovered from `.pi/skills/`, `.agents/skills/`, and global locations (Pi-standard `<name>/SKILL.md` directory layout supported)
- **Styled completion notifications** — background agent results render as themed, compact notification boxes (icon, stats, result preview) instead of raw XML.
  Expandable to show full output
- **Event bus** — lifecycle events (`subagents:created`, `started`, `completed`, `failed`, `steered`, `compacted`) emitted via `pi.events`, enabling other extensions to react to sub-agent activity

## Install

```bash
pi install npm:@gotgenes/pi-subagents
```

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## Quick Start

The parent agent spawns sub-agents using the `subagent` tool:

```text
subagent({
  subagent_type: "Explore",
  prompt: "Find all files that handle authentication",
  description: "Find auth files",
  run_in_background: true,
})
```

Foreground agents block until complete and return results inline.
Background agents return an ID immediately and notify you on completion.

## UI

The extension renders a persistent widget above the editor showing all active agents:

```text
● Agents
├─ ⠹ Agent  Refactor auth module · ⟳5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
│    ⎿  editing 2 files…
├─ ⠹ Explore  Find auth files · ⟳3 · 3 tool uses · 12.4k token (8%) · 4.1s
│    ⎿  searching…
├─ ⠹ Agent  Long-running task · ⟳42 · 38 tool uses · 91.0k token (84% · ↻2) · 2m17s
│    ⎿  reading…
└─ 2 queued
```

The token field is annotated with two optional signals inside parens:

- **`NN%`** — context-window utilization (color-coded: <70% dim, 70–85% warning, ≥85% error).
  Omitted when the model has no declared `contextWindow`, or briefly right after compaction.
- **`↻N`** — number of times the session has compacted, when > 0.
  Stays dim; the percent's color carries urgency.

Individual agent results render Claude Code-style in the conversation:

| State          | Example                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| **Running**    | `⠹ ⟳3≤30 · 3 tool uses · 12.4k token (8%)` / `⎿ searching, reading 3 files…`             |
| **Completed**  | `✓ ⟳8 · 5 tool uses · 33.8k token (62%) · 12.3s` / `⎿ Done`                              |
| **Wrapped up** | `✓ ⟳50≤50 · 50 tool uses · 89.1k token (84% · ↻2) · 45.2s` / `⎿ Wrapped up (turn limit)` |
| **Stopped**    | `■ ⟳3 · 3 tool uses · 12.4k token (8%)` / `⎿ Stopped`                                    |
| **Error**      | `✗ ⟳3 · 3 tool uses · 12.4k token (8%)` / `⎿ Error: timeout`                             |
| **Aborted**    | `✗ ⟳55≤50 · 55 tool uses · 102.3k token (95% · ↻3)` / `⎿ Aborted (max turns exceeded)`   |

Completed results can be expanded (ctrl+o in pi) to show the full agent output inline.

Background agent completion notifications render as styled boxes:

```text
✓ Find auth files completed
  ⟳3 · 3 tool uses · 12.4k token · 4.1s
  ⎿  Found 5 files related to authentication...
  transcript: .pi/output/agent-abc123.jsonl
```

The LLM receives structured `<task-notification>` XML for parsing, while the user sees the themed visual.

## Default Agent Types

| Type              | Tools                      | Model                         | Prompt Mode            | Description                                                                           |
| ----------------- | -------------------------- | ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `general-purpose` | all 7                      | inherit                       | `append` (parent twin) | Inherits the parent's full system prompt — same rules, CLAUDE.md, project conventions |
| `Explore`         | read, bash, grep, find, ls | haiku (falls back to inherit) | `replace` (standalone) | Fast codebase exploration (read-only)                                                 |
| `Plan`            | read, bash, grep, find, ls | inherit                       | `replace` (standalone) | Software architect for implementation planning (read-only)                            |

The `general-purpose` agent is a **parent twin** — it receives the parent's entire system prompt plus a sub-agent context bridge, so it follows the same rules the parent does.
Explore and Plan use standalone prompts tailored to their read-only roles.

Default agents can be **ejected** (`/agents` → select agent → Eject) to export them as `.md` files for customization, **overridden** by creating a `.md` file with the same name (e.g. `.pi/agents/general-purpose.md`), or **disabled** per-project with `enabled: false` frontmatter.

## Custom Agents

Define custom agent types by creating `.md` files.
The filename becomes the agent type name.
Any name is allowed — using a default agent's name overrides it.

Agents are discovered from two locations (higher priority wins):

| Priority    | Location                                                                         | Scope                         |
| ----------- | -------------------------------------------------------------------------------- | ----------------------------- |
| 1 (highest) | `.pi/agents/<name>.md`                                                           | Project — per-repo agents     |
| 2           | `$PI_CODING_AGENT_DIR/agents/<name>.md` (default `~/.pi/agent/agents/<name>.md`) | Global — available everywhere |

Project-level agents override global ones with the same name, so you can customize a global agent for a specific project.
The global location follows the upstream `PI_CODING_AGENT_DIR` env var — set it to relocate all pi-coding-agent state (agents, skills, settings) to a custom directory.

### Example: `.pi/agents/auditor.md`

```markdown
---
description: Security Code Reviewer
tools: read, grep, find, bash
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
---

You are a security auditor.
Review code for vulnerabilities including:

- Injection flaws (SQL, command, XSS)
- Authentication and authorization issues
- Sensitive data exposure
- Insecure configurations

Report findings with file paths, line numbers, severity, and remediation advice.
```

Then spawn it like any built-in type:

```text
subagent({ subagent_type: "auditor", prompt: "Review the auth module", description: "Security audit" })
```

### Frontmatter Fields

All fields are optional — sensible defaults for everything.

| Field               | Default        | Description                                                                                                                                                                                            |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `description`       | filename       | Agent description shown in tool listings                                                                                                                                                               |
| `display_name`      | —              | Display name for UI (e.g. widget, agent list)                                                                                                                                                          |
| `tools`             | all 7          | Comma-separated built-in tools: read, bash, edit, write, grep, find, ls. `none` for no tools                                                                                                           |
| `extensions`        | `true`         | `true` to inherit all MCP/extension tools, `false` to disable                                                                                                                                          |
| `skills`            | `true`         | Inherit skills from parent. Can be a comma-separated list of skill names to preload (see [Skill Preloading](#skill-preloading) for discovery locations)                                                |
| `memory`            | —              | Persistent agent memory scope: `project`, `local`, or `user`. Auto-detects read-only agents                                                                                                            |
| `isolation`         | —              | Set to `worktree` to run in an isolated git worktree                                                                                                                                                   |
| `model`             | inherit parent | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`)                                                                                                                                       |
| `thinking`          | inherit        | off, minimal, low, medium, high, xhigh                                                                                                                                                                 |
| `max_turns`         | unlimited      | Max agentic turns before graceful shutdown. `0` or omit for unlimited                                                                                                                                  |
| `prompt_mode`       | `replace`      | `replace`: body is the full system prompt (no AGENTS.md / CLAUDE.md inheritance). `append`: body appended to parent's prompt (agent acts as a "parent twin" — inherits parent's AGENTS.md / CLAUDE.md) |
| `inherit_context`   | `false`        | Fork parent conversation into agent                                                                                                                                                                    |
| `run_in_background` | `false`        | Run in background by default                                                                                                                                                                           |
| `isolated`          | `false`        | No extension/MCP tools, only built-in                                                                                                                                                                  |
| `enabled`           | `true`         | Set to `false` to disable an agent (useful for hiding a default agent per-project)                                                                                                                     |

Frontmatter is authoritative.
If an agent file sets `model`, `thinking`, `max_turns`, `inherit_context`, `run_in_background`, `isolated`, or `isolation`, those values are locked for that agent.
`subagent` tool parameters only fill fields the agent config leaves unspecified.

## Tools

### `subagent`

Launch a sub-agent.

| Parameter           | Type         | Required | Description                                                      |
| ------------------- | ------------ | -------- | ---------------------------------------------------------------- |
| `prompt`            | string       | yes      | The task for the agent                                           |
| `description`       | string       | yes      | Short 3-5 word summary (shown in UI)                             |
| `subagent_type`     | string       | yes      | Agent type (built-in or custom)                                  |
| `model`             | string       | no       | Model — `provider/modelId` or fuzzy name (`"haiku"`, `"sonnet"`) |
| `thinking`          | string       | no       | Thinking level: off, minimal, low, medium, high, xhigh           |
| `max_turns`         | number       | no       | Max agentic turns. Omit for unlimited (default)                  |
| `run_in_background` | boolean      | no       | Run without blocking                                             |
| `resume`            | string       | no       | Agent ID to resume a previous session                            |
| `isolated`          | boolean      | no       | No extension/MCP tools                                           |
| `isolation`         | `"worktree"` | no       | Run in an isolated git worktree                                  |
| `inherit_context`   | boolean      | no       | Fork parent conversation into agent                              |

### `get_subagent_result`

Check status and retrieve results from a background agent.

| Parameter  | Type    | Required | Description                   |
| ---------- | ------- | -------- | ----------------------------- |
| `agent_id` | string  | yes      | Agent ID to check             |
| `wait`     | boolean | no       | Wait for completion           |
| `verbose`  | boolean | no       | Include full conversation log |

### `steer_subagent`

Send a steering message to a running agent.
The message interrupts after the current tool execution.

| Parameter  | Type   | Required | Description                               |
| ---------- | ------ | -------- | ----------------------------------------- |
| `agent_id` | string | yes      | Agent ID to steer                         |
| `message`  | string | yes      | Message to inject into agent conversation |

## Commands

| Command   | Description                       |
| --------- | --------------------------------- |
| `/agents` | Interactive agent management menu |

The `/agents` command opens an interactive menu:

```text
Running agents (2) — 1 running, 1 done     ← only shown when agents exist
Agent types (6)                             ← unified list: defaults + custom
Create new agent                            ← manual wizard or AI-generated
Settings                                    ← max concurrency, max turns, grace turns
```

- **Agent types** — unified list with source indicators: `•` (project), `◦` (global), `✕` (disabled).
  Select an agent to manage it:
  - **Default agents** (no override): Eject (export as `.md`), Disable
  - **Default agents** (ejected/overridden): Edit, Disable, Reset to default, Delete
  - **Custom agents**: Edit, Disable, Delete
  - **Disabled agents**: Enable, Edit, Delete
- **Eject** — writes the embedded default config as a `.md` file to project or personal location, so you can customize it
- **Disable/Enable** — toggle agent availability.
  Disabled agents stay visible in the list (marked `✕`) and can be re-enabled
- **Create new agent** — choose project/personal location, then manual wizard (step-by-step prompts for name, tools, model, thinking, system prompt) or AI-generated (describe what the agent should do and a sub-agent writes the `.md` file).
  Any name is allowed, including default agent names (overrides them)
- **Settings** — configure max concurrency, default max turns, and grace turns at runtime

## Graceful Max Turns

Instead of hard-aborting at the turn limit, agents get a graceful shutdown:

1. At `max_turns` — steering message: *"Wrap up immediately — provide your final answer now."*
2. Up to 5 grace turns to finish cleanly
3. Hard abort only after the grace period

| Status      | Meaning                       | Icon       |
| ----------- | ----------------------------- | ---------- |
| `completed` | Finished naturally            | `✓` green  |
| `steered`   | Hit limit, wrapped up in time | `✓` yellow |
| `aborted`   | Grace period exceeded         | `✗` red    |
| `stopped`   | User-initiated abort          | `■` dim    |

## Concurrency

Background agents are subject to a configurable concurrency limit (default: 4).
Excess agents are automatically queued and start as running agents complete.
The widget shows queued agents as a collapsed count.

Foreground agents bypass the queue — they block the parent anyway.

## Persistent Settings

Runtime tuning values set via `/agents` → Settings (max concurrency, default max turns, grace turns) persist across pi restarts.
Two files, merged on load:

- **Global:** `~/.pi/agent/subagents.json` — your machine-wide defaults.
  Edit by hand; the `/agents` menu never writes here.
- **Project:** `<cwd>/.pi/subagents.json` — per-project overrides.
  Written by `/agents` → Settings.

**Precedence:** project overrides global on any field present in both.
Missing fields fall back to the hardcoded defaults (max concurrency `4`, default max turns unlimited, grace turns `5`).

**Example — global defaults for a beefy machine:**

```bash
mkdir -p ~/.pi/agent
cat > ~/.pi/agent/subagents.json <<'EOF'
{
  "maxConcurrent": 16,
  "graceTurns": 10
}
EOF
```

Every project now starts with concurrency 16 and grace 10, without ever touching the menu.
Individual projects can still override via `/agents` → Settings.

**Failure behavior:** missing file is silent; malformed JSON logs a `[pi-subagents] Ignoring malformed settings at …` warning to stderr; invalid/out-of-range field values are dropped per-field; write failures downgrade the `/agents` toast to a warning with `(session only; failed to persist)`.

## Events

Agent lifecycle events are emitted via `pi.events.emit()` so other extensions can react:

| Event                        | When                                                    | Key fields                                                                                                           |
| ---------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `subagents:created`          | Background agent registered                             | `id`, `type`, `description`, `isBackground`                                                                          |
| `subagents:started`          | Agent transitions to running (including queued→running) | `id`, `type`, `description`                                                                                          |
| `subagents:completed`        | Agent finished successfully                             | `id`, `type`, `durationMs`, `tokens` (lifetime `{ input, output, total }`), `toolUses`, `result`                     |
| `subagents:failed`           | Agent errored, stopped, or aborted                      | same as completed + `error`, `status`                                                                                |
| `subagents:steered`          | Steering message sent                                   | `id`, `message`                                                                                                      |
| `subagents:compacted`        | Agent's session successfully compacted                  | `id`, `type`, `description`, `reason` (`"manual"` / `"threshold"` / `"overflow"`), `tokensBefore`, `compactionCount` |
| `subagents:settings_loaded`  | Persisted settings applied at extension init            | `settings` (merged global + project)                                                                                 |
| `subagents:settings_changed` | `/agents` → Settings mutation was applied               | `settings`, `persisted` (`boolean` — `false` on write failure)                                                       |

`tokens.total` = `input + output + cacheWrite`.
`cacheRead` is excluded — each turn's `cacheRead` is the cumulative cached prefix re-read on that one API call, so summing per-message would over-count it.
Use `contextUsage.percent` (surfaced as `(NN%)` in the widget) for current context size.

## Persistent Agent Memory

Agents can have persistent memory across sessions.
Set `memory` in frontmatter to enable:

```yaml
---
memory: project   # project | local | user
---
```

| Scope     | Location                         | Use case                           |
| --------- | -------------------------------- | ---------------------------------- |
| `project` | `.pi/agent-memory/<name>/`       | Shared across the team (committed) |
| `local`   | `.pi/agent-memory-local/<name>/` | Machine-specific (gitignored)      |
| `user`    | `~/.pi/agent-memory/<name>/`     | Global personal memory             |

Memory uses a `MEMORY.md` index file and individual memory files with frontmatter.
Agents with write tools get full read-write access.
**Read-only agents** (no `write`/`edit` tools) automatically get read-only memory — they can consume memories written by other agents but cannot modify them.
This prevents unintended tool escalation.

## Worktree Isolation

Set `isolation: worktree` to run an agent in a temporary git worktree:

```text
subagent({ subagent_type: "refactor", prompt: "...", isolation: "worktree" })
```

The agent gets a full, isolated copy of the repository.
On completion:

- **No changes:** worktree is cleaned up automatically
- **Changes made:** changes are committed to a new branch (`pi-agent-<id>`) and returned in the result

If the worktree cannot be created (not a git repo, no commits, or `git worktree add` fails), the `subagent` tool returns a clear error instead of running unisolated — `isolation: "worktree"` is a strict guarantee, not a hint.
Initialize git and commit at least once, or omit `isolation`.

## Skill Preloading

Skills can be preloaded by name and injected into the agent's system prompt:

```yaml
---
skills: api-conventions, error-handling
---
```

**Discovery roots** (checked in this order, first match wins):

| Scope   | Path                                                           | Source                                                       |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| Project | `<cwd>/.pi/skills/`                                            | Pi-standard                                                  |
| Project | `<cwd>/.agents/skills/`                                        | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User    | `$PI_CODING_AGENT_DIR/skills/` (default `~/.pi/agent/skills/`) | Pi-standard                                                  |
| User    | `~/.agents/skills/`                                            | [Agent Skills spec](https://agentskills.io/integrate-skills) |
| User    | `~/.pi/skills/`                                                | Legacy (pre-Pi)                                              |

**Per root, a skill named `foo` resolves to the first of:**

- `<root>/foo.md` — flat file at the top level
- `<root>/foo/SKILL.md` — directory skill (top-level)
- `<root>/*/.../foo/SKILL.md` — directory skill, found by recursive descent

Recursion skips dotfile directories and `node_modules`.
A directory that itself contains a `SKILL.md` is treated as a single skill — we don't descend into it.
Traversal is byte-order sorted for deterministic resolution across filesystems.

**Security:** symlinks are rejected at every layer (root, flat file, skill directory, `SKILL.md` inside a skill directory) — intentional deviation from Pi, which follows symlinks.
Skill names with path-traversal characters (`..`, `/`, `\`, spaces, leading dot, >128 chars) are rejected.

## Migrating from `disallowed_tools`

The `disallowed_tools` frontmatter field has been removed.
Use [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system)'s `permission:` frontmatter instead — it provides richer semantics (allow/ask/deny vs. binary hide):

```yaml
# Before (no longer supported)
disallowed_tools: bash

# After
permission:
  bash: deny
```

## Permission System Integration

When [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) is installed, this extension integrates automatically:

- **Per-agent permission policies** — define `permission:` in agent YAML frontmatter to set allow/ask/deny rules per agent type.
  The permission system resolves the agent name from the `<active_agent>` tag in the child system prompt.
- **Tool filtering** — the permission system's `before_agent_start` handler removes denied tools from the child session before the agent starts.
- **`ask`-state forwarding** — when a child session triggers an `ask` permission, the prompt forwards to the parent session's UI.
  The parent approves or denies, and the child resumes.
- **Deterministic child detection** — this extension publishes `subagents:child:session-created` before `bindExtensions()` fires; the permission system subscribes and registers the child session synchronously, so detection does not rely on env vars or filesystem heuristics.

No configuration is required.
When `@gotgenes/pi-permission-system` is not installed, the lifecycle events have no subscriber — a harmless no-op.

## Architecture

See `docs/architecture/architecture.md` for the full architecture document with domain decomposition, Mermaid diagrams, and improvement roadmap.

```text
src/
  index.ts                          # Extension entry: tool/command registration, rendering
  runtime.ts                        # Session-scoped state bag with methods
  types.ts                          # Shared type definitions
  settings.ts                       # Persistent settings (concurrency, turn limits)
  config/                           # Agent type registry and configuration
    agent-types.ts                  # Unified agent registry (defaults + custom)
    default-agents.ts               # Embedded default agent configs
    custom-agents.ts                # Load user-defined agents from .pi/agents/*.md
    invocation-config.ts            # Per-call merge of tool params + agent config
  session/                          # Pure session assembly
    session-config.ts               # Session configuration assembler
    prompts.ts                      # Config-driven system prompt builder
    context.ts                      # Parent conversation context for inherit_context
    conversation.ts                 # Render a session's messages as formatted text
    content-items.ts                # Shared message content parsing
    env.ts                          # Environment detection (git, platform)
    model-resolver.ts               # Fuzzy model matching
    session-dir.ts                  # Session directory derivation
  lifecycle/                        # Agent execution and state tracking
    agent-manager.ts                # Collection manager + observer wiring
    agent.ts                        # Full execution lifecycle (run, abort, steer, workspace)
    create-subagent-session.ts      # Assembly factory: session creation, binding, tool filtering
    subagent-session.ts             # Born-complete child session: turn loop, steer, dispose
    child-lifecycle.ts              # Child-execution lifecycle event publisher
    concurrency-queue.ts            # Background agent scheduling
    parent-snapshot.ts              # Immutable spawn-time parent state
    turn-limits.ts                  # Turn-count policy (normalizeMaxTurns)
    workspace.ts                    # Workspace provider seam
    usage.ts                        # Token usage tracking
  observation/                      # Progress tracking and notification
    record-observer.ts              # Session-event stats observer
    notification.ts                 # Completion nudges
    notification-state.ts           # Notification state tracking
    renderer.ts                     # Notification rendering
  service/                          # Cross-extension API boundary
    service.ts                      # SubagentsService interface + Symbol.for() accessors
    service-adapter.ts              # SubagentsService wrapper around AgentManager
  tools/                            # LLM-facing tools
  ui/                               # Widget, conversation viewer, /agents menu
```

## Deviations from upstream

This fork carries three divergences from [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).
Each has a corresponding upstream PR:

1. **Peer-dep migration to `@earendil-works/pi-*`** — `peerDependencies` and all imports point at `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` (the active scope on npm) instead of the deprecated `@mariozechner/pi-*` scope.
   Also fixes a latent bug where `ThinkingLevel` was imported from `pi-agent-core` (an undeclared transitive dep that breaks under pnpm).
   Upstream PR: [tintinweb/pi-subagents#71](https://github.com/tintinweb/pi-subagents/pull/71).
2. **Post-`bindExtensions` active-tool re-filter** (`src/agent-runner.ts`) — `runAgent` re-runs its active-tool filter after `session.bindExtensions(...)` so the `EXCLUDED_TOOL_NAMES` recursion guard applies to extension-registered tools (which join the active set during `bindExtensions`).
   Upstream PR: [tintinweb/pi-subagents#72](https://github.com/tintinweb/pi-subagents/pull/72).
3. **`<active_agent>` system-prompt tag** (`src/prompts.ts`) — `buildAgentPrompt` prepends `<active_agent name="${config.name}"/>` to every assembled child system prompt (both `replace` and `append` modes).
   Downstream extensions like [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-permission-system) parse this tag to resolve per-agent `permission:` frontmatter inside the child session.
   Upstream PR: [tintinweb/pi-subagents#73](https://github.com/tintinweb/pi-subagents/pull/73).
4. **Child-execution lifecycle events** (`src/lifecycle/child-lifecycle.ts`) — the child-session execution lifecycle is published as ordered events on `pi.events` (`subagents:child:spawning`, `session-created`, `completed`, `disposed`).
   `session-created` fires synchronously before `bindExtensions()` so consumers (e.g. `@gotgenes/pi-permission-system`) can register the child session before binding proceeds.
   This inverts the former outbound `permission-bridge` pattern (ADR 0002 / [#261]) — the core publishes, consumers subscribe.
   No upstream equivalent — this feature is specific to the `@gotgenes` fork.

The upstream `vitest` suite plus tests added for each patch all pass on every commit.

## License

MIT — [tintinweb](https://github.com/tintinweb) (upstream) and [Chris Lasher](https://github.com/gotgenes) (fork)
