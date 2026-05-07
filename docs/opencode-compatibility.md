# OpenCode Compatibility

This extension's flat permission format and evaluation semantics were directly inspired by [OpenCode's permission model](https://opencode.ai/docs/permissions/) (v1.1.x permission rework).
If you are familiar with OpenCode's permission system, most concepts transfer directly — the same mental model applies.

> **Point-in-time reference.**
> This comparison reflects OpenCode as of May 2026.
> See the [official OpenCode permissions docs](https://opencode.ai/docs/permissions/) for the latest upstream behavior.

## What Transfers Directly

The following concepts are shared between OpenCode and this extension:

|Concept|Description|
|---|---|
|Three actions|`allow` / `ask` / `deny` — identical semantics|
|Flat `permission` object|Top-level key in config; surface names as keys|
|`"*"` universal fallback|Sets the default action when no surface-specific rule matches|
|Granular object syntax|Surface key → string (catch-all) or `{ pattern: action }` map|
|Last-match-wins|When multiple patterns match, the last one in config order wins|
|`*` wildcard|Matches zero or more of any character (including path separators)|
|Home directory expansion|`~/` and `$HOME/` expand to the OS home directory in patterns|
|`external_directory` surface|Gates access to paths outside the working directory|
|`bash` surface|Command patterns matched against shell commands|
|`skill` surface|Skill name patterns matched against skill invocations|
|`task` surface|Gates subagent/delegation tool calls|
|Session-scoped approvals|`once` / `always` / `reject` from the ask dialog; `always` adds a session rule|
|Per-agent overrides|Override global permissions for specific agents|
|Tool hiding|Denied tools are removed before the agent starts (no wasted turns probing)|

If your OpenCode config uses these features, the equivalent works in this extension with minimal translation (see [Porting Guide](#porting-an-opencode-config) below).

## Where They Diverge

### Summary Table

|Area|OpenCode|This extension|
|---|---|---|
|Default fallback|`"*": "allow"` (permissive)|`"*": "ask"` (least privilege)|
|`.env` file protection|Built-in `read` rules deny/ask `.env` files|No built-in rules; user configures manually|
|`?` wildcard|Matches exactly one character|Not supported; `?` is a literal character|
|Trailing wildcard optionality|`"ls *"` matches bare `"ls"` (trailing `*` is optional)|`"ls *"` does NOT match bare `"ls"`|
|`doom_loop` surface|Active, defaults to `ask`|Deprecated and removed|
|File mutation surfaces|`edit` covers `edit`, `write`, `apply_patch`|Separate `write` and `edit` surfaces|
|Search/discovery surfaces|`glob`, `grep`, `list`|`find`, `grep`, `ls` (Pi tool names)|
|OpenCode-only surfaces|`lsp`, `question`, `webfetch`, `websearch`, `todowrite`|Not applicable (Pi lacks these tools)|
|`mcp` surface|Not a documented permission surface|First-class with server/tool-level granularity|
|Top-level string shorthand|`"permission": "allow"` sets all surfaces|Not supported; must use an object|
|Bash arity table|Extracts "human-understandable command" before rule matching|Has arity table, but uses it only for session approval pattern suggestions — rule matching is against the full command string|
|Per-agent config location|`agent` key in config JSON or YAML frontmatter|YAML frontmatter in agent `.md` files only|
|Config file paths|`~/.config/opencode/opencode.json`|`~/.pi/agent/extensions/pi-permission-system/config.json`|
|Subagent prompt forwarding|Not documented|`ask` policies work in non-UI subagent contexts|
|Infrastructure auto-allow|N/A|Read-only tools to Pi infra dirs bypass the gate|
|Permission review log|No equivalent documented|Writes decisions to a JSONL audit log|

### Notable Differences Explained

#### Default Fallback: `allow` vs `ask`

OpenCode defaults to permissive — most tools work without configuration.
This extension defaults to least privilege — omitting `"*"` gives you `"ask"` for everything.

If you want OpenCode-like permissiveness:

```jsonc
{
  "permission": {
    "*": "allow",
    "external_directory": "ask"
  }
}
```

#### File Mutation Surfaces

OpenCode unifies all file writes under a single `edit` permission.
This extension exposes Pi's actual tool names: `write` (create/overwrite) and `edit` (targeted replacement).

To replicate OpenCode's unified behavior, set both to the same action:

```jsonc
{
  "permission": {
    "write": "ask",
    "edit": "ask"
  }
}
```

#### Trailing Wildcard Optionality

In OpenCode, `"git *"` matches both `"git status"` and bare `"git"` (the trailing `*` is treated as optional).
In this extension, `"git *"` only matches commands that start with `"git "` followed by something.
To match both cases, add an explicit rule for the bare command:

```jsonc
{
  "permission": {
    "bash": {
      "git": "allow",
      "git *": "allow"
    }
  }
}
```

#### `?` Wildcard

OpenCode supports `?` to match exactly one character (e.g., `"file?.txt"` matches `"file1.txt"` but not `"file12.txt"`).
This extension treats `?` as a literal character.
Use `*` for broader matching instead.

#### MCP Surface (Pi-Only)

This extension provides a first-class `mcp` permission surface with granular server and tool-level control:

```jsonc
{
  "permission": {
    "mcp": {
      "*": "ask",
      "mcp_status": "allow",
      "myServer:*": "ask",
      "dangerousServer": "deny"
    }
  }
}
```

OpenCode does not expose MCP as a configurable permission surface.

## Porting an OpenCode Config

### Before (OpenCode)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "*": "allow",
    "bash": {
      "*": "ask",
      "git *": "allow",
      "npm *": "allow",
      "rm *": "deny"
    },
    "edit": {
      "*": "ask",
      "src/**/*.ts": "allow"
    },
    "external_directory": {
      "~/projects/**": "allow"
    }
  }
}
```

### After (this extension)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json",
  "permission": {
    "*": "allow",
    "bash": {
      "*": "ask",
      "git": "allow",
      "git *": "allow",
      "npm": "allow",
      "npm *": "allow",
      "rm *": "deny"
    },
    "write": "ask",
    "edit": "ask",
    "external_directory": {
      "*": "ask",
      "~/projects/*": "allow"
    }
  }
}
```

### Key Translation Steps

1. **Replace `"permission": "allow"`** (top-level string) with `"permission": { "*": "allow" }`.
2. **Split `edit`** into separate `write` and `edit` entries if you need different policies for create vs. modify.
   If not, set both to the same action.
3. **Rename search surfaces**: `glob` → `find`, `list` → `ls`.
4. **Add bare-command rules** for any pattern that uses trailing `*` where you also want to match the command alone (e.g., add `"git": "allow"` alongside `"git *": "allow"`).
5. **Replace `**`** with `*` in external_directory patterns — this extension's `*` already matches across path separators.
6. **Add `.env` rules manually** if you relied on OpenCode's built-in protection:

    ```jsonc
    {
      "permission": {
        "read": {
          "*": "allow",
          "*.env": "deny",
          "*.env.*": "deny",
          "*.env.example": "allow"
        }
      }
    }
    ```

7. **Remove OpenCode-only surfaces** (`lsp`, `question`, `webfetch`, `websearch`, `todowrite`, `doom_loop`) — they have no effect in this extension.
8. **Add `mcp` rules** if you use MCP servers — OpenCode has no equivalent, so this is new configuration.
