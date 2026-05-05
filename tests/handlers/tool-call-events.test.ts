/**
 * Tests that handleToolCall emits permissions:decision events at every
 * gate resolution and fast-path site.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { handleToolCall } from "../../src/handlers/tool-call";
import type { HandlerDeps } from "../../src/handlers/types";
import type { PermissionDecisionEvent } from "../../src/permission-events";
import { PERMISSIONS_DECISION_CHANNEL } from "../../src/permission-events";
import type { ExtensionRuntime } from "../../src/runtime";
import type { PermissionCheckResult } from "../../src/types";

// ── helpers ────────────────────────────────────────────────────────────────

function makeEvents() {
  return {
    emit: vi.fn<[string, unknown], void>(),
    on: vi
      .fn<[string, (data: unknown) => void], () => void>()
      .mockReturnValue(() => undefined),
  };
}

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: "/test/project",
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
    },
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
      getSessionDir: vi.fn().mockReturnValue("/sessions/test"),
      addEntry: vi.fn(),
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

function makeToolCallEvent(
  toolName: string,
  extraFields: Record<string, unknown> = {},
) {
  return {
    type: "tool_call",
    toolCallId: "tc-1",
    name: toolName,
    input: {},
    ...extraFields,
  };
}

function makeCheckResult(
  state: "allow" | "deny" | "ask",
  overrides: Partial<PermissionCheckResult> = {},
): PermissionCheckResult {
  return {
    state,
    toolName: "read",
    source: "tool",
    origin: "builtin",
    matchedPattern: "*",
    ...overrides,
  };
}

function makeRuntime(
  overrides: Partial<ExtensionRuntime> = {},
): ExtensionRuntime {
  return {
    agentDir: "/test/agent",
    sessionsDir: "/test/agent/sessions",
    subagentSessionsDir: "/test/agent/subagent-sessions",
    forwardingDir: "/test/agent/sessions/permission-forwarding",
    globalLogsDir: "/test/agent/extensions/pi-permission-system/logs",
    piInfrastructureDirs: ["/test/agent", "/test/agent/git"],
    config: { debugLog: false, permissionReviewLog: true, yoloMode: false },
    runtimeContext: null,
    permissionManager: {
      checkPermission: vi.fn().mockReturnValue(makeCheckResult("allow")),
    } as unknown as ExtensionRuntime["permissionManager"],
    activeSkillEntries: [],
    lastKnownActiveAgentName: null,
    lastActiveToolsCacheKey: null,
    lastPromptStateCacheKey: null,
    lastConfigWarning: null,
    sessionRules: {
      approve: vi.fn(),
      getRuleset: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as ExtensionRuntime["sessionRules"],
    permissionForwardingContext: null,
    permissionForwardingTimer: null,
    isProcessingForwardedRequests: false,
    writeDebugLog: vi.fn(),
    writeReviewLog: vi.fn(),
    ...overrides,
  } as ExtensionRuntime;
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    runtime: makeRuntime(),
    events: makeEvents(),
    createPermissionManagerForCwd: vi.fn(),
    refreshExtensionConfig: vi.fn(),
    notifyWarning: vi.fn(),
    logResolvedConfigPaths: vi.fn(),
    resolveAgentName: vi.fn().mockReturnValue(null),
    canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
    promptPermission: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" }),
    createPermissionRequestId: vi.fn().mockReturnValue("req-id"),
    startForwardedPermissionPolling: vi.fn(),
    stopForwardedPermissionPolling: vi.fn(),
    stopPermissionRpcHandlers: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([{ name: "read" }, { name: "bash" }]),
    setActiveTools: vi.fn(),
    ...overrides,
  };
}

/** Extract all permissions:decision payloads from the events.emit mock. */
function getDecisionEvents(deps: HandlerDeps): PermissionDecisionEvent[] {
  const emitMock = (deps.events as ReturnType<typeof makeEvents>).emit;
  return emitMock.mock.calls
    .filter(([channel]) => channel === PERMISSIONS_DECISION_CHANNEL)
    .map(([, payload]) => payload as PermissionDecisionEvent);
}

