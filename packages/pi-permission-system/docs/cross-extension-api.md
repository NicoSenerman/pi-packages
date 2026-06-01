# Event API

The extension provides two cross-extension integration surfaces:

1. **Service accessor** (preferred) — a `Symbol.for()`-backed synchronous API on `globalThis` for direct policy queries.
2. **Event bus** — broadcasts and RPC on `pi.events` for observation and prompt forwarding.

---

## Service Accessor

The preferred way for other extensions to query the permission policy is the `Symbol.for()`-backed service accessor.
It provides direct, synchronous, type-safe function calls — no async RPC envelope needed.

### Quick Start

```typescript
try {
  const { getPermissionsService } = await import(
    "@gotgenes/pi-permission-system"
  );
  const permissions = getPermissionsService();
  if (permissions) {
    const result = permissions.checkPermission("bash", "git push");
    console.log(result.state); // "allow" | "deny" | "ask"
  }
} catch {
  // Not installed — graceful degradation
}
```

### How It Works

Pi's extension loader creates a fresh [jiti](https://github.com/nicolo-ribaudo/jiti) instance per extension with `moduleCache: false`, which isolates module-level state.
`Symbol.for()` and `globalThis` are process-global by spec, so they survive this isolation.

The permission-system extension publishes a service object on `globalThis` via `Symbol.for("@gotgenes/pi-permission-system:service")` during startup.
Consumers call `getPermissionsService()` to retrieve it — even though their `import()` loads a fresh module copy, the accessor reads from the shared `globalThis` slot.

### API

The `PermissionsService` interface:

```typescript
interface PermissionsService {
  /** Query the permission policy for a surface and value. */
  checkPermission(
    surface: string,
    value?: string,
    agentName?: string,
  ): PermissionCheckResult;

  /** Query tool-level permission state for pre-filtering before session creation. */
  getToolPermission(toolName: string, agentName?: string): PermissionState;

  /**
   * Register a custom preview formatter for a specific tool name.
   * Returns a disposer that unregisters the formatter.
   * Throws if a formatter is already registered for that tool name.
   */
  registerToolInputFormatter(
    toolName: string,
    formatter: (input: Record<string, unknown>) => string | undefined,
  ): () => void;
}
```

#### `checkPermission`

| Parameter   | Required | Description                                                                              |
| ----------- | -------- | ---------------------------------------------------------------------------------------- |
| `surface`   | Yes      | Permission surface: `"bash"`, `"read"`, `"mcp"`, `"skill"`, `"external_directory"`, etc. |
| `value`     | No       | Value to evaluate (command, name, path); defaults to `""`                                |
| `agentName` | No       | Agent name for per-agent policy resolution                                               |

Returns `PermissionCheckResult` with fields `state`, `matchedPattern`, `source`, `origin`, etc.

#### `getToolPermission`

Returns `"allow"` | `"deny"` | `"ask"` for a tool name without considering command-level rules.
Use this to pre-filter a tool list before creating a child session — it avoids calling `checkPermission` per tool and interpreting the full result.

```typescript
const denied = tools.filter(
  (t) => permissions.getToolPermission(t, agentName) === "deny",
);
```

#### `registerToolInputFormatter`

Register a custom preview formatter for a specific tool name.
The formatter is called inside `ToolPreviewFormatter.formatToolInputForPrompt` before the built-in switch — return a string to use it as the ask-prompt preview, or `undefined` to fall through to the default.

Only one formatter may be registered per tool name.
A second call for the same name throws.
The returned disposer unregisters the formatter; it is identity-guarded so a stale call cannot evict a later registration.

```typescript
const svc = getPermissionsService();
const dispose = svc?.registerToolInputFormatter(
  "my-server:batch",
  (input) => {
    const cmds = input.commands;
    return Array.isArray(cmds)
      ? `runs ${cmds.length} command${cmds.length === 1 ? "" : "s"}`
      : undefined;
  },
);

// On extension shutdown:
dispose?.();
```

A built-in formatter for the `"mcp"` surface ships by default and renders a compact key/value summary of the call's `arguments`.
Register before startup is complete to install your formatter before the built-in.
To override the built-in `"mcp"` formatter, dispose it first (the disposer is returned by your own registration — the built-in is registered internally and cannot be disposed externally; raise an issue if you need this).

#### Subagent session registration

In-process subagent registration is event-driven.
`@gotgenes/pi-subagents` emits `subagents:child:session-created` before `bindExtensions()` and `subagents:child:disposed` in the run's `finally`; the permission system subscribes automatically — no service call from the spawner is required.
See [Subagent Integration](subagent-integration.md) for details.

### Reload Safety

During `/reload`, all extensions re-initialize.
The permission-system clears the slot on shutdown and publishes a fresh service on re-initialization.
Consumers that re-initialize during reload naturally get the new instance.

Best practice: call `getPermissionsService()` per use rather than caching the reference.

### Graceful Degradation

`getPermissionsService()` returns `undefined` when the permission-system extension has not loaded (or has been unloaded).
The `import()` throws if the package is not installed.
Wrap both in `try/catch` + `if` guard as shown in the Quick Start example.

---

## Event Bus

