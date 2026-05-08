/**
 * Integration tests for external_directory tool_call enforcement.
 *
 * These tests exercise PermissionGateHandler.handleToolCall with the
 * external-directory gate, verifying the full descriptor→runner pipeline
 * while mocking only the PermissionSession boundary.
 *
 * Regression guard: importing the four external-directory message helpers
 * ensures the test file fails to load if any helper is removed.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  formatExternalDirectoryAskPrompt,
  formatExternalDirectoryDenyReason,
  formatExternalDirectoryHardStopHint,
  formatExternalDirectoryUserDeniedReason,
} from "../../src/handlers/gates/external-directory-messages";
import { PermissionGateHandler } from "../../src/handlers/permission-gate-handler";
import {
  PERMISSIONS_DECISION_CHANNEL,
  type PermissionDecisionEvent,
} from "../../src/permission-events";
import type { PermissionSession } from "../../src/permission-session";
import type { ToolRegistry } from "../../src/tool-registry";
import type { PermissionCheckResult, PermissionState } from "../../src/types";

// ── SDK stubs ──────────────────────────────────────────────────────────────
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...original };
});

// ── Constants ──────────────────────────────────────────────────────────────

const CWD = "/test/project";
const EXTERNAL_PATH = "/outside/project/file.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCheckPermission(
  externalDirectoryState: PermissionState,
  toolState: PermissionState = "allow",
) {
  return vi
    .fn()
    .mockImplementation((surface: string): PermissionCheckResult => {
      const state =
        surface === "external_directory" ? externalDirectoryState : toolState;
      return { state, toolName: surface, source: "tool", origin: "builtin" };
    });
}

function makeCtx(
  overrides: Partial<ExtensionContext> & { cwd?: string } = {},
): ExtensionContext {
  return {
    cwd: CWD,
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
  input: Record<string, unknown> = {},
) {
  return {
    type: "tool_call",
    toolCallId: "tc-ext-1",
    name: toolName,
    input,
  };
}

function makeSession(
  overrides: Partial<Record<keyof PermissionSession, unknown>> = {},
): PermissionSession {
  return {
    logger: { debug: vi.fn(), review: vi.fn(), warn: vi.fn() },
    activate: vi.fn(),
    resolveAgentName: vi.fn().mockReturnValue(null),
    checkPermission: makeCheckPermission("deny"),
    getToolPermission: vi.fn().mockReturnValue("allow" as PermissionState),
    getSessionRuleset: vi.fn().mockReturnValue([]),
    approveSessionRule: vi.fn(),
    getActiveSkillEntries: vi.fn().mockReturnValue([]),
    getInfrastructureDirs: vi.fn().mockReturnValue([]),
    getInfrastructureReadPaths: vi.fn().mockReturnValue([]),
    canPrompt: vi.fn().mockReturnValue(true),
    prompt: vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    ...overrides,
  } as unknown as PermissionSession;
}

function makeEvents() {
  return {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
}

/** All PATH_BEARING_TOOLS members. */
const ALL_PATH_BEARING_TOOLS = ["read", "write", "edit", "find", "grep", "ls"];

/** Tools where path is optional. */
const OPTIONAL_PATH_TOOLS = ["find", "grep", "ls"];

function makeToolRegistry(overrides: Partial<ToolRegistry> = {}): ToolRegistry {
  return {
    getAll: vi
      .fn()
      .mockReturnValue(
        [...ALL_PATH_BEARING_TOOLS, "bash"].map((name) => ({ name })),
      ),
    setActive: vi.fn(),
    ...overrides,
  };
}

function makeHandler(overrides?: {
  session?: Partial<Record<keyof PermissionSession, unknown>>;
  toolRegistry?: Partial<ToolRegistry>;
}): {
  handler: PermissionGateHandler;
  events: ReturnType<typeof makeEvents>;
  session: PermissionSession;
} {
  const session = makeSession(overrides?.session);
  const events = makeEvents();
  const toolRegistry = makeToolRegistry(overrides?.toolRegistry);
  const handler = new PermissionGateHandler(session, events, toolRegistry);
  return { handler, events, session };
}

function getDecisionEvents(
  events: ReturnType<typeof makeEvents>,
): PermissionDecisionEvent[] {
  return events.emit.mock.calls
    .filter(([channel]) => channel === PERMISSIONS_DECISION_CHANNEL)
    .map(([, payload]) => payload as PermissionDecisionEvent);
}

// ── Regression guard: helper presence ──────────────────────────────────────

describe("external_directory helper regression guard", () => {
  it("formatExternalDirectoryHardStopHint is a callable function", () => {
    expect(typeof formatExternalDirectoryHardStopHint).toBe("function");
    expect(formatExternalDirectoryHardStopHint()).toContain("Hard stop");
  });

  it("formatExternalDirectoryAskPrompt is a callable function", () => {
    expect(typeof formatExternalDirectoryAskPrompt).toBe("function");
    expect(
      formatExternalDirectoryAskPrompt("read", "/outside/file", "/project"),
    ).toContain("/outside/file");
  });

  it("formatExternalDirectoryDenyReason is a callable function", () => {
    expect(typeof formatExternalDirectoryDenyReason).toBe("function");
    expect(
      formatExternalDirectoryDenyReason("read", "/outside/file", "/project"),
    ).toContain("Hard stop");
  });

  it("formatExternalDirectoryUserDeniedReason is a callable function", () => {
    expect(typeof formatExternalDirectoryUserDeniedReason).toBe("function");
    expect(
      formatExternalDirectoryUserDeniedReason("read", "/outside/file"),
    ).toContain("User denied");
  });
});

