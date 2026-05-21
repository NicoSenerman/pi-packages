import { describe, expect, it, vi } from "vitest";
import type { SubagentsService } from "../src/service.js";
import { type AdapterDeps, createSubagentsService, toSubagentRecord } from "../src/service-adapter.js";
import type { AgentRecord } from "../src/types.js";
import { createTestRecord } from "./helpers/make-record.js";

describe("toSubagentRecord", () => {
  const baseRecord = createTestRecord({
    id: "abc-123",
    type: "Explore",
    description: "Check stale TODOs",
    result: "Found 3 stale TODOs",
    toolUses: 5,
    lifetimeUsage: { input: 100, output: 200, cacheWrite: 50 },
    compactionCount: 1,
    worktreeResult: { hasChanges: true, branch: "agent/abc-123" },
  });

  it("includes all serializable fields", () => {
    const result = toSubagentRecord(baseRecord);
    expect(result).toEqual({
      id: "abc-123",
      type: "Explore",
      description: "Check stale TODOs",
      status: "completed",
      result: "Found 3 stale TODOs",
      toolUses: 5,
      startedAt: 1000,
      completedAt: 2000,
      lifetimeUsage: { input: 100, output: 200, cacheWrite: 50 },
      compactionCount: 1,
      worktreeResult: { hasChanges: true, branch: "agent/abc-123" },
    });
  });

  it("strips session from the record", () => {
    const record = createTestRecord({ session: { dispose: () => {} } as any });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("session");
  });

  it("strips abortController from the record", () => {
    const record = createTestRecord({ abortController: new AbortController() });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("abortController");
  });

  it("strips promise from the record", () => {
    const record = createTestRecord({ promise: Promise.resolve("done") });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("promise");
  });

  it("strips session, abortController, promise, outputFile, and other runtime fields from the record", () => {
    const record = createTestRecord({ session: {} as any, abortController: new AbortController(), promise: Promise.resolve("x") });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("session");
    expect(result).not.toHaveProperty("abortController");
    expect(result).not.toHaveProperty("promise");
  });

  it("strips resultConsumed, toolCallId, outputFile, worktree, invocation", () => {
    const record = createTestRecord({
      resultConsumed: true,
      toolCallId: "tool-1",
      outputFile: "/tmp/out.jsonl",
      worktree: { path: "/tmp/wt", branch: "wt-branch" },
      invocation: { modelName: "haiku" },
    });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("resultConsumed");
    expect(result).not.toHaveProperty("toolCallId");
    expect(result).not.toHaveProperty("outputFile");
    expect(result).not.toHaveProperty("worktree");
    expect(result).not.toHaveProperty("invocation");
  });

  it("omits optional fields when undefined on the source", () => {
    const minimal = createTestRecord({
      id: "min-1",
      description: "test",
      status: "running",
      result: undefined,
      toolUses: 0,
      startedAt: 500,
      completedAt: undefined,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    });
    const result = toSubagentRecord(minimal);
    expect(result).toEqual({
      id: "min-1",
      type: "general-purpose",
      description: "test",
      status: "running",
      toolUses: 0,
      startedAt: 500,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    });
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("completedAt");
    expect(result).not.toHaveProperty("worktreeResult");
  });
});

