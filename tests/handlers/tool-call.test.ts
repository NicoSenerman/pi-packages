import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { getEventInput, handleToolCall } from "../../src/handlers/tool-call";
import type { HandlerDeps } from "../../src/handlers/types";
import type { ExtensionRuntime } from "../../src/runtime";
import type { PermissionCheckResult } from "../../src/types";

// ── SDK stubs ──────────────────────────────────────────────────────────────
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return { ...original };
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeCtx(
  overrides: Partial<ExtensionContext> & { cwd?: string } = {},
): ExtensionContext {
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

function makePermissionResult(
  state: "allow" | "deny" | "ask",
): PermissionCheckResult {
  return { state, toolName: "read", source: "tool", origin: "builtin" };
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
      checkPermission: vi.fn().mockReturnValue(makePermissionResult("allow")),
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
    events: { emit: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) },
    startForwardedPermissionPolling: vi.fn(),
    stopForwardedPermissionPolling: vi.fn(),
    stopPermissionRpcHandlers: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([{ name: "read" }, { name: "bash" }]),
    setActiveTools: vi.fn(),
    ...overrides,
  };
}

// ── getEventInput ──────────────────────────────────────────────────────────

describe("getEventInput", () => {
  it("returns the input field when present", () => {
    expect(getEventInput({ input: { path: "/foo" } })).toEqual({
      path: "/foo",
    });
  });

  it("returns the arguments field when input is absent", () => {
    expect(getEventInput({ arguments: { command: "ls" } })).toEqual({
      command: "ls",
    });
  });

  it("returns empty object when neither field is present", () => {
    expect(getEventInput({ type: "tool_call" })).toEqual({});
  });

  it("prefers input over arguments when both are present", () => {
    expect(getEventInput({ input: { a: 1 }, arguments: { b: 2 } })).toEqual({
      a: 1,
    });
  });
});

// ── handleToolCall ─────────────────────────────────────────────────────────

describe("handleToolCall", () => {
  it("sets runtime context", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleToolCall(deps, makeToolCallEvent("read"), ctx);
    expect(deps.runtime.runtimeContext).toBe(ctx);
  });

  it("starts forwarded permission polling", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleToolCall(deps, makeToolCallEvent("read"), ctx);
    expect(deps.startForwardedPermissionPolling).toHaveBeenCalledWith(ctx);
  });

  it("blocks when tool name cannot be resolved", async () => {
    const deps = makeDeps();
    // An event with no recognisable name field
    const result = await handleToolCall(deps, { type: "tool_call" }, makeCtx());
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("tool"),
    });
  });

  it("blocks when tool is not registered", async () => {
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    const result = await handleToolCall(
      deps,
      makeToolCallEvent("unknown-tool"),
      makeCtx(),
    );
    expect(result).toMatchObject({ block: true });
  });

  it("returns empty object when tool is allowed", async () => {
    // default makeRuntime() has checkPermission → "allow"
    const deps = makeDeps();
    const result = await handleToolCall(
      deps,
      makeToolCallEvent("read"),
      makeCtx(),
    );
    expect(result).toEqual({});
  });

  it("blocks when tool is denied by policy", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi
            .fn()
            .mockReturnValue(makePermissionResult("deny")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
    });
    const result = await handleToolCall(
      deps,
      makeToolCallEvent("read"),
      makeCtx(),
    );
    expect(result).toMatchObject({ block: true });
  });

  it("blocks when tool ask has no UI available", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makePermissionResult("ask")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(false),
    });
    const result = await handleToolCall(
      deps,
      makeToolCallEvent("read"),
      makeCtx(),
    );
    expect(result).toMatchObject({ block: true });
  });

  it("allows when user approves the ask prompt", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makePermissionResult("ask")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    });
    const result = await handleToolCall(
      deps,
      makeToolCallEvent("read"),
      makeCtx(),
    );
    expect(result).toEqual({});
  });

  it("blocks when user denies the ask prompt", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makePermissionResult("ask")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: false, state: "denied" }),
    });
    const result = await handleToolCall(
      deps,
      makeToolCallEvent("read"),
      makeCtx(),
    );
    expect(result).toMatchObject({ block: true });
  });
});

