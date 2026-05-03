import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  extractSkillNameFromInput,
  handleInput,
} from "../../src/handlers/input";
import type { HandlerDeps } from "../../src/handlers/types";
import type { SkillPromptEntry } from "../../src/skill-prompt-sanitizer";

// ── helpers ────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
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

function makeInputEvent(text: string) {
  return { type: "input" as const, text, source: "user" as const };
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    getPermissionManager: vi.fn().mockReturnValue({
      checkPermission: vi.fn().mockReturnValue({ state: "allow" }),
      getConfigIssues: vi.fn().mockReturnValue([]),
    }),
    setPermissionManager: vi.fn(),
    getRuntimeContext: vi.fn().mockReturnValue(null),
    setRuntimeContext: vi.fn(),
    getActiveSkillEntries: vi.fn().mockReturnValue([] as SkillPromptEntry[]),
    setActiveSkillEntries: vi.fn(),
    getLastKnownActiveAgentName: vi.fn().mockReturnValue(null),
    setLastKnownActiveAgentName: vi.fn(),
    getLastActiveToolsCacheKey: vi.fn().mockReturnValue(null),
    setLastActiveToolsCacheKey: vi.fn(),
    getLastPromptStateCacheKey: vi.fn().mockReturnValue(null),
    setLastPromptStateCacheKey: vi.fn(),
    sessionApprovalCache: {
      approve: vi.fn(),
      has: vi.fn(),
      findMatchingPrefix: vi.fn(),
      clear: vi.fn(),
    } as unknown as HandlerDeps["sessionApprovalCache"],
    createPermissionManagerForCwd: vi.fn(),
    refreshExtensionConfig: vi.fn(),
    notifyWarning: vi.fn(),
    logResolvedConfigPaths: vi.fn(),
    resolveAgentName: vi.fn().mockReturnValue(null),
    canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
    promptPermission: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" }),
    createPermissionRequestId: vi.fn().mockReturnValue("req-id"),
    startForwardedPermissionPolling: vi.fn(),
    stopForwardedPermissionPolling: vi.fn(),
    writeReviewLog: vi.fn(),
    writeDebugLog: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    ...overrides,
  };
}

// ── extractSkillNameFromInput ──────────────────────────────────────────────

describe("extractSkillNameFromInput", () => {
  it("returns null for plain text", () => {
    expect(extractSkillNameFromInput("hello world")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractSkillNameFromInput("")).toBeNull();
  });

  it("returns null for bare /skill: with no name", () => {
    expect(extractSkillNameFromInput("/skill:")).toBeNull();
  });

  it("extracts skill name from /skill:<name>", () => {
    expect(extractSkillNameFromInput("/skill:librarian")).toBe("librarian");
  });

  it("extracts skill name stopping at whitespace", () => {
    expect(extractSkillNameFromInput("/skill:librarian some extra")).toBe(
      "librarian",
    );
  });

  it("trims leading whitespace before the prefix", () => {
    expect(extractSkillNameFromInput("  /skill:my-skill")).toBe("my-skill");
  });

  it("returns null when the skill name after trimming is empty", () => {
    expect(extractSkillNameFromInput("/skill: ")).toBeNull();
  });
});

// ── handleInput ───────────────────────────────────────────────────────────

describe("handleInput", () => {
  it("sets runtime context", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleInput(deps, makeInputEvent("hello"), ctx);
    expect(deps.setRuntimeContext).toHaveBeenCalledWith(ctx);
  });

  it("starts forwarded permission polling", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleInput(deps, makeInputEvent("hello"), ctx);
    expect(deps.startForwardedPermissionPolling).toHaveBeenCalledWith(ctx);
  });

  it("returns continue for non-skill input", async () => {
    const deps = makeDeps();
    const result = await handleInput(
      deps,
      makeInputEvent("just a message"),
      makeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
  });

  it("does not check permissions for non-skill input", async () => {
    const deps = makeDeps();
    await handleInput(deps, makeInputEvent("just a message"), makeCtx());
    expect(deps.getPermissionManager().checkPermission).not.toHaveBeenCalled();
  });

  it("returns continue when skill is allowed", async () => {
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue({ state: "allow" }),
      }),
    });
    const result = await handleInput(
      deps,
      makeInputEvent("/skill:librarian"),
      makeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
  });

  it("returns handled when skill is denied", async () => {
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue({ state: "deny" }),
      }),
    });
    const result = await handleInput(
      deps,
      makeInputEvent("/skill:librarian"),
      makeCtx(),
    );
    expect(result).toEqual({ action: "handled" });
  });

  it("shows a warning notification when skill is denied and UI is available", async () => {
    const ctx = makeCtx({ hasUI: true });
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue({ state: "deny" }),
      }),
    });
    await handleInput(deps, makeInputEvent("/skill:librarian"), ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("librarian"),
      "warning",
    );
  });

  it("does not show a warning notification when skill is denied and UI is absent", async () => {
    const ctx = makeCtx({ hasUI: false });
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue({ state: "deny" }),
      }),
    });
    await handleInput(deps, makeInputEvent("/skill:librarian"), ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("returns handled when skill requires approval but no UI is available", async () => {
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue({ state: "ask" }),
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(false),
    });
    const result = await handleInput(
      deps,
      makeInputEvent("/skill:librarian"),
      makeCtx(),
    );
    expect(result).toEqual({ action: "handled" });
  });

  it("prompts and returns continue when skill ask is approved", async () => {
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue({ state: "ask" }),
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    });
    const result = await handleInput(
      deps,
      makeInputEvent("/skill:librarian"),
      makeCtx(),
    );
    expect(result).toEqual({ action: "continue" });
    expect(deps.promptPermission).toHaveBeenCalledOnce();
  });

  it("returns handled when skill ask is denied by user", async () => {
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue({ state: "ask" }),
      }),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: false, state: "denied" }),
    });
    const result = await handleInput(
      deps,
      makeInputEvent("/skill:librarian"),
      makeCtx(),
    );
    expect(result).toEqual({ action: "handled" });
  });

  it("passes agentName in the prompt permission request", async () => {
    const deps = makeDeps({
      getPermissionManager: vi.fn().mockReturnValue({
        checkPermission: vi.fn().mockReturnValue({ state: "ask" }),
      }),
      resolveAgentName: vi.fn().mockReturnValue("code-agent"),
      canRequestPermissionConfirmation: vi.fn().mockReturnValue(true),
      promptPermission: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    });
    await handleInput(deps, makeInputEvent("/skill:librarian"), makeCtx());
    expect(deps.promptPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentName: "code-agent",
        skillName: "librarian",
      }),
    );
  });
});
