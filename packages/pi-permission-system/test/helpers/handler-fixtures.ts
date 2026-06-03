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
import type { GateHandlerSession } from "#src/gate-handler-session";
import type { GatePrompter } from "#src/gate-prompter";
import { GateRunner } from "#src/handlers/gates/runner";
import {
  type SkillInputGateInputs,
  SkillInputGatePipeline,
} from "#src/handlers/gates/skill-input-gate-pipeline";
import {
  type ToolCallGateInputs,
  ToolCallGatePipeline,
} from "#src/handlers/gates/tool-call-gate-pipeline";
import { PermissionGateHandler } from "#src/handlers/permission-gate-handler";
import type { PermissionPromptDecision } from "#src/permission-dialog";
import type { PermissionDecisionEvent } from "#src/permission-events";
import { PERMISSIONS_DECISION_CHANNEL } from "#src/permission-events";
import type { PromptPermissionDetails } from "#src/permission-prompter";
import type { Rule } from "#src/rule";
import type { SessionApprovalRecorder } from "#src/session-approval-recorder";
import type { SessionLogger } from "#src/session-logger";
import { resolveToolPreviewLimits } from "#src/tool-preview-formatter";
import type { ToolRegistry } from "#src/tool-registry";
import type { PermissionCheckResult } from "#src/types";

/**
 * Precise mock boundary for PermissionGateHandler integration tests.
 *
 * Intersection of every role the handler and its collaborators require,
 * plus the context-bound prompting helpers that GatePrompter delegates to.
 * Without a cast, TypeScript enforces this at the call sites where the
 * mock is passed to GateRunner / ToolCallGatePipeline / PermissionGateHandler.
 *
 * The 4-arg `checkPermission` overrides the 3-arg version from
 * GateHandlerSession so the `resolve` delegation can forward session rules.
 */
export type MockGateHandlerSession = ToolCallGateInputs &
  SkillInputGateInputs &
  SessionApprovalRecorder &
  GatePrompter &
  GateHandlerSession & {
    /** Logger source for the reporter the fixture builds. */
    logger: SessionLogger;
    /** Session-rule accessor — used by the resolve delegation. */
    getSessionRuleset(): Rule[];
    /** 4-arg form so the resolve delegation can pass rules. */
    checkPermission(
      surface: string,
      input: unknown,
      agentName?: string,
      rules?: Rule[],
    ): PermissionCheckResult;
    /** Context-bound canPrompt — overriding this steers canConfirm. */
    canPrompt(ctx: ExtensionContext): boolean;
    /** Context-bound prompt — overriding this steers promptPermission. */
    prompt(
      ctx: ExtensionContext,
      details: PromptPermissionDetails,
    ): Promise<PermissionPromptDecision>;
  };

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
 * Full-intersection session stub.
 *
 * Uses per-field `??` selection (no spread) so TypeScript verifies every
 * field against `MockGateHandlerSession` individually — a missing field fails
 * `pnpm run check` instead of failing silently at runtime.
 *
 * The `resolve`, `canConfirm`, and `promptPermission` delegations are inlined
 * as closures that read `session` at call time, so overriding `checkPermission`,
 * `canPrompt`, or `prompt` automatically steers them without extra guards.
 */
export function makeSession(
  overrides: Partial<MockGateHandlerSession> = {},
): MockGateHandlerSession {
  const session: MockGateHandlerSession = {
    logger: overrides.logger ?? {
      debug: vi.fn(),
      review: vi.fn(),
      warn: vi.fn(),
    },
    activate: overrides.activate ?? vi.fn<MockGateHandlerSession["activate"]>(),
    resolveAgentName:
      overrides.resolveAgentName ??
      vi.fn<MockGateHandlerSession["resolveAgentName"]>().mockReturnValue(null),
    checkPermission:
      overrides.checkPermission ??
      vi
        .fn<MockGateHandlerSession["checkPermission"]>()
        .mockReturnValue(makeCheckResult()),
    getSessionRuleset:
      overrides.getSessionRuleset ??
      vi.fn<MockGateHandlerSession["getSessionRuleset"]>().mockReturnValue([]),
    recordSessionApproval:
      overrides.recordSessionApproval ??
      vi.fn<MockGateHandlerSession["recordSessionApproval"]>(),
    getActiveSkillEntries:
      overrides.getActiveSkillEntries ??
      vi
        .fn<MockGateHandlerSession["getActiveSkillEntries"]>()
        .mockReturnValue([]),
    getInfrastructureReadDirs:
      overrides.getInfrastructureReadDirs ??
      vi
        .fn<MockGateHandlerSession["getInfrastructureReadDirs"]>()
        .mockReturnValue(["/test/agent", "/test/agent/git"]),
    getToolPreviewLimits:
      overrides.getToolPreviewLimits ??
      vi
        .fn<MockGateHandlerSession["getToolPreviewLimits"]>()
        .mockReturnValue(resolveToolPreviewLimits(DEFAULT_EXTENSION_CONFIG)),
    canPrompt:
      overrides.canPrompt ??
      vi.fn<MockGateHandlerSession["canPrompt"]>().mockReturnValue(true),
    prompt:
      overrides.prompt ??
      vi
        .fn<MockGateHandlerSession["prompt"]>()
        .mockResolvedValue({ approved: true, state: "approved" }),
    // Delegations — closures read `session` at call time so overrides win.
    resolve:
      overrides.resolve ??
      vi.fn<MockGateHandlerSession["resolve"]>((surface, input, agentName) =>
        session.checkPermission(
          surface,
          input,
          agentName,
          session.getSessionRuleset(),
        ),
      ),
    canConfirm:
      overrides.canConfirm ??
      vi.fn<MockGateHandlerSession["canConfirm"]>(() =>
        session.canPrompt(undefined as unknown as ExtensionContext),
      ),
    promptPermission:
      overrides.promptPermission ??
      vi.fn<MockGateHandlerSession["promptPermission"]>((details) =>
        session.prompt(undefined as unknown as ExtensionContext, details),
      ),
  };
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
  session?: Partial<MockGateHandlerSession>;
  toolRegistry?: Partial<ToolRegistry>;
}) {
  const session = makeSession(overrides?.session);
  const events = makeEvents();
  const toolRegistry = makeToolRegistry(overrides?.toolRegistry);
  const pipeline = new ToolCallGatePipeline(session);
  const skillInputPipeline = new SkillInputGatePipeline(session);
  const reporter = new GateDecisionReporter(session.logger, events);
  const runner = new GateRunner(session, session, session, reporter);
  const handler = new PermissionGateHandler(
    session,
    toolRegistry,
    pipeline,
    skillInputPipeline,
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
