import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (hoisted) ─────────────────────────────────────────────────

const { mockGetActiveAgentName, mockGetActiveAgentNameFromSystemPrompt } =
  vi.hoisted(() => ({
    mockGetActiveAgentName: vi.fn<(ctx: ExtensionContext) => string | null>(),
    mockGetActiveAgentNameFromSystemPrompt:
      vi.fn<(systemPrompt?: string) => string | null>(),
  }));

vi.mock("../src/active-agent", () => ({
  getActiveAgentName: mockGetActiveAgentName,
  getActiveAgentNameFromSystemPrompt: mockGetActiveAgentNameFromSystemPrompt,
}));

// ── Test helpers ───────────────────────────────────────────────────────────

import type { ExtensionPaths } from "#src/extension-paths";
import type { ForwardingController } from "#src/forwarding-manager";
import type { ScopedPermissionManager } from "#src/permission-manager";
import {
  PermissionSession,
  type PermissionSessionRuntimeDeps,
} from "#src/permission-session";
import type { Ruleset } from "#src/rule";
import { SessionApproval } from "#src/session-approval";
import type { SessionLogger } from "#src/session-logger";
import type { SkillPromptEntry } from "#src/skill-prompt-sanitizer";
import type { PermissionCheckResult, PermissionState } from "#src/types";
import { makeCtx } from "#test/helpers/handler-fixtures";

function makeSkillEntry(
  name: string,
  overrides: Partial<SkillPromptEntry> = {},
): SkillPromptEntry {
  return {
    name,
    description: `${name} skill`,
    location: `/${name}/SKILL.md`,
    state: "allow",
    normalizedLocation: `/${name}/SKILL.md`,
    normalizedBaseDir: `/${name}`,
    ...overrides,
  };
}

function makePaths(overrides: Partial<ExtensionPaths> = {}): ExtensionPaths {
  return {
    agentDir: "/test/agent",
    sessionsDir: "/test/agent/sessions",
    subagentSessionsDir: "/test/agent/subagent-sessions",
    forwardingDir: "/test/agent/sessions/permission-forwarding",
    globalLogsDir: "/test/agent/logs",
    piInfrastructureDirs: ["/test/agent", "/test/agent/git"],
    ...overrides,
  };
}

function makeLogger(): SessionLogger {
  return {
    debug: vi.fn(),
    review: vi.fn(),
    warn: vi.fn(),
  };
}

function makeRuntimeDeps(): PermissionSessionRuntimeDeps {
  return {
    refreshExtensionConfig: vi.fn(),
    logResolvedConfigPaths: vi.fn(),
    getConfig: vi.fn().mockReturnValue({}),
    canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
    promptPermission: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" }),
  };
}

