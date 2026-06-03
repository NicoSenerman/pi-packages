import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionManager } from "#src/permission-manager";
import { LocalPermissionsService } from "#src/permissions-service";
import type { Ruleset } from "#src/rule";
import type { SessionRules } from "#src/session-rules";
import type {
  ToolInputFormatter,
  ToolInputFormatterRegistry,
} from "#src/tool-input-formatter-registry";

import { makeCheckResult } from "#test/helpers/handler-fixtures";

// ── input-normalizer stub ──────────────────────────────────────────────────

const mockBuildInputForSurface = vi.hoisted(() =>
  vi.fn<(surface: string, value?: string) => unknown>(),
);

vi.mock("#src/input-normalizer", () => ({
  buildInputForSurface: mockBuildInputForSurface,
}));

// ── helpers ────────────────────────────────────────────────────────────────

function makePermissionManager(): PermissionManager {
  return {
    checkPermission: vi
      .fn<PermissionManager["checkPermission"]>()
      .mockReturnValue(makeCheckResult()),
    getToolPermission: vi
      .fn<PermissionManager["getToolPermission"]>()
      .mockReturnValue("allow"),
  } as unknown as PermissionManager;
}

function makeSessionRules(rules: Ruleset = []): SessionRules {
  return {
    getRuleset: vi.fn<SessionRules["getRuleset"]>().mockReturnValue(rules),
  } as unknown as SessionRules;
}

function makeFormatterRegistry(): ToolInputFormatterRegistry {
  return {
    register: vi
      .fn<ToolInputFormatterRegistry["register"]>()
      .mockReturnValue(vi.fn()),
  } as unknown as ToolInputFormatterRegistry;
}

function makeService(overrides?: {
  permissionManager?: PermissionManager;
  sessionRules?: SessionRules;
  formatterRegistry?: ToolInputFormatterRegistry;
}) {
  const permissionManager =
    overrides?.permissionManager ?? makePermissionManager();
  const sessionRules = overrides?.sessionRules ?? makeSessionRules();
  const formatterRegistry =
    overrides?.formatterRegistry ?? makeFormatterRegistry();
  const service = new LocalPermissionsService(
    permissionManager,
    sessionRules,
    formatterRegistry,
  );
  return { service, permissionManager, sessionRules, formatterRegistry };
}

// ── tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockBuildInputForSurface.mockReset();
  mockBuildInputForSurface.mockReturnValue({ type: "tool-input" });
});

describe("checkPermission", () => {
  it("builds the surface input from surface and value", () => {
    const { service } = makeService();
    service.checkPermission("bash", "echo hi");
    expect(mockBuildInputForSurface).toHaveBeenCalledWith("bash", "echo hi");
  });

  it("builds the surface input with undefined value when value is omitted", () => {
    const { service } = makeService();
    service.checkPermission("read");
    expect(mockBuildInputForSurface).toHaveBeenCalledWith("read", undefined);
  });

  it("calls permissionManager.checkPermission with surface, built input, agentName, and current ruleset", () => {
    const ruleset: Ruleset = [
      { surface: "bash", pattern: "*", action: "allow", origin: "global" },
    ];
    const builtInput = { type: "bash-input" };
    mockBuildInputForSurface.mockReturnValue(builtInput);
    const { service, permissionManager, sessionRules } = makeService({
      sessionRules: makeSessionRules(ruleset),
    });
    service.checkPermission("bash", "echo hi", "my-agent");
    expect(permissionManager.checkPermission).toHaveBeenCalledWith(
      "bash",
      builtInput,
      "my-agent",
      ruleset,
    );
    void sessionRules; // used indirectly
  });

  it("returns the result from permissionManager.checkPermission", () => {
    const expected = makeCheckResult({ state: "deny", toolName: "bash" });
    const { service, permissionManager } = makeService();
    vi.mocked(permissionManager.checkPermission).mockReturnValue(expected);
    const result = service.checkPermission("bash", "rm -rf /");
    expect(result).toBe(expected);
  });
});

describe("getToolPermission", () => {
  it("delegates to permissionManager.getToolPermission", () => {
    const { service, permissionManager } = makeService();
    vi.mocked(permissionManager.getToolPermission).mockReturnValue("deny");
    const result = service.getToolPermission("write", "my-agent");
    expect(permissionManager.getToolPermission).toHaveBeenCalledWith(
      "write",
      "my-agent",
    );
    expect(result).toBe("deny");
  });

  it("omits agentName when not provided", () => {
    const { service, permissionManager } = makeService();
    service.getToolPermission("read");
    expect(permissionManager.getToolPermission).toHaveBeenCalledWith(
      "read",
      undefined,
    );
  });
});

describe("registerToolInputFormatter", () => {
  it("delegates to formatterRegistry.register and returns the unsubscribe function", () => {
    const unsub = vi.fn();
    const { service, formatterRegistry } = makeService();
    vi.mocked(formatterRegistry.register).mockReturnValue(unsub);
    const formatter: ToolInputFormatter = vi.fn();
    const result = service.registerToolInputFormatter("my-tool", formatter);
    expect(formatterRegistry.register).toHaveBeenCalledWith(
      "my-tool",
      formatter,
    );
    expect(result).toBe(unsub);
  });
});
