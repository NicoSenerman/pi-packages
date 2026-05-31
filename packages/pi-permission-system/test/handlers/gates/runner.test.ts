import { describe, expect, it, vi } from "vitest";

import type { DenialContext } from "#src/denial-messages";
import { EXTENSION_TAG } from "#src/denial-messages";
import type { GateDescriptor } from "#src/handlers/gates/descriptor";
import { runGateCheck } from "#src/handlers/gates/runner";
import { SessionApproval } from "#src/session-approval";
import { makeDescriptor, makeRunnerDeps } from "#test/helpers/gate-fixtures";
import { makeCheckResult } from "#test/helpers/handler-fixtures";

// ── tests ──────────────────────────────────────────────────────────────────

describe("runGateCheck", () => {
  it("returns allow and emits policy_allow when policy is allow", async () => {
    const deps = makeRunnerDeps();
    const result = await runGateCheck(makeDescriptor(), null, "tc-1", deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "read",
        value: "read",
        result: "allow",
        resolution: "policy_allow",
      }),
    );
  });

  it("returns block and emits policy_deny when policy is deny", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "deny", matchedPattern: "*" }),
        ),
    });
    const result = await runGateCheck(makeDescriptor(), null, "tc-1", deps);
    expect(result).toMatchObject({ action: "block" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "policy_deny",
      }),
    );
    expect(deps.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.blocked",
      expect.objectContaining({ resolution: "policy_denied" }),
    );
  });

  it("returns allow and emits session_approved on session hit", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ source: "session", matchedPattern: "git *" }),
        ),
    });
    const result = await runGateCheck(
      makeDescriptor({
        surface: "bash",
        input: { command: "git status" },
        decision: { surface: "bash", value: "git status" },
      }),
      null,
      "tc-1",
      deps,
    );
    expect(result).toEqual({ action: "allow" });
    expect(deps.writeReviewLog).toHaveBeenCalledWith(
      "permission_request.session_approved",
      expect.objectContaining({
        resolution: "session_approved",
        sessionApprovalPattern: "git *",
      }),
    );
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "session_approved",
        matchedPattern: "git *",
      }),
    );
  });

  it("returns allow and emits user_approved when ask + user approves", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    });
    const result = await runGateCheck(makeDescriptor(), null, "tc-1", deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "allow",
        resolution: "user_approved",
      }),
    );
  });

  it("returns allow, emits user_approved_for_session, and records session rule on approved_for_session", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const descriptor = makeDescriptor({
      sessionApproval: SessionApproval.single("read", "*"),
    });
    const result = await runGateCheck(descriptor, null, "tc-1", deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "user_approved_for_session",
      }),
    );
    expect(deps.recordSessionApproval).toHaveBeenCalledWith(
      SessionApproval.single("read", "*"),
    );
  });

  it("calls recordSessionApproval once with the full SessionApproval when sessionApproval has multiple patterns", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const approval = SessionApproval.multiple("external_directory", [
      "/outside/a/*",
      "/outside/b/*",
    ]);
    const descriptor = makeDescriptor({ sessionApproval: approval });
    const result = await runGateCheck(descriptor, null, "tc-1", deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.recordSessionApproval).toHaveBeenCalledTimes(1);
    expect(deps.recordSessionApproval).toHaveBeenCalledWith(approval);
  });

  it("returns block and emits user_denied when ask + user denies", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: false, state: "denied" }),
    });
    const result = await runGateCheck(makeDescriptor(), null, "tc-1", deps);
    expect(result).toMatchObject({ action: "block" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "user_denied",
      }),
    );
  });

  it("returns block and emits confirmation_unavailable when ask + no UI", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
      canConfirm: vi.fn().mockReturnValue(false),
    });
    const result = await runGateCheck(makeDescriptor(), null, "tc-1", deps);
    expect(result).toMatchObject({ action: "block" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "confirmation_unavailable",
      }),
    );
  });

  it("emits auto_approved resolution when decision has autoApproved flag", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
      promptPermission: vi.fn().mockResolvedValue({
        approved: true,
        state: "approved",
        autoApproved: true,
      }),
    });
    const result = await runGateCheck(makeDescriptor(), null, "tc-1", deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "auto_approved",
      }),
    );
  });

  it("uses preResolved.state instead of calling checkPermission", async () => {
    const deps = makeRunnerDeps();
    const descriptor = makeDescriptor({
      preResolved: { state: "deny" },
    });
    const result = await runGateCheck(descriptor, null, "tc-1", deps);
    expect(result).toMatchObject({ action: "block" });
    expect(deps.checkPermission).not.toHaveBeenCalled();
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "policy_deny",
      }),
    );
  });

  it("uses preResolved.state allow without calling checkPermission", async () => {
    const deps = makeRunnerDeps();
    const descriptor = makeDescriptor({
      preResolved: { state: "allow" },
    });
    const result = await runGateCheck(descriptor, null, "tc-1", deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.checkPermission).not.toHaveBeenCalled();
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "policy_allow",
      }),
    );
  });

  it("passes agentName to checkPermission and decision event", async () => {
    const deps = makeRunnerDeps();
    const result = await runGateCheck(
      makeDescriptor(),
      "test-agent",
      "tc-1",
      deps,
    );
    expect(result).toEqual({ action: "allow" });
    expect(deps.checkPermission).toHaveBeenCalledWith(
      "read",
      {},
      "test-agent",
      [],
    );
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "test-agent",
      }),
    );
  });

  it("passes requestId from toolCallId to promptPermission", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
    });
    await runGateCheck(makeDescriptor(), null, "tc-42", deps);
    expect(deps.promptPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "tc-42" }),
    );
  });

  it("does not call recordSessionApproval when user approves once (no sessionApproval)", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    });
    await runGateCheck(makeDescriptor(), null, "tc-1", deps);
    expect(deps.recordSessionApproval).not.toHaveBeenCalled();
  });

  it("uses preCheck result directly instead of calling checkPermission", async () => {
    const deps = makeRunnerDeps();
    const descriptor = makeDescriptor({
      preCheck: makeCheckResult({
        state: "deny",
        origin: "global",
        matchedPattern: "rm *",
      }),
    });
    const result = await runGateCheck(descriptor, null, "tc-1", deps);
    expect(result).toMatchObject({ action: "block" });
    expect(deps.checkPermission).not.toHaveBeenCalled();
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "policy_deny",
        origin: "global",
        matchedPattern: "rm *",
      }),
    );
  });

  it("does not call recordSessionApproval when user approves for session but no sessionApproval on descriptor", async () => {
    const deps = makeRunnerDeps({
      checkPermission: vi
        .fn()
        .mockReturnValue(
          makeCheckResult({ state: "ask", matchedPattern: "*" }),
        ),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    // No sessionApproval on descriptor
    await runGateCheck(makeDescriptor(), null, "tc-1", deps);
    expect(deps.recordSessionApproval).not.toHaveBeenCalled();
  });

  describe("denialContext formatting", () => {
    function makeDenialContextDescriptor(
      denialContext: DenialContext,
      overrides: Partial<GateDescriptor> = {},
    ): GateDescriptor {
      return {
        surface: "write",
        input: {},
        denialContext,
        promptDetails: {
          source: "tool_call",
          agentName: null,
          message: "Allow tool 'write'?",
          toolCallId: "tc-1",
          toolName: "write",
        },
        logContext: {
          source: "tool_call",
          toolCallId: "tc-1",
          toolName: "write",
        },
        decision: {
          surface: "write",
          value: "write",
        },
        ...overrides,
      };
    }

    it("uses denialContext to format denyReason with extension tag", async () => {
      const deps = makeRunnerDeps({
        checkPermission: vi
          .fn()
          .mockReturnValue(
            makeCheckResult({ state: "deny", matchedPattern: "*" }),
          ),
      });
      const ctx: DenialContext = {
        kind: "tool",
        check: makeCheckResult({ state: "deny", matchedPattern: "*" }),
        agentName: "test-agent",
      };
      const result = await runGateCheck(
        makeDenialContextDescriptor(ctx),
        "test-agent",
        "tc-1",
        deps,
      );
      expect(result.action).toBe("block");
      if (result.action === "block") {
        expect(result.reason).toContain(EXTENSION_TAG);
        expect(result.reason).not.toContain("Hard stop");
      }
    });

    it("uses denialContext to format unavailableReason with extension tag", async () => {
      const deps = makeRunnerDeps({
        checkPermission: vi
          .fn()
          .mockReturnValue(
            makeCheckResult({ state: "ask", matchedPattern: "*" }),
          ),
        canConfirm: vi.fn().mockReturnValue(false),
      });
      const ctx: DenialContext = {
        kind: "tool",
        check: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      };
      const result = await runGateCheck(
        makeDenialContextDescriptor(ctx),
        null,
        "tc-1",
        deps,
      );
      expect(result.action).toBe("block");
      if (result.action === "block") {
        expect(result.reason).toContain(EXTENSION_TAG);
        expect(result.reason).toContain("no interactive UI");
      }
    });

    it("uses denialContext to format userDeniedReason with extension tag", async () => {
      const deps = makeRunnerDeps({
        checkPermission: vi
          .fn()
          .mockReturnValue(
            makeCheckResult({ state: "ask", matchedPattern: "*" }),
          ),
        promptPermission: vi.fn().mockResolvedValue({
          approved: false,
          state: "denied",
          denialReason: "too risky",
        }),
      });
      const ctx: DenialContext = {
        kind: "tool",
        check: makeCheckResult({ state: "ask", matchedPattern: "*" }),
      };
      const result = await runGateCheck(
        makeDenialContextDescriptor(ctx),
        null,
        "tc-1",
        deps,
      );
      expect(result.action).toBe("block");
      if (result.action === "block") {
        expect(result.reason).toContain(EXTENSION_TAG);
        expect(result.reason).toContain("too risky");
      }
    });
  });
});