// ── skill-read gate ────────────────────────────────────────────────────────

describe("handleToolCall — skill-read gate", () => {
  it("blocks a read of a denied skill path", async () => {
    const skillEntry = {
      name: "librarian",
      description: "Research skills",
      location: "/skills/librarian/SKILL.md",
      state: "deny" as const,
      normalizedLocation: "/skills/librarian/SKILL.md",
      normalizedBaseDir: "/skills/librarian",
    };
    const deps = makeDeps({
      runtime: makeRuntime({ activeSkillEntries: [skillEntry] }),
      getAllTools: vi.fn().mockReturnValue([{ toolName: "read" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-skill",
      toolName: "read",
      input: { path: "/skills/librarian/SKILL.md" },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });

  it("allows a read of a non-skill path even when skill entries are present", async () => {
    const skillEntry = {
      name: "librarian",
      description: "Research skills",
      location: "/skills/librarian/SKILL.md",
      state: "deny" as const,
      normalizedLocation: "/skills/librarian/SKILL.md",
      normalizedBaseDir: "/skills/librarian",
    };
    const deps = makeDeps({
      runtime: makeRuntime({ activeSkillEntries: [skillEntry] }),
      getAllTools: vi.fn().mockReturnValue([{ toolName: "read" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-ok",
      toolName: "read",
      input: { path: "/test/project/src/index.ts" },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toEqual({});
  });
});

// ── external-directory gate ────────────────────────────────────────────────

describe("handleToolCall — external-directory gate", () => {
  it("blocks a read of a path outside cwd when policy is deny", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi
            .fn()
            .mockReturnValue(makePermissionResult("deny")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-ext",
      name: "read",
      input: { path: "/outside/project/file.ts" },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });

  it("allows when session has an existing approval for the external path", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        sessionRules: {
          approve: vi.fn(),
          getRuleset: vi.fn().mockReturnValue([
            {
              surface: "external_directory",
              pattern: "/outside/project/*",
              action: "allow",
            },
          ]),
          clear: vi.fn(),
        } as unknown as ExtensionRuntime["sessionRules"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-session",
      name: "read",
      input: { path: "/outside/project/file.ts" },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toEqual({});
  });

  it("approves session when user selects approved_for_session", async () => {
    const sessionRules = {
      approve: vi.fn(),
      getRuleset: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as ExtensionRuntime["sessionRules"];
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue(makePermissionResult("ask")),
        } as unknown as ExtensionRuntime["permissionManager"],
        sessionRules,
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-sess-approve",
      name: "read",
      input: { path: "/outside/project/file.ts" },
    };
    await handleToolCall(deps, event, makeCtx());
    expect(sessionRules.approve).toHaveBeenCalledWith(
      "external_directory",
      expect.any(String),
    );
  });
});

// ── Pi infrastructure read bypass ───────────────────────────────────────────

describe("handleToolCall — Pi infrastructure read bypass", () => {
  const infraPath = "/test/agent/git/some-package/SKILL.md";

  it("skips external-directory gate for read tool targeting an infra dir", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi
            .fn()
            .mockReturnValue(makePermissionResult("allow")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-infra-read",
      name: "read",
      input: { path: infraPath },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toEqual({});
    // external_directory permission check must NOT have been called.
    const checkPermission = deps.runtime.permissionManager
      .checkPermission as ReturnType<typeof vi.fn>;
    const calls = checkPermission.mock.calls as Array<[string, ...unknown[]]>;
    const extDirCalls = calls.filter(
      ([surface]) => surface === "external_directory",
    );
    expect(extDirCalls).toHaveLength(0);
  });

  it("does NOT skip gate for write tool targeting an infra dir", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi
            .fn()
            .mockReturnValue(makePermissionResult("deny")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "write" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-infra-write",
      name: "write",
      input: { path: infraPath },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toMatchObject({ block: true });
    const checkPermission = deps.runtime.permissionManager
      .checkPermission as ReturnType<typeof vi.fn>;
    const calls = checkPermission.mock.calls as Array<[string, ...unknown[]]>;
    const extDirCalls = calls.filter(
      ([surface]) => surface === "external_directory",
    );
    expect(extDirCalls.length).toBeGreaterThan(0);
  });

  it("does NOT skip gate for read tool targeting a non-infra external path", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi
            .fn()
            .mockReturnValue(makePermissionResult("deny")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-non-infra",
      name: "read",
      input: { path: "/etc/passwd" },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toMatchObject({ block: true });
    const checkPermission = deps.runtime.permissionManager
      .checkPermission as ReturnType<typeof vi.fn>;
    const calls = checkPermission.mock.calls as Array<[string, ...unknown[]]>;
    const extDirCalls = calls.filter(
      ([surface]) => surface === "external_directory",
    );
    expect(extDirCalls.length).toBeGreaterThan(0);
  });

  it("writes a review log entry when bypassing the gate", async () => {
    const writeReviewLog = vi.fn();
    const deps = makeDeps({
      runtime: makeRuntime({ writeReviewLog }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-infra-log",
      name: "read",
      input: { path: infraPath },
    };
    await handleToolCall(deps, event, makeCtx());
    expect(writeReviewLog).toHaveBeenCalledWith(
      "permission_request.infrastructure_auto_allowed",
      expect.objectContaining({ toolName: "read", path: infraPath }),
    );
  });

  it("respects config piInfrastructureReadPaths for bypass", async () => {
    const customInfraPath = "/custom/infra/packages/SKILL.md";
    const deps = makeDeps({
      runtime: makeRuntime({
        piInfrastructureDirs: [],
        config: {
          debugLog: false,
          permissionReviewLog: true,
          yoloMode: false,
          piInfrastructureReadPaths: ["/custom/infra/packages"],
        },
        permissionManager: {
          checkPermission: vi
            .fn()
            .mockReturnValue(makePermissionResult("allow")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-config-infra",
      name: "read",
      input: { path: customInfraPath },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toEqual({});
    const checkPermission = deps.runtime.permissionManager
      .checkPermission as ReturnType<typeof vi.fn>;
    const calls = checkPermission.mock.calls as Array<[string, ...unknown[]]>;
    const extDirCalls = calls.filter(
      ([surface]) => surface === "external_directory",
    );
    expect(extDirCalls).toHaveLength(0);
  });
});

// ── bash external-directory gate ──────────────────────────────────────────

describe("handleToolCall — bash external-directory gate", () => {
  it("blocks a bash command referencing an external path when policy is deny", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi
            .fn()
            .mockReturnValue(makePermissionResult("deny")),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "bash" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-bash-ext",
      name: "bash",
      input: { command: "cat /outside/project/file.ts" },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });

  it("skips bash external gate when all referenced paths are session-approved", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        sessionRules: {
          approve: vi.fn(),
          // /outside/project/* covers /outside/project/file.ts
          getRuleset: vi.fn().mockReturnValue([
            {
              surface: "external_directory",
              pattern: "/outside/project/*",
              action: "allow",
            },
          ]),
          clear: vi.fn(),
        } as unknown as ExtensionRuntime["sessionRules"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "bash" }]),
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-bash-sess",
      name: "bash",
      input: { command: "cat /outside/project/file.ts" },
    };
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toEqual({});
  });
});

// ── session approval ───────────────────────────────────────────────

describe("handleToolCall — session-hit detection (normal gate)", () => {
  it("skips gate and logs session_approved when bash check returns source=session", async () => {
    const sessionRules = {
      approve: vi.fn(),
      getRuleset: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as ExtensionRuntime["sessionRules"];
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue({
            state: "allow",
            toolName: "bash",
            source: "session",
            command: "git status",
            matchedPattern: "git *",
          }),
        } as unknown as ExtensionRuntime["permissionManager"],
        sessionRules,
      }),
    });
    const event = makeToolCallEvent("bash", {
      input: { command: "git status" },
    });
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toEqual({});
    expect(deps.runtime.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.session_approved",
      expect.objectContaining({
        resolution: "session_approved",
        toolName: "bash",
      }),
    );
  });

  it("skips gate and logs session_approved when mcp check returns source=session", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue({
            state: "allow",
            toolName: "mcp",
            source: "session",
            target: "exa:search",
            matchedPattern: "exa:*",
          }),
        } as unknown as ExtensionRuntime["permissionManager"],
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "mcp" }]),
    });
    const event = makeToolCallEvent("mcp", { input: { tool: "exa:search" } });
    const result = await handleToolCall(deps, event, makeCtx());
    expect(result).toEqual({});
    expect(deps.runtime.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.session_approved",
      expect.objectContaining({
        resolution: "session_approved",
        toolName: "mcp",
      }),
    );
  });

  it("does NOT call sessionRules.approve when source is session (already recorded)", async () => {
    const sessionRules = {
      approve: vi.fn(),
      getRuleset: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as ExtensionRuntime["sessionRules"];
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue({
            state: "allow",
            toolName: "bash",
            source: "session",
            command: "git status",
            matchedPattern: "git *",
          }),
        } as unknown as ExtensionRuntime["permissionManager"],
        sessionRules,
      }),
    });
    const event = makeToolCallEvent("bash", {
      input: { command: "git status" },
    });
    await handleToolCall(deps, event, makeCtx());
    expect(sessionRules.approve).not.toHaveBeenCalled();
  });
});

