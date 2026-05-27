import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { AgentManager, type AgentManagerObserver } from "#src/lifecycle/agent-manager";
import type { AgentRunner } from "#src/lifecycle/agent-runner";
import type { WorktreeManager } from "#src/lifecycle/worktree";
import { NotificationState } from "#src/observation/notification-state";
import type { RunConfig } from "#src/runtime";
import type { AgentRecord } from "#src/types";
import { createBlockingRunner, createMockWorktrees, createRunResult, createSessionRunner } from "#test/helpers/manager-stubs";
import { createMockSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

/** Minimal registry with no user agents — sufficient since AgentManager only relays it to the runner. */
const testRegistry = new AgentTypeRegistry(() => new Map());



/** Test helper: construct an AgentManager with injected stubs. */
function createManager(overrides?: {
  runner?: AgentRunner;
  worktrees?: WorktreeManager;
  observer?: Partial<AgentManagerObserver>;
  getMaxConcurrent?: () => number;
  getRunConfig?: () => RunConfig;
}) {
  const runner: AgentRunner = overrides?.runner ?? {
    run: vi.fn().mockResolvedValue({
      responseText: "done",
      session: createMockSession(),
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
  const observer: AgentManagerObserver | undefined = overrides?.observer
    ? {
        onAgentStarted: overrides.observer.onAgentStarted ?? (() => {}),
        onAgentCompleted: overrides.observer.onAgentCompleted ?? (() => {}),
        onAgentCompacted: overrides.observer.onAgentCompacted ?? (() => {}),
        onAgentCreated: overrides.observer.onAgentCreated ?? (() => {}),
      }
    : undefined;
  const manager = new AgentManager({
    runner,
    worktrees,
    exec: vi.fn(),
    registry: testRegistry,
    observer,
    getMaxConcurrent: overrides?.getMaxConcurrent,
    getRunConfig: overrides?.getRunConfig,
  });
  return { manager, runner, worktrees };
}

/** Spawn a background agent using STUB_SNAPSHOT. */
function spawnBg(mgr: AgentManager, prompt = "test", desc = prompt) {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
    isBackground: true,
  });
}

/** Spawn a foreground agent using STUB_SNAPSHOT. */
function spawnFg(mgr: AgentManager, prompt = "test", desc = prompt) {
  return mgr.spawnAndWait(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
  });
}

describe("AgentManager — Bug 1 race condition (notification.resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when markConsumed called after await", async () => {
    let seenConsumed: boolean | undefined;
    ({ manager } = createManager({ observer: { onAgentCompleted: (r) => {
      seenConsumed = r.notification?.resultConsumed;
    } } }));

    const id = spawnBg(manager);
    const record = manager.getRecord(id)!;
    record.notification = new NotificationState("tc-1");

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.notification.markConsumed(); // too late — onComplete already fired

    // onComplete saw resultConsumed as false — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when markConsumed called before await", async () => {
    let seenConsumed: boolean | undefined;
    ({ manager } = createManager({ observer: { onAgentCompleted: (r) => {
      seenConsumed = r.notification?.resultConsumed;
    } } }));

    const id = spawnBg(manager);
    const record = manager.getRecord(id)!;
    record.notification = new NotificationState("tc-1");

    // The fix: pre-mark BEFORE awaiting
    record.notification.markConsumed();
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with no notification when agent was not spawned via tool", async () => {
    let completedRecord: AgentRecord | undefined;
    ({ manager } = createManager({ observer: { onAgentCompleted: (r) => {
      completedRecord = r;
    } } }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.notification).toBeUndefined();
  });

  it("onComplete is not called for foreground agents", async () => {
    let onCompleteCalled = false;
    ({ manager } = createManager({ observer: { onAgentCompleted: () => {
      onCompleteCalled = true;
    } } }));

    await spawnFg(manager);

    expect(onCompleteCalled).toBe(false);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    ({ manager } = createManager({ observer: { onAgentCompleted: () => {
      throw new Error("stale extension context");
    } } }));

    const id = spawnBg(manager);
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("does not keep the process alive on its own", () => {
    ({ manager } = createManager());

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    ({ manager } = createManager());

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=1 to keep second agent queued; runner never resolves
    const runner = createBlockingRunner();
    ({ manager } = createManager({ getMaxConcurrent: () => 1, runner }));

    const id1 = spawnBg(manager, "test1", "running agent");
    // Second agent should be queued (limit=1)
    const id2 = spawnBg(manager, "test2", "queued agent");

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
    const sess = createMockSession({ dispose: disposeSpy });
    const runner: AgentRunner = {
      run: vi.fn().mockResolvedValue(createRunResult(sess)),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner }));

    const id = spawnBg(manager);
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

    const id = spawnBg(manager);
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
    manager.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    // Runner never resolves — we just want to inspect the record at spawn time.
    const runner = createBlockingRunner();
    ({ manager } = createManager({ runner }));

    const id = spawnBg(manager);
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("record observer accumulates assistant usage into record.lifetimeUsage", async () => {
    // The record observer subscribes to session events via onSessionCreated.
    // Emitting message_end events through the mock session drives stats.
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
        const session = createMockSession();
        opts.onSessionCreated?.(session);
        session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } } });
        session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } } });
        return { responseText: "done", session, aborted: false, steered: false };
      }),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("record observer increments compactionCount on compaction_end events", async () => {
    const compactSeen: any[] = [];

    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
        const session = createMockSession();
        opts.onSessionCreated?.(session);
        // Compaction fires while the agent is still running — the record passed to
        // onCompact should reflect the just-incremented count.
        session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 12345 }, reason: "threshold" });
        session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 22222 }, reason: "manual" });
        return { responseText: "done", session, aborted: false, steered: false };
      }),
      resume: vi.fn(),
    };

    ({ manager } = createManager({ runner, observer: { onAgentCompacted: (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    } } }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    // First, spawn with a subscribable session that resume can latch onto
    const session = createMockSession();
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
        opts.onSessionCreated?.(session);
        return { responseText: "first", session, aborted: false, steered: false };
      }),
      resume: vi.fn().mockImplementation(async (_session: any, _prompt: any) => {
        // Emit events through the session — the record observer subscribed by
        // AgentManager.resume() will pick them up.
        session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 70, output: 30, cacheWrite: 5 } } });
        session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 999 }, reason: "overflow" });
        return "second";
      }),
    };
    ({ manager } = createManager({ runner }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't emit usage events)
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
    manager.dispose();
  });

  it("passes defaultMaxTurns and graceTurns from getRunConfig to runAgent", async () => {
    const getRunConfig = vi.fn(() => ({ defaultMaxTurns: 10, graceTurns: 3 }));
    let runner: AgentRunner;
    ({ manager, runner } = createManager({ getRunConfig }));

    spawnBg(manager);

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());

    const runOpts = vi.mocked(runner.run).mock.calls[0][3];
    expect(runOpts.defaultMaxTurns).toBe(10);
    expect(runOpts.graceTurns).toBe(3);
    expect(runOpts.context.exec).toBeDefined();
    expect(runOpts.context.registry).toBeDefined();
  });

  it("omits defaultMaxTurns and graceTurns from runAgent when no getRunConfig is provided", async () => {
    let runner: AgentRunner;
    ({ manager, runner } = createManager());

    spawnBg(manager);

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());

    const runOpts = vi.mocked(runner.run).mock.calls[0][3];
    expect(runOpts.defaultMaxTurns).toBeUndefined();
    expect(runOpts.graceTurns).toBeUndefined();
    expect(runOpts.context.exec).toBeDefined();
    expect(runOpts.context.registry).toBeDefined();
  });
});

