import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleResourcesDiscover,
  handleSessionShutdown,
  handleSessionStart,
} from "../../src/handlers/lifecycle";
import type { HandlerDeps } from "../../src/handlers/types";
import type { PermissionManager } from "../../src/permission-manager";
import type { ExtensionRuntime } from "../../src/runtime";
import type { SessionRules } from "../../src/session-rules";
import type { SkillPromptEntry } from "../../src/skill-prompt-sanitizer";

// ── active-agent stub ──────────────────────────────────────────────────────
const { mockGetActiveAgentName } = vi.hoisted(() => ({
  mockGetActiveAgentName: vi.fn<(ctx: ExtensionContext) => string | null>(),
}));

vi.mock("../../src/active-agent", () => ({
  getActiveAgentName: mockGetActiveAgentName,
  getActiveAgentNameFromSystemPrompt: vi.fn().mockReturnValue(null),
}));

// ── PERMISSION_SYSTEM_STATUS_KEY stub ──────────────────────────────────────
// status.ts is re-exported through the handler; the key value doesn't matter
// for these tests.
vi.mock("../../src/status", () => ({
  PERMISSION_SYSTEM_STATUS_KEY: "permission-system",
  syncPermissionSystemStatus: vi.fn(),
  getPermissionSystemStatus: vi.fn(),
}));

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

function makePermissionManager(
  issues: string[] = [],
): Pick<PermissionManager, "getConfigIssues"> {
  return {
    getConfigIssues: vi.fn().mockReturnValue(issues),
  };
}

function makeSessionRules(): SessionRules {
  return {
    approve: vi.fn(),
    getRuleset: vi.fn().mockReturnValue([]),
    clear: vi.fn(),
  } as unknown as SessionRules;
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
    permissionManager: makePermissionManager() as unknown as PermissionManager,
    activeSkillEntries: [] as SkillPromptEntry[],
    lastKnownActiveAgentName: null,
    lastActiveToolsCacheKey: null,
    lastPromptStateCacheKey: null,
    lastConfigWarning: null,
    sessionRules: makeSessionRules(),
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
    createPermissionManagerForCwd: vi
      .fn()
      .mockReturnValue(makePermissionManager()),
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

// ── handleSessionStart ─────────────────────────────────────────────────────

describe("handleSessionStart", () => {
  beforeEach(() => {
    mockGetActiveAgentName.mockReset();
    mockGetActiveAgentName.mockReturnValue(null);
  });

  it("sets the runtime context", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, ctx);
    expect(deps.runtime.runtimeContext).toBe(ctx);
  });

  it("refreshes extension config with ctx", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, ctx);
    expect(deps.refreshExtensionConfig).toHaveBeenCalledWith(ctx);
  });

  it("creates a new permission manager for ctx.cwd and stores it", async () => {
    const ctx = makeCtx({ cwd: "/my/project" });
    const newPm = makePermissionManager();
    const deps = makeDeps({
      createPermissionManagerForCwd: vi.fn().mockReturnValue(newPm),
    });
    await handleSessionStart(deps, { reason: "startup" }, ctx);
    expect(deps.createPermissionManagerForCwd).toHaveBeenCalledWith(
      "/my/project",
    );
    expect(deps.runtime.permissionManager).toBe(newPm);
  });

  it("clears the before_agent_start cache", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, ctx);
    expect(deps.runtime.activeSkillEntries).toEqual([]);
    expect(deps.runtime.lastActiveToolsCacheKey).toBeNull();
    expect(deps.runtime.lastPromptStateCacheKey).toBeNull();
  });

  it("sets lastKnownActiveAgentName from getActiveAgentName", async () => {
    mockGetActiveAgentName.mockReturnValue("my-agent");
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, ctx);
    expect(deps.runtime.lastKnownActiveAgentName).toBe("my-agent");
  });

  it("sets lastKnownActiveAgentName to null when no agent is active", async () => {
    mockGetActiveAgentName.mockReturnValue(null);
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, ctx);
    expect(deps.runtime.lastKnownActiveAgentName).toBeNull();
  });

  it("starts forwarded permission polling", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, ctx);
    expect(deps.startForwardedPermissionPolling).toHaveBeenCalledWith(ctx);
  });

  it("logs resolved config paths", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, ctx);
    expect(deps.logResolvedConfigPaths).toHaveBeenCalledOnce();
  });

  it("notifies each policy issue", async () => {
    const pm = makePermissionManager(["issue A", "issue B"]);
    const deps = makeDeps({
      createPermissionManagerForCwd: vi.fn().mockReturnValue(pm),
    });
    await handleSessionStart(deps, { reason: "startup" }, makeCtx());
    expect(deps.notifyWarning).toHaveBeenCalledWith("issue A");
    expect(deps.notifyWarning).toHaveBeenCalledWith("issue B");
  });

  it("does not call notifyWarning when there are no policy issues", async () => {
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, makeCtx());
    expect(deps.notifyWarning).not.toHaveBeenCalled();
  });

  it("writes lifecycle.reload debug log when reason is reload", async () => {
    const ctx = makeCtx({ cwd: "/proj" });
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "reload" }, ctx);
    expect(deps.runtime.writeDebugLog).toHaveBeenCalledWith(
      "lifecycle.reload",
      {
        triggeredBy: "session_start",
        reason: "reload",
        cwd: "/proj",
      },
    );
  });

  it("does not write lifecycle.reload debug log for non-reload reasons", async () => {
    const deps = makeDeps();
    await handleSessionStart(deps, { reason: "startup" }, makeCtx());
    expect(deps.runtime.writeDebugLog).not.toHaveBeenCalled();
  });
});

