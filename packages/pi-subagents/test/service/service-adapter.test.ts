import { describe, expect, it, vi } from "vitest";
import { WorktreeState } from "#src/lifecycle/worktree-state";
import { NotificationState } from "#src/observation/notification-state";
import type { SubagentsService } from "#src/service/service";
import type { AgentManagerLike } from "#src/service/service-adapter";
import { createSubagentsService, toSubagentRecord } from "#src/service/service-adapter";
import type { AgentRecord } from "#src/types";
import { createTestRecord } from "#test/helpers/make-record";
import { createMockSession, toAgentSession } from "#test/helpers/mock-session";

describe("toSubagentRecord", () => {
  const baseRecord = (() => {
    const r = createTestRecord({
      id: "abc-123",
      type: "Explore",
      description: "Check stale TODOs",
      result: "Found 3 stale TODOs",
      toolUses: 5,
      lifetimeUsage: { input: 100, output: 200, cacheWrite: 50 },
      compactionCount: 1,
    });
    r.worktreeState = new WorktreeState({ path: "/tmp/wt", branch: "agent/abc-123" });
    r.worktreeState.recordCleanup({ hasChanges: true, branch: "agent/abc-123" });
    return r;
  })();

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

  it("strips execution from the record", () => {
    const record = createTestRecord();
    record.execution = { session: toAgentSession(createMockSession()), outputFile: undefined };
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("execution");
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

  it("strips abortController, promise, and collaborator fields from the record", () => {
    const record = createTestRecord({ abortController: new AbortController(), promise: Promise.resolve("x") });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("abortController");
    expect(result).not.toHaveProperty("promise");
    expect(result).not.toHaveProperty("execution");
    expect(result).not.toHaveProperty("notification");
    expect(result).not.toHaveProperty("worktreeState");
  });

  it("strips invocation and collaborator fields from the serialized output", () => {
    const record = createTestRecord({ invocation: { modelName: "haiku" } });
    record.notification = new NotificationState("tc-1");
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("notification");
    expect(result).not.toHaveProperty("execution");
    expect(result).not.toHaveProperty("worktreeState");
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

/** Minimal ctx stub that satisfies buildParentSnapshot. */
function makeStubCtx() {
  return {
    cwd: "/tmp",
    getSystemPrompt: () => "test prompt",
    model: undefined,
    modelRegistry: { find: () => null },
  };
}

describe("createSubagentsService — getRecord and listAgents", () => {
  const recordA = createTestRecord({
    id: "a-1",
    type: "Explore",
    description: "task A",
    lifetimeUsage: { input: 10, output: 20, cacheWrite: 5 },
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
    return createSubagentsService(
      manager,
      () => ({ id: "test" }),
      () => ({ pi: {}, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
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
  function defaultManager(): AgentManagerLike {
    return {
      spawn: vi.fn(() => "spawned-id"),
      getRecord: vi.fn(),
      listAgents: vi.fn(() => []),
      abort: vi.fn(() => true),
      waitForAll: vi.fn(async () => {}),
      hasRunning: vi.fn(() => false),
      queueSteer: vi.fn(() => true),
    };
  }

  it("throws when getCtx returns undefined (no active session)", () => {
    const svc = createSubagentsService(
      defaultManager(),
      vi.fn(),
      () => undefined,
      () => ({ find: () => null, getAll: () => [] }),
    );
    expect(() => svc.spawn("Explore", "do something")).toThrow(
      /no active session/i,
    );
  });

  it("resolves string model names via resolveModel", () => {
    const resolveModel = vi.fn(() => ({ id: "claude-sonnet", provider: "anthropic" }));
    const svc = createSubagentsService(
      defaultManager(),
      resolveModel,
      () => ({ pi: { fake: true }, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
    svc.spawn("Explore", "check TODOs", { model: "haiku" });
    expect(resolveModel).toHaveBeenCalledWith("haiku", expect.anything());
  });

  it("throws on model resolution failure", () => {
    const svc = createSubagentsService(
      defaultManager(),
      () => 'Model not found: "bad-model".\n\nAvailable models:\n  anthropic/claude-sonnet',
      () => ({ pi: {}, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
    expect(() => svc.spawn("Explore", "task", { model: "bad-model" })).toThrow(
      /Model not found/,
    );
  });

  it("delegates to manager.spawn with resolved model", () => {
    const resolvedModel = { id: "claude-sonnet", provider: "anthropic" };
    const mgr = defaultManager();
    const svc = createSubagentsService(
      mgr,
      () => resolvedModel,
      () => ({ pi: {}, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
    const id = svc.spawn("Explore", "check TODOs", { model: "sonnet", maxTurns: 5 });
    expect(id).toBe("spawned-id");
    expect(mgr.spawn).toHaveBeenCalledWith(
      expect.anything(), // snapshot
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
    const mgr = defaultManager();
    const svc = createSubagentsService(
      mgr,
      vi.fn(),
      () => ({ pi: {}, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
    svc.spawn("Plan", "plan work", { foreground: true });
    expect(mgr.spawn).toHaveBeenCalledWith(
      expect.anything(), // snapshot
      "Plan",
      "plan work",
      expect.objectContaining({ isBackground: false }),
    );
  });

  it("uses truncated prompt as default description", () => {
    const mgr = defaultManager();
    const svc = createSubagentsService(
      mgr,
      vi.fn(),
      () => ({ pi: {}, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
    const longPrompt = "x".repeat(200);
    svc.spawn("Explore", longPrompt);
    expect(mgr.spawn).toHaveBeenCalledWith(
      expect.anything(), // snapshot
      "Explore",
      longPrompt,
      expect.objectContaining({ description: "x".repeat(80) }),
    );
  });

  it("uses provided description over default", () => {
    const mgr = defaultManager();
    const svc = createSubagentsService(
      mgr,
      vi.fn(),
      () => ({ pi: {}, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
    svc.spawn("Explore", "long prompt here", { description: "short desc" });
    expect(mgr.spawn).toHaveBeenCalledWith(
      expect.anything(), // snapshot
      "Explore",
      "long prompt here",
      expect.objectContaining({ description: "short desc" }),
    );
  });

  it("does not call resolveModel when no model option is provided", () => {
    const resolveModel = vi.fn();
    const svc = createSubagentsService(
      defaultManager(),
      resolveModel,
      () => ({ pi: {}, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
    svc.spawn("Explore", "quick check");
    expect(resolveModel).not.toHaveBeenCalled();
  });
});

describe("createSubagentsService — steer, abort, waitForAll, hasRunning", () => {
  function createTestManager() {
    return {
      spawn: vi.fn(() => "id"),
      getRecord: vi.fn<AgentManagerLike["getRecord"]>(),
      listAgents: vi.fn(() => [] as AgentRecord[]),
      abort: vi.fn<AgentManagerLike["abort"]>(() => true),
      waitForAll: vi.fn(async () => {}),
      hasRunning: vi.fn(() => true),
      queueSteer: vi.fn<AgentManagerLike["queueSteer"]>(() => true),
    };
  }

  function createSvc(mgr: ReturnType<typeof createTestManager>) {
    return createSubagentsService(
      mgr,
      vi.fn(),
      () => ({ pi: {}, ctx: makeStubCtx() }),
      () => ({ find: () => null, getAll: () => [] }),
    );
  }

  describe("abort", () => {
    it("delegates to manager.abort and returns its result", () => {
      const mgr = createTestManager();
      const svc = createSvc(mgr);
      const result = svc.abort("agent-1");
      expect(mgr.abort).toHaveBeenCalledWith("agent-1");
      expect(result).toBe(true);
    });

    it("returns false when manager returns false", () => {
      const mgr = createTestManager();
      mgr.abort.mockReturnValue(false);
      const svc = createSvc(mgr);
      expect(svc.abort("unknown")).toBe(false);
    });
  });

  describe("waitForAll", () => {
    it("delegates to manager.waitForAll", async () => {
      const mgr = createTestManager();
      const svc = createSvc(mgr);
      await svc.waitForAll();
      expect(mgr.waitForAll).toHaveBeenCalled();
    });
  });

  describe("hasRunning", () => {
    it("delegates to manager.hasRunning", () => {
      const mgr = createTestManager();
      const svc = createSvc(mgr);
      expect(svc.hasRunning()).toBe(true);
      expect(mgr.hasRunning).toHaveBeenCalled();
    });
  });

  describe("steer", () => {
    it("returns false for non-running agent", async () => {
      const mgr = createTestManager();
      mgr.getRecord.mockReturnValue({
        id: "a-1",
        status: "completed",
      } as AgentRecord);
      const svc = createSvc(mgr);
      expect(await svc.steer("a-1", "hurry")).toBe(false);
    });

    it("returns false for unknown agent", async () => {
      const mgr = createTestManager();
      mgr.getRecord.mockReturnValue(undefined);
      const svc = createSvc(mgr);
      expect(await svc.steer("unknown", "hurry")).toBe(false);
    });

    it("queues message and returns true when session not ready", async () => {
      const record = createTestRecord({ id: "a-1", status: "running" });
      const mgr = createTestManager();
      mgr.getRecord.mockReturnValue(record);
      const svc = createSvc(mgr);
      expect(await svc.steer("a-1", "do this")).toBe(true);
      expect(mgr.queueSteer).toHaveBeenCalledWith("a-1", "do this");
    });

    it("delegates to session.steer and returns true when session is ready", async () => {
      const mockSteer = vi.fn(async () => {});
      const record = createTestRecord({ id: "a-1", status: "running" });
      record.execution = { session: toAgentSession(createMockSession({ steer: mockSteer })), outputFile: undefined };
      const mgr = createTestManager();
      mgr.getRecord.mockReturnValue(record);
      const svc = createSvc(mgr);
      expect(await svc.steer("a-1", "focus on tests")).toBe(true);
      expect(mockSteer).toHaveBeenCalledWith("focus on tests");
    });
  });
});