describe("handleToolCall — session recording on approved_for_session", () => {
  it("records bash session approval with suggestBashPattern result", async () => {
    const sessionRules = {
      approve: vi.fn(),
      getRuleset: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as ExtensionRuntime["sessionRules"];
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue({
            state: "ask",
            toolName: "bash",
            source: "bash",
            command: "git status",
          }),
        } as unknown as ExtensionRuntime["permissionManager"],
        sessionRules,
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const event = makeToolCallEvent("bash", {
      input: { command: "git status" },
    });
    await handleToolCall(deps, event, makeCtx());
    // git arity=2: "git status" prefix covers all 2 tokens → trailing wildcard.
    expect(sessionRules.approve).toHaveBeenCalledWith("bash", "git status*");
  });

  it("records mcp session approval with suggestMcpPattern result", async () => {
    const sessionRules = {
      approve: vi.fn(),
      getRuleset: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as ExtensionRuntime["sessionRules"];
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue({
            state: "ask",
            toolName: "mcp",
            source: "mcp",
            target: "exa:search",
          }),
        } as unknown as ExtensionRuntime["permissionManager"],
        sessionRules,
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "mcp" }]),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const event = makeToolCallEvent("mcp", { input: { tool: "exa:search" } });
    await handleToolCall(deps, event, makeCtx());
    expect(sessionRules.approve).toHaveBeenCalledWith("mcp", "exa:*");
  });

  it("records tool session approval with * pattern for read surface", async () => {
    const sessionRules = {
      approve: vi.fn(),
      getRuleset: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as ExtensionRuntime["sessionRules"];
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue({
            state: "ask",
            toolName: "read",
            source: "tool",
            origin: "builtin",
          }),
        } as unknown as ExtensionRuntime["permissionManager"],
        sessionRules,
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const event = makeToolCallEvent("read", {
      input: { path: "/test/project/foo.ts" },
    });
    await handleToolCall(deps, event, makeCtx());
    expect(sessionRules.approve).toHaveBeenCalledWith("read", "*");
  });

  it("does NOT call sessionRules.approve when user approves once (not for session)", async () => {
    const sessionRules = {
      approve: vi.fn(),
      getRuleset: vi.fn().mockReturnValue([]),
      clear: vi.fn(),
    } as unknown as ExtensionRuntime["sessionRules"];
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: {
          checkPermission: vi.fn().mockReturnValue({
            state: "ask",
            toolName: "bash",
            source: "bash",
            command: "git status",
          }),
        } as unknown as ExtensionRuntime["permissionManager"],
        sessionRules,
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    });
    const event = makeToolCallEvent("bash", {
      input: { command: "git status" },
    });
    await handleToolCall(deps, event, makeCtx());
    expect(sessionRules.approve).not.toHaveBeenCalled();
  });
});