// ── policy_allow path ──────────────────────────────────────────────────────

describe("handleToolCall decision events — policy_allow", () => {
  it("emits allow with policy_allow when checkPermission returns allow", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(
            makeCheckResult("allow", {
              origin: "global",
              matchedPattern: "*",
            }),
          ),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
    });

    await handleToolCall(deps, makeToolCallEvent("read"), makeCtx());

    const events = getDecisionEvents(deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: "read",
      result: "allow",
      resolution: "policy_allow",
      origin: "global",
      matchedPattern: "*",
    });
  });
});

// ── policy_deny path ───────────────────────────────────────────────────────

describe("handleToolCall decision events — policy_deny", () => {
  it("emits deny with policy_deny when checkPermission returns deny", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(
            makeCheckResult("deny", {
              origin: "project",
              matchedPattern: "read",
            }),
          ),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
    });

    await handleToolCall(deps, makeToolCallEvent("read"), makeCtx());

    const events = getDecisionEvents(deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: "read",
      result: "deny",
      resolution: "policy_deny",
    });
  });
});

// ── session_approved fast path ─────────────────────────────────────────────

describe("handleToolCall decision events — session_approved", () => {
  it("emits allow with session_approved when checkPermission returns source:session", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(
            makeCheckResult("allow", {
              source: "session",
              matchedPattern: "git *",
            }),
          ),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
    });

    await handleToolCall(
      deps,
      makeToolCallEvent("bash", { input: { command: "git status" } }),
      makeCtx(),
    );

    const events = getDecisionEvents(deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: "bash",
      result: "allow",
      resolution: "session_approved",
    });
  });
});

// ── user_approved path ─────────────────────────────────────────────────────

describe("handleToolCall decision events — user_approved", () => {
  it("emits allow with user_approved when state=ask and user approves once", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    });

    await handleToolCall(deps, makeToolCallEvent("read"), makeCtx());

    const events = getDecisionEvents(deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      result: "allow",
      resolution: "user_approved",
    });
  });

  it("emits allow with user_approved_for_session when user approves for session", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });

    await handleToolCall(deps, makeToolCallEvent("read"), makeCtx());

    const events = getDecisionEvents(deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      result: "allow",
      resolution: "user_approved_for_session",
    });
  });
});

// ── user_denied path ───────────────────────────────────────────────────────

describe("handleToolCall decision events — user_denied", () => {
  it("emits deny with user_denied when state=ask and user denies", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: false, state: "denied" }),
    });

    await handleToolCall(deps, makeToolCallEvent("read"), makeCtx());

    const events = getDecisionEvents(deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      result: "deny",
      resolution: "user_denied",
    });
  });
});

// ── confirmation_unavailable path ──────────────────────────────────────────

describe("handleToolCall decision events — confirmation_unavailable", () => {
  it("emits deny with confirmation_unavailable when state=ask but no UI", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(false),
    });

    await handleToolCall(
      deps,
      makeToolCallEvent("read"),
      makeCtx({ hasUI: false }),
    );

    const events = getDecisionEvents(deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      result: "deny",
      resolution: "confirmation_unavailable",
    });
  });
});

// ── infrastructure_auto_allowed path ──────────────────────────────────────

describe("handleToolCall decision events — infrastructure_auto_allowed", () => {
  it("emits allow with infrastructure_auto_allowed for Pi infra reads", async () => {
    const infraDir = "/test/agent";
    const deps = makeDeps({
      runtime: makeRuntime({
        piInfrastructureDirs: [infraDir],
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makeCheckResult("allow")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
    });

    const event = makeToolCallEvent("read", {
      input: { path: `${infraDir}/some-file.json` },
    });
    await handleToolCall(deps, event, makeCtx());

    const events = getDecisionEvents(deps);
    // One infrastructure_auto_allowed event + one policy_allow for the normal gate
    const infraEvents = events.filter(
      (e) => e.resolution === "infrastructure_auto_allowed",
    );
    expect(infraEvents).toHaveLength(1);
    expect(infraEvents[0]).toMatchObject({
      result: "allow",
      resolution: "infrastructure_auto_allowed",
    });
  });
});
