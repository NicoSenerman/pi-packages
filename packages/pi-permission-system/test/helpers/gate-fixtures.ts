/**
 * Shared gate-level test fixtures for gate descriptor and runner tests.
 */
import { vi } from "vitest";

import type {
  GateDescriptor,
  GateRunnerDeps,
} from "#src/handlers/gates/descriptor";
import type { ToolCallContext } from "#src/handlers/gates/types";
import type { PermissionCheckResult } from "#src/types";

import { makeCheckResult } from "#test/helpers/handler-fixtures";

/**
 * Gate descriptor factory with runner-test defaults.
 *
 * Uses deny as the default `denialContext` check result so tests that
 * verify block paths don't need to override the surface check.
 */
export function makeDescriptor(
  overrides: Partial<GateDescriptor> = {},
): GateDescriptor {
  return {
    surface: "read",
    input: {},
    denialContext: {
      kind: "tool",
      check: makeCheckResult({ state: "deny", matchedPattern: "*" }),
    },
    promptDetails: {
      source: "tool_call",
      agentName: null,
      message: "Allow tool 'read'?",
      toolCallId: "tc-1",
      toolName: "read",
    },
    logContext: {
      source: "tool_call",
      toolCallId: "tc-1",
      toolName: "read",
    },
    decision: {
      surface: "read",
      value: "read",
    },
    ...overrides,
  };
}

export function makeRunnerDeps(
  overrides: Partial<GateRunnerDeps> = {},
): GateRunnerDeps {
  return {
    checkPermission: vi
      .fn()
      .mockReturnValue(makeCheckResult({ matchedPattern: "*" })),
    getSessionRuleset: vi.fn().mockReturnValue([]),
    recordSessionApproval: vi.fn(),
    writeReviewLog: vi.fn(),
    emitDecision: vi.fn(),
    canConfirm: vi.fn().mockReturnValue(true),
    promptPermission: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" }),
    ...overrides,
  };
}

/**
 * Tool-call context factory with bash defaults.
 *
 * path.test.ts uses different defaults (toolName "read", path input) and
 * keeps a local wrapper; bash-path.test.ts uses this factory directly.
 */
export function makeTcc(
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    toolName: "bash",
    agentName: null,
    input: { command: "cat .env" },
    toolCallId: "tc-1",
    cwd: "/test/project",
    ...overrides,
  };
}

/**
 * Path-surface check result factory.
 *
 * Shared between bash-path.test.ts and path.test.ts; both use
 * toolName "path", source "special", origin "global" as defaults.
 */
export function makeGateCheckResult(
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
