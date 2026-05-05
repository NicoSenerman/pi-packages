# 🔐 @gotgenes/pi-permission-system

[![npm version](https://img.shields.io/npm/v/@gotgenes/pi-permission-system?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@gotgenes/pi-permission-system) [![CI](https://img.shields.io/github/actions/workflow/status/gotgenes/pi-permission-system/ci.yml?style=flat&logo=github&label=CI)](https://github.com/gotgenes/pi-permission-system/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

Permission enforcement extension for the Pi coding agent that provides centralized, deterministic permission gates for tool, bash, MCP, skill, and special operations.

> **Fork notice:** This package is a full fork of [MasuRii/pi-permission-system](https://github.com/MasuRii/pi-permission-system), published to npm as `@gotgenes/pi-permission-system`.
> It has diverged substantially from upstream in config format, internal architecture, and permission model.
> The `/permission-system` slash command name is the only upstream identity preserved.

## Features

- **Tool Filtering** — Hides disallowed tools from the agent before it starts (reduces "try another tool" behavior)
- **System Prompt Sanitization** — Removes denied tool entries from the `Available tools:` system prompt section so the agent only sees tools it can actually call
- **Runtime Enforcement** — Blocks/asks/allows at tool call time with UI confirmation dialogs and readable approval summaries
- **Bash Command Control** — Wildcard pattern matching for granular bash command permissions
- **MCP Access Control** — Server and tool-level permissions for MCP operations
- **Skill Protection** — Controls which skills can be loaded or read from disk, including multi-block prompt sanitization
- **Per-Agent Overrides** — Agent-specific permission policies via YAML frontmatter
- **Subagent Permission Forwarding** — Forwards `ask` confirmations from non-UI subagents back to the main interactive session
- **File-Based Review Logging** — Writes permission request/denial review entries to a file by default for later auditing
- **Optional Debug Logging** — Keeps verbose extension diagnostics in a separate file when enabled in `config.json`
- **JSON Schema Validation** — Full schema for editor autocomplete and config validation
- **External Directory Guard** — Enforces `special.external_directory` for path-bearing file tools and bash commands that reference paths outside the active working directory

## Installation

### npm package

```bash
pi install npm:pi-permission-system
```

### Local extension folder

Place this folder in one of the following locations:

| Scope          | Path                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| Global default | `~/.pi/agent/extensions/pi-permission-system` (respects `PI_CODING_AGENT_DIR`) |
| Project        | `.pi/extensions/pi-permission-system`                                          |

Pi auto-discovers extensions in these paths.

> **Tip:** All `~/.pi/agent` paths shown in this document are defaults. If the `PI_CODING_AGENT_DIR` environment variable is set, pi uses that directory instead. The extension automatically follows pi's `getAgentDir()` helper, so global policy files, per-agent overrides, session directories, and extension installation paths all resolve under the configured agent directory.

## Usage

### Quick Start

1. Create the global config file (default: `~/.pi/agent/extensions/pi-permission-system/config.json`, respects `PI_CODING_AGENT_DIR`):

```jsonc
{
  "permission": {
    "*": "ask",
    "read": "allow",
    "write": "deny"
  }
}
```

1. Start Pi — the extension automatically loads and enforces your policy.

### Permission States

All permissions use one of three states:

| State   | Behavior                                 |
| ------- | ---------------------------------------- |
| `allow` | Permits the action silently              |
| `deny`  | Blocks the action with an error message  |
| `ask`   | Prompts the user for confirmation via UI |

### Pi Integration Hooks

The extension integrates via Pi's lifecycle hooks:

| Hook                 | Behavior                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `before_agent_start` | Filters active tools, removes denied tool entries from the system prompt, and hides denied skills |
| `tool_call`          | Enforces permissions for every tool invocation                                                    |
| `input`              | Intercepts `/skill:<name>` requests and enforces skill policy                                     |

**Additional behaviors:**

- Unknown/unregistered tools are blocked before permission checks (prevents bypass attempts)
- The `Available tools:` system prompt section is rewritten to match the filtered active tool set
- Extension-provided tools like `task`, `mcp`, and third-party tools are handled by exact registered name instead of private built-in hardcodes
- When a subagent hits an `ask` permission without direct UI access, the request can be forwarded to the main interactive session for confirmation
- Generic extension-tool approval prompts include a bounded input preview; built-in file tools use concise human-readable summaries instead of raw multiline JSON
- Permission review logs include bounded `toolInputPreview` values for non-bash/non-MCP tool calls so approvals can be audited without writing raw full payloads
- Path-bearing file tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) evaluate `permission.external_directory` before their normal tool permission when an explicit path points outside `ctx.cwd`
- Bash commands are parsed with a full bash AST (`web-tree-sitter` + `tree-sitter-bash`) to extract path-bearing arguments; only genuine command arguments and redirect destinations are checked — heredoc bodies, comments, and quoted string contents are correctly excluded — and paths that resolve outside `ctx.cwd` trigger the same `permission.external_directory` gate before the normal bash pattern check

## Configuration

### Config File

**Location:** one unified config file per scope, following the `pi-autoformat` convention:

| Scope   | Path                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pi-permission-system/config.json` (respects `PI_CODING_AGENT_DIR`)        |
| Project | `<cwd>/.pi/extensions/pi-permission-system/config.json`                                           |

Project config overrides global config; per-agent frontmatter overrides both.
The `permission` object uses deep-shallow merge: string-vs-string replaces; both-object shallow-merges pattern maps; string-vs-object the override wins entirely.
Scalar fields (`debugLog`, `permissionReviewLog`, `yoloMode`) use simple replacement.

The config file combines runtime knobs and permission policy in one object:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json",

  // Runtime knobs
  "debugLog": false,
  "permissionReviewLog": true,
  "yoloMode": false,
  "piInfrastructureReadPaths": [],  // extra dirs to auto-allow for reads

  // Flat permission policy
  "permission": {
    "*": "ask",                              // universal fallback
    "read": "allow",
    "write": "deny",
    "bash": { "git status": "allow", "git *": "ask" },
    "mcp": { "mcp_status": "allow" },
    "skill": { "*": "ask" },
    "external_directory": "ask"
  }
}
```

#### Runtime knobs

| Key                          | Default | Description                                                                                             |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `debugLog`                   | `false` | Enables verbose diagnostic logging to `logs/pi-permission-system-debug.jsonl`                           |
| `permissionReviewLog`        | `true`  | Enables the permission request/denial review log at `logs/pi-permission-system-permission-review.jsonl` |
| `yoloMode`                   | `false` | Auto-approves `ask` results instead of prompting when yolo mode is enabled                              |
| `piInfrastructureReadPaths`  | `[]`    | Extra directories to auto-allow for reads, bypassing the `external_directory` gate (supports `~`)       |

Both logs write to `~/.pi/agent/extensions/pi-permission-system/logs/`.
No debug output is printed to the terminal.

#### Policy sections

The config file is a JSON object with these policy sections:

The `permission` object maps surface names to actions:

| Key | Value type | Description |
| --- | ---------- | ----------- |
| `"*"` | string | Universal fallback — applies when no surface-specific rule matches |
| tool name (e.g. `read`) | string | Catch-all for that tool surface |
| `bash` | string or object | Bash catch-all or `{ pattern: action }` map |
| `mcp` | string or object | MCP catch-all or `{ pattern: action }` map |
| `skill` | string or object | Skill catch-all or `{ pattern: action }` map |
| `external_directory` | string or object | Controls access to paths outside `cwd`; supports `~/` and `$HOME/` patterns |

> **Note:** Trailing commas are **not** supported. If parsing fails, the extension falls back to `ask` for all categories.

### Global Per-Agent Overrides

Override global permissions for specific agents via YAML frontmatter in the global Pi agents directory (default: `~/.pi/agent/agents/<agent>.md`, respects `PI_CODING_AGENT_DIR`):

```yaml
---
name: my-agent
permission:
  read: allow
  write: deny
  mcp: allow
  bash:
    git status: allow
    git *: ask
  mcp:
    chrome_devtools_*: deny
    exa_*: allow
  skill:
    "*": ask
---
```

**MCP behavior:** `permission.mcp` is the coarse entry/fallback permission for a registered `mcp` tool when one is available. More specific `permission.mcp` target rules override that fallback when they match.

**Limitations:** The frontmatter parser is intentionally minimal. Use only `key: value` scalars and nested maps. Avoid arrays, multi-line scalars, and YAML anchors.

### Project-Level Config and Overrides

Project-local config uses the same format as the global config file.
Per-agent overrides use YAML frontmatter in the project agents directory:

| Scope                  | Path                                                          |
| ---------------------- | ------------------------------------------------------------- |
| Project config         | `<cwd>/.pi/extensions/pi-permission-system/config.json`       |
| Project agent override | `<cwd>/.pi/agent/agents/<agent>.md`                           |

These project files are resolved from Pi's current session `cwd`, so they are workspace-specific and do **not** move under `PI_CODING_AGENT_DIR`.

**Precedence order:**

1. Global config file
2. Project config file
3. Global agent frontmatter
4. Project agent frontmatter

Later layers override earlier layers. Within a surface map like `bash` or `mcp`, matching follows **last matching rule wins** — put broad catch-alls first and specific overrides after. The recommended convention is also used by [OpenCode's permission model](https://opencode.ai/docs/permissions/#granular-rules-object-syntax).

---

## Policy Reference

### `permission["*"]` — universal fallback

The `"*"` key sets the action used when no surface-specific rule matches:

```jsonc
{
  "permission": {
    "*": "ask"
  }
}
```

Omitting `"*"` defaults to `"ask"` (least privilege).

### Tool surfaces

Any registered tool name can be a surface key. A string value is a catch-all for that surface.

| Surface example | Description |
| --------------- | ----------- |
| `read`, `write`, `edit`, `grep`, `find`, `ls` | Canonical Pi built-in file tools |
| `bash` | Shell command execution |
| `mcp` | Registered MCP proxy tool |
| `task` | Delegation tool |
| `third_party_tool` | Any other registered extension tool |

```jsonc
{
  "permission": {
    "read": "allow",
    "write": "deny",
    "third_party_tool": "ask"
  }
}
```

Unknown or absent tools are not required in the config. If a tool is not registered at runtime, this extension blocks it before permission checks run.

### `bash` surface

Command patterns use `*` wildcards matched against the full command string. **Last matching rule wins** — put broad catch-alls first, specific overrides after.

```jsonc
{
  "permission": {
    "bash": {
      "*": "ask",
      "git status": "allow",
      "git diff": "allow",
      "git *": "ask",
      "rm -rf *": "deny"
    }
  }
}
```

String shorthand sets a catch-all for all bash commands:

```jsonc
{
  "permission": { "bash": "allow" }
}
```

### `mcp` surface

MCP permissions match against derived targets from tool input:

| Target type | Examples |
| ----------- | -------- |
| Baseline ops | `mcp_status`, `mcp_list`, `mcp_search`, `mcp_describe`, `mcp_connect` |
| Server name | `myServer` |
| Server/tool combo | `myServer:search`, `myServer_search` |
| Generic | `mcp_call` |

```jsonc
{
  "permission": {
    "mcp": {
      "*": "ask",
      "mcp_status": "allow",
      "mcp_list": "allow",
      "myServer:*": "ask",
      "dangerousServer": "deny"
    }
  }
}
```

> **Note:** Baseline discovery targets auto-allow when any explicit `mcp: allow` rule exists.

String shorthand grants broad MCP access — useful for per-agent overrides:

```yaml
# ~/.pi/agent/agents/researcher.md (respects PI_CODING_AGENT_DIR)
---
name: researcher
permission:
  mcp: allow
---
```

### `skill` surface

Skill name patterns use `*` wildcards (note: surface is `skill`, not `skills`):

```jsonc
{
  "permission": {
    "skill": {
      "*": "ask",
      "dangerous-*": "deny",
      "librarian": "allow"
    }
  }
}
```

### Home directory expansion in patterns

Pattern keys in any permission surface can start with `~/` or `$HOME/` (or be exactly `~` / `$HOME`).
They are expanded to the OS home directory at match time, so configs are portable across machines and users.

```jsonc
{
  "permission": {
    "external_directory": {
      "*": "ask",
      "~/development/*": "allow"
    }
  }
}
```

The pattern is stored and displayed as written (e.g. `~/development/*`) in logs and approval dialogs.

### `external_directory` surface

Controls access to paths outside the active working directory.
Use a pattern map to allow specific directories without opening all external access:

```jsonc
{
  "permission": {
    "external_directory": {
      "*": "ask",
      "~/development/*": "allow"
    }
  }
}
```

`external_directory` is evaluated before the normal tool permission check. For example, `read: "allow"` can permit ordinary reads while `external_directory: "ask"` still requires confirmation before reading `../outside.txt` or an absolute path outside `ctx.cwd`.
Optional-path search tools (`find`, `grep`, `ls`) skip this check when no `path` is provided.

Bash commands are also covered: the extension extracts path-like tokens from the command string and applies the same gate when any resolve outside `ctx.cwd`.
Quoted strings are stripped first to reduce false positives.
This is a best-effort heuristic — variable expansion, subshells, and escaped quotes are not parsed.
OS device paths (`/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`) are always excluded.

**Pi infrastructure read auto-allow** — Read-only tools (`read`, `find`, `grep`, `ls`) targeting Pi infrastructure directories are automatically allowed without triggering the gate, even when `external_directory` is `ask` or `deny`.
Infrastructure directories include:

1. The agent config directory (`~/.pi/agent/` or `$PI_CODING_AGENT_DIR`)
2. Git-cloned global packages (`<agentDir>/git/`)
3. The global `node_modules` root (auto-discovered from the extension's own install path; falls back to `npm root -g` when running from a local development checkout)
4. Project-local Pi packages (`<cwd>/.pi/npm/` and `<cwd>/.pi/git/`)
5. Any paths listed in `piInfrastructureReadPaths`

Write tools (`write`, `edit`) to infrastructure paths are **not** auto-allowed and still go through the gate.

---

## Common Recipes

### Read-Only Mode

```jsonc
{
  "permission": {
    "*": "ask",
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "write": "deny",
    "edit": "deny"
  }
}
```

### Restricted Bash Surface

```jsonc
{
  "permission": {
    "*": "ask",
    "bash": {
      "*": "deny",
      "git status": "allow",
      "git diff": "allow",
      "git log *": "allow"
    }
  }
}
```

### MCP Discovery Only

```jsonc
{
  "permission": {
    "*": "ask",
    "mcp": {
      "*": "ask",
      "mcp_status": "allow",
      "mcp_list": "allow",
      "mcp_search": "allow",
      "mcp_describe": "allow"
    }
  }
}
```

### Per-Agent Lockdown

In the global Pi agents directory (default: `~/.pi/agent/agents/reviewer.md`, respects `PI_CODING_AGENT_DIR`):

```yaml
---
permission:
  write: deny
  edit: deny
  bash: deny
---
```

---

## Technical Details

### Permission Prompt Summaries

When a tool permission resolves to `ask`, the prompt is designed to be readable enough for an informed approval decision:

- `bash` prompts show the command and matched bash pattern when available.
- `mcp` prompts show the derived MCP target and matched rule when available.
- Built-in file tools show concise summaries, such as the target path and edit/write line counts, instead of raw multiline JSON.
- Unknown or third-party extension tools show a bounded single-line JSON preview of the input so users are not asked to approve a blind tool name.

Example edit approval prompt:

```text
Current agent requested tool 'edit' for '.gitignore' (1 replacement: edit #1 replaces 5 lines with 2 lines). Allow this call?
```

### Session-Scoped Approvals

When any permission resolves to `ask`, the permission dialog offers four options:

```text
Yes | Yes, allow "<pattern>" for this session | No | No, provide reason
```

Selecting **Yes, allow "\<pattern\>" for this session** approves the current request and records the suggested wildcard pattern as a session rule.
Subsequent requests that match the pattern skip the prompt for the remainder of the session.

The suggested pattern is surface-specific:

|Surface|Example request|Suggested session pattern|
|---|---|---|
|bash|`git status --short`|`git status *`|
|mcp (qualified)|`exa:search`|`exa:*`|
|mcp (munged)|`exa_search`|`exa_*`|
|skill|`librarian`|`librarian`|
|tool (read, write, …)|`read`|`*`|
|external_directory|`/other/project/src/foo.ts`|`/other/project/src/*`|

#### Bash arity table

Bash pattern suggestions use a curated arity dictionary (`src/bash-arity.ts`) to determine how many tokens define the "human-understandable subcommand."
Longest matching prefix wins, so `npm run` (arity 3) takes precedence over `npm` (arity 2).
Unknown commands default to arity 1 (first word only).

|Example command|Arity entry matched|Suggested pattern|
|---|---|---|
|`git checkout main`|`git` → 2|`git checkout *`|
|`npm run dev`|`npm run` → 3|`npm run dev*`|
|`npm install lodash`|`npm` → 2|`npm install *`|
|`docker compose up`|`docker compose` → 3|`docker compose up *`|
|`rm -rf node_modules`|`rm` → 1|`rm *`|
|`mytool --verbose`|(unknown) → 1|`mytool *`|

The arity table covers common CLI tools including git, npm/pnpm/yarn/bun, docker, cargo, go, kubectl, gh, and others.
To add an entry, open `src/bash-arity.ts` and add a key/arity pair to the `ARITY` object.
Put the most specific multi-word prefix first (e.g. `"npm run": 3`) before the shorter fallback (`"npm": 2`).

Session approvals are ephemeral — they are never persisted to disk and are cleared on `session_shutdown`.
The review log records these decisions: `resolution: "approved_for_session"` when the user approves, and `resolution: "session_approved"` when a later request is matched by an existing session rule.

### Subagent Permission Forwarding

When a delegated or routed subagent runs without direct UI access, `ask` permissions can still be enforced by forwarding the confirmation request through Pi session directories. The main interactive session polls for forwarded requests, shows the confirmation prompt, writes the response, and the subagent resumes once that decision is available.

This keeps `ask` policies usable even when the original permission check happens inside a non-UI execution context.

### Coexistence with Subagent Extensions

Several pi-subagent extensions implement their own tool restriction mechanisms.
These compose correctly with the permission system because the two operate at different layers: **visibility** (subagent extension) and **policy** (permission system).

#### The two-layer model

```text
┌─────────────────────────────────────────────────────┐
│  Layer 1 – Visibility  (subagent extension)          │
│  Controls which tools are registered / active        │
│  before the agent session starts.                    │
├─────────────────────────────────────────────────────┤
│  Layer 2 – Policy  (pi-permission-system)            │
│  Controls allow / ask / deny decisions on every      │
│  tool call, bash command, MCP operation, etc.        │
└─────────────────────────────────────────────────────┘
```

#### Known subagent extensions and their mechanisms

|Extension|Mechanism|Frontmatter key|
|----|----------|----------|
|[nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)|`--tools` CLI allowlist passed to subprocess|`tools:` (CSV allowlist)|
|[tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)|`session.setActiveToolsByName()` in-process filter|`disallowed_tools:` (CSV denylist)|
|[HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)|`PI_DENY_TOOLS` env var + `--tools` CLI allowlist|`deny-tools:` (CSV denylist), `spawning:` (bool)|

#### Interaction rules

1. **Hidden tool → permission system never sees it.**
   If a subagent extension removes a tool from the active set, the permission system receives no registration or call event for that tool.
   The permission policy for that tool is irrelevant — it is already gone.
2. **Denied tool → hidden regardless of the subagent extension's allowlist.**
   If the permission system denies a tool (via `deny` policy or tool filtering), it is removed from the active set before the agent starts.
   A `tools:` allowlist in a subagent extension cannot restore a tool that the permission system has already hidden.
3. **The two denylist mechanisms are additive, not conflicting.**
   A tool blocked by either layer stays blocked.
   Neither layer can silently re-enable what the other has blocked.

#### `permission:` frontmatter is exclusive to this extension

The `permission:` key in an agent's YAML frontmatter is read exclusively by `pi-permission-system`.
It has no interaction with the `tools:`, `disallowed_tools:`, or `deny-tools:` keys consumed by subagent extensions.
You can freely use both in the same agent file:

```yaml
---
# Subagent extension: allow only bash and read_file in the subprocess
tools: bash,read_file
# pi-permission-system: still enforce ask on bash within those allowed tools
permission:
  bash: ask
---
```

In this example the subagent extension restricts visibility to `bash` and `read_file`, and the permission system then gates every `bash` call with an `ask` prompt — both rules apply independently.

### Logging

When the extension prompts, denies, or forwards permission requests, it can append structured JSONL entries under:

```text
Default global logs directory: ~/.pi/agent/extensions/pi-permission-system/logs/
Actual global logs directory: $PI_CODING_AGENT_DIR/extensions/pi-permission-system/logs/ when PI_CODING_AGENT_DIR is set
```

- `pi-permission-system-permission-review.jsonl` — enabled by default for permission review/audit history, including bounded `toolInputPreview` values for non-bash/non-MCP tool calls
- `pi-permission-system-debug.jsonl` — disabled by default and intended for troubleshooting

On every session start, the extension emits a `config.resolved` entry to both logs listing the resolved config paths and whether each exists.
This makes it easy to verify which files the extension actually loaded:

```jsonc
{
  "event": "config.resolved",
  "globalConfigPath": "/…/.pi/agent/extensions/pi-permission-system/config.json",
  "globalConfigExists": true,
  "projectConfigPath": "/…/my-project/.pi/extensions/pi-permission-system/config.json",
  "projectConfigExists": false,
  "agentsDir": "/…/.pi/agent/agents",
  "agentsDirExists": true,
  "projectAgentsDir": "/…/my-project/.pi/agent/agents",
  "projectAgentsDirExists": false,
  "legacyGlobalPolicyDetected": false,
  "legacyProjectPolicyDetected": false,
  "legacyExtensionConfigDetected": false
}
```

### Architecture

```text
index.ts                    → Root Pi entrypoint shim
src/
├── index.ts                → Extension bootstrap, permission checks, readable prompts, review logging, reload handling, and subagent forwarding
├── pattern-suggest.ts        → Per-surface session approval pattern suggestions
├── bash-arity.ts             → Curated arity dictionary for smarter bash session-approval patterns
├── session-rules.ts          → Ephemeral session-scoped approval rules (Ruleset-based, wildcard patterns across all surfaces)
├── config-loader.ts        → Unified config loader, merger, and legacy-path detection
├── config-paths.ts         → Path derivation for global, project, and legacy config locations
├── config-reporter.ts      → Resolved config path reporting for diagnostic logs
├── extension-config.ts     → Runtime config normalization and defaults
├── logging.ts              → File-only debug/review logging helpers
├── permission-manager.ts   → Global/project policy loading, merging, and resolution with caching
├── skill-prompt-sanitizer.ts → Skill prompt parsing, multi-block sanitization, and skill-read path matching
├── bash-filter.ts          → Bash command wildcard pattern matching
├── wildcard-matcher.ts     → Shared wildcard pattern compilation and matching
├── common.ts               → Shared utilities (YAML parsing, type guards, etc.)
├── tool-registry.ts        → Registered tool name resolution
└── types.ts                → TypeScript type definitions
tests/
├── permission-system.test.ts → Core permission, layering, forwarding, and policy tests
├── config-modal.test.ts      → Config command and modal behavior tests
└── test-harness.ts           → Shared lightweight test helpers
schemas/
└── permissions.schema.json → JSON Schema for policy validation
config/
└── config.example.json     → Starter global policy template
```

#### Module Organization

The extension uses a modular architecture with shared utilities:

| Module                      | Purpose                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `common.ts`                 | Shared utilities: `toRecord()`, `getNonEmptyString()`, `isPermissionState()`, `parseSimpleYamlMap()`, `extractFrontmatter()` |
| `wildcard-matcher.ts`       | Compile-once wildcard patterns with last-match-wins evaluation: `compileWildcardPatterns()`, `findCompiledWildcardMatch()`   |
| `permission-manager.ts`     | Policy resolution with file stamp caching for performance                                                                    |
| `bash-filter.ts`            | Uses shared wildcard matcher for bash command patterns                                                                       |
| `skill-prompt-sanitizer.ts` | Parses all available skill prompt blocks, removes denied skills, and tracks visible skill paths for read protection          |

#### Performance Optimizations

- **File stamp caching**: Configurations are cached with file modification timestamps to avoid redundant reads
- **Pre-compiled patterns**: Wildcard patterns are compiled to regex once and reused across permission checks
- **Resolved permissions caching**: Merged agent+global permissions are cached per-agent with invalidation on file changes

### Threat Model

**Goal:** Enforce policy at the host level, not the model level.

**What this stops:**

- Agent calling tools it shouldn't use (e.g., `write`, dangerous `bash`)
- Tool switching attempts (calling non-existent tool names)
- Accidental escalation via skill loading
- Unapproved path-bearing tool access outside the active working directory when `external_directory` is `ask` or `deny`

**Limitations:**

- If a dangerous action is possible via an allowed tool, policy must explicitly restrict it
- This is a permission decision layer, not a sandbox

### Schema Validation

Validate your config against the included schema:

```bash
npx --yes ajv-cli@5 validate \
  -s ./schemas/permissions.schema.json \
  -d ./pi-permissions.valid.json
```

**Editor tip:** Add `"$schema": "./schemas/permissions.schema.json"` to your config for autocomplete support.

---

## Event API

The extension emits events on Pi's `pi.events` bus so other extensions can observe permission decisions and integrate with the policy system without importing this package.

### Stability guarantee

Fields may be added to any payload, but existing fields will not be removed or renamed without a semver-major version bump.
The protocol version constant is exported from `src/permission-events.ts` and embedded in every RPC reply.

### Channel reference

|Channel|Direction|When|Payload type|
|---|---|---|---|
|`permissions:ready`|Broadcast|Once, immediately after load|`PermissionsReadyEvent`|
|`permissions:decision`|Broadcast|After every gate resolution|`PermissionDecisionEvent`|
|`permissions:rpc:check`|Request|On-demand|`PermissionsCheckRequest`|
|`permissions:rpc:check:reply:<requestId>`|Reply|After each check request|`PermissionsRpcReply<PermissionsCheckReplyData>`|
|`permissions:rpc:prompt`|Request|On-demand|`PermissionsPromptRequest`|
|`permissions:rpc:prompt:reply:<requestId>`|Reply|After prompt is resolved|`PermissionsRpcReply<PermissionsPromptReplyData>`|

### Surface 1 — Decision broadcasts

Every permission gate resolution emits a `permissions:decision` event, regardless of outcome.
This is useful for dashboards, telemetry, or audit overlays.

```typescript
pi.events.on("permissions:decision", (raw) => {
  const event = raw as import("@gotgenes/pi-permission-system").PermissionDecisionEvent;
  console.log(event.surface, event.result, event.resolution);
  // e.g. "bash" "allow" "user_approved_for_session"
});
```

Payload fields:

|Field|Type|Description|
|---|---|---|
|`surface`|`string`|Permission surface (`"bash"`, `"read"`, `"mcp"`, `"skill"`, `"external_directory"`, etc.)|
|`value`|`string`|Value evaluated (command, tool name, skill name, path)|
|`result`|`"allow" \| "deny"`|Final outcome|
|`resolution`|`string`|How the outcome was reached (see table below)|
|`origin`|`string \| null`|Config scope that contributed the winning rule|
|`agentName`|`string \| null`|Active agent name when known|
|`matchedPattern`|`string \| null`|Pattern from the winning rule|

Resolution values:

|Value|Meaning|
|---|---|
|`policy_allow`|Config rule said allow — no prompt shown|
|`policy_deny`|Config rule said deny — blocked immediately|
|`session_approved`|Covered by a session-level approval from earlier in the same session|
|`infrastructure_auto_allowed`|Read of a Pi infrastructure path — auto-allowed|
|`user_approved`|User approved once via dialog|
|`user_approved_for_session`|User approved for the rest of the session|
|`user_denied`|User denied via dialog|
|`auto_approved`|Yolo mode — approved automatically without dialog|
|`confirmation_unavailable`|State was `ask` but no UI was available — blocked|

### Surface 2 — Policy query RPC

Other extensions can evaluate the current permission policy without importing this package.
The call is synchronous-style: emit a request, listen on a scoped reply channel.

```typescript
const requestId = crypto.randomUUID();

// Listen for the reply first
const unsub = pi.events.on(
  `permissions:rpc:check:reply:${requestId}`,
  (raw) => {
    unsub();
    const reply = raw as import("@gotgenes/pi-permission-system").PermissionsRpcReply<
      import("@gotgenes/pi-permission-system").PermissionsCheckReplyData
    >;
    if (reply.success) {
      console.log(reply.data?.result); // "allow" | "deny" | "ask"
    }
  },
);

// Then emit the request
pi.events.emit("permissions:rpc:check", {
  requestId,
  surface: "bash",
  value: "git push",
  agentName: "Worker", // optional
});
```

If the extension is not loaded, no reply arrives.
Callers should implement a timeout and treat no-reply as `deny` (graceful degradation).

Request fields:

|Field|Required|Description|
|---|---|---|
|`requestId`|Yes|Unique string; scopes the reply channel|
|`surface`|Yes|Permission surface to evaluate|
|`value`|No|Value to evaluate (command, name, path); defaults to `"*"`|
|`agentName`|No|Agent name for per-agent policy resolution|

Reply data fields (`PermissionsCheckReplyData`):

|Field|Type|Description|
|---|---|---|
|`result`|`"allow" \| "deny" \| "ask"`|Policy decision (including active session rules)|
|`matchedPattern`|`string \| null`|Matched rule pattern|
|`origin`|`string \| null`|Config scope of the winning rule|

### Surface 3 — Prompt forwarding RPC

In-process child sessions (e.g. tintinweb/pi-subagents running via `createAgentSession()`) cannot use file-based permission forwarding because no child process is spawned.
They can instead forward permission prompts to the parent session's UI via this RPC.

```typescript
const requestId = crypto.randomUUID();

const unsub = pi.events.on(
  `permissions:rpc:prompt:reply:${requestId}`,
  (raw) => {
    unsub();
    const reply = raw as import("@gotgenes/pi-permission-system").PermissionsRpcReply<
      import("@gotgenes/pi-permission-system").PermissionsPromptReplyData
    >;
    if (reply.success && reply.data?.approved) {
      // proceed
    } else {
      // deny — either user denied or no UI was available (error: "no_ui")
    }
  },
);

pi.events.emit("permissions:rpc:prompt", {
  requestId,
  surface: "bash",
  value: "rm -rf /tmp/build",
  message: "Allow rm -rf /tmp/build?",
  agentName: "Explore",      // optional
  sessionLabel: "Allow rm *", // optional — label for the \"for this session\" option
});
```

The handler replies with `{ success: false, error: "no_ui" }` when no interactive session is available.
A successful reply contains:

|Field|Type|Description|
|---|---|---|
|`approved`|`boolean`|Whether the user approved|
|`state`|`string`|`"approved"`, `"approved_for_session"`, `"denied"`, or `"denied_with_reason"`|
|`denialReason`|`string` (optional)|User-provided denial reason|

### Ready event

The extension emits `permissions:ready` once immediately after it loads.
Consumers that start after the extension can check via a ping-style RPC check — the `permissions:rpc:check` handler is active as long as the extension is loaded.

```typescript
pi.events.on("permissions:ready", (raw) => {
  const event = raw as import("@gotgenes/pi-permission-system").PermissionsReadyEvent;
  console.log("Permission system loaded, protocol version:", event.protocolVersion);
});
```

---

## Migration from pre-v2 layout

Before v2, config was split across two files:

- Policy: `~/.pi/agent/pi-permissions.jsonc`
- Runtime knobs: `<extension-install-dir>/config.json`

These are now consolidated into one file.
The extension detects legacy files and merges them with a warning for one release.
To migrate manually:

```bash
# Move the global policy file
mkdir -p ~/.pi/agent/extensions/pi-permission-system
mv ~/.pi/agent/pi-permissions.jsonc ~/.pi/agent/extensions/pi-permission-system/config.json

# If you had project-level policy:
mkdir -p .pi/extensions/pi-permission-system
mv .pi/agent/pi-permissions.jsonc .pi/extensions/pi-permission-system/config.json
```

Then add any runtime knobs (`debugLog`, `permissionReviewLog`, `yoloMode`) to the same file.
The old extension-root `config.json` is no longer read from the install directory.

> **Note:** Logs also moved from `<extension-install-dir>/logs/` to `~/.pi/agent/extensions/pi-permission-system/logs/`.
> Old log files are not deleted or migrated — they remain readable but no new entries are appended.

---

## Troubleshooting

| Problem                              | Cause                                                      | Solution                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config not applied (everything asks) | File not found or parse error                              | Verify the global config at `~/.pi/agent/extensions/pi-permission-system/config.json` (respects `PI_CODING_AGENT_DIR`); check for trailing commas                    |
| Per-agent override not applied       | Frontmatter parsing issue                                  | Ensure `---` delimiters at file top; keep YAML simple; restart session                                                                                               |
| Tool blocked as unregistered         | Unknown tool name                                          | Use a registered `mcp` tool for server tools: `{ "tool": "server:tool" }`                                                                                            |
| `/skill:<name>` blocked              | Deny policy or confirmation unavailable                    | Check merged `skills` policy (global/project/agent layers). Active agent context is optional in the main session; `ask` still requires UI or forwarded confirmation. |
| External file path blocked           | `special.external_directory` is `ask` without UI or `deny` | Allow/ask the special permission or keep file tools inside the active working directory.                                                                             |
| Permission prompt is too verbose     | Generic extension tool input is large                      | Built-in file tools are summarized automatically; third-party tools are capped to a bounded one-line JSON preview.                                                   |

---

## Development

```bash
pnpm run build       # Type-check TypeScript (no emit)
pnpm run lint        # Biome lint + format check
pnpm run lint:fix    # Biome lint + format auto-fix
pnpm run lint:md     # markdownlint-cli2 on README etc.
pnpm run lint:all    # lint + lint:md
pnpm run format      # Biome format --write
pnpm run test        # Run tests from ./tests
pnpm run check       # build + lint:all + test
```

### Pre-commit hooks

This project uses [prek](https://prek.j178.dev/) to run Biome and markdownlint on staged files before each commit.
This catches lint and formatting issues locally instead of waiting for CI.

1. Install prek ([installation guide](https://prek.j178.dev/installation/)).
2. Run `pnpm install` — the `prepare` script calls `prek install` automatically.
   If prek is not installed, the script prints a warning and continues.
3. Hooks run automatically on `git commit`.
   To skip in emergencies: `git commit --no-verify`.

The hook configuration lives in `prek.toml` at the repo root.

---

## Acknowledgments

This project began as a fork of [MasuRii/pi-permission-system](https://github.com/MasuRii/pi-permission-system).
Thank you to [MasuRii](https://github.com/MasuRii) for the original work that made this possible.

Thank you to the [OpenCode](https://opencode.ai) team for the permission model design that inspired the flat config format and evaluation semantics used in this extension.

## License

[MIT](LICENSE)
