/**
 * Shared handler-level test fixtures for PermissionGateHandler tests.
 *
 * All factories use override bags so callers can specialize any field
 * without constructing the full object from scratch.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

import { GateDecisionReporter } from "#src/decision-reporter";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { GateRunner } from "#src/handlers/gates/runner";
import { ToolCallGatePipeline } from "#src/handlers/gates/tool-call-gate-pipeline";
import { PermissionGateHandler } from "#src/handlers/permission-gate-handler";
import type { PermissionDecisionEvent } from "#src/permission-events";
import { PERMISSIONS_DECISION_CHANNEL } from "#src/permission-events";
import type { PermissionSession } from "#src/permission-session";
import { resolveToolPreviewLimits } from "#src/tool-preview-formatter";
import type { ToolRegistry } from "#src/tool-registry";
import type { PermissionCheckResult } from "#src/types";

export function makeEvents() {
  return {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
}

export function makeCtx(
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
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

export function makeToolCallEvent(
  toolName: string,
  extraFields: Record<string, unknown> = {},
) {
  return {
    type: "tool_call",
    toolCallId: "tc-1",
    name: toolName,
    input: {},
    ...extraFields,
  };
}

/**
 * Neutral-default check-result builder.
 *
 * Pass exactly the fields the original fixture hard-coded so divergent
 * defaults across test files are preserved at their call sites.
 */
export function makeCheckResult(
  overrides: Partial<PermissionCheckResult> = {},
): PermissionCheckResult {
  return {
    state: "allow",
    toolName: "read",
    source: "tool",
    origin: "builtin",
    ...overrides,
  };
}

/**
 * Full-union session stub.
 *
 * Includes every method mocked across handler test files so each file
 * only needs to override the fields that differ from the defaults.
 */
export function makeSession(
  overrides: Partial<Record<keyof PermissionSession, unknown>> = {},
): PermissionSession {
  const session = {
    logger: { debug: vi.fn(), review: vi.fn(), warn: vi.fn() },
    activate: vi.fn(),
    resolveAgentName: vi.fn().mockReturnValue(null),
    checkPermission: vi.fn().mockReturnValue(makeCheckResult()),
    getToolPermission: vi.fn().mockReturnValue("allow"),
    getSessionRuleset: vi.fn().mockReturnValue([]),
    recordSessionApproval: vi.fn(),
    getActiveSkillEntries: vi.fn().mockReturnValue([]),
    getInfrastructureReadDirs: vi
      .fn()
      .mockReturnValue(["/test/agent", "/test/agent/git"]),
    getToolPreviewLimits: vi
      .fn()
      .mockReturnValue(resolveToolPreviewLimits(DEFAULT_EXTENSION_CONFIG)),
    config: DEFAULT_EXTENSION_CONFIG,
    canPrompt: vi.fn().mockReturnValue(true),
    prompt: vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    createPermissionRequestId: vi.fn().mockReturnValue("req-id"),
    ...overrides,
  } as unknown as PermissionSession;

  // `resolve` mirrors production: checkPermission applying the current session
  // ruleset. Delegating to the (possibly overridden) `checkPermission` keeps the
  // integration tests that drive gate outcomes via `checkPermission` working
  // without each also having to override `resolve`.
  if (!Object.hasOwn(overrides, "resolve")) {
    (session as { resolve: unknown }).resolve = vi.fn(
      (surface: string, input: unknown, agentName?: string) =>
        session.checkPermission(
          surface,
          input,
          agentName,
          session.getSessionRuleset(),
        ),
    );
  }
  // GateRunner calls canConfirm() / promptPermission() on the session.
  // Delegate to the (possibly overridden) canPrompt / prompt so existing
  // tests that override those stubs continue to drive gate outcomes.
  if (!Object.hasOwn(overrides, "canConfirm")) {
    (session as { canConfirm: unknown }).canConfirm = vi.fn(() =>
      session.canPrompt(undefined as never),
    );
  }
  if (!Object.hasOwn(overrides, "promptPermission")) {
    (session as { promptPermission: unknown }).promptPermission = vi.fn(
      (details: Parameters<typeof session.prompt>[1]) =>
        session.prompt(undefined as never, details),
    );
  }
  return session;
}

export function makeToolRegistry(
  overrides: Partial<ToolRegistry> = {},
): ToolRegistry {
  return {
    getAll: vi.fn().mockReturnValue([{ name: "read" }, { name: "bash" }]),
    setActive: vi.fn(),
    ...overrides,
  };
}

/**
 * Constructs a PermissionGateHandler with mocked collaborators.
 *
 * Returns all collaborators so each test file can destructure only what
 * it needs — handler, events, session, and toolRegistry are all available.
 */
export function makeHandler(overrides?: {
  session?: Partial<Record<keyof PermissionSession, unknown>>;
  toolRegistry?: Partial<ToolRegistry>;
}) {
  const session = makeSession(overrides?.session);
  const events = makeEvents();
  const toolRegistry = makeToolRegistry(overrides?.toolRegistry);
  const pipeline = new ToolCallGatePipeline(session);
  const reporter = new GateDecisionReporter(session.logger, events);
  const runner = new GateRunner(session, session, session, reporter);
  const handler = new PermissionGateHandler(
    session,
    toolRegistry,
    pipeline,
    runner,
  );
  return { handler, events, session, toolRegistry };
}

/** Extract all permissions:decision payloads from the events.emit mock. */
export function getDecisionEvents(
  events: ReturnType<typeof makeEvents>,
): PermissionDecisionEvent[] {
  return events.emit.mock.calls
    .filter(([channel]) => channel === PERMISSIONS_DECISION_CHANNEL)
    .map(([, payload]) => payload as PermissionDecisionEvent);
}
