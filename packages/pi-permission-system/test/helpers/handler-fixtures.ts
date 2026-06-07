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
import type { PermissionDecisionEvent } from "#src/permission-events";
import { PERMISSIONS_DECISION_CHANNEL } from "#src/permission-events";
import type { Rule } from "#src/rule";
import type { SessionLogger } from "#src/session-logger";
import { SessionRules } from "#src/session-rules";
import { resolveToolPreviewLimits } from "#src/tool-preview-formatter";
import type { ToolRegistry } from "#src/tool-registry";
import type { PermissionCheckResult, PermissionState } from "#src/types";

/**
 * Precise mock boundary for PermissionGateHandler integration tests.
 *
 * Intersection of every role the handler and its collaborators require.
 * Prompting is not included here — it moved to `PromptingGateway` (#339).
 * Pass a `prompter` override to `makeHandler` to steer GateRunner's prompting
 * role; `makeHandler` creates a clean default prompter when none is supplied.
 *
 * The 4-arg `checkPermission` keeps the `rules?` param for backward compat
 * with call sites that supply rules — the resolver no longer forwards ruleset
 * via the session, but the mock signature is a superset of SkillInputGateInputs.
 */
export type MockGateHandlerSession = ToolCallGateInputs &
  SkillInputGateInputs &
  GateHandlerSession & {
    /** Logger source for the reporter the fixture builds. */
    logger: SessionLogger;
    /** 4-arg form kept for backward compat with existing test overrides. */
    checkPermission(
      surface: string,
      input: unknown,
      agentName?: string,
      rules?: Rule[],
    ): PermissionCheckResult;
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
 * Prompting is not part of this mock — pass `prompter` to `makeHandler`.
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
 * Surface-dispatching `checkPermission` mock.
 *
 * Builds a `vi.fn()` that returns a `PermissionCheckResult` for each surface,
 * using `bySurface[surface]` when matched and `defaultResult` otherwise.
 * Default fields: `toolName` = the surface string, `source: "tool"`,
 * `origin: "builtin"` — callers override by including the field in the
 * per-surface or default partial (e.g. `{ path: { state: "allow", source: "special" } }`).
 *
 * Return type is intentionally unannotated so callers retain full `vi.fn()`
 * mock access (`mock.calls`, `toHaveBeenCalledWith`, etc.).
 */
export function makeSurfaceCheck(
  bySurface: Record<
    string,
    Partial<PermissionCheckResult> & { state: PermissionState }
  >,
  defaultResult: Partial<PermissionCheckResult> & { state: PermissionState } = {
    state: "allow",
  },
) {
  return vi
    .fn<MockGateHandlerSession["checkPermission"]>()
    .mockImplementation((surface): PermissionCheckResult => {
      const base = bySurface[surface] ?? defaultResult;
      return {
        toolName: surface,
        source: "tool",
        origin: "builtin",
        ...base,
      };
    });
}

/**
 * Bash-surface `checkPermission` mock that dispatches on a command regex.
 *
 * For the `bash` surface: returns a deny result when `opts.deny` matches the
 * command, and an allow result otherwise.  For all other surfaces, returns a
 * plain allow result.
 *
 * Return type is intentionally unannotated so callers retain full `vi.fn()`
 * mock access.
 */
export function makeBashCommandCheck(opts: {
  deny: RegExp;
  denyMatched: string;
  allowMatched?: string;
}) {
  return vi
    .fn<MockGateHandlerSession["checkPermission"]>()
    .mockImplementation((surface, input): PermissionCheckResult => {
      if (surface === "bash") {
        const command = (input as { command?: string }).command ?? "";
        return opts.deny.test(command)
          ? makeCheckResult({
              state: "deny",
              source: "bash",
              command,
              matchedPattern: opts.denyMatched,
            })
          : makeCheckResult({
              state: "allow",
              source: "bash",
              command,
              matchedPattern: opts.allowMatched,
            });
      }
      return makeCheckResult({ state: "allow" });
    });
}

/**
 * Constructs a PermissionGateHandler with mocked collaborators.
 *
 * Returns all collaborators so each test file can destructure only what
 * it needs — handler, events, session, toolRegistry, and prompter are all available.
 *
 * The default prompter approves all requests. Pass `prompter` explicitly to
 * steer canConfirm/prompt behavior for the test.
 */
export function makeHandler(overrides?: {
  session?: Partial<MockGateHandlerSession>;
  /** Override the GatePrompter passed to GateRunner. Defaults to an allow-all stub. */
  prompter?: GatePrompter;
  toolRegistry?: Partial<ToolRegistry>;
  /** Sugar: builds the `getAll` mock from a list of tool names. */
  tools?: string[];
}) {
  const session = makeSession(overrides?.session);
  const events = makeEvents();
  const toolRegistry =
    overrides?.tools !== undefined
      ? makeToolRegistry({
          getAll: vi
            .fn()
            .mockReturnValue(overrides.tools.map((name) => ({ name }))),
        })
      : makeToolRegistry(overrides?.toolRegistry);
  // Resolver delegates to session's checkPermission —
  // overriding session.checkPermission steers resolve automatically.
  // The recorder is a shared SessionRules so the runner records approvals
  // independently of the session mock.
  const recorder = new SessionRules();
  const resolver = {
    resolve: (surface: string, input: unknown, agentName?: string) =>
      session.checkPermission(surface, input, agentName),
  };
  const pipeline = new ToolCallGatePipeline(resolver, session);
  const skillInputPipeline = new SkillInputGatePipeline(session);
  const reporter = new GateDecisionReporter(session.logger, events);
  const prompter: GatePrompter = overrides?.prompter ?? {
    canConfirm: vi.fn().mockReturnValue(true),
    prompt: vi
      .fn<GatePrompter["prompt"]>()
      .mockResolvedValue({ approved: true, state: "approved" }),
  };
  const runner = new GateRunner(resolver, recorder, prompter, reporter);
  const handler = new PermissionGateHandler(
    session,
    toolRegistry,
    pipeline,
    skillInputPipeline,
    runner,
  );
  return { handler, events, session, toolRegistry, prompter, recorder };
}

/** Extract all permissions:decision payloads from the events.emit mock. */
export function getDecisionEvents(
  events: ReturnType<typeof makeEvents>,
): PermissionDecisionEvent[] {
  return events.emit.mock.calls
    .filter(([channel]) => channel === PERMISSIONS_DECISION_CHANNEL)
    .map(([, payload]) => payload as PermissionDecisionEvent);
}
