import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { getEventInput, handleToolCall } from "../../src/handlers/tool-call";
import type { HandlerDeps } from "../../src/handlers/types";
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
  return { state, toolName: "read", matchedPattern: null, matchedRule: null };
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    getPermissionManager: vi.fn().mockReturnValue({
      checkPermission: vi.fn().mockReturnValue(makePermissionResult("allow")),
    }),
    setPermissionManager: vi.fn(),
    getRuntimeContext: vi.fn().mockReturnValue(null),
    setRuntimeContext: vi.fn(),
    getActiveSkillEntries: vi.fn().mockReturnValue([]),
    setActiveSkillEntries: vi.fn(),
    getLastKnownActiveAgentName: vi.fn().mockReturnValue(null),
    setLastKnownActiveAgentName: vi.fn(),
    getLastActiveToolsCacheKey: vi.fn().mockReturnValue(null),
    setLastActiveToolsCacheKey: vi.fn(),
    getLastPromptStateCacheKey: vi.fn().mockReturnValue(null),
    setLastPromptStateCacheKey: vi.fn(),
    sessionApprovalCache: {
      approve: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      findMatchingPrefix: vi.fn().mockReturnValue(null),
      clear: vi.fn(),
    } as unknown as HandlerDeps["sessionApprovalCache"],
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
    writeReviewLog: vi.fn(),
    writeDebugLog: vi.fn(),
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
    expect(deps.setRuntimeContext).toHaveBeenCalledWith(ctx);
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
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("allow")),
      }),
    });
    const result = await handleToolCall(
      deps,
      makeToolCallEvent("read"),
      makeCtx(),
    );
    expect(result).toEqual({});
  });

  it("blocks when tool is denied by policy", async () => {
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("deny")),
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
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("ask")),
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
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("ask")),
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
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("ask")),
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
      getActiveSkillEntries: vi.fn().mockReturnValue([skillEntry]),
      getAllTools: vi.fn().mockReturnValue([{ toolName: "read" }]),
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("allow")),
      }),
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
      getActiveSkillEntries: vi.fn().mockReturnValue([skillEntry]),
      getAllTools: vi.fn().mockReturnValue([{ toolName: "read" }]),
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("allow")),
      }),
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
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("deny")),
      }),
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
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("allow")),
      }),
      sessionApprovalCache: {
        approve: vi.fn(),
        has: vi.fn().mockReturnValue(false),
        findMatchingPrefix: vi.fn().mockReturnValue("/outside/project/"),
        clear: vi.fn(),
      } as unknown as HandlerDeps["sessionApprovalCache"],
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
    const approveCache = {
      approve: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      findMatchingPrefix: vi.fn().mockReturnValue(null),
      clear: vi.fn(),
    } as unknown as HandlerDeps["sessionApprovalCache"];
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("ask")),
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
      sessionApprovalCache: approveCache,
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-sess-approve",
      name: "read",
      input: { path: "/outside/project/file.ts" },
    };
    await handleToolCall(deps, event, makeCtx());
    expect(approveCache.approve).toHaveBeenCalledWith(
      "external_directory",
      expect.any(String),
    );
  });
});

// ── bash external-directory gate ──────────────────────────────────────────

describe("handleToolCall — bash external-directory gate", () => {
  it("blocks a bash command referencing an external path when policy is deny", async () => {
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([{ name: "bash" }]),
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("deny")),
      }),
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
      getAllTools: vi.fn().mockReturnValue([{ name: "bash" }]),
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue(makePermissionResult("allow")),
      }),
      sessionApprovalCache: {
        approve: vi.fn(),
        // All paths are covered
        has: vi.fn().mockReturnValue(true),
        findMatchingPrefix: vi.fn().mockReturnValue(null),
        clear: vi.fn(),
      } as unknown as HandlerDeps["sessionApprovalCache"],
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
