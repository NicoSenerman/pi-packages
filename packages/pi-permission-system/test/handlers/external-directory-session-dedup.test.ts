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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { GateDecisionReporter } from "#src/decision-reporter";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { GateRunner } from "#src/handlers/gates/runner";
import { SkillInputGatePipeline } from "#src/handlers/gates/skill-input-gate-pipeline";
import { ToolCallGatePipeline } from "#src/handlers/gates/tool-call-gate-pipeline";
import { PermissionGateHandler } from "#src/handlers/permission-gate-handler";
import type { PromptPermissionDetails } from "#src/permission-prompter";
import type { Rule } from "#src/rule";
import type { SessionApproval } from "#src/session-approval";
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
 * `checkPermission` returns "ask" for `external_directory` unless a
 * matching session rule exists (via `recordSessionApproval`), in which case
 * it returns "allow" with `source: "session"`. All other surfaces return
 * "allow" by default.
 */
function makeStatefulSession(
  overrides: Partial<MockGateHandlerSession> = {},
): MockGateHandlerSession {
  const sessionRules: Rule[] = [];

  const checkPermission = vi
    .fn<MockGateHandlerSession["checkPermission"]>()
    .mockImplementation(
      (
        surface: string,
        input: unknown,
        _agentName?: string,
        rules?: Rule[],
      ): PermissionCheckResult => {
        // Merge stored session rules with any passed-in rules
        const allRules = [...sessionRules, ...(rules ?? [])];

        if (surface === "external_directory") {
          const record = (input ?? {}) as Record<string, unknown>;
          const pathValue =
            typeof record.path === "string" ? record.path : null;

          if (pathValue && allRules.length > 0) {
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

  const recordSessionApproval = vi
    .fn<MockGateHandlerSession["recordSessionApproval"]>()
    .mockImplementation((approval: SessionApproval) => {
      for (const pattern of approval.patterns) {
        sessionRules.push({
          surface: approval.surface,
          pattern,
          action: "allow",
          layer: "session",
          origin: "session",
        });
      }
    });

  const getSessionRuleset = vi
    .fn<MockGateHandlerSession["getSessionRuleset"]>()
    .mockImplementation(() => [...sessionRules]);

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
    getSessionRuleset: overrides.getSessionRuleset ?? getSessionRuleset,
    recordSessionApproval:
      overrides.recordSessionApproval ?? recordSessionApproval,
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
    canPrompt:
      overrides.canPrompt ??
      vi.fn<MockGateHandlerSession["canPrompt"]>().mockReturnValue(true),
    prompt:
      overrides.prompt ??
      vi
        .fn<MockGateHandlerSession["prompt"]>()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
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
      vi.fn<MockGateHandlerSession["promptPermission"]>(
        (details: PromptPermissionDetails) =>
          session.prompt(undefined as unknown as ExtensionContext, details),
      ),
  };
  return session;
}

function makeHandlerForSession(
  session: MockGateHandlerSession,
): PermissionGateHandler {
  const events = makeEvents();
  const reporter = new GateDecisionReporter(session.logger, events);
  const runner = new GateRunner(session, session, session, reporter);
  return new PermissionGateHandler(
    session,
    makeToolRegistry(),
    new ToolCallGatePipeline(session),
    new SkillInputGatePipeline(session),
    runner,
  );
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
      const session = makeStatefulSession();
      const handler = makeHandlerForSession(session);
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
      expect(session.prompt).toHaveBeenCalledTimes(1);

      // Second call — same path, should hit session rule, no prompt
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: externalPath },
      };
      const result2 = await handler.handleToolCall(event2, ctx);
      expect(result2).toEqual({});
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });

    it("does not re-prompt for a different file in the same external directory", async () => {
      const session = makeStatefulSession();
      const handler = makeHandlerForSession(session);
      const ctx = makeCtx();

      // First call — prompt for /outside/project/a.txt
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "read",
        input: { path: "/outside/project/a.txt" },
      };
      await handler.handleToolCall(event1, ctx);
      expect(session.prompt).toHaveBeenCalledTimes(1);

      // Second call — /outside/project/b.txt is in the same directory
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: "/outside/project/b.txt" },
      };
      await handler.handleToolCall(event2, ctx);
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });

    it("does prompt for a file in a different external directory", async () => {
      const session = makeStatefulSession();
      const handler = makeHandlerForSession(session);
      const ctx = makeCtx();

      // First call — /outside/alpha/file.txt
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "read",
        input: { path: "/outside/alpha/file.txt" },
      };
      await handler.handleToolCall(event1, ctx);
      expect(session.prompt).toHaveBeenCalledTimes(1);

      // Second call — /outside/beta/file.txt is a different directory
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: "/outside/beta/file.txt" },
      };
      await handler.handleToolCall(event2, ctx);
      expect(session.prompt).toHaveBeenCalledTimes(2);
    });

    it("re-prompts when user approved once (not for session)", async () => {
      const session = makeStatefulSession({
        prompt: vi
          .fn()
          .mockResolvedValue({ approved: true, state: "approved" }),
      });
      const handler = makeHandlerForSession(session);
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
      expect(session.prompt).toHaveBeenCalledTimes(1);

      // Second call — no session rule recorded, should prompt again
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: externalPath },
      };
      await handler.handleToolCall(event2, ctx);
      expect(session.prompt).toHaveBeenCalledTimes(2);
    });
  });

  describe("bash commands with external paths", () => {
    it("does not re-prompt for a bash command referencing the same external path after session approval", async () => {
      const session = makeStatefulSession();
      const handler = makeHandlerForSession(session);
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
      expect(session.prompt).toHaveBeenCalledTimes(1);

      // Second call — different bash command, same external path
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "bash",
        input: { command: "cat /tmp/out.txt" },
      };
      const result2 = await handler.handleToolCall(event2, ctx);
      expect(result2).toEqual({});
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });

    it("does not re-prompt for read after bash already approved the same directory", async () => {
      const session = makeStatefulSession();
      const handler = makeHandlerForSession(session);
      const ctx = makeCtx();

      // First call — bash writes to /tmp/out.txt
      const event1 = {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "echo hello > /tmp/out.txt" },
      };
      await handler.handleToolCall(event1, ctx);
      expect(session.prompt).toHaveBeenCalledTimes(1);

      // Second call — read from /tmp/out.txt (same directory, different tool)
      const event2 = {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read",
        input: { path: "/tmp/out.txt" },
      };
      await handler.handleToolCall(event2, ctx);
      expect(session.prompt).toHaveBeenCalledTimes(1);
    });
  });
});
