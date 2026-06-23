import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopedPermissionManager } from "#src/permission-manager";
import { PermissionResolver } from "#src/permission-resolver";
import type { Ruleset } from "#src/rule";
import { SessionApproval } from "#src/session-approval";
import { SessionRules } from "#src/session-rules";
import type { PermissionCheckResult, PermissionState } from "#src/types";

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
    checkPathPolicy: vi
      .fn<
        (
          values: readonly string[],
          agentName?: string,
          sessionRules?: Ruleset,
        ) => PermissionCheckResult
      >()
      .mockReturnValue({
        state: "allow",
        toolName: "path",
        source: "special",
        origin: "builtin",
      }),
    getToolPermission: vi
      .fn<(toolName: string, agentName?: string) => PermissionState>()
      .mockReturnValue("allow"),
    getConfigIssues: vi.fn((): string[] => []),
  };
}

function makeResolver(
  pm?: ScopedPermissionManager,
  sessionRules?: Pick<SessionRules, "getRuleset">,
) {
  const permissionManager = pm ?? makePermissionManager();
  const rules = sessionRules ?? new SessionRules();
  return {
    resolver: new PermissionResolver(permissionManager, rules),
    permissionManager,
  };
}

beforeEach(() => {
  // no module-level vi.fn() stubs to reset
});

describe("PermissionResolver", () => {
  describe("resolve", () => {
    it("forwards surface, input, and agentName, applying the empty session ruleset", () => {
      const { resolver, permissionManager } = makeResolver();

      resolver.resolve("bash", { command: "ls" }, "agent-x");

      expect(permissionManager.checkPermission).toHaveBeenCalledWith(
        "bash",
        { command: "ls" },
        "agent-x",
        [],
      );
    });

    it("defaults agentName to undefined when omitted", () => {
      const { resolver, permissionManager } = makeResolver();

      resolver.resolve("read", { path: ".env" });

      expect(permissionManager.checkPermission).toHaveBeenCalledWith(
        "read",
        { path: ".env" },
        undefined,
        [],
      );
    });

    it("applies a recorded session approval on the next resolve", () => {
      const pm = makePermissionManager();
      const sessionRules = new SessionRules();
      const { resolver } = makeResolver(pm, sessionRules);

      // Record an approval directly into the shared SessionRules instance.
      sessionRules.recordSessionApproval(
        SessionApproval.single("bash", "git *"),
      );
      resolver.resolve("bash", { command: "git status" });

      const passedRules = vi.mocked(pm.checkPermission).mock.calls[0][3];
      expect(passedRules).toHaveLength(1);
      expect(passedRules?.[0]).toMatchObject({
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
      const { resolver } = makeResolver(pm);

      const result = resolver.resolve("bash", { command: "rm -rf /" });

      expect(result).toEqual({
        state: "deny",
        toolName: "bash",
        source: "bash",
        origin: "global",
        matchedPattern: "rm *",
      });
    });
  });

  describe("resolvePathPolicy", () => {
    it("forwards values and agentName with the current session ruleset", () => {
      const { resolver, permissionManager } = makeResolver();

      resolver.resolvePathPolicy(["/proj/src/a.ts", "src/a.ts"], "agent-x");

      expect(permissionManager.checkPathPolicy).toHaveBeenCalledWith(
        ["/proj/src/a.ts", "src/a.ts"],
        "agent-x",
        [],
        "path",
      );
    });

    it("forwards an explicit surface to checkPathPolicy", () => {
      const { resolver, permissionManager } = makeResolver();

      resolver.resolvePathPolicy(["/tmp/x"], "agent-x", "external_directory");

      expect(permissionManager.checkPathPolicy).toHaveBeenCalledWith(
        ["/tmp/x"],
        "agent-x",
        [],
        "external_directory",
      );
    });

    it("applies a recorded session approval on the next call", () => {
      const pm = makePermissionManager();
      const sessionRules = new SessionRules();
      const { resolver } = makeResolver(pm, sessionRules);

      sessionRules.recordSessionApproval(
        SessionApproval.single("path", "src/*"),
      );
      resolver.resolvePathPolicy(["src/a.ts"]);

      const passedRules = vi.mocked(pm.checkPathPolicy).mock.calls[0][2];
      expect(passedRules).toHaveLength(1);
      expect(passedRules?.[0]).toMatchObject({
        surface: "path",
        pattern: "src/*",
        action: "allow",
      });
    });

    it("returns the PermissionManager's check result", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.checkPathPolicy).mockReturnValue({
        state: "deny",
        toolName: "path",
        source: "special",
        origin: "global",
        matchedPattern: "src/*",
      });
      const { resolver } = makeResolver(pm);

      const result = resolver.resolvePathPolicy(["src/a.ts"]);

      expect(result).toEqual({
        state: "deny",
        toolName: "path",
        source: "special",
        origin: "global",
        matchedPattern: "src/*",
      });
    });
  });

  describe("checkPermission", () => {
    it("delegates to permissionManager.checkPermission with the given args", () => {
      const { resolver, permissionManager } = makeResolver();

      resolver.checkPermission("bash", { command: "ls" }, "agent-1");

      expect(permissionManager.checkPermission).toHaveBeenCalledWith(
        "bash",
        { command: "ls" },
        "agent-1",
        undefined,
      );
    });

    it("passes optional sessionRules through when supplied", () => {
      const { resolver, permissionManager } = makeResolver();
      const extraRules: Ruleset = [
        { surface: "bash", pattern: "*", action: "allow", origin: "session" },
      ];

      resolver.checkPermission(
        "bash",
        { command: "ls" },
        undefined,
        extraRules,
      );

      expect(permissionManager.checkPermission).toHaveBeenCalledWith(
        "bash",
        { command: "ls" },
        undefined,
        extraRules,
      );
    });
  });

  describe("getToolPermission", () => {
    it("delegates to permissionManager.getToolPermission", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.getToolPermission).mockReturnValue("deny");
      const { resolver } = makeResolver(pm);

      const result = resolver.getToolPermission("write", "my-agent");

      expect(pm.getToolPermission).toHaveBeenCalledWith("write", "my-agent");
      expect(result).toBe("deny");
    });
  });

  describe("getConfigIssues", () => {
    it("delegates to permissionManager.getConfigIssues", () => {
      const pm = makePermissionManager();
      vi.mocked(pm.getConfigIssues).mockReturnValue(["issue-1"]);
      const { resolver } = makeResolver(pm);

      const result = resolver.getConfigIssues("agent-1");

      expect(pm.getConfigIssues).toHaveBeenCalledWith("agent-1");
      expect(result).toEqual(["issue-1"]);
    });
  });
});
