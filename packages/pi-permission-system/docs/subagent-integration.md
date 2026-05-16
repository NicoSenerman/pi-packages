# Subagent Integration

## Permission Forwarding

When a delegated or routed subagent runs without direct UI access, `ask` permissions can still be enforced by forwarding the confirmation request through Pi session directories.
The main interactive session polls for forwarded requests, shows the confirmation prompt, writes the response, and the subagent resumes once that decision is available.

This keeps `ask` policies usable even when the original permission check happens inside a non-UI execution context.

For in-process child sessions (e.g. tintinweb/pi-subagents running via `createAgentSession()`), the [Prompt Forwarding RPC](cross-extension-api.md#prompt-forwarding-rpc) is used instead of file-based forwarding.

---

## Coexistence with Subagent Extensions

Several pi-subagent extensions implement their own tool restriction mechanisms.
These compose correctly with the permission system because the two operate at different layers: **visibility** (subagent extension) and **policy** (permission system).

### The Two-Layer Model

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

### Known Subagent Extensions

| Extension                                                                           | Mechanism                                          | Frontmatter key                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)               | `--tools` CLI allowlist passed to subprocess       | `tools:` (CSV allowlist)                         |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)                 | `session.setActiveToolsByName()` in-process filter | `disallowed_tools:` (CSV denylist)               |
| [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) | `PI_DENY_TOOLS` env var + `--tools` CLI allowlist  | `deny-tools:` (CSV denylist), `spawning:` (bool) |

### Interaction Rules

1. **Hidden tool → permission system never sees it.**
   If a subagent extension removes a tool from the active set, the permission system receives no registration or call event for that tool.
   The permission policy for that tool is irrelevant — it is already gone.

2. **Denied tool → hidden regardless of the subagent extension's allowlist.**
   If the permission system denies a tool (via `deny` policy or tool filtering), it is removed from the active set before the agent starts.
   A `tools:` allowlist in a subagent extension cannot restore a tool that the permission system has already hidden.

3. **The two denylist mechanisms are additive, not conflicting.**
   A tool blocked by either layer stays blocked.
   Neither layer can silently re-enable what the other has blocked.

### `permission:` Frontmatter is Exclusive to This Extension

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
