/**
 * Integration tests verifying that sequential tool calls to the same
 * external path only prompt once — the session-approval recorded by the
 * first call covers the second.
 *
 * These tests use stateful mocks: `recordSessionApproval` records rules,
 * and `checkPermission` consults them via `getSessionRuleset`, mirroring
 * the real interaction between PermissionSession, SessionRules, and
 * PermissionManager.
 */

import { describe, expect, it, vi } from "vitest";

import { GateDecisionReporter } from "#src/decision-reporter";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import type { GatePrompter } from "#src/gate-prompter";
import { GateRunner } from "#src/handlers/gates/runner";
import { SkillInputGatePipeline } from "#src/handlers/gates/skill-input-gate-pipeline";
import { ToolCallGatePipeline } from "#src/handlers/gates/tool-call-gate-pipeline";
import { PermissionGateHandler } from "#src/handlers/permission-gate-handler";
import { SessionRules } from "#src/session-rules";
import { resolveToolPreviewLimits } from "#src/tool-preview-formatter";
import type { ToolRegistry } from "#src/tool-registry";
import type { PermissionCheckResult } from "#src/types";
import { wildcardMatch } from "#src/wildcard-matcher";

import {
  type MockGateHandlerSession,
  makeCtx,
  makeEvents,
} from "#test/helpers/handler-fixtures";

// ── SDK stub ───────────────────────────────────────────────────────────────
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...original };
});

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Build a PermissionSession mock with stateful session-rule tracking.
 *
 * Returns `{ session, sessionRules }` — pass the same `sessionRules` to
 * `makeHandlerForSession` so the runner records approvals into the store
 * that `checkPermission` reads from.
 *
 * `checkPermission` returns "ask" for `external_directory` unless a
 * matching rule exists in `sessionRules`, in which case it returns "allow"
 * with `source: "session"`. All other surfaces return "allow" by default.
 */
function makeStatefulSession(overrides: Partial<MockGateHandlerSession> = {}): {
  session: MockGateHandlerSession;
  sessionRules: SessionRules;
} {
  const sessionRules = new SessionRules();

  const checkPermission = vi
    .fn<MockGateHandlerSession["checkPermission"]>()
    .mockImplementation(
      (surface: string, input: unknown): PermissionCheckResult => {
        if (surface === "external_directory") {
          const record = (input ?? {}) as Record<string, unknown>;
          const pathValue =
            typeof record.path === "string" ? record.path : null;

          if (pathValue) {
            const allRules = sessionRules.getRuleset();
            const match = allRules.findLast(
              (r) =>
                r.surface === "external_directory" &&
                wildcardMatch(r.pattern, pathValue),
            );
            if (match) {
              return {
                state: "allow",
                toolName: surface,
                source: "session",
                origin: "session",
                matchedPattern: match.pattern,
              };
            }
          }

          // No session match → config-level "ask"
          return {
            state: "ask",
            toolName: surface,
            source: "special",
            origin: "global",
          };
        }

        // All other surfaces: allow
        return {
          state: "allow",
          toolName: surface,
          source: "tool",
          origin: "builtin",
        };
      },
    );

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
    checkPermission: overrides.checkPermission ?? checkPermission,
    getActiveSkillEntries:
      overrides.getActiveSkillEntries ??
      vi
        .fn<MockGateHandlerSession["getActiveSkillEntries"]>()
        .mockReturnValue([]),
    getInfrastructureReadDirs:
      overrides.getInfrastructureReadDirs ??
      vi
        .fn<MockGateHandlerSession["getInfrastructureReadDirs"]>()
        .mockReturnValue([]),
    getToolPreviewLimits:
      overrides.getToolPreviewLimits ??
      vi
        .fn<MockGateHandlerSession["getToolPreviewLimits"]>()
        .mockReturnValue(resolveToolPreviewLimits(DEFAULT_EXTENSION_CONFIG)),
  };
  return { session, sessionRules };
}

function makeHandlerForSession(
  session: MockGateHandlerSession,
  sessionRules: SessionRules,
  prompter?: GatePrompter,
): { handler: PermissionGateHandler; prompter: GatePrompter } {
  const events = makeEvents();
  const reporter = new GateDecisionReporter(session.logger, events);
  const resolvedPrompter: GatePrompter = prompter ?? {
    canConfirm: vi.fn().mockReturnValue(true),
    prompt: vi
      .fn<GatePrompter["prompt"]>()
      .mockResolvedValue({ approved: true, state: "approved_for_session" }),
  };
  // Resolver delegates to session's checkPermission; the shared sessionRules
  // is the recorder so GateRunner writes approvals into the same store that
  // checkPermission reads from.
  const resolver = {
    resolve: (surface: string, input: unknown, agentName?: string) =>
      session.checkPermission(surface, input, agentName),
  };
  const runner = new GateRunner(
    resolver,
    sessionRules,
    resolvedPrompter,
    reporter,
  );
  const handler = new PermissionGateHandler(
    session,
    makeToolRegistry(),
    new ToolCallGatePipeline(resolver, session),
    new SkillInputGatePipeline(session),
    runner,
  );
  return { handler, prompter: resolvedPrompter };
}