describe("createSubagentsService — getRecord and listAgents", () => {
  const recordA = createTestRecord({
    id: "a-1",
    type: "Explore",
    description: "task A",
    lifetimeUsage: { input: 10, output: 20, cacheWrite: 5 },
    session: { dispose: () => {} } as any,
    abortController: new AbortController(),
  });

  const recordB = createTestRecord({
    id: "b-2",
    type: "Plan",
    description: "task B",
    status: "running",
    toolUses: 1,
    startedAt: 3000,
    result: undefined,
    completedAt: undefined,
    lifetimeUsage: { input: 5, output: 10, cacheWrite: 0 },
  });

  function createMockManager(records: AgentRecord[]) {
    return {
      spawn: vi.fn(() => "id"),
      getRecord: vi.fn((id: string) => records.find((r) => r.id === id)),
      listAgents: vi.fn(() => [...records].sort((a, b) => b.startedAt - a.startedAt)),
      abort: vi.fn(() => true),
      waitForAll: vi.fn(async () => {}),
      hasRunning: vi.fn(() => false),
      queueSteer: vi.fn(() => true),
    };
  }

  function createService(records: AgentRecord[]): SubagentsService {
    const manager = createMockManager(records);
    return createSubagentsService({
      manager,
      resolveModel: () => ({ id: "test" }),
      getCtx: () => ({ pi: {}, ctx: {} }),
      getModelRegistry: () => ({ find: () => null, getAll: () => [] }),
    });
  }

  it("getRecord returns serialized record for known id", () => {
    const svc = createService([recordA, recordB]);
    const result = svc.getRecord("a-1");
    expect(result).toBeDefined();
    expect(result!.id).toBe("a-1");
    expect(result).not.toHaveProperty("session");
    expect(result).not.toHaveProperty("abortController");
  });

  it("getRecord returns undefined for unknown id", () => {
    const svc = createService([recordA]);
    expect(svc.getRecord("unknown")).toBeUndefined();
  });

  it("listAgents returns serialized records sorted by startedAt descending", () => {
    const svc = createService([recordA, recordB]);
    const list = svc.listAgents();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("b-2");
    expect(list[1].id).toBe("a-1");
    // Verify serialization
    expect(list[0]).not.toHaveProperty("session");
    expect(list[1]).not.toHaveProperty("abortController");
  });
});

describe("createSubagentsService — spawn", () => {
  function createDeps(overrides: Partial<AdapterDeps> = {}): AdapterDeps {
    return {
      manager: {
        spawn: vi.fn(() => "spawned-id"),
        getRecord: vi.fn(),
        listAgents: vi.fn(() => []),
        abort: vi.fn(() => true),
        waitForAll: vi.fn(async () => {}),
        hasRunning: vi.fn(() => false),
        queueSteer: vi.fn(() => true),
      },
      resolveModel: vi.fn(() => ({ id: "claude-sonnet", provider: "anthropic" })),
      getCtx: () => ({ pi: { fake: true }, ctx: { cwd: "/tmp" } }),
      getModelRegistry: () => ({ find: () => null, getAll: () => [] }),
      ...overrides,
    };
  }

  it("throws when getCtx returns undefined (no active session)", () => {
    const deps = createDeps({ getCtx: () => undefined });
    const svc = createSubagentsService(deps);
    expect(() => svc.spawn("Explore", "do something")).toThrow(
      /no active session/i,
    );
  });

  it("resolves string model names via resolveModel", () => {
    const deps = createDeps();
    const svc = createSubagentsService(deps);
    svc.spawn("Explore", "check TODOs", { model: "haiku" });
    expect(deps.resolveModel).toHaveBeenCalledWith("haiku", expect.anything());
  });

  it("throws on model resolution failure", () => {
    const deps = createDeps({
      resolveModel: () => 'Model not found: "bad-model".\n\nAvailable models:\n  anthropic/claude-sonnet',
    });
    const svc = createSubagentsService(deps);
    expect(() => svc.spawn("Explore", "task", { model: "bad-model" })).toThrow(
      /Model not found/,
    );
  });

  it("delegates to manager.spawn with resolved model", () => {
    const resolvedModel = { id: "claude-sonnet", provider: "anthropic" };
    const deps = createDeps({ resolveModel: () => resolvedModel });
    const svc = createSubagentsService(deps);
    const id = svc.spawn("Explore", "check TODOs", { model: "sonnet", maxTurns: 5 });
    expect(id).toBe("spawned-id");
    expect(deps.manager.spawn).toHaveBeenCalledWith(
      expect.anything(), // ctx
      "Explore",
      "check TODOs",
      expect.objectContaining({
        model: resolvedModel,
        maxTurns: 5,
        isBackground: true,
      }),
    );
  });

  it("spawns as foreground when options.foreground is true", () => {
    const deps = createDeps();
    const svc = createSubagentsService(deps);
    svc.spawn("Plan", "plan work", { foreground: true });
    expect(deps.manager.spawn).toHaveBeenCalledWith(
      expect.anything(), // ctx
      "Plan",
      "plan work",
      expect.objectContaining({ isBackground: false }),
    );
  });

  it("uses truncated prompt as default description", () => {
    const deps = createDeps();
    const svc = createSubagentsService(deps);
    const longPrompt = "x".repeat(200);
    svc.spawn("Explore", longPrompt);
    expect(deps.manager.spawn).toHaveBeenCalledWith(
      expect.anything(), // ctx
      "Explore",
      longPrompt,
      expect.objectContaining({ description: "x".repeat(80) }),
    );
  });

  it("uses provided description over default", () => {
    const deps = createDeps();
    const svc = createSubagentsService(deps);
    svc.spawn("Explore", "long prompt here", { description: "short desc" });
    expect(deps.manager.spawn).toHaveBeenCalledWith(
      expect.anything(), // ctx
      "Explore",
      "long prompt here",
      expect.objectContaining({ description: "short desc" }),
    );
  });

  it("does not call resolveModel when no model option is provided", () => {
    const deps = createDeps();
    const svc = createSubagentsService(deps);
    svc.spawn("Explore", "quick check");
    expect(deps.resolveModel).not.toHaveBeenCalled();
  });
});

