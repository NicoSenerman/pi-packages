import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  handleBeforeAgentStart,
  shouldExposeTool,
} from "../../src/handlers/before-agent-start";
import type { HandlerDeps } from "../../src/handlers/types";
import type { PermissionSession } from "../../src/permission-session";
import type { PermissionState } from "../../src/types";

// ── SDK stubs ──────────────────────────────────────────────────────────────
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...original,
    isToolCallEventType: vi.fn().mockReturnValue(false),
  };
});

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

function makeEvent(systemPrompt = "You are an assistant.") {
  return { systemPrompt };
}

function makeSession(
  overrides: Partial<Record<keyof PermissionSession, unknown>> = {},
): PermissionSession {
  return {
    logger: { debug: vi.fn(), review: vi.fn(), warn: vi.fn() },
    activate: vi.fn(),
    refreshConfig: vi.fn(),
    resolveAgentName: vi.fn().mockReturnValue(null),
    getToolPermission: vi.fn().mockReturnValue("allow" as PermissionState),
    checkPermission: vi.fn().mockReturnValue({ state: "allow" }),
    shouldUpdateActiveTools: vi.fn().mockReturnValue(true),
    commitActiveToolsCacheKey: vi.fn(),
    getPolicyCacheStamp: vi.fn().mockReturnValue("stamp-1"),
    shouldUpdatePromptState: vi.fn().mockReturnValue(true),
    commitPromptStateCacheKey: vi.fn(),
    setActiveSkillEntries: vi.fn(),
    getActiveSkillEntries: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as PermissionSession;
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    session: makeSession(),
    events: { emit: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) },
    canRequestPermissionConfirmation: vi.fn().mockReturnValue(false),
    promptPermission: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" }),
    createPermissionRequestId: vi.fn().mockReturnValue("test-id"),
    stopPermissionRpcHandlers: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    ...overrides,
  };
}

// ── shouldExposeTool (pure helper) ─────────────────────────────────────────

describe("shouldExposeTool", () => {
  it("returns true when tool permission is allow", () => {
    const getter = vi.fn().mockReturnValue("allow");
    expect(shouldExposeTool("read", null, getter)).toBe(true);
  });

  it("returns true when tool permission is ask", () => {
    const getter = vi.fn().mockReturnValue("ask");
    expect(shouldExposeTool("bash", "agent-x", getter)).toBe(true);
  });

  it("returns false when tool permission is deny", () => {
    const getter = vi.fn().mockReturnValue("deny");
    expect(shouldExposeTool("write", null, getter)).toBe(false);
  });

  it("passes agentName through to getToolPermission", () => {
    const getter = vi.fn().mockReturnValue("allow");
    shouldExposeTool("read", "my-agent", getter);
    expect(getter).toHaveBeenCalledWith("read", "my-agent");
  });

  it("converts null agentName to undefined for getToolPermission", () => {
    const getter = vi.fn().mockReturnValue("allow");
    shouldExposeTool("read", null, getter);
    expect(getter).toHaveBeenCalledWith("read", undefined);
  });
});

// ── handleBeforeAgentStart ─────────────────────────────────────────────────

describe("handleBeforeAgentStart", () => {
  it("activates the session with ctx", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleBeforeAgentStart(deps, makeEvent(), ctx);
    expect(deps.session.activate).toHaveBeenCalledWith(ctx);
  });

  it("refreshes config with ctx", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleBeforeAgentStart(deps, makeEvent(), ctx);
    expect(deps.session.refreshConfig).toHaveBeenCalledWith(ctx);
  });

  it("resolves agent name using systemPrompt", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleBeforeAgentStart(
      deps,
      makeEvent("<active_agent name='x'>"),
      ctx,
    );
    expect(deps.session.resolveAgentName).toHaveBeenCalledWith(
      ctx,
      "<active_agent name='x'>",
    );
  });

  it("filters out denied tools from allowed list", async () => {
    const session = makeSession({
      getToolPermission: vi.fn().mockReturnValue("deny"),
    });
    const deps = makeDeps({
      session,
      getAllTools: vi
        .fn()
        .mockReturnValue([{ name: "write" }, { name: "read" }]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.setActiveTools).toHaveBeenCalledWith([]);
  });

  it("includes allowed and ask tools in the active list", async () => {
    const deps = makeDeps({
      getAllTools: vi
        .fn()
        .mockReturnValue([{ name: "read" }, { name: "write" }]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.setActiveTools).toHaveBeenCalledWith(["read", "write"]);
  });

  it("commits active-tools cache key after applying", async () => {
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.session.commitActiveToolsCacheKey).toHaveBeenCalled();
  });

  it("skips setActiveTools when cache key is unchanged", async () => {
    const session = makeSession({
      shouldUpdateActiveTools: vi.fn().mockReturnValue(false),
    });
    const deps = makeDeps({
      session,
      getAllTools: vi.fn().mockReturnValue([{ name: "read" }]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.setActiveTools).not.toHaveBeenCalled();
    expect(session.commitActiveToolsCacheKey).not.toHaveBeenCalled();
  });

  it("returns empty object when prompt cache is unchanged", async () => {
    const session = makeSession({
      shouldUpdatePromptState: vi.fn().mockReturnValue(false),
    });
    const deps = makeDeps({
      session,
      getAllTools: vi.fn().mockReturnValue([]),
    });
    const result = await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(result).toEqual({});
    expect(session.commitPromptStateCacheKey).not.toHaveBeenCalled();
  });

  it("commits prompt-state cache key and processes prompt when cache is new", async () => {
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.session.commitPromptStateCacheKey).toHaveBeenCalled();
  });

  it("stores resolved skill entries on the session", async () => {
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([]),
    });
    await handleBeforeAgentStart(deps, makeEvent(), makeCtx());
    expect(deps.session.setActiveSkillEntries).toHaveBeenCalledWith(
      expect.any(Array),
    );
  });

  it("returns modified systemPrompt when prompt changes", async () => {
    const systemPrompt = `You are an assistant.\n\nAvailable tools:\n- read\n- write\n`;
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([]),
    });
    const result = await handleBeforeAgentStart(
      deps,
      makeEvent(systemPrompt),
      makeCtx(),
    );
    expect(result).toHaveProperty("systemPrompt");
  });

  it("returns empty object when systemPrompt is unchanged", async () => {
    const prompt = "No tools section here.";
    const deps = makeDeps({
      getAllTools: vi.fn().mockReturnValue([]),
    });
    const result = await handleBeforeAgentStart(
      deps,
      makeEvent(prompt),
      makeCtx(),
    );
    expect(result).toEqual({});
  });
});
