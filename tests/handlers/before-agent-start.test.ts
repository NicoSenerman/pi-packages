import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  handleBeforeAgentStart,
  shouldExposeTool,
} from "../../src/handlers/before-agent-start";
import type { HandlerDeps } from "../../src/handlers/types";
import type { PermissionManager } from "../../src/permission-manager";
import type { ExtensionRuntime } from "../../src/runtime";
import type { SkillPromptEntry } from "../../src/skill-prompt-sanitizer";

// ── SDK stubs ──────────────────────────────────────────────────────────────
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...original,
    isToolCallEventType: vi.fn().mockReturnValue(false),
  };
});

// ── helpers ────────────────────────────────────────────────────────────────

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

function makeEvent(systemPrompt = "You are an assistant.") {
  return { systemPrompt };
}

/** Minimal PermissionManager stub for shouldExposeTool / policy-cache tests. */
function makePm(
  toolPermission: "allow" | "deny" | "ask" = "allow",
): PermissionManager {
  return {
    getToolPermission: vi.fn().mockReturnValue(toolPermission),
    getPolicyCacheStamp: vi.fn().mockReturnValue("stamp-1"),
    getConfigIssues: vi.fn().mockReturnValue([]),
    checkPermission: vi.fn().mockReturnValue({ state: "allow" }),
  } as unknown as PermissionManager;
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
    config: { debugLog: false, permissionReviewLog: true, yoloMode: false },
    runtimeContext: null,
    permissionManager: makePm() as unknown as PermissionManager,
    activeSkillEntries: [] as SkillPromptEntry[],
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
    createPermissionManagerForCwd: vi.fn().mockReturnValue(makePm()),
    refreshExtensionConfig: vi.fn(),
    notifyWarning: vi.fn(),
    logResolvedConfigPaths: vi.fn(),
    resolveAgentName: vi.fn().mockReturnValue(null),
    canRequestPermissionConfirmation: vi.fn().mockReturnValue(false),
    promptPermission: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" }),
    createPermissionRequestId: vi.fn().mockReturnValue("test-id"),
    events: { emit: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) },
    startForwardedPermissionPolling: vi.fn(),
    stopForwardedPermissionPolling: vi.fn(),
    stopPermissionRpcHandlers: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    ...overrides,
  };
}

// ── shouldExposeTool (pure helper) ─────────────────────────────────────────

describe("shouldExposeTool", () => {
  it("returns true when tool permission is allow", () => {
    const pm = makePm("allow");
    expect(shouldExposeTool("read", null, pm)).toBe(true);
  });

  it("returns true when tool permission is ask", () => {
    const pm = makePm("ask");
    expect(shouldExposeTool("bash", "agent-x", pm)).toBe(true);
  });

  it("returns false when tool permission is deny", () => {
    const pm = makePm("deny");
    expect(shouldExposeTool("write", null, pm)).toBe(false);
  });

  it("passes agentName through to getToolPermission", () => {
    const pm = makePm("allow");
    shouldExposeTool("read", "my-agent", pm);
    expect(pm.getToolPermission).toHaveBeenCalledWith("read", "my-agent");
  });

  it("converts null agentName to undefined for getToolPermission", () => {
    const pm = makePm("allow");
    shouldExposeTool("read", null, pm);
    expect(pm.getToolPermission).toHaveBeenCalledWith("read", undefined);
  });
});

// ── handleBeforeAgentStart ─────────────────────────────────────────────────

describe("handleBeforeAgentStart", () => {
  it("refreshes extension config with ctx", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleBeforeAgentStart(deps, makeEvent(), ctx);
    expect(deps.refreshExtensionConfig).toHaveBeenCalledWith(ctx);
  });

  it("starts forwarded permission polling", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleBeforeAgentStart(deps, makeEvent(), ctx);
    expect(deps.startForwardedPermissionPolling).toHaveBeenCalledWith(ctx);
  });

  it("resolves agent name using systemPrompt", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleBeforeAgentStart(
      deps,
      makeEvent("<active_agent name='x'>"),
      ctx,
    );
    expect(deps.resolveAgentName).toHaveBeenCalledWith(
      ctx,
      "<active_agent name='x'>",
    );
  });

  it("filters out denied tools from allowed list", async () => {
    const pm = makePm("deny");
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: pm as unknown as PermissionManager,
      }),
      getAllTools: vi
        .fn()
        .mockReturnValue([{ name: "write" }, { name: "read" }]),
    });
    // write is deny, read is deny (same pm stub — both denied)
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.setActiveTools).toHaveBeenCalledWith([]);
  });

  it("includes allowed and ask tools in the active list", async () => {
    const pm = makePm("allow");
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: pm as unknown as PermissionManager,
      }),
      getAllTools: vi
        .fn()
        .mockReturnValue([{ name: "read" }, { name: "write" }]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.setActiveTools).toHaveBeenCalledWith(["read", "write"]);
  });

  it("updates the active-tools cache key after applying", async () => {
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.runtime.lastActiveToolsCacheKey).not.toBeNull();
  });

  it("skips setActiveTools when cache key is unchanged", async () => {
    // Pre-populate the cache key to match what would be computed for ["read"]
    const { createActiveToolsCacheKey } = await import(
      "../../src/before-agent-start-cache"
    );
    const key = createActiveToolsCacheKey(["read"]);
    const deps = makeDeps({
      runtime: makeRuntime({ lastActiveToolsCacheKey: key }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.setActiveTools).not.toHaveBeenCalled();
  });

  it("updates the prompt-state cache key and returns modified systemPrompt", async () => {
    // Provide a systemPrompt that sanitizeAvailableToolsSection will modify:
    // it strips denied tools from the "Available tools:" section.
    const systemPrompt = `You are an assistant.\n\nAvailable tools:\n- read\n- write\n`;
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([]),
    });
    const result = await handleBeforeAgentStart(
      deps,
      makeEvent(systemPrompt),
      makeCtx(),
    );
    // The prompt was modified, so systemPrompt should be returned
    expect(result).toHaveProperty("systemPrompt");
    expect(deps.runtime.lastPromptStateCacheKey).not.toBeNull();
  });

  it("returns empty object when systemPrompt is unchanged", async () => {
    const prompt = "No tools section here.";
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([]),
    });
    const result = await handleBeforeAgentStart(
      deps,
      makeEvent(prompt),
      makeCtx(),
    );
    expect(result).toEqual({});
  });

  it("stores resolved skill entries on deps", async () => {
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.runtime.activeSkillEntries).toEqual(expect.any(Array));
  });

  it("returns empty object and skips prompt work when prompt cache key is unchanged", async () => {
    const { createBeforeAgentStartPromptStateKey } = await import(
      "../../src/before-agent-start-cache"
    );
    const pm = makePm("allow");
    const ctx = makeCtx({ cwd: "/proj" });
    const allowedTools: string[] = ["read"];
    const key = createBeforeAgentStartPromptStateKey({
      agentName: null,
      cwd: "/proj",
      permissionStamp: "stamp-1",
      systemPrompt: "hello",
      allowedToolNames: allowedTools,
    });
    const deps = makeDeps({
      runtime: makeRuntime({
        permissionManager: pm as unknown as PermissionManager,
        lastPromptStateCacheKey: key,
      }),
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    const result = await handleBeforeAgentStart(deps, makeEvent("hello"), ctx);
    expect(result).toEqual({});
    // activeSkillEntries was not assigned by the handler (early return)
    expect(deps.runtime.activeSkillEntries).toEqual([]);
  });
});