describe("AgentManager — parent session threading", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("threads parentSession from AgentSpawnConfig to RunOptions", async () => {
    let runner: AgentRunner;
    ({ manager, runner } = createManager());

    manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test",
      isBackground: true,
      parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "parent-session-123" },
    });

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());

    const runOpts = vi.mocked(runner.run).mock.calls[0][3];
    expect(runOpts.context.parentSession?.parentSessionFile).toBe("/sessions/parent.jsonl");
    expect(runOpts.context.parentSession?.parentSessionId).toBe("parent-session-123");
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
    manager.dispose();
  });

  it("spawn() throws when worktrees.create returns undefined; no orphan record left behind", async () => {
    const worktrees = createMockWorktrees({ createResult: undefined });
    const runner: AgentRunner = {
      run: vi.fn(),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner, worktrees }));
    expect(() => manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
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
    manager.dispose();
  });

  it("calls injected runner.run when spawning an agent", async () => {
    let runner: AgentRunner;
    ({ manager, runner } = createManager());

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(runner.run).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.result).toBe("done");
  });

  it("calls injected runner.resume when resuming an agent", async () => {
    const session = createMockSession();
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

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    await manager.resume(id, "continue");

    expect(runner.resume).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.result).toBe("second");
  });

  it("calls worktrees.create for worktree isolation", async () => {
    const worktrees = createMockWorktrees();
    ({ manager } = createManager({ worktrees }));

    manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
      isBackground: true,
    });

    expect(worktrees.create).toHaveBeenCalledOnce();
  });

  it("calls worktrees.cleanup after agent completes with a worktree", async () => {
    const worktrees = createMockWorktrees();
    ({ manager } = createManager({ worktrees }));

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(worktrees.cleanup).toHaveBeenCalledOnce();
  });

  it("sets record.worktreeState with path and branch from worktrees.create", async () => {
    const worktrees = createMockWorktrees();
    ({ manager } = createManager({ worktrees }));

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    const record = manager.getRecord(id)!;
    expect(record.worktreeState).toBeDefined();
    expect(record.worktreeState!.path).toBe("/tmp/wt");
    expect(record.worktreeState!.branch).toBe("pi-agent-x");
  });

  it("records cleanup result on worktreeState after completion", async () => {
    const worktrees = createMockWorktrees({ cleanupResult: { hasChanges: true, branch: "pi-agent-x" } });
    ({ manager } = createManager({ worktrees }));

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    const record = manager.getRecord(id)!;
    expect(record.worktreeState!.cleanupResult).toEqual({ hasChanges: true, branch: "pi-agent-x" });
  });
});

