/**
 * Shared gate-level test fixtures for gate descriptor and runner tests.
 */
import { vi } from "vitest";

import type { DecisionReporter } from "#src/decision-reporter";
import type { GatePrompter } from "#src/gate-prompter";
import type { GateDescriptor } from "#src/handlers/gates/descriptor";
import { GateRunner } from "#src/handlers/gates/runner";
import type { ToolCallContext } from "#src/handlers/gates/types";
import type { PermissionResolver } from "#src/permission-resolver";
import type { SessionApprovalRecorder } from "#src/session-approval-recorder";
import type { PermissionCheckResult } from "#src/types";

import { makeCheckResult } from "#test/helpers/handler-fixtures";

/**
 * Permission resolver mock with an optional default check result.
 *
 * Returns a plain object whose `resolve` is a `vi.fn` so callers retain full
 * mock access (`mockReturnValue`, `mockImplementation`, `mock.calls`).
 */
export function makeResolver(defaultCheck?: PermissionCheckResult) {
  const resolve = vi.fn<PermissionResolver["resolve"]>();
  if (defaultCheck) {
    resolve.mockReturnValue(defaultCheck);
  }
  return { resolve };
}

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

/**
 * Reporter mock with independently inspectable vi.fn() stubs.
 */
export function makeReporter(
  overrides: Partial<DecisionReporter> = {},
): DecisionReporter {
  return {
    writeReviewLog: vi.fn(),
    emitDecision: vi.fn(),
    ...overrides,
  };
}

/**
 * Gate runner factory for `GateRunner` unit tests.
 *
 * Builds one `GateRunner` from four role mocks and returns `{ runner, deps }`
 * so tests can both invoke `runner.run(...)` and assert on the individual
 * mock call records (`deps.reporter.*`, `deps.resolve`, etc.).
 */
export function makeGateRunner(
  overrides: {
    resolve?: PermissionResolver["resolve"];
    recordSessionApproval?: SessionApprovalRecorder["recordSessionApproval"];
    canConfirm?: GatePrompter["canConfirm"];
    promptPermission?: GatePrompter["promptPermission"];
    reporter?: Partial<DecisionReporter>;
  } = {},
) {
  const reporter = makeReporter(overrides.reporter);
  const resolve =
    overrides.resolve ??
    vi
      .fn<PermissionResolver["resolve"]>()
      .mockReturnValue(makeCheckResult({ matchedPattern: "*" }));
  const recordSessionApproval =
    overrides.recordSessionApproval ??
    (vi.fn() as SessionApprovalRecorder["recordSessionApproval"]);
  const canConfirm =
    overrides.canConfirm ??
    (vi.fn().mockReturnValue(true) as GatePrompter["canConfirm"]);
  const promptPermission =
    overrides.promptPermission ??
    vi
      .fn<GatePrompter["promptPermission"]>()
      .mockResolvedValue({ approved: true, state: "approved" });
  const runner = new GateRunner(
    { resolve },
    { recordSessionApproval },
    { canConfirm, promptPermission },
    reporter,
  );
  return {
    runner,
    deps: {
      resolve,
      recordSessionApproval,
      canConfirm,
      promptPermission,
      reporter,
    },
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
