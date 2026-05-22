import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/agent-types.js";
import { type AgentToolDeps, createAgentTool } from "../../src/tools/agent-tool.js";
import { AgentActivityTracker } from "../../src/ui/agent-activity-tracker.js";
import { createTestRecord } from "../helpers/make-record.js";

const testRegistry = new AgentTypeRegistry(() => new Map());

function makeDeps(overrides: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return {
    manager: {
      spawn: vi.fn().mockReturnValue("agent-1"),
      spawnAndWait: vi.fn().mockResolvedValue(createTestRecord()),
      resume: vi.fn().mockResolvedValue(createTestRecord()),
      getRecord: vi.fn().mockReturnValue(createTestRecord()),
      getMaxConcurrent: vi.fn().mockReturnValue(4),
      listAgents: vi.fn().mockReturnValue([]),
    },
    widget: {
      setUICtx: vi.fn(),
      ensureTimer: vi.fn(),
      update: vi.fn(),
      markFinished: vi.fn(),
    },
    agentActivity: new Map<string, AgentActivityTracker>(),
    registry: testRegistry,
    agentDir: "/home/user/.pi",
    settings: { defaultMaxTurns: undefined as number | undefined },
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    model: { id: "claude-sonnet", name: "Claude Sonnet" },
    modelRegistry: {},
    cwd: "/test",
    ui: { fake: true },
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/sessions/parent.jsonl" },
    ...overrides,
  };
}

async function execute(
  deps: AgentToolDeps,
  params: Record<string, unknown>,
  ctx?: ReturnType<typeof makeCtx>,
) {
  const tool = createAgentTool(deps);
  return tool.execute(
    "tc-1",
    params,
    new AbortController().signal,
    vi.fn(),
    ctx ?? makeCtx(),
  );
}

describe("createAgentTool", () => {
  it("returns tool definition with correct name and label", () => {
    const tool = createAgentTool(makeDeps());
    expect(tool.name).toBe("Agent");
    expect(tool.label).toBe("Agent");
  });

  it("derives type list from registry — includes default agents in description", () => {
    const tool = createAgentTool(makeDeps());
    // testRegistry loads default agents: general-purpose, Explore, Plan
    expect(tool.description).toContain("- general-purpose: General-purpose agent");
    expect(tool.description).toContain("- Explore: Fast codebase exploration agent");
  });

  it("calls registry.reload() on each execute", async () => {
    const reloadSpy = vi.spyOn(testRegistry, "reload");
    const deps = makeDeps();
    await execute(deps, {
      prompt: "test",
      description: "test",
      subagent_type: "general-purpose",
    });
    expect(reloadSpy).toHaveBeenCalledOnce();
    reloadSpy.mockRestore();
  });

  it("sets UI context on widget at start of execute", async () => {
    const deps = makeDeps();
    const ctx = makeCtx();
    await execute(deps, {
      prompt: "test",
      description: "test",
      subagent_type: "general-purpose",
    }, ctx);
    expect(deps.widget.setUICtx).toHaveBeenCalledWith(ctx.ui);
  });
});

describe("Agent tool — resume path", () => {
  it("returns not-found when resume ID does not exist", async () => {
    const deps = makeDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
    const result = await execute(deps, {
      prompt: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "nonexistent",
    });
    expect(result.content[0].text).toContain("Agent not found");
  });

  it("returns no-session when agent has no active session", async () => {
    const deps = makeDeps();
    // No execution state set — session not yet created
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestRecord());
    const result = await execute(deps, {
      prompt: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "agent-1",
    });
    expect(result.content[0].text).toContain("no active session");
  });

  it("returns result text on successful resume", async () => {
    const deps = makeDeps();
    const resumeRecord = createTestRecord();
    resumeRecord.execution = { session: {} as any, outputFile: undefined };
    deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
    deps.manager.resume = vi.fn().mockResolvedValue(createTestRecord({ result: "Resumed output." }));
    const result = await execute(deps, {
      prompt: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: "agent-1",
    });
    expect(result.content[0].text).toContain("Resumed output.");
  });
});

describe("Agent tool — model resolution error", () => {
  it("returns error when model resolution fails", async () => {
    const deps = makeDeps();
    // Provide a real-enough modelRegistry so resolveInvocationModel can iterate it
    const ctx = makeCtx({
      modelRegistry: { getAll: () => [], getAvailable: () => [] },
    });
    const result = await execute(
      deps,
      {
        prompt: "test",
        description: "test",
        subagent_type: "general-purpose",
        model: "nonexistent-model-xyz",
      },
      ctx,
    );
    // User-specified model that doesn't resolve → error message
    expect(result.content[0].text).toContain("nonexistent-model-xyz");
  });
});

describe("Agent tool — background execution", () => {
  it("returns background launch message with agent ID", async () => {
    const deps = makeDeps();
    const record = createTestRecord({ status: "running" });
    deps.manager.getRecord = vi.fn().mockReturnValue(record);
    const result = await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    const text = result.content[0].text;
    expect(text).toContain("background");
    expect(text).toContain("agent-1");
    expect(text).toContain("bg task");
  });

  it("does not emit subagents:created directly — delegated to observer.onAgentCreated", async () => {
    // The subagents:created event is now emitted by AgentManagerObserver.onAgentCreated,
    // called from AgentManager.spawn(). Tested in agent-manager.test.ts.
    // This test ensures the tool no longer holds an emitEvent dep for this purpose.
    const deps = makeDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestRecord({ status: "running" }));
    const result = await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    // Background spawn succeeds — no emitEvent dep required
    expect(result.content[0].text).toContain("background");
  });

  it("registers activity in agentActivity map", async () => {
    const deps = makeDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(createTestRecord({ status: "running" }));
    await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    expect(deps.agentActivity.has("agent-1")).toBe(true);
  });

  it("sets record.notification with the tool call id for background agents", async () => {
    const record = createTestRecord({ status: "running" });
    const deps = makeDeps();
    deps.manager.getRecord = vi.fn().mockReturnValue(record);
    await execute(deps, {
      prompt: "do something",
      description: "bg task",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    expect(record.notification).toBeDefined();
    expect(record.notification!.toolCallId).toBe("tc-1");
    expect(record.notification!.resultConsumed).toBe(false);
  });
});

describe("Agent tool — foreground execution", () => {
  it("returns completion message with stats", async () => {
    const deps = makeDeps();
    deps.manager.spawnAndWait = vi.fn().mockResolvedValue(
      createTestRecord({ result: "Task complete.", toolUses: 5 }),
    );
    const result = await execute(deps, {
      prompt: "do task",
      description: "fg task",
      subagent_type: "general-purpose",
    });
    const text = result.content[0].text;
    expect(text).toContain("Agent completed");
    expect(text).toContain("Task complete.");
  });

  it("returns error message when agent fails", async () => {
    const deps = makeDeps();
    deps.manager.spawnAndWait = vi.fn().mockResolvedValue(
      createTestRecord({ status: "error", error: "Out of context" }),
    );
    const result = await execute(deps, {
      prompt: "do task",
      description: "fg task",
      subagent_type: "general-purpose",
    });
    expect(result.content[0].text).toContain("Agent failed");
    expect(result.content[0].text).toContain("Out of context");
  });

  it("returns error when spawnAndWait throws", async () => {
    const deps = makeDeps();
    deps.manager.spawnAndWait = vi.fn().mockRejectedValue(new Error("spawn failure"));
    const result = await execute(deps, {
      prompt: "do task",
      description: "fg task",
      subagent_type: "general-purpose",
    });
    expect(result.content[0].text).toContain("spawn failure");
  });
});