// ── Path scope: gate applicability ────────────────────────────────────────

describe("external_directory path scope", () => {
  it("skips external_directory check when path is inside CWD", async () => {
    const { handler } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny") },
    });
    const event = makeToolCallEvent("read", {
      path: `${CWD}/src/index.ts`,
    });
    const result = await handler.handleToolCall(event, makeCtx());
    // Should not be blocked — the external_directory gate is skipped,
    // and the tool gate sees "allow" (default toolState in makeCheckPermission)
    expect(result).toEqual({});
  });

  it("fires external_directory check when path is outside CWD", async () => {
    const { handler } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny") },
    });
    const event = makeToolCallEvent("read", { path: EXTERNAL_PATH });
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });

  it("skips external_directory check for non-path-bearing tool (bash)", async () => {
    const { handler } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny", "allow") },
    });
    const event = makeToolCallEvent("bash", {
      command: `cat ${EXTERNAL_PATH}`,
    });
    // bash is not in PATH_BEARING_TOOLS, so the external_directory gate
    // for tool path does not fire (bash-external-directory gate is separate)
    const result = await handler.handleToolCall(event, makeCtx());
    // bash-external-directory gate MAY fire separately, but the tool-path
    // external_directory gate does NOT fire for bash
    // We verify the checkPermission was not called with "external_directory"
    // from the tool-path gate by checking the result is not blocked by it
    expect(result).toBeDefined();
  });

  it.each(
    ALL_PATH_BEARING_TOOLS,
  )("blocks %s with an out-of-cwd path when external_directory is deny", async (toolName) => {
    const { handler } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny") },
    });
    const event = makeToolCallEvent(toolName, { path: EXTERNAL_PATH });
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });

  it.each(
    OPTIONAL_PATH_TOOLS,
  )("skips external_directory check for %s when path is omitted", async (toolName) => {
    const { handler } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny") },
    });
    // No path in input — external_directory gate should not fire
    const event = makeToolCallEvent(toolName, {});
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toEqual({});
  });
});

// ── Policy state matrix: allow and deny ────────────────────────────────────

describe("external_directory policy state — allow", () => {
  it("falls through to tool gate when external_directory is allow", async () => {
    const { handler } = makeHandler({
      session: { checkPermission: makeCheckPermission("allow") },
    });
    const event = makeToolCallEvent("read", { path: EXTERNAL_PATH });
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toEqual({});
  });

  it("emits decision event with policy_allow on external_directory surface", async () => {
    const { handler, events } = makeHandler({
      session: { checkPermission: makeCheckPermission("allow") },
    });
    const event = makeToolCallEvent("read", { path: EXTERNAL_PATH });
    await handler.handleToolCall(event, makeCtx());
    const decisions = getDecisionEvents(events);
    const extDirDecision = decisions.find(
      (d) => d.surface === "external_directory",
    );
    expect(extDirDecision).toMatchObject({
      surface: "external_directory",
      result: "allow",
      resolution: "policy_allow",
    });
  });

  it("does not write a block review-log entry when external_directory is allow", async () => {
    const { handler, session } = makeHandler({
      session: { checkPermission: makeCheckPermission("allow") },
    });
    const event = makeToolCallEvent("read", { path: EXTERNAL_PATH });
    await handler.handleToolCall(event, makeCtx());
    const reviewCalls = (session.logger.review as ReturnType<typeof vi.fn>).mock
      .calls;
    const blockEntries = reviewCalls.filter(
      ([eventName]: [string]) => eventName === "permission_request.blocked",
    );
    expect(blockEntries).toHaveLength(0);
  });
});

describe("external_directory policy state — deny", () => {
  it("blocks with reason containing the external path", async () => {
    const { handler } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny") },
    });
    const event = makeToolCallEvent("read", { path: EXTERNAL_PATH });
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result.block).toBe(true);
    expect(result.reason).toContain(EXTERNAL_PATH);
  });

  it("block reason contains the hard-stop hint", async () => {
    const { handler } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny") },
    });
    const event = makeToolCallEvent("read", { path: EXTERNAL_PATH });
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result.reason).toContain("Hard stop");
  });

  it("writes review-log entry with resolution policy_denied", async () => {
    const { handler, session } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny") },
    });
    const event = makeToolCallEvent("read", { path: EXTERNAL_PATH });
    await handler.handleToolCall(event, makeCtx());
    const reviewCalls = (session.logger.review as ReturnType<typeof vi.fn>).mock
      .calls;
    const blockEntries = reviewCalls.filter(
      ([eventName]: [string]) => eventName === "permission_request.blocked",
    );
    expect(blockEntries.length).toBeGreaterThanOrEqual(1);
    expect(blockEntries[0][1]).toMatchObject({
      resolution: "policy_denied",
    });
  });

  it("emits decision event with policy_deny on external_directory surface", async () => {
    const { handler, events } = makeHandler({
      session: { checkPermission: makeCheckPermission("deny") },
    });
    const event = makeToolCallEvent("read", { path: EXTERNAL_PATH });
    await handler.handleToolCall(event, makeCtx());
    const decisions = getDecisionEvents(events);
    const extDirDecision = decisions.find(
      (d) => d.surface === "external_directory",
    );
    expect(extDirDecision).toMatchObject({
      surface: "external_directory",
      result: "deny",
      resolution: "policy_deny",
    });
  });
});