describe("AgentManager — queueing and concurrency with injected stubs", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("queues excess background agents and drains them in order", async () => {
    const startOrder: string[] = [];
    const { promise: gate1, resolve: resolve1 } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    const { promise: gate2, resolve: resolve2 } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

    let callCount = 0;
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        const n = callCount;
        startOrder.push(`start-${n}`);
        if (n === 1) await gate1;
        if (n === 2) await gate2;
        return { responseText: `result-${n}`, session: createMockSession(), aborted: false, steered: false };
      }),
      resume: vi.fn(),
    };
    ({ manager } = createManager({ runner, getMaxConcurrent: () => 1 }));

    // Spawn two background agents — first runs, second queues
    const id1 = spawnBg(manager, "test1", "first");
    const id2 = spawnBg(manager, "test2", "second");

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    // Complete first agent — second should start
    resolve1();
    await manager.getRecord(id1)!.promise;

    // Wait for the second to start
    await vi.waitFor(() => expect(manager.getRecord(id2)!.status).toBe("running"));

    resolve2();
    await manager.getRecord(id2)!.promise;

    expect(startOrder).toEqual(["start-1", "start-2"]);
    expect(manager.getRecord(id1)!.result).toBe("result-1");
    expect(manager.getRecord(id2)!.result).toBe("result-2");
  });

  it("abort removes a queued agent without ever running it", () => {
    const runner = createBlockingRunner();
    ({ manager } = createManager({ runner, getMaxConcurrent: () => 1 }));

    // First runs, second queues
    const id1 = spawnBg(manager, "a");
    const id2 = spawnBg(manager, "b");

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
    const { promise: gate, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

    let callCount = 0;
    const runner: AgentRunner = {
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) await gate;
        return { responseText: "ok", session: createMockSession(), aborted: false, steered: false };
      }),
      resume: vi.fn(),
    };
    ({ manager } = createManager({
      runner,
      getMaxConcurrent: () => 1,
      observer: { onAgentStarted: (record) => { startedIds.push(record.id); } },
    }));

    const id1 = spawnBg(manager, "a");
    const id2 = spawnBg(manager, "b");

    // First agent started immediately
    expect(startedIds).toEqual([id1]);

    // Complete first — second should start and fire onStart
    resolve();
    await manager.getRecord(id1)!.promise;
    await vi.waitFor(() => expect(startedIds).toHaveLength(2));

    expect(startedIds).toEqual([id1, id2]);

    await manager.getRecord(id2)!.promise;
  });
});

