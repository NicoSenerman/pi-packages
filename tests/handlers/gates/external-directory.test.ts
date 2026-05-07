import { describe, expect, it, vi } from "vitest";

import { evaluateExternalDirectoryGate } from "../../../src/handlers/gates/external-directory";
import type {
  ExternalDirectoryGateDeps,
  ToolCallContext,
} from "../../../src/handlers/gates/types";
import type { PermissionCheckResult } from "../../../src/types";

// ── helpers ────────────────────────────────────────────────────────────────

function makeTcc(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    toolName: "read",
    agentName: null,
    input: { path: "/outside/project/file.ts" },
    toolCallId: "tc-1",
    cwd: "/test/project",
    ...overrides,
  };
}

function makeCheckResult(
  state: "allow" | "deny" | "ask",
  overrides: Partial<PermissionCheckResult> = {},
): PermissionCheckResult {
  return {
    state,
    toolName: "external_directory",
    source: "special",
    origin: "builtin",
    ...overrides,
  };
}

function makeExtDirGateDeps(
  overrides: Partial<ExternalDirectoryGateDeps> = {},
): ExternalDirectoryGateDeps {
  return {
    checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
    getSessionRuleset: vi.fn().mockReturnValue([]),
    approveSessionRule: vi.fn(),
    writeReviewLog: vi.fn(),
    emitDecision: vi.fn(),
    canConfirm: vi.fn().mockReturnValue(true),
    promptPermission: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" }),
    getInfrastructureDirs: vi
      .fn()
      .mockReturnValue(["/test/agent", "/test/agent/git"]),
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("evaluateExternalDirectoryGate", () => {
  it("returns null when no CWD", async () => {
    const tcc = makeTcc({ cwd: undefined });
    const result = await evaluateExternalDirectoryGate(
      tcc,
      makeExtDirGateDeps(),
    );
    expect(result).toBeNull();
  });

  it("returns null when tool is not path-bearing", async () => {
    const tcc = makeTcc({ toolName: "bash", input: { command: "ls" } });
    const result = await evaluateExternalDirectoryGate(
      tcc,
      makeExtDirGateDeps(),
    );
    expect(result).toBeNull();
  });

  it("returns null when path is inside CWD", async () => {
    const tcc = makeTcc({ input: { path: "/test/project/src/index.ts" } });
    const result = await evaluateExternalDirectoryGate(
      tcc,
      makeExtDirGateDeps(),
    );
    expect(result).toBeNull();
  });

  // ── Pi infrastructure read bypass ──────────────────────────────────────

  it("allows and emits infrastructure_auto_allowed for read targeting infra dir", async () => {
    const deps = makeExtDirGateDeps();
    const tcc = makeTcc({
      toolName: "read",
      input: { path: "/test/agent/git/some-package/SKILL.md" },
    });
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "infrastructure_auto_allowed",
        result: "allow",
      }),
    );
  });

  it("respects config.piInfrastructureReadPaths for bypass", async () => {
    const deps = makeExtDirGateDeps({
      getInfrastructureDirs: vi.fn().mockReturnValue(["/custom/infra"]),
    });
    const tcc = makeTcc({
      toolName: "read",
      input: { path: "/custom/infra/SKILL.md" },
    });
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toEqual({ action: "allow" });
  });

  it("does NOT bypass for write tools targeting infra dirs", async () => {
    const deps = makeExtDirGateDeps({
      checkPermission: vi.fn().mockReturnValue(makeCheckResult("deny")),
    });
    const tcc = makeTcc({
      toolName: "write",
      input: { path: "/test/agent/git/some-file.ts", content: "x" },
    });
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toMatchObject({ action: "block" });
  });

  // ── Session-rule hit ─────────────────────────────────────────────────────

  it("allows and emits session_approved when session rule covers the path", async () => {
    const deps = makeExtDirGateDeps({
      checkPermission: vi.fn().mockReturnValue(
        makeCheckResult("allow", {
          source: "session",
          matchedPattern: "/outside/project/*",
        }),
      ),
      getSessionRuleset: vi.fn().mockReturnValue([
        {
          surface: "external_directory",
          pattern: "/outside/project/*",
          action: "allow",
        },
      ]),
    });
    const tcc = makeTcc();
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "session_approved",
        matchedPattern: "/outside/project/*",
      }),
    );
  });

  // ── Policy deny ──────────────────────────────────────────────────────────

  it("blocks and emits policy_deny when policy is deny", async () => {
    const deps = makeExtDirGateDeps({
      checkPermission: vi.fn().mockReturnValue(makeCheckResult("deny")),
    });
    const tcc = makeTcc();
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toMatchObject({ action: "block" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "external_directory",
        result: "deny",
        resolution: "policy_deny",
      }),
    );
  });

  // ── Policy ask — user approves once ──────────────────────────────────────

  it("allows without recording session rule when user approves once", async () => {
    const deps = makeExtDirGateDeps({
      checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    });
    const tcc = makeTcc();
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.approveSessionRule).not.toHaveBeenCalled();
  });

  // ── Policy ask — user approves for session ───────────────────────────────

  it("records session rule when user approves for session", async () => {
    const deps = makeExtDirGateDeps({
      checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved_for_session" }),
    });
    const tcc = makeTcc();
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toEqual({ action: "allow" });
    expect(deps.approveSessionRule).toHaveBeenCalledWith(
      "external_directory",
      expect.any(String),
    );
  });

  // ── Policy ask — user denies ─────────────────────────────────────────────

  it("blocks and emits user_denied when user denies", async () => {
    const deps = makeExtDirGateDeps({
      checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: false, state: "denied" }),
    });
    const tcc = makeTcc();
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toMatchObject({ action: "block" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "user_denied",
      }),
    );
  });

  // ── Policy ask — no UI ───────────────────────────────────────────────────

  it("blocks and emits confirmation_unavailable when no UI", async () => {
    const deps = makeExtDirGateDeps({
      checkPermission: vi.fn().mockReturnValue(makeCheckResult("ask")),
      canConfirm: vi.fn().mockReturnValue(false),
    });
    const tcc = makeTcc();
    const result = await evaluateExternalDirectoryGate(tcc, deps);
    expect(result).toMatchObject({ action: "block" });
    expect(deps.emitDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "deny",
        resolution: "confirmation_unavailable",
      }),
    );
  });
});