// ── handleResourcesDiscover ────────────────────────────────────────────────

describe("handleResourcesDiscover", () => {
  it("does nothing when reason is not reload", async () => {
    const deps = makeDeps();
    await handleResourcesDiscover(deps, { reason: "startup" });
    expect(deps.createPermissionManagerForCwd).not.toHaveBeenCalled();
    expect(deps.runtime.writeDebugLog).not.toHaveBeenCalled();
  });

  it("creates and stores a new PM using runtimeContext.cwd on reload", async () => {
    const ctx = makeCtx({ cwd: "/runtime/cwd" });
    const newPm = makePermissionManager();
    const deps = makeDeps({
      runtime: makeRuntime({ runtimeContext: ctx }),
      createPermissionManagerForCwd: vi.fn().mockReturnValue(newPm),
    });
    await handleResourcesDiscover(deps, { reason: "reload" });
    expect(deps.createPermissionManagerForCwd).toHaveBeenCalledWith(
      "/runtime/cwd",
    );
    expect(deps.runtime.permissionManager).toBe(newPm);
  });

  it("uses undefined cwd when runtimeContext is null on reload", async () => {
    const deps = makeDeps();
    await handleResourcesDiscover(deps, { reason: "reload" });
    expect(deps.createPermissionManagerForCwd).toHaveBeenCalledWith(undefined);
  });

  it("clears the before_agent_start cache on reload", async () => {
    const deps = makeDeps();
    await handleResourcesDiscover(deps, { reason: "reload" });
    expect(deps.runtime.activeSkillEntries).toEqual([]);
    expect(deps.runtime.lastActiveToolsCacheKey).toBeNull();
    expect(deps.runtime.lastPromptStateCacheKey).toBeNull();
  });

  it("writes lifecycle.reload debug log on reload", async () => {
    const ctx = makeCtx({ cwd: "/proj" });
    const deps = makeDeps({ runtime: makeRuntime({ runtimeContext: ctx }) });
    await handleResourcesDiscover(deps, { reason: "reload" });
    expect(deps.runtime.writeDebugLog).toHaveBeenCalledWith(
      "lifecycle.reload",
      {
        triggeredBy: "resources_discover",
        reason: "reload",
        cwd: "/proj",
      },
    );
  });

  it("logs cwd as null when runtimeContext is null on reload", async () => {
    const deps = makeDeps();
    await handleResourcesDiscover(deps, { reason: "reload" });
    expect(deps.runtime.writeDebugLog).toHaveBeenCalledWith(
      "lifecycle.reload",
      {
        triggeredBy: "resources_discover",
        reason: "reload",
        cwd: null,
      },
    );
  });
});

// ── handleSessionShutdown ──────────────────────────────────────────────────

describe("handleSessionShutdown", () => {
  it("clears the UI status when a runtime context is present", async () => {
    const ctx = makeCtx();
    const deps = makeDeps({
      runtime: makeRuntime({ runtimeContext: ctx }),
    });
    await handleSessionShutdown(deps);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "permission-system",
      undefined,
    );
  });

  it("does not throw when runtime context is null", async () => {
    const deps = makeDeps();
    await expect(handleSessionShutdown(deps)).resolves.not.toThrow();
  });

  it("sets runtime context to null", async () => {
    const ctx = makeCtx();
    const deps = makeDeps({ runtime: makeRuntime({ runtimeContext: ctx }) });
    await handleSessionShutdown(deps);
    expect(deps.runtime.runtimeContext).toBeNull();
  });

  it("clears the before_agent_start cache", async () => {
    const deps = makeDeps();
    await handleSessionShutdown(deps);
    expect(deps.runtime.activeSkillEntries).toEqual([]);
    expect(deps.runtime.lastActiveToolsCacheKey).toBeNull();
    expect(deps.runtime.lastPromptStateCacheKey).toBeNull();
  });

  it("clears the session rules", async () => {
    const deps = makeDeps();
    await handleSessionShutdown(deps);
    expect(deps.runtime.sessionRules.clear).toHaveBeenCalledOnce();
  });

  it("stops forwarded permission polling", async () => {
    const deps = makeDeps();
    await handleSessionShutdown(deps);
    expect(deps.stopForwardedPermissionPolling).toHaveBeenCalledOnce();
  });

  it("calls stopPermissionRpcHandlers on shutdown", async () => {
    const deps = makeDeps();
    await handleSessionShutdown(deps);
    expect(deps.stopPermissionRpcHandlers).toHaveBeenCalledOnce();
  });

  it("does not reset lastKnownActiveAgentName", async () => {
    const deps = makeDeps({
      runtime: makeRuntime({ lastKnownActiveAgentName: "remembered" }),
    });
    await handleSessionShutdown(deps);
    expect(deps.runtime.lastKnownActiveAgentName).toBe("remembered");
  });
});