describe("createSubagentsService — steer, abort, waitForAll, hasRunning", () => {
  function createDeps(overrides: Partial<AdapterDeps> = {}): AdapterDeps {
    return {
      manager: {
        spawn: vi.fn(() => "id"),
        getRecord: vi.fn(),
        listAgents: vi.fn(() => []),
        abort: vi.fn(() => true),
        waitForAll: vi.fn(async () => {}),
        hasRunning: vi.fn(() => true),
        queueSteer: vi.fn(() => true),
      },
      resolveModel: vi.fn(),
      getCtx: () => ({ pi: {}, ctx: {} }),
      getModelRegistry: () => ({ find: () => null, getAll: () => [] }),
      ...overrides,
    };
  }

  describe("abort", () => {
    it("delegates to manager.abort and returns its result", () => {
      const deps = createDeps();
      const svc = createSubagentsService(deps);
      const result = svc.abort("agent-1");
      expect(deps.manager.abort).toHaveBeenCalledWith("agent-1");
      expect(result).toBe(true);
    });

    it("returns false when manager returns false", () => {
      const deps = createDeps();
      (deps.manager.abort as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const svc = createSubagentsService(deps);
      expect(svc.abort("unknown")).toBe(false);
    });
  });

  describe("waitForAll", () => {
    it("delegates to manager.waitForAll", async () => {
      const deps = createDeps();
      const svc = createSubagentsService(deps);
      await svc.waitForAll();
      expect(deps.manager.waitForAll).toHaveBeenCalled();
    });
  });

  describe("hasRunning", () => {
    it("delegates to manager.hasRunning", () => {
      const deps = createDeps();
      const svc = createSubagentsService(deps);
      expect(svc.hasRunning()).toBe(true);
      expect(deps.manager.hasRunning).toHaveBeenCalled();
    });
  });

  describe("steer", () => {
    it("returns false for non-running agent", async () => {
      const deps = createDeps();
      (deps.manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "a-1",
        status: "completed",
      });
      const svc = createSubagentsService(deps);
      expect(await svc.steer("a-1", "hurry")).toBe(false);
    });

    it("returns false for unknown agent", async () => {
      const deps = createDeps();
      (deps.manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      const svc = createSubagentsService(deps);
      expect(await svc.steer("unknown", "hurry")).toBe(false);
    });

    it("queues message and returns true when session not ready", async () => {
      const record = createTestRecord({
        id: "a-1",
        status: "running",
        session: undefined,
      });
      const deps = createDeps();
      (deps.manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(record);
      const svc = createSubagentsService(deps);
      expect(await svc.steer("a-1", "do this")).toBe(true);
      expect(deps.manager.queueSteer).toHaveBeenCalledWith("a-1", "do this");
    });

    it("delegates to session.steer and returns true when session is ready", async () => {
      const mockSteer = vi.fn(async () => {});
      const record = createTestRecord({
        id: "a-1",
        status: "running",
        session: { steer: mockSteer } as any,
      });
      const deps = createDeps();
      (deps.manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(record);
      const svc = createSubagentsService(deps);
      expect(await svc.steer("a-1", "focus on tests")).toBe(true);
      expect(mockSteer).toHaveBeenCalledWith("focus on tests");
    });
  });
});
