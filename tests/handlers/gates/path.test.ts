import { describe, expect, it, vi } from "vitest";

import type { GateDescriptor } from "../../../src/handlers/gates/descriptor";
import { isGateDescriptor } from "../../../src/handlers/gates/descriptor";
import { describePathGate } from "../../../src/handlers/gates/path";
import type { ToolCallContext } from "../../../src/handlers/gates/types";
import type { PermissionCheckResult } from "../../../src/types";

// ── helpers ────────────────────────────────────────────────────────────────

function makeTcc(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    toolName: "read",
    agentName: null,
    input: { path: ".env" },
    toolCallId: "tc-1",
    cwd: "/test/project",
    ...overrides,
  };
}

function makeCheckResult(
  overrides: Partial<PermissionCheckResult> = {},
): PermissionCheckResult {
  return {
    toolName: "path",
    state: "allow",
    source: "special",
    origin: "global",
    ...overrides,
  };
}

type CheckPermissionFn = (
  surface: string,
  input: unknown,
  agentName?: string,
  sessionRules?: unknown[],
) => PermissionCheckResult;

// ── tests ──────────────────────────────────────────────────────────────────

describe("describePathGate", () => {
  it("returns null for non-path-bearing tools", () => {
    const checkPermission = vi.fn<CheckPermissionFn>();
    const result = describePathGate(
      makeTcc({ toolName: "bash", input: { command: "ls" } }),
      checkPermission,
    );
    expect(result).toBeNull();
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it("returns null when tool has no extractable path", () => {
    const checkPermission = vi.fn<CheckPermissionFn>();
    const result = describePathGate(
      makeTcc({ toolName: "read", input: {} }),
      checkPermission,
    );
    expect(result).toBeNull();
  });

  it("returns null when path check result is allow", () => {
    const checkPermission = vi
      .fn<CheckPermissionFn>()
      .mockReturnValue(makeCheckResult({ state: "allow" }));
    const result = describePathGate(makeTcc(), checkPermission);
    expect(result).toBeNull();
  });

  it("returns GateDescriptor when path check result is deny", () => {
    const checkPermission = vi.fn<CheckPermissionFn>().mockReturnValue(
      makeCheckResult({
        state: "deny",
        matchedPattern: "*.env",
      }),
    );
    const result = describePathGate(makeTcc(), checkPermission);
    expect(result).not.toBeNull();
    expect(isGateDescriptor(result)).toBe(true);
    const desc = result as GateDescriptor;
    expect(desc.surface).toBe("path");
    expect(desc.preCheck?.state).toBe("deny");
  });

  it("returns GateDescriptor when path check result is ask", () => {
    const checkPermission = vi.fn<CheckPermissionFn>().mockReturnValue(
      makeCheckResult({
        state: "ask",
        matchedPattern: "*.env",
      }),
    );
    const result = describePathGate(makeTcc(), checkPermission);
    expect(result).not.toBeNull();
    expect(isGateDescriptor(result)).toBe(true);
    const desc = result as GateDescriptor;
    expect(desc.surface).toBe("path");
    expect(desc.preCheck?.state).toBe("ask");
  });

  it("descriptor has correct session approval surface and pattern", () => {
    const checkPermission = vi
      .fn<CheckPermissionFn>()
      .mockReturnValue(makeCheckResult({ state: "ask" }));
    const result = describePathGate(
      makeTcc({ input: { path: "/test/project/src/.env" } }),
      checkPermission,
    ) as GateDescriptor;
    expect(result.sessionApproval).toBeDefined();
    expect(result.sessionApproval).toHaveProperty("surface", "path");
    expect(result.sessionApproval).toHaveProperty("pattern");
  });

  it("descriptor messages reference the file path", () => {
    const checkPermission = vi
      .fn<CheckPermissionFn>()
      .mockReturnValue(makeCheckResult({ state: "deny" }));
    const result = describePathGate(
      makeTcc(),
      checkPermission,
    ) as GateDescriptor;
    expect(result.messages.denyReason).toContain(".env");
    expect(result.messages.unavailableReason).toContain(".env");
  });

  it("descriptor decision uses surface 'path' and the file path as value", () => {
    const checkPermission = vi
      .fn<CheckPermissionFn>()
      .mockReturnValue(makeCheckResult({ state: "deny" }));
    const result = describePathGate(
      makeTcc(),
      checkPermission,
    ) as GateDescriptor;
    expect(result.decision.surface).toBe("path");
    expect(result.decision.value).toBe(".env");
  });

  it("passes agentName to checkPermission", () => {
    const checkPermission = vi
      .fn<CheckPermissionFn>()
      .mockReturnValue(makeCheckResult({ state: "allow" }));
    describePathGate(makeTcc({ agentName: "my-agent" }), checkPermission);
    expect(checkPermission).toHaveBeenCalledWith(
      "path",
      { path: ".env" },
      "my-agent",
    );
  });
});