The extension also emits events on Pi's `pi.events` bus so other extensions can observe permission decisions and integrate with the policy system without importing this package.

## Stability Guarantee

Fields may be added to any payload, but existing fields will not be removed or renamed without a semver-major version bump.
The protocol version constant is exported from `src/permission-events.ts` and embedded in every RPC reply.

## Channel Reference

| Channel                                    | Direction | When                         | Payload type                                      |
| ------------------------------------------ | --------- | ---------------------------- | ------------------------------------------------- |
| `permissions:ready`                        | Broadcast | Once, immediately after load | `PermissionsReadyEvent`                           |
| `permissions:decision`                     | Broadcast | After every gate resolution  | `PermissionDecisionEvent`                         |
| `permissions:rpc:check`                    | Request   | On-demand                    | `PermissionsCheckRequest`                         |
| `permissions:rpc:check:reply:<requestId>`  | Reply     | After each check request     | `PermissionsRpcReply<PermissionsCheckReplyData>`  |
| `permissions:rpc:prompt`                   | Request   | On-demand                    | `PermissionsPromptRequest`                        |
| `permissions:rpc:prompt:reply:<requestId>` | Reply     | After prompt is resolved     | `PermissionsRpcReply<PermissionsPromptReplyData>` |

---

## Decision Broadcasts

Every permission gate resolution emits a `permissions:decision` event, regardless of outcome.
This is useful for dashboards, telemetry, or audit overlays.

```typescript
pi.events.on("permissions:decision", (raw) => {
  const event = raw as import("@gotgenes/pi-permission-system").PermissionDecisionEvent;
  console.log(event.surface, event.result, event.resolution);
  // e.g. "bash" "allow" "user_approved_for_session"
});
```

### Payload Fields

| Field            | Type                | Description                                                                               |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `surface`        | `string`            | Permission surface (`"bash"`, `"read"`, `"mcp"`, `"skill"`, `"external_directory"`, etc.) |
| `value`          | `string`            | Value evaluated (command, tool name, skill name, path)                                    |
| `result`         | `"allow" \| "deny"` | Final outcome                                                                             |
| `resolution`     | `string`            | How the outcome was reached (see table below)                                             |
| `origin`         | `string \| null`    | Config scope that contributed the winning rule                                            |
| `agentName`      | `string \| null`    | Active agent name when known                                                              |
| `matchedPattern` | `string \| null`    | Pattern from the winning rule                                                             |

### Resolution Values

| Value                         | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `policy_allow`                | Config rule said allow — no prompt shown                             |
| `policy_deny`                 | Config rule said deny — blocked immediately                          |
| `session_approved`            | Covered by a session-level approval from earlier in the same session |
| `infrastructure_auto_allowed` | Read of a Pi infrastructure path — auto-allowed                      |
| `user_approved`               | User approved once via dialog                                        |
| `user_approved_for_session`   | User approved for the rest of the session                            |
| `user_denied`                 | User denied via dialog                                               |
| `auto_approved`               | Yolo mode — approved automatically without dialog                    |
| `confirmation_unavailable`    | State was `ask` but no UI was available — blocked                    |

---

## Policy Query RPC (deprecated)

> **Deprecated**: prefer the [Service Accessor](#service-accessor) above.
> The event-bus RPC remains available as a zero-dependency fallback.

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

### Request Fields

| Field       | Required | Description                                                |
| ----------- | -------- | ---------------------------------------------------------- |
| `requestId` | Yes      | Unique string; scopes the reply channel                    |
| `surface`   | Yes      | Permission surface to evaluate                             |
| `value`     | No       | Value to evaluate (command, name, path); defaults to `"*"` |
| `agentName` | No       | Agent name for per-agent policy resolution                 |

### Reply Data Fields (`PermissionsCheckReplyData`)

| Field            | Type                         | Description                                      |
| ---------------- | ---------------------------- | ------------------------------------------------ |
| `result`         | `"allow" \| "deny" \| "ask"` | Policy decision (including active session rules) |
| `matchedPattern` | `string \| null`             | Matched rule pattern                             |
| `origin`         | `string \| null`             | Config scope of the winning rule                 |

---

## Prompt Forwarding RPC

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
  sessionLabel: "Allow rm *", // optional — label for the "for this session" option
});
```

The handler replies with `{ success: false, error: "no_ui" }` when no interactive session is available.

### Successful Reply Fields

| Field          | Type                | Description                                                                   |
| -------------- | ------------------- | ----------------------------------------------------------------------------- |
| `approved`     | `boolean`           | Whether the user approved                                                     |
| `state`        | `string`            | `"approved"`, `"approved_for_session"`, `"denied"`, or `"denied_with_reason"` |
| `denialReason` | `string` (optional) | User-provided denial reason                                                   |

---

## Ready Event

The extension emits `permissions:ready` once immediately after it loads.
Consumers that start after the extension can check via a ping-style RPC check — the `permissions:rpc:check` handler is active as long as the extension is loaded.

```typescript
pi.events.on("permissions:ready", (raw) => {
  const event = raw as import("@gotgenes/pi-permission-system").PermissionsReadyEvent;
  console.log("Permission system loaded, protocol version:", event.protocolVersion);
});
```
