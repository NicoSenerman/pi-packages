import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type OnAgentCompact, type OnAgentComplete, type OnAgentStart } from "../src/agent-manager.js";
import type { AgentRunner, ResumeOptions } from "../src/agent-runner.js";
import type { RunConfig } from "../src/runtime.js";
import type { AgentRecord } from "../src/types.js";
import type { WorktreeManager } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

/** Test helper: construct an AgentManager with injected stubs. */
function createManager(overrides?: {
  runner?: AgentRunner;
  worktrees?: WorktreeManager;
  onComplete?: OnAgentComplete;
  onStart?: OnAgentStart;
  onCompact?: OnAgentCompact;
  maxConcurrent?: number;
  getRunConfig?: () => RunConfig;
}) {
  const runner: AgentRunner = overrides?.runner ?? {
    run: vi.fn().mockResolvedValue({
      responseText: "done",
      session: mockSession(),
      aborted: false,
      steered: false,
    }),
    resume: vi.fn().mockResolvedValue("resumed"),
  };
  const worktrees: WorktreeManager = overrides?.worktrees ?? {
    create: vi.fn(),
    cleanup: vi.fn(() => ({ hasChanges: false })),
    prune: vi.fn(),
  };
  const manager = new AgentManager({
    runner,
    worktrees,
    onComplete: overrides?.onComplete,
    onStart: overrides?.onStart,
    onCompact: overrides?.onCompact,
    maxConcurrent: overrides?.maxConcurrent,
    getRunConfig: overrides?.getRunConfig,
  });
  return { manager, runner, worktrees };
}

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    ({ manager } = createManager({ onComplete: (r) => {
      seenConsumed = r.resultConsumed;
    } }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    ({ manager } = createManager({ onComplete: (r) => {
      seenConsumed = r.resultConsumed;
    } }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    ({ manager } = createManager({ onComplete: (r) => {
      completedRecord = r;
    } }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete is not called for foreground agents", async () => {
    let onCompleteCalled = false;
    ({ manager } = createManager({ onComplete: () => {
      onCompleteCalled = true;
    } }));

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(onCompleteCalled).toBe(false);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    ({ manager } = createManager({ onComplete: () => {
      throw new Error("stale extension context");
    } }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    ({ manager } = createManager());

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    ({ manager } = createManager());

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=1 to keep second agent queued; runner never resolves
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(() => new Promise(() => {})),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ maxConcurrent: 1, runner }));

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    const runner: AgentRunner = {
      run: vi.fn().mockResolvedValue({
        responseText: "done",
        session: sess as any,
        aborted: false,
        steered: false,
      }),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    const runner: AgentRunner = {
      run: vi.fn().mockRejectedValue(new Error("boom")),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    // Runner never resolves — we just want to inspect the record at spawn time.
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(() => new Promise(() => {})),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    // Drive callbacks inside the runner to simulate assistant usage events
    let captured: any;
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
        captured = opts;
        opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
        opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
        return { responseText: "done", session: mockSession(), aborted: false, steered: false };
      }),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    const compactSeen: any[] = [];

    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
        // Compaction fires while the agent is still running — the record passed to
        // onCompact should reflect the just-incremented count.
        opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
        opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
        return { responseText: "done", session: mockSession(), aborted: false, steered: false };
      }),
      resume: vi.fn(),
    };

    ({ manager } = createManager({ runner, onCompact: (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    } }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    const runner: AgentRunner = {
      run: vi.fn().mockResolvedValue({
        responseText: "first",
        session: session as any,
        aborted: false,
        steered: false,
      }),
      resume: vi.fn().mockImplementation(async (_session: any, _prompt: any, opts?: ResumeOptions) => {
        opts?.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
        opts?.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
        return "second";
      }),
    };
    ({ manager } = createManager({ runner }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — getRunConfig threads defaultMaxTurns and graceTurns into RunOptions", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("passes defaultMaxTurns and graceTurns from getRunConfig to runAgent", async () => {
    const getRunConfig = vi.fn(() => ({ defaultMaxTurns: 10, graceTurns: 3 }));
    let runner: AgentRunner;
    ({ manager, runner } = createManager({ getRunConfig }));

    manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());

    const runOpts = vi.mocked(runner.run).mock.calls[0][3];
    expect(runOpts.defaultMaxTurns).toBe(10);
    expect(runOpts.graceTurns).toBe(3);
  });

  it("omits defaultMaxTurns and graceTurns from runAgent when no getRunConfig is provided", async () => {
    let runner: AgentRunner;
    ({ manager, runner } = createManager());

    manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());

    const runOpts = vi.mocked(runner.run).mock.calls[0][3];
    expect(runOpts.defaultMaxTurns).toBeUndefined();
    expect(runOpts.graceTurns).toBeUndefined();
  });
});

describe("AgentManager — dispose calls worktrees.prune", () => {
  it("calls worktrees.prune on dispose", () => {
    const { manager, worktrees } = createManager();
    manager.dispose();
    expect(worktrees.prune).toHaveBeenCalledOnce();
  });
});

describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn() throws when worktrees.create returns undefined; no orphan record left behind", async () => {
    const worktrees: WorktreeManager = {
      create: vi.fn().mockReturnValue(undefined),
      cleanup: vi.fn(() => ({ hasChanges: false })),
      prune: vi.fn(),
    };
    const runner: AgentRunner = {
      run: vi.fn(),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner, worktrees }));
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runner.run never invoked — strict, no silent fallback
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("AgentManager — dependency injection via options bag", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("calls injected runner.run when spawning an agent", async () => {
    let runner: AgentRunner;
    ({ manager, runner } = createManager());

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(runner.run).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.result).toBe("done");
  });

  it("calls injected runner.resume when resuming an agent", async () => {
    const session = mockSession();
    const runner: AgentRunner = {
      run: vi.fn().mockResolvedValue({
        responseText: "first",
        session,
        aborted: false,
        steered: false,
      }),
      resume: vi.fn().mockResolvedValue("second"),
    };
    ({ manager } = createManager({ runner }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    await manager.resume(id, "continue");

    expect(runner.resume).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.result).toBe("second");
  });

  it("calls worktrees.create for worktree isolation", async () => {
    const worktrees: WorktreeManager = {
      create: vi.fn().mockReturnValue({ path: "/tmp/wt", branch: "pi-agent-x" }),
      cleanup: vi.fn(() => ({ hasChanges: false })),
      prune: vi.fn(),
    };
    ({ manager } = createManager({ worktrees }));

    manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
      isBackground: true,
    });

    expect(worktrees.create).toHaveBeenCalledOnce();
  });

  it("calls worktrees.cleanup after agent completes with a worktree", async () => {
    const worktrees: WorktreeManager = {
      create: vi.fn().mockReturnValue({ path: "/tmp/wt", branch: "pi-agent-x" }),
      cleanup: vi.fn(() => ({ hasChanges: false })),
      prune: vi.fn(),
    };
    ({ manager } = createManager({ worktrees }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(worktrees.cleanup).toHaveBeenCalledOnce();
  });
});

describe("AgentManager — queueing and concurrency with injected stubs", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("queues excess background agents and drains them in order", async () => {
    const startOrder: string[] = [];
    const { promise: gate1, resolve: resolve1 } = Promise.withResolvers<void>();
    const { promise: gate2, resolve: resolve2 } = Promise.withResolvers<void>();

    let callCount = 0;
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        const n = callCount;
        startOrder.push(`start-${n}`);
        if (n === 1) await gate1;
        if (n === 2) await gate2;
        return { responseText: `result-${n}`, session: mockSession(), aborted: false, steered: false };
      }),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner, maxConcurrent: 1 }));

    // Spawn two background agents — first runs, second queues
    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "first", isBackground: true,
    });
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "second", isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    // Complete first agent — second should start
    resolve1!();
    await manager.getRecord(id1)!.promise;

    // Wait for the second to start
    await vi.waitFor(() => expect(manager.getRecord(id2)!.status).toBe("running"));

    resolve2!();
    await manager.getRecord(id2)!.promise;

    expect(startOrder).toEqual(["start-1", "start-2"]);
    expect(manager.getRecord(id1)!.result).toBe("result-1");
    expect(manager.getRecord(id2)!.result).toBe("result-2");
  });

  it("abort removes a queued agent without ever running it", () => {
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(() => new Promise(() => {})),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner, maxConcurrent: 1 }));

    // First runs, second queues
    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "a", {
      description: "a", isBackground: true,
    });
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "b", {
      description: "b", isBackground: true,
    });

    expect(manager.getRecord(id2)!.status).toBe("queued");

    // Abort the queued agent
    expect(manager.abort(id2)).toBe(true);
    expect(manager.getRecord(id2)!.status).toBe("stopped");

    // runner.run was called once (for the first agent), never for the aborted one
    expect(runner.run).toHaveBeenCalledOnce();

    manager.abort(id1);
  });

  it("onStart fires when agent transitions from queued to running", async () => {
    const startedIds: string[] = [];
    const { promise: gate, resolve } = Promise.withResolvers<void>();

    let callCount = 0;
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) await gate;
        return { responseText: "ok", session: mockSession(), aborted: false, steered: false };
      }),
      resume: vi.fn(),
    };
    ({ manager } = createManager({
      runner,
      maxConcurrent: 1,
      onStart: (record) => { startedIds.push(record.id); },
    }));

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "a", {
      description: "a", isBackground: true,
    });
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "b", {
      description: "b", isBackground: true,
    });

    // First agent started immediately
    expect(startedIds).toEqual([id1]);

    // Complete first — second should start and fire onStart
    resolve!();
    await manager.getRecord(id1)!.promise;
    await vi.waitFor(() => expect(startedIds).toHaveLength(2));

    expect(startedIds).toEqual([id1, id2]);

    await manager.getRecord(id2)!.promise;
  });
});
