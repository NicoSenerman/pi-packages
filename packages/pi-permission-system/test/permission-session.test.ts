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

import type { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { SessionApproval } from "#src/session-approval";
import { SessionRules } from "#src/session-rules";
import type { SkillPromptEntry } from "#src/skill-prompt-sanitizer";
import { makeCtx } from "#test/helpers/handler-fixtures";
import {
  makeConfigStore,
  makeFakePermissionManager,
  makeRealSession,
} from "#test/helpers/session-fixtures";

// Alias so the existing tests read naturally.
const createSession = makeRealSession;
const makePermissionManager = makeFakePermissionManager;

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

    it("forwards activate to the gateway", () => {
      const { session, gateway } = createSession();
      const ctx = makeCtx();

      session.activate(ctx);

      expect(gateway.activate).toHaveBeenCalledWith(ctx);
    });

    it("forwards deactivate to the gateway", () => {
      const { session, gateway } = createSession();
      session.activate(makeCtx());
      session.deactivate();

      expect(gateway.deactivate).toHaveBeenCalled();
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
      const { session, sessionRules } = createSession();
      sessionRules.recordSessionApproval(SessionApproval.single("bash", "*"));
      expect(sessionRules.getRuleset()).toHaveLength(1);

      session.shutdown();

      expect(sessionRules.getRuleset()).toEqual([]);
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
      const configStore = makeConfigStore({
        current: vi.fn().mockReturnValue({
          piInfrastructureReadPaths: ["/extra/path"],
        }),
      });
      const { session } = createSession({ configStore });
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
    it("refreshConfig delegates to configStore.refresh", () => {
      const { session, configStore } = createSession();
      const ctx = makeCtx();
      session.refreshConfig(ctx);
      expect(configStore.refresh).toHaveBeenCalledWith(ctx);
    });

    it("logResolvedConfigPaths delegates to configStore.logResolvedPaths", () => {
      const { session, configStore } = createSession();
      session.logResolvedConfigPaths();
      expect(configStore.logResolvedPaths).toHaveBeenCalled();
    });

    it("config getter delegates to configStore.current()", () => {
      const fakeConfig = { debugLog: true } as typeof DEFAULT_EXTENSION_CONFIG;
      const configStore = makeConfigStore({
        current: vi.fn().mockReturnValue(fakeConfig),
      });
      const { session } = createSession({ configStore });
      expect(session.config).toBe(fakeConfig);
    });

    it("getToolPreviewLimits returns resolved preview limits from config", () => {
      const configStore = makeConfigStore({
        current: vi.fn().mockReturnValue({
          toolInputPreviewMaxLength: 400,
          toolTextSummaryMaxLength: 120,
        }),
      });
      const { session } = createSession({ configStore });
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
});