function makeForwarding(): ForwardingController {
  return {
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function makePermissionManager() {
  return {
    configureForCwd: vi.fn<(cwd: string | undefined | null) => void>(),
    checkPermission: vi
      .fn<
        (
          toolName: string,
          input: unknown,
          agentName?: string,
          sessionRules?: Ruleset,
        ) => PermissionCheckResult
      >()
      .mockReturnValue({
        state: "allow",
        toolName: "read",
        source: "tool",
        origin: "builtin",
      }),
    getToolPermission: vi
      .fn<(toolName: string, agentName?: string) => PermissionState>()
      .mockReturnValue("allow"),
    getConfigIssues: vi.fn((): string[] => []),
    getPolicyCacheStamp: vi.fn((): string => "stamp-1"),
  };
}

function createSession(overrides?: {
  paths?: Partial<ExtensionPaths>;
  logger?: SessionLogger;
  forwarding?: ForwardingController;
  permissionManager?: ScopedPermissionManager;
  runtimeDeps?: PermissionSessionRuntimeDeps;
}): {
  session: PermissionSession;
  paths: ExtensionPaths;
  logger: SessionLogger;
  forwarding: ForwardingController;
  runtimeDeps: PermissionSessionRuntimeDeps;
} {
  const paths = makePaths(overrides?.paths);
  const logger = overrides?.logger ?? makeLogger();
  const forwarding = overrides?.forwarding ?? makeForwarding();
  const permissionManager =
    overrides?.permissionManager ?? makePermissionManager();
  const runtimeDeps = overrides?.runtimeDeps ?? makeRuntimeDeps();
  const session = new PermissionSession(
    paths,
    logger,
    forwarding,
    permissionManager,
    runtimeDeps,
  );
  return { session, paths, logger, forwarding, runtimeDeps };
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetActiveAgentName.mockReset();
  mockGetActiveAgentNameFromSystemPrompt.mockReset();
  mockGetActiveAgentName.mockReturnValue(null);
  mockGetActiveAgentNameFromSystemPrompt.mockReturnValue(null);
});

describe("PermissionSession", () => {
  describe("constructor and delegation", () => {
    it("delegates checkPermission to internal PermissionManager", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });

      const result = session.checkPermission("bash", { command: "ls" });

      expect(pm.checkPermission).toHaveBeenCalledWith(
        "bash",
        { command: "ls" },
        undefined,
        undefined,
      );
      expect(result.state).toBe("allow");
    });

    it("delegates getToolPermission to internal PermissionManager", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });

      const result = session.getToolPermission("read");

      expect(pm.getToolPermission).toHaveBeenCalledWith("read", undefined);
      expect(result).toBe("allow");
    });

    it("delegates getConfigIssues to internal PermissionManager", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.getConfigIssues).mockReturnValue(["issue1"]);
      const { session } = createSession({ permissionManager: pm });

      expect(session.getConfigIssues("agent1")).toEqual(["issue1"]);
      expect(pm.getConfigIssues).toHaveBeenCalledWith("agent1");
    });

    it("delegates getPolicyCacheStamp to internal PermissionManager", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });

      expect(session.getPolicyCacheStamp("agent1")).toBe("stamp-1");
      expect(pm.getPolicyCacheStamp).toHaveBeenCalledWith("agent1");
    });

    it("delegates getSessionRuleset to internal SessionRules", () => {
      const { session } = createSession();
      const rules = session.getSessionRuleset();
      expect(rules).toEqual([]);
    });

    it("delegates recordSessionApproval to internal SessionRules", () => {
      const { session } = createSession();
      session.recordSessionApproval(
        SessionApproval.single("bash", "/usr/bin/*"),
      );
      const rules = session.getSessionRuleset();
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        surface: "bash",
        pattern: "/usr/bin/*",
        action: "allow",
      });
    });
  });

  describe("resolve", () => {
    it("forwards surface, input, and agentName, applying the empty session ruleset", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });

      session.resolve("bash", { command: "ls" }, "agent-x");

      expect(pm.checkPermission).toHaveBeenCalledWith(
        "bash",
        { command: "ls" },
        "agent-x",
        [],
      );
    });

    it("defaults agentName to undefined when omitted", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });

      session.resolve("read", { path: ".env" });

      expect(pm.checkPermission).toHaveBeenCalledWith(
        "read",
        { path: ".env" },
        undefined,
        [],
      );
    });

    it("applies a recorded session approval on the next resolve", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });

      session.recordSessionApproval(SessionApproval.single("bash", "git *"));
      session.resolve("bash", { command: "git status" });

      const sessionRules = vi.mocked(pm.checkPermission).mock.calls[0][3];
      expect(sessionRules).toHaveLength(1);
      expect(sessionRules?.[0]).toMatchObject({
        surface: "bash",
        pattern: "git *",
        action: "allow",
      });
    });

    it("returns the PermissionManager's check result", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.checkPermission).mockReturnValue({
        state: "deny",
        toolName: "bash",
        source: "bash",
        origin: "global",
        matchedPattern: "rm *",
      });
      const { session } = createSession({ permissionManager: pm });

      const result = session.resolve("bash", { command: "rm -rf /" });

      expect(result).toEqual({
        state: "deny",
        toolName: "bash",
        source: "bash",
        origin: "global",
        matchedPattern: "rm *",
      });
    });
  });

  describe("activate and deactivate", () => {
    it("stores the context on activate", () => {
      const { session, forwarding } = createSession();
      const ctx = makeCtx();

      session.activate(ctx);

      expect(forwarding.start).toHaveBeenCalledWith(ctx);
    });

    it("clears context on deactivate", () => {
      const { session, forwarding } = createSession();
      session.activate(makeCtx());
      session.deactivate();

      expect(forwarding.stop).toHaveBeenCalled();
    });
  });

  describe("resetForNewSession", () => {
    it("configures the injected PermissionManager for the context cwd", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });
      const ctx = makeCtx({ cwd: "/new/project" });

      session.resetForNewSession(ctx);

      expect(pm.configureForCwd).toHaveBeenCalledWith("/new/project");
    });

    it("clears cache keys", () => {
      const { session } = createSession();
      session.commitActiveToolsCacheKey("key-1");
      session.commitPromptStateCacheKey("key-2");
      expect(session.shouldUpdateActiveTools("key-1")).toBe(false);
      expect(session.shouldUpdatePromptState("key-2")).toBe(false);

      session.resetForNewSession(makeCtx());

      // After reset, same keys should be treated as new
      expect(session.shouldUpdateActiveTools("key-1")).toBe(true);
      expect(session.shouldUpdatePromptState("key-2")).toBe(true);
    });

    it("clears skill entries", () => {
      const { session } = createSession();
      session.setActiveSkillEntries([makeSkillEntry("test")]);
      expect(session.getActiveSkillEntries()).toHaveLength(1);

      session.resetForNewSession(makeCtx());

      expect(session.getActiveSkillEntries()).toEqual([]);
    });

    it("starts forwarding with the new context", () => {
      const { session, forwarding } = createSession();
      const ctx = makeCtx();

      session.resetForNewSession(ctx);

      expect(forwarding.start).toHaveBeenCalledWith(ctx);
    });

    it("activates the new context", () => {
      const { session } = createSession();
      const ctx = makeCtx();

      session.resetForNewSession(ctx);

      // Verify context is stored by calling resolveAgentName which needs it
      mockGetActiveAgentName.mockReturnValue("test-agent");
      const name = session.resolveAgentName(ctx);
      expect(name).toBe("test-agent");
    });
  });

  describe("shutdown", () => {
    it("clears session rules", () => {
      const { session } = createSession();
      session.recordSessionApproval(SessionApproval.single("bash", "*"));
      expect(session.getSessionRuleset()).toHaveLength(1);

      session.shutdown();

      expect(session.getSessionRuleset()).toEqual([]);
    });

    it("clears cache keys", () => {
      const { session } = createSession();
      session.commitActiveToolsCacheKey("k1");
      session.commitPromptStateCacheKey("k2");

      session.shutdown();

      expect(session.shouldUpdateActiveTools("k1")).toBe(true);
      expect(session.shouldUpdatePromptState("k2")).toBe(true);
    });

    it("clears skill entries", () => {
      const { session } = createSession();
      session.setActiveSkillEntries([makeSkillEntry("s")]);

      session.shutdown();

      expect(session.getActiveSkillEntries()).toEqual([]);
    });

    it("stops forwarding and deactivates context", () => {
      const { session, forwarding } = createSession();
      session.activate(makeCtx());

      session.shutdown();

      expect(forwarding.stop).toHaveBeenCalled();
    });
  });

  describe("cache key methods", () => {
    it("shouldUpdateActiveTools returns true for new key", () => {
      const { session } = createSession();
      expect(session.shouldUpdateActiveTools("key-1")).toBe(true);
    });

    it("shouldUpdateActiveTools returns false for committed key", () => {
      const { session } = createSession();
      session.commitActiveToolsCacheKey("key-1");
      expect(session.shouldUpdateActiveTools("key-1")).toBe(false);
    });

    it("shouldUpdateActiveTools returns true for different key", () => {
      const { session } = createSession();
      session.commitActiveToolsCacheKey("key-1");
      expect(session.shouldUpdateActiveTools("key-2")).toBe(true);
    });

    it("shouldUpdatePromptState returns true for new key", () => {
      const { session } = createSession();
      expect(session.shouldUpdatePromptState("key-1")).toBe(true);
    });

    it("shouldUpdatePromptState returns false for committed key", () => {
      const { session } = createSession();
      session.commitPromptStateCacheKey("key-1");
      expect(session.shouldUpdatePromptState("key-1")).toBe(false);
    });
  });

  describe("skill entries", () => {
    it("get/set skill entries", () => {
      const { session } = createSession();
      const entries = [makeSkillEntry("a"), makeSkillEntry("b")];
      session.setActiveSkillEntries(entries);
      expect(session.getActiveSkillEntries()).toEqual(entries);
    });
  });

  describe("resolveAgentName", () => {
    it("returns name from session context", () => {
      mockGetActiveAgentName.mockReturnValue("ctx-agent");
      const { session } = createSession();
      const ctx = makeCtx();

      expect(session.resolveAgentName(ctx)).toBe("ctx-agent");
    });

    it("falls back to system prompt", () => {
      mockGetActiveAgentName.mockReturnValue(null);
      mockGetActiveAgentNameFromSystemPrompt.mockReturnValue("prompt-agent");
      const { session } = createSession();
      const ctx = makeCtx();

      expect(session.resolveAgentName(ctx, "system prompt")).toBe(
        "prompt-agent",
      );
    });

    it("falls back to last known name", () => {
      const { session } = createSession();
      const ctx = makeCtx();

      // First call sets name
      mockGetActiveAgentName.mockReturnValue("first-agent");
      session.resolveAgentName(ctx);

      // Second call with no name resolves to last known
      mockGetActiveAgentName.mockReturnValue(null);
      mockGetActiveAgentNameFromSystemPrompt.mockReturnValue(null);
      expect(session.resolveAgentName(ctx)).toBe("first-agent");
    });

    it("exposes lastKnownActiveAgentName", () => {
      const { session } = createSession();
      expect(session.lastKnownActiveAgentName).toBeNull();

      mockGetActiveAgentName.mockReturnValue("named");
      session.resolveAgentName(makeCtx());
      expect(session.lastKnownActiveAgentName).toBe("named");
    });
  });

  describe("infrastructure paths", () => {
    it("getInfrastructureReadDirs combines piInfrastructureDirs and piInfrastructureReadPaths", () => {
      const runtimeDeps = makeRuntimeDeps();
      (runtimeDeps.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        piInfrastructureReadPaths: ["/extra/path"],
      });
      const { session } = createSession({ runtimeDeps });
      expect(session.getInfrastructureReadDirs()).toEqual([
        "/test/agent",
        "/test/agent/git",
        "/extra/path",
      ]);
    });

    it("getInfrastructureReadDirs returns only piInfrastructureDirs when config omits the field", () => {
      const { session } = createSession();
      expect(session.getInfrastructureReadDirs()).toEqual([
        "/test/agent",
        "/test/agent/git",
      ]);
    });
  });

  describe("config delegation", () => {
    it("refreshConfig delegates to runtimeDeps", () => {
      const { session, runtimeDeps } = createSession();
      const ctx = makeCtx();
      session.refreshConfig(ctx);
      expect(runtimeDeps.refreshExtensionConfig).toHaveBeenCalledWith(ctx);
    });

    it("logResolvedConfigPaths delegates to runtimeDeps", () => {
      const { session, runtimeDeps } = createSession();
      session.logResolvedConfigPaths();
      expect(runtimeDeps.logResolvedConfigPaths).toHaveBeenCalled();
    });

    it("config getter delegates to runtimeDeps.getConfig", () => {
      const runtimeDeps = makeRuntimeDeps();
      const fakeConfig = { debugLog: true };
      (runtimeDeps.getConfig as ReturnType<typeof vi.fn>).mockReturnValue(
        fakeConfig,
      );
      const { session } = createSession({ runtimeDeps });
      expect(session.config).toBe(fakeConfig);
    });

    it("getToolPreviewLimits returns resolved preview limits from config", () => {
      const runtimeDeps = makeRuntimeDeps();
      (runtimeDeps.getConfig as ReturnType<typeof vi.fn>).mockReturnValue({
        toolInputPreviewMaxLength: 400,
        toolTextSummaryMaxLength: 120,
      });
      const { session } = createSession({ runtimeDeps });
      const limits = session.getToolPreviewLimits();
      expect(limits.toolInputPreviewMaxLength).toBe(400);
      expect(limits.toolTextSummaryMaxLength).toBe(120);
    });

    it("getToolPreviewLimits falls back to built-in defaults when config omits fields", () => {
      const { session } = createSession();
      const limits = session.getToolPreviewLimits();
      expect(limits.toolInputPreviewMaxLength).toBeGreaterThan(0);
      expect(limits.toolTextSummaryMaxLength).toBeGreaterThan(0);
      expect(limits.toolInputLogPreviewMaxLength).toBeGreaterThan(0);
    });
  });

  describe("reload", () => {
    it("configures PermissionManager for current context cwd", () => {
      const pm = makePermissionManager();
      const { session } = createSession({ permissionManager: pm });
      const ctx = makeCtx({ cwd: "/project" });
      session.activate(ctx);

      session.reload();

      expect(pm.configureForCwd).toHaveBeenCalledWith("/project");
    });

    it("clears caches and skill entries", () => {
      const { session } = createSession();
      session.commitActiveToolsCacheKey("k1");
      session.commitPromptStateCacheKey("k2");
      session.setActiveSkillEntries([makeSkillEntry("s")]);

      session.reload();

      expect(session.shouldUpdateActiveTools("k1")).toBe(true);
      expect(session.shouldUpdatePromptState("k2")).toBe(true);
      expect(session.getActiveSkillEntries()).toEqual([]);
    });
  });

  describe("getRuntimeContext", () => {
    it("returns null before activation", () => {
      const { session } = createSession();
      expect(session.getRuntimeContext()).toBeNull();
    });

    it("returns context after activation", () => {
      const { session } = createSession();
      const ctx = makeCtx();
      session.activate(ctx);
      expect(session.getRuntimeContext()).toBe(ctx);
    });

    it("returns null after deactivation", () => {
      const { session } = createSession();
      session.activate(makeCtx());
      session.deactivate();
      expect(session.getRuntimeContext()).toBeNull();
    });
  });

  describe("canConfirm", () => {
    it("returns true when context is active and canPrompt returns true", () => {
      const { session } = createSession();
      session.activate(makeCtx());
      expect(session.canConfirm()).toBe(true);
    });

    it("returns false when no context is active", () => {
      const { session } = createSession();
      expect(session.canConfirm()).toBe(false);
    });

    it("returns false when canPrompt returns false", () => {
      const runtimeDeps = makeRuntimeDeps();
      (
        runtimeDeps.canRequestPermissionConfirmation as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);
      const { session } = createSession({ runtimeDeps });
      session.activate(makeCtx());
      expect(session.canConfirm()).toBe(false);
    });
  });

  describe("promptPermission", () => {
    it("delegates to prompt with stored context", async () => {
      const { session, runtimeDeps } = createSession();
      const ctx = makeCtx();
      session.activate(ctx);
      const details = {
        requestId: "req-1",
        source: "tool_call" as const,
        agentName: null,
        message: "Allow?",
      };

      const result = await session.promptPermission(details);

      expect(runtimeDeps.promptPermission).toHaveBeenCalledWith(ctx, details);
      expect(result).toEqual({ approved: true, state: "approved" });
    });

    it("throws when no context is active", async () => {
      const { session } = createSession();
      const details = {
        requestId: "req-1",
        source: "tool_call" as const,
        agentName: null,
        message: "Allow?",
      };

      await expect(session.promptPermission(details)).rejects.toThrow(
        "promptPermission called before the session was activated",
      );
    });
  });

  describe("canPrompt", () => {
    it("delegates to runtimeDeps.canRequestPermissionConfirmation", () => {
      const { session, runtimeDeps } = createSession();
      const ctx = makeCtx();

      const result = session.canPrompt(ctx);

      expect(runtimeDeps.canRequestPermissionConfirmation).toHaveBeenCalledWith(
        ctx,
      );
      expect(result).toBe(true);
    });

    it("returns false when runtimeDeps says no", () => {
      const runtimeDeps = makeRuntimeDeps();
      (
        runtimeDeps.canRequestPermissionConfirmation as ReturnType<typeof vi.fn>
      ).mockReturnValue(false);
      const { session } = createSession({ runtimeDeps });

      expect(session.canPrompt(makeCtx())).toBe(false);
    });
  });

  describe("prompt", () => {
    it("delegates to runtimeDeps.promptPermission", async () => {
      const { session, runtimeDeps } = createSession();
      const ctx = makeCtx();
      const details = {
        requestId: "req-1",
        source: "tool_call" as const,
        agentName: null,
        message: "Allow?",
      };

      const result = await session.prompt(ctx, details);

      expect(runtimeDeps.promptPermission).toHaveBeenCalledWith(ctx, details);
      expect(result).toEqual({ approved: true, state: "approved" });
    });
  });
});
