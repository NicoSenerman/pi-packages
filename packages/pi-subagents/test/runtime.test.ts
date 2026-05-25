import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { createSubagentRuntime, SubagentRuntime, type WidgetLike } from "#src/runtime";
import type { SessionContext } from "#src/types";
import { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

const mockBuildParentSnapshot = vi.hoisted(() =>
  vi.fn<(ctx: SessionContext, inheritContext?: boolean) => ParentSnapshot>(),
);

vi.mock("#src/lifecycle/parent-snapshot", () => ({
  buildParentSnapshot: mockBuildParentSnapshot,
}));

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    cwd: "/test/cwd",
    model: undefined,
    modelRegistry: undefined,
    getSystemPrompt: () => "test prompt",
    sessionManager: {
      getSessionFile: () => "/sessions/test.jsonl",
      getSessionId: () => "test-session-id",
      getBranch: () => [],
    },
    ...overrides,
  };
}

function createWidgetStub(): WidgetLike {
  return {
    setUICtx: vi.fn(),
    onTurnStart: vi.fn(),
    markFinished: vi.fn(),
    update: vi.fn(),
    ensureTimer: vi.fn(),
  };
}

describe("createSubagentRuntime", () => {
  it("returns correct defaults", () => {
    const runtime = createSubagentRuntime();
    expect(runtime.currentCtx).toBeUndefined();
    expect(runtime.widget).toBeNull();
    expect(runtime.agentActivity).toBeInstanceOf(Map);
    expect(runtime.agentActivity.size).toBe(0);
  });

  it("currentCtx is the stored SessionContext after setSessionContext", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
  });

  it("agentActivity map is independently mutable", () => {
    const runtime = createSubagentRuntime();
    const activity = new AgentActivityTracker();
    runtime.agentActivity.set("agent-1", activity);
    expect(runtime.agentActivity.size).toBe(1);
    expect(runtime.agentActivity.get("agent-1")).toBe(activity);
  });

  it("multiple instances are isolated — mutations do not cross-contaminate", () => {
    const a = createSubagentRuntime();
    const b = createSubagentRuntime();

    a.agentActivity.set("x", new AgentActivityTracker());

    expect(b.agentActivity.size).toBe(0);
  });

  it("widget field accepts a WidgetLike stub", () => {
    const runtime = createSubagentRuntime();
    const stub = createWidgetStub();
    runtime.widget = stub;
    expect(runtime.widget).toBe(stub);
  });
});

describe("SubagentRuntime class", () => {
  it("is a class — instances are created with new", () => {
    const runtime = new SubagentRuntime();
    expect(runtime).toBeInstanceOf(SubagentRuntime);
  });

  it("createSubagentRuntime returns an instance of the class", () => {
    const runtime = createSubagentRuntime();
    expect(runtime).toBeInstanceOf(SubagentRuntime);
  });
});

describe("SubagentRuntime session-context methods", () => {
  it("setSessionContext stores the provided SessionContext directly", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
  });

  it("clearSessionContext resets currentCtx to undefined", () => {
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx());
    expect(runtime.currentCtx).toBeDefined();
    runtime.clearSessionContext();
    expect(runtime.currentCtx).toBeUndefined();
  });

  it("round-trip: set then clear returns to initial state", () => {
    const runtime = createSubagentRuntime();
    expect(runtime.currentCtx).toBeUndefined();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
    runtime.clearSessionContext();
    expect(runtime.currentCtx).toBeUndefined();
  });
});

describe("SubagentRuntime context query methods", () => {
  beforeEach(() => {
    mockBuildParentSnapshot.mockReset();
  });

  it("buildSnapshot delegates to buildParentSnapshot with the current context and inheritContext flag", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);
    const result = runtime.buildSnapshot(true);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, true);
    expect(result).toBe(STUB_SNAPSHOT);
  });

  it("buildSnapshot passes false inheritContext correctly", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);
    runtime.buildSnapshot(false);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, false);
  });

  it("getModelInfo returns model and modelRegistry from current context", () => {
    const runtime = createSubagentRuntime();
    const registry = { find: () => undefined, getAll: () => [], getAvailable: () => [] };
    const ctx = makeSessionCtx({ model: { id: "claude-sonnet", name: "Claude Sonnet" }, modelRegistry: registry });
    runtime.setSessionContext(ctx);
    const info = runtime.getModelInfo();
    expect(info.parentModel).toEqual({ id: "claude-sonnet", name: "Claude Sonnet" });
    expect(info.modelRegistry).toBe(registry);
  });

  it("getModelInfo returns undefined parentModel when context model is undefined", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({ model: undefined });
    runtime.setSessionContext(ctx);
    const info = runtime.getModelInfo();
    expect(info.parentModel).toBeUndefined();
  });

  it("getSessionInfo returns session file and id from sessionManager", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "session-42",
        getBranch: () => [],
      },
    });
    runtime.setSessionContext(ctx);
    const info = runtime.getSessionInfo();
    expect(info.parentSessionFile).toBe("/sessions/parent.jsonl");
    expect(info.parentSessionId).toBe("session-42");
  });

  it("getSessionInfo uses empty string when getSessionFile returns undefined", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => "session-99",
        getBranch: () => [],
      },
    });
    runtime.setSessionContext(ctx);
    const info = runtime.getSessionInfo();
    expect(info.parentSessionFile).toBe("");
    expect(info.parentSessionId).toBe("session-99");
  });
});

describe("SubagentRuntime widget delegation methods", () => {
  it("setUICtx delegates to widget.setUICtx", () => {
    const runtime = createSubagentRuntime();
    const stub = createWidgetStub();
    runtime.widget = stub;
    const ctx = { setStatus: vi.fn(), setWidget: vi.fn() };
    runtime.setUICtx(ctx);
    expect(stub.setUICtx).toHaveBeenCalledWith(ctx);
  });

  it("onTurnStart delegates to widget.onTurnStart", () => {
    const runtime = createSubagentRuntime();
    const stub = createWidgetStub();
    runtime.widget = stub;
    runtime.onTurnStart();
    expect(stub.onTurnStart).toHaveBeenCalledOnce();
  });

  it("markFinished delegates to widget.markFinished", () => {
    const runtime = createSubagentRuntime();
    const stub = createWidgetStub();
    runtime.widget = stub;
    runtime.markFinished("agent-42");
    expect(stub.markFinished).toHaveBeenCalledWith("agent-42");
  });

  it("updateWidget delegates to widget.update", () => {
    const runtime = createSubagentRuntime();
    const stub = createWidgetStub();
    runtime.widget = stub;
    runtime.updateWidget();
    expect(stub.update).toHaveBeenCalledOnce();
  });

  it("ensureTimer delegates to widget.ensureTimer", () => {
    const runtime = createSubagentRuntime();
    const stub = createWidgetStub();
    runtime.widget = stub;
    runtime.ensureTimer();
    expect(stub.ensureTimer).toHaveBeenCalledOnce();
  });

  it("all delegation methods no-op when widget is null", () => {
    const runtime = createSubagentRuntime();
    expect(runtime.widget).toBeNull();
    // None of these should throw
    runtime.setUICtx({ setStatus: vi.fn(), setWidget: vi.fn() });
    runtime.onTurnStart();
    runtime.markFinished("id");
    runtime.updateWidget();
    runtime.ensureTimer();
  });
});