function makeToolRegistry(): ToolRegistry {
  return {
    getAll: vi
      .fn()
      .mockReturnValue([
        { name: "read" },
        { name: "write" },
        { name: "edit" },
        { name: "bash" },
      ]),
    setActive: vi.fn(),
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("external-directory session dedup", () => {
  describe("path-bearing tools (read, write, edit)", () => {
    it("does not re-prompt for the same external path after session approval", async () => {
      const { session, sessionRules } = makeStatefulSession();
      const { handler, prompter } = makeHandlerForSession(
        session,
        sessionRules,
      );
      const ctx = makeCtx();
      const externalPath = "/outside/project/data.txt";

      // First call — should prompt
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "read",
        input: { path: externalPath },
      };
      const result1 = await handler.handleToolCall(event1, ctx);
      expect(result1).toEqual({});
      expect(prompter.prompt).toHaveBeenCalledTimes(1);

      // Second call — same path, should hit session rule, no prompt
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: externalPath },
      };
      const result2 = await handler.handleToolCall(event2, ctx);
      expect(result2).toEqual({});
      expect(prompter.prompt).toHaveBeenCalledTimes(1);
    });

    it("does not re-prompt for a different file in the same external directory", async () => {
      const { session, sessionRules } = makeStatefulSession();
      const { handler, prompter } = makeHandlerForSession(
        session,
        sessionRules,
      );
      const ctx = makeCtx();

      // First call — prompt for /outside/project/a.txt
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "read",
        input: { path: "/outside/project/a.txt" },
      };
      await handler.handleToolCall(event1, ctx);
      expect(prompter.prompt).toHaveBeenCalledTimes(1);

      // Second call — /outside/project/b.txt is in the same directory
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: "/outside/project/b.txt" },
      };
      await handler.handleToolCall(event2, ctx);
      expect(prompter.prompt).toHaveBeenCalledTimes(1);
    });

    it("does prompt for a file in a different external directory", async () => {
      const { session, sessionRules } = makeStatefulSession();
      const { handler, prompter } = makeHandlerForSession(
        session,
        sessionRules,
      );
      const ctx = makeCtx();

      // First call — /outside/alpha/file.txt
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "read",
        input: { path: "/outside/alpha/file.txt" },
      };
      await handler.handleToolCall(event1, ctx);
      expect(prompter.prompt).toHaveBeenCalledTimes(1);

      // Second call — /outside/beta/file.txt is a different directory
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: "/outside/beta/file.txt" },
      };
      await handler.handleToolCall(event2, ctx);
      expect(prompter.prompt).toHaveBeenCalledTimes(2);
    });

    it("re-prompts when user approved once (not for session)", async () => {
      const { session, sessionRules } = makeStatefulSession();
      const approveOnce: GatePrompter = {
        canConfirm: vi.fn().mockReturnValue(true),
        prompt: vi
          .fn<GatePrompter["prompt"]>()
          .mockResolvedValue({ approved: true, state: "approved" }),
      };
      const { handler, prompter } = makeHandlerForSession(
        session,
        sessionRules,
        approveOnce,
      );
      const ctx = makeCtx();
      const externalPath = "/outside/project/data.txt";

      // First call — prompt, approved once
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "read",
        input: { path: externalPath },
      };
      await handler.handleToolCall(event1, ctx);
      expect(prompter.prompt).toHaveBeenCalledTimes(1);

      // Second call — no session rule recorded, should prompt again
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: externalPath },
      };
      await handler.handleToolCall(event2, ctx);
      expect(prompter.prompt).toHaveBeenCalledTimes(2);
    });
  });

  describe("bash commands with external paths", () => {
    it("does not re-prompt for a bash command referencing the same external path after session approval", async () => {
      const { session, sessionRules } = makeStatefulSession();
      const { handler, prompter } = makeHandlerForSession(
        session,
        sessionRules,
      );
      const ctx = makeCtx();

      // First call — bash referencing /tmp/out.txt
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "echo hello > /tmp/out.txt" },
      };
      const result1 = await handler.handleToolCall(event1, ctx);
      expect(result1).toEqual({});
      expect(prompter.prompt).toHaveBeenCalledTimes(1);

      // Second call — different bash command, same external path
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "bash",
        input: { command: "cat /tmp/out.txt" },
      };
      const result2 = await handler.handleToolCall(event2, ctx);
      expect(result2).toEqual({});
      expect(prompter.prompt).toHaveBeenCalledTimes(1);
    });

    it("does not re-prompt for read after bash already approved the same directory", async () => {
      const { session, sessionRules } = makeStatefulSession();
      const { handler, prompter } = makeHandlerForSession(
        session,
        sessionRules,
      );
      const ctx = makeCtx();

      // First call — bash writes to /tmp/out.txt
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "echo hello > /tmp/out.txt" },
      };
      await handler.handleToolCall(event1, ctx);
      expect(prompter.prompt).toHaveBeenCalledTimes(1);

      // Second call — read from /tmp/out.txt (same directory, different tool)
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: "/tmp/out.txt" },
      };
      await handler.handleToolCall(event2, ctx);
      expect(prompter.prompt).toHaveBeenCalledTimes(1);
    });
  });
});