describe("AgentManager — execution state", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("sets record.execution with session and outputFile after session creation", async () => {
    const session = createMockSession();
    session.sessionManager.getSessionFile.mockReturnValue("/tmp/session.jsonl");
    const runner = createSessionRunner(session);
    ({ manager } = createManager({ runner }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    const record = manager.getRecord(id)!;
    expect(record.execution).toBeDefined();
    expect(record.execution!.session).toBe(session);
    expect(record.execution!.outputFile).toBe("/tmp/session.jsonl");
  });

  it("record.execution is undefined before the session is created", () => {
    const runner = createBlockingRunner();
    ({ manager } = createManager({ runner }));

    const id = spawnBg(manager);
    const record = manager.getRecord(id)!;
    expect(record.execution).toBeUndefined();
    manager.abort(id);
  });
});


describe("AgentManager — onAgentCreated observer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("fires onAgentCreated when a background agent is spawned", () => {
    const onCreated = vi.fn();
    ({ manager } = createManager({ observer: { onAgentCreated: onCreated } }));

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test agent",
      isBackground: true,
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(manager.getRecord(id));

    manager.abort(id);
  });

  it("does not fire onAgentCreated for foreground agents", async () => {
    const onCreated = vi.fn();
    ({ manager } = createManager({ observer: { onAgentCreated: onCreated } }));

    await manager.spawnAndWait(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "foreground agent",
    });

    expect(onCreated).not.toHaveBeenCalled();
  });

  it("fires onAgentCreated before onAgentStarted for background agents", async () => {
    const callOrder: string[] = [];
    ({ manager } = createManager({
      observer: {
        onAgentCreated: () => { callOrder.push("created"); },
        onAgentStarted: () => { callOrder.push("started"); },
      },
    }));

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "bg agent",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(callOrder).toEqual(["created", "started"]);
  });
});

describe("AgentManager — onSessionCreated callback receives record", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("passes record as second argument to onSessionCreated callback", async () => {
    const session = createMockSession();
    const received: { record: AgentRecord | undefined } = { record: undefined };
    const runner = createSessionRunner(session);
    ({ manager } = createManager({ runner }));

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test",
      isBackground: true,
      onSessionCreated: (_session, record) => {
        received.record = record;
      },
    });
    await manager.getRecord(id)!.promise;

    expect(received.record).toBe(manager.getRecord(id));
    expect(received.record!.id).toBe(id);
  });

  it("passes record to foreground onSessionCreated callback", async () => {
    const session = createMockSession();
    const received: { record: AgentRecord | undefined } = { record: undefined };
    const runner = createSessionRunner(session);
    ({ manager } = createManager({ runner }));

    await manager.spawnAndWait(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "fg",
      onSessionCreated: (_session, record) => {
        received.record = record;
      },
    });

    expect(received.record).toBeDefined();
    expect(received.record!.type).toBe("general-purpose");
  });
});

describe("AgentManager — toolCallId notification wiring", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("wires NotificationState on spawn when toolCallId is provided", () => {
    ({ manager } = createManager());

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "bg",
      isBackground: true,
      parentSession: { toolCallId: "tc-42" },
    });
    const record = manager.getRecord(id)!;

    expect(record.notification).toBeInstanceOf(NotificationState);
    expect(record.notification!.toolCallId).toBe("tc-42");
    expect(record.notification!.resultConsumed).toBe(false);
    manager.abort(id);
  });

  it("does not wire NotificationState when toolCallId is absent", () => {
    ({ manager } = createManager());

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "bg",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.notification).toBeUndefined();
    manager.abort(id);
  });
});
