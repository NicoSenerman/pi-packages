import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentLifecycleObserver } from "#src/lifecycle/agent";
import type { AgentRunner, RunResult } from "#src/lifecycle/agent-runner";
import type { WorktreeManager } from "#src/lifecycle/worktree";
import { WorktreeState } from "#src/lifecycle/worktree-state";
import { createMockSession, toAgentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

describe("Agent — constructor", () => {
	it("sets required fields from init", () => {
		const record = new Agent({
			id: "abc-123",
			type: "Explore",
			description: "Find stale TODOs",
		});
		expect(record.id).toBe("abc-123");
		expect(record.type).toBe("Explore");
		expect(record.description).toBe("Find stale TODOs");
	});

	it("defaults status to 'queued'", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
		});
		expect(record.status).toBe("queued");
	});

	it("defaults numeric counters to zero", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
		});
		expect(record.toolUses).toBe(0);
		expect(record.compactionCount).toBe(0);
		expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
	});

	it("passes through optional transition fields", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "completed",
			result: "done",
			error: "oops",
			startedAt: 1000,
			completedAt: 2000,
		});
		expect(record.status).toBe("completed");
		expect(record.result).toBe("done");
		expect(record.error).toBe("oops");
		expect(record.startedAt).toBe(1000);
		expect(record.completedAt).toBe(2000);
	});

	it("passes through optional identity fields", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			invocation: { modelName: "haiku" },
		});
		expect(record.abortController).toBeInstanceOf(AbortController);
		expect(record.invocation).toEqual({ modelName: "haiku" });
		// Stats always start at zero — set via mutation methods after construction
		expect(record.toolUses).toBe(0);
		expect(record.compactionCount).toBe(0);
		expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
	});

	it("leaves optional fields undefined when not provided", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
		});
		expect(record.result).toBeUndefined();
		expect(record.error).toBeUndefined();
		expect(record.completedAt).toBeUndefined();
		expect(record.promise).toBeUndefined();
		expect(record.execution).toBeUndefined();
		expect(record.worktreeState).toBeUndefined();
		expect(record.notification).toBeUndefined();
	});

	it("always creates its own AbortController", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
		});
		expect(record.abortController).toBeInstanceOf(AbortController);
		expect(record.abortController.signal.aborted).toBe(false);
	});

	it("creates NotificationState when parentSession.toolCallId is provided", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			parentSession: { toolCallId: "tc-42" },
		});
		expect(record.notification).toBeDefined();
		expect(record.notification!.toolCallId).toBe("tc-42");
	});

	it("does not create NotificationState when toolCallId is absent", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			parentSession: { parentSessionFile: "/sessions/p.jsonl" },
		});
		expect(record.notification).toBeUndefined();
	});

	it("does not create NotificationState when parentSession is absent", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
		});
		expect(record.notification).toBeUndefined();
	});
});

describe("Agent — markRunning", () => {
	it("sets status to 'running' and updates startedAt", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "queued",
			startedAt: 1000,
		});
		record.markRunning(2000);
		expect(record.status).toBe("running");
		expect(record.startedAt).toBe(2000);
	});
});

describe("Agent — markCompleted", () => {
	it("sets status, result, and completedAt", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		record.markCompleted("all done", 5000);
		expect(record.status).toBe("completed");
		expect(record.result).toBe("all done");
		expect(record.completedAt).toBe(5000);
	});

	it("defaults completedAt to Date.now() when not provided", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		const before = Date.now();
		record.markCompleted("done");
		const after = Date.now();
		expect(record.completedAt).toBeGreaterThanOrEqual(before);
		expect(record.completedAt).toBeLessThanOrEqual(after);
	});

	it("preserves existing completedAt (??= semantics)", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
			completedAt: 1000,
		});
		record.markCompleted("done", 9999);
		expect(record.completedAt).toBe(1000);
	});

	it("preserves status when already stopped, but still sets result and completedAt", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "stopped",
			completedAt: 1000,
		});
		record.markCompleted("late result", 2000);
		expect(record.status).toBe("stopped");
		expect(record.result).toBe("late result");
		// completedAt preserved via ??= — already set to 1000
		expect(record.completedAt).toBe(1000);
	});
});

describe("Agent — markAborted", () => {
	it("sets status to 'aborted' with result and completedAt", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		record.markAborted("partial result", 3000);
		expect(record.status).toBe("aborted");
		expect(record.result).toBe("partial result");
		expect(record.completedAt).toBe(3000);
	});

	it("preserves status when already stopped, but still sets result", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "stopped",
			completedAt: 500,
		});
		record.markAborted("partial", 2000);
		expect(record.status).toBe("stopped");
		expect(record.result).toBe("partial");
		expect(record.completedAt).toBe(500);
	});
});

describe("Agent — markSteered", () => {
	it("sets status to 'steered' with result and completedAt", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		record.markSteered("redirected", 4000);
		expect(record.status).toBe("steered");
		expect(record.result).toBe("redirected");
		expect(record.completedAt).toBe(4000);
	});

	it("preserves status when already stopped, but still sets result", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "stopped",
			completedAt: 500,
		});
		record.markSteered("redirected", 2000);
		expect(record.status).toBe("stopped");
		expect(record.result).toBe("redirected");
		expect(record.completedAt).toBe(500);
	});
});

describe("Agent — markError", () => {
	it("sets status to 'error' and formats Error objects to .message", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		record.markError(new Error("something broke"), 6000);
		expect(record.status).toBe("error");
		expect(record.error).toBe("something broke");
		expect(record.completedAt).toBe(6000);
	});

	it("formats non-Error values with String()", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		record.markError(42, 6000);
		expect(record.error).toBe("42");
	});

	it("preserves status when already stopped, but still sets error and completedAt", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "stopped",
			completedAt: 1000,
		});
		record.markError(new Error("late error"), 2000);
		expect(record.status).toBe("stopped");
		expect(record.error).toBe("late error");
		expect(record.completedAt).toBe(1000);
	});

	it("preserves existing completedAt (??= semantics)", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
			completedAt: 1000,
		});
		record.markError(new Error("err"), 9999);
		expect(record.completedAt).toBe(1000);
	});
});

describe("Agent — markStopped", () => {
	it("sets status to 'stopped' and completedAt", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		record.markStopped(7000);
		expect(record.status).toBe("stopped");
		expect(record.completedAt).toBe(7000);
	});

	it("defaults completedAt to Date.now() when not provided", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		const before = Date.now();
		record.markStopped();
		const after = Date.now();
		expect(record.completedAt).toBeGreaterThanOrEqual(before);
		expect(record.completedAt).toBeLessThanOrEqual(after);
	});

	it("overwrites any previous status — no guard", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "completed",
		});
		record.markStopped(8000);
		expect(record.status).toBe("stopped");
	});
});

describe("Agent — incrementToolUses", () => {
	it("starts at 0 and increments by 1 each call", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		expect(record.toolUses).toBe(0);
		record.incrementToolUses();
		expect(record.toolUses).toBe(1);
		record.incrementToolUses();
		expect(record.toolUses).toBe(2);
	});
});

describe("Agent — addUsage", () => {
	it("accumulates usage deltas into lifetimeUsage", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
		record.addUsage({ input: 100, output: 50, cacheWrite: 10 });
		expect(record.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });
		record.addUsage({ input: 200, output: 80, cacheWrite: 20 });
		expect(record.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
	});
});

describe("Agent — incrementCompactions", () => {
	it("starts at 0 and increments by 1 each call", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		expect(record.compactionCount).toBe(0);
		record.incrementCompactions();
		expect(record.compactionCount).toBe(1);
		record.incrementCompactions();
		expect(record.compactionCount).toBe(2);
	});
});

describe("Agent — resetForResume", () => {
	it("sets status to 'running' and new startedAt", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "completed",
			startedAt: 1000,
		});
		record.resetForResume(9000);
		expect(record.status).toBe("running");
		expect(record.startedAt).toBe(9000);
	});

	it("clears completedAt, result, and error", () => {
		const record = new Agent({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "error",
			result: "old result",
			error: "old error",
			completedAt: 5000,
		});
		record.resetForResume(9000);
		expect(record.completedAt).toBeUndefined();
		expect(record.result).toBeUndefined();
		expect(record.error).toBeUndefined();
	});
});

describe("convenience getters", () => {
	describe("session", () => {
		it("returns undefined when execution is not set", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(record.session).toBeUndefined();
		});

		it("returns session from execution when set", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			const fakeSession = {} as any;
			record.execution = { session: fakeSession, outputFile: undefined };
			expect(record.session).toBe(fakeSession);
		});
	});

	describe("outputFile", () => {
		it("returns undefined when execution is not set", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(record.outputFile).toBeUndefined();
		});

		it("returns outputFile from execution when set", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			record.execution = { session: {} as any, outputFile: "/path/to/session.jsonl" };
			expect(record.outputFile).toBe("/path/to/session.jsonl");
		});

		it("returns undefined when execution is set but outputFile is undefined", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			record.execution = { session: {} as any, outputFile: undefined };
			expect(record.outputFile).toBeUndefined();
		});
	});
});

describe("Agent — queueSteer", () => {
	it("buffers a steer message", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		record.queueSteer("hello");
		record.queueSteer("world");
		expect(record.pendingSteerCount).toBe(2);
	});

	it("starts with an empty steer buffer", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		expect(record.pendingSteerCount).toBe(0);
	});
});

describe("Agent — abort", () => {
	it("returns false and does nothing when not running", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test", status: "queued" });
		expect(record.abort()).toBe(false);
		expect(record.status).toBe("queued");
	});

	it("fires the AbortController, marks stopped, and returns true when running", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test", status: "running" });
		expect(record.abort()).toBe(true);
		expect(record.abortController.signal.aborted).toBe(true);
		expect(record.status).toBe("stopped");
	});

	it("marks stopped and returns true even without an AbortController", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test", status: "running" });
		expect(record.abort()).toBe(true);
		expect(record.status).toBe("stopped");
	});

	it("returns false when already stopped", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test", status: "stopped" });
		expect(record.abort()).toBe(false);
	});

	it("returns false when completed", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test", status: "completed" });
		expect(record.abort()).toBe(false);
	});
});

describe("Agent — setupWorktree", () => {
	it("returns undefined and sets no worktreeState when isolation is not 'worktree'", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		const result = record.setupWorktree();
		expect(result).toBeUndefined();
		expect(record.worktreeState).toBeUndefined();
	});

	it("creates a worktree, sets worktreeState, and returns the path when isolation is 'worktree'", () => {
		const wtInfo = { path: "/tmp/wt", branch: "agent/wt-1" };
		const worktrees = { create: vi.fn(() => wtInfo), cleanup: vi.fn(), prune: vi.fn() };
		const record = new Agent({ id: "wt-1", type: "general-purpose", description: "test", isolation: "worktree", worktrees });
		const result = record.setupWorktree();
		expect(result).toBe("/tmp/wt");
		expect(record.worktreeState).toBeDefined();
		expect(record.worktreeState!.path).toBe("/tmp/wt");
		expect(worktrees.create).toHaveBeenCalledWith("wt-1");
	});

	it("throws when worktree creation fails", () => {
		const worktrees = { create: vi.fn(() => undefined), cleanup: vi.fn(), prune: vi.fn() };
		const record = new Agent({ id: "1", type: "general-purpose", description: "test", isolation: "worktree", worktrees });
		expect(() => record.setupWorktree()).toThrow(/Cannot run with isolation/);
		expect(record.worktreeState).toBeUndefined();
	});

	it("throws when isolation is 'worktree' but worktrees dep is missing", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test", isolation: "worktree" });
		expect(() => record.setupWorktree()).toThrow(/missing worktrees dependency/);
	});
});

describe("Agent — flushPendingSteers", () => {
	it("calls session.steer for each buffered message and clears the buffer", async () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		record.queueSteer("msg1");
		record.queueSteer("msg2");

		const steered: string[] = [];
		const session = { steer: (m: string) => { steered.push(m); return Promise.resolve(); } };
		record.flushPendingSteers(session as any);

		expect(steered).toEqual(["msg1", "msg2"]);
		expect(record.pendingSteerCount).toBe(0);
	});

	it("does nothing when the buffer is empty", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		const session = { steer: vi.fn(() => Promise.resolve()) };
		record.flushPendingSteers(session as any);
		expect(session.steer).not.toHaveBeenCalled();
	});
});

/** Minimal mock worktrees for completeRun / failRun tests. */
function createMockWorktrees(cleanupResult = { hasChanges: false }) {
	return { create: vi.fn(), cleanup: vi.fn(() => cleanupResult), prune: vi.fn() };
}

/** Create an Agent with worktrees dependency for completeRun / failRun tests. */
function createAgentWithWorktrees(overrides?: { worktrees?: ReturnType<typeof createMockWorktrees>; observer?: AgentLifecycleObserver }) {
	const worktrees = overrides?.worktrees ?? createMockWorktrees();
	return {
		record: new Agent({ id: "1", type: "general-purpose", description: "test", status: "running", worktrees, observer: overrides?.observer }),
		worktrees,
	};
}

function createRunResult(overrides?: Partial<RunResult>): RunResult {
	return {
		responseText: "done",
		session: {} as any,
		aborted: false,
		steered: false,
		...overrides,
	};
}

describe("Agent — completeRun", () => {
	it("transitions to completed for a normal result", () => {
		const { record } = createAgentWithWorktrees();
		record.completeRun(createRunResult());
		expect(record.status).toBe("completed");
		expect(record.result).toBe("done");
	});

	it("transitions to aborted when result.aborted is true", () => {
		const { record } = createAgentWithWorktrees();
		record.completeRun(createRunResult({ aborted: true }));
		expect(record.status).toBe("aborted");
	});

	it("transitions to steered when result.steered is true", () => {
		const { record } = createAgentWithWorktrees();
		record.completeRun(createRunResult({ steered: true }));
		expect(record.status).toBe("steered");
	});

	it("performs worktree cleanup and appends branch info to result", () => {
		const worktrees = createMockWorktrees({ hasChanges: true, branch: "pi-agent-x" } as any);
		const { record } = createAgentWithWorktrees({ worktrees });
		record.worktreeState = new WorktreeState({ path: "/tmp/wt", branch: "pi-agent-x" });
		record.completeRun(createRunResult({ responseText: "result" }));
		expect(record.result).toContain("result");
		expect(record.result).toContain("pi-agent-x");
		expect(worktrees.cleanup).toHaveBeenCalledOnce();
	});

	it("updates execution state with session and outputFile", () => {
		const session = { fake: true } as any;
		const { record } = createAgentWithWorktrees();
		record.completeRun(createRunResult({ session, sessionFile: "/tmp/out.jsonl" }));
		expect(record.execution?.session).toBe(session);
		expect(record.execution?.outputFile).toBe("/tmp/out.jsonl");
	});

	it("preserves existing outputFile when sessionFile is undefined", () => {
		const { record } = createAgentWithWorktrees();
		record.execution = { session: {} as any, outputFile: "/existing.jsonl" };
		record.completeRun(createRunResult({ sessionFile: undefined }));
		expect(record.execution.outputFile).toBe("/existing.jsonl");
	});

	it("fires observer.onRunFinished on completion", () => {
		const onRunFinished = vi.fn();
		const { record } = createAgentWithWorktrees({ observer: { onRunFinished } });
		record.completeRun(createRunResult());
		expect(onRunFinished).toHaveBeenCalledOnce();
		expect(onRunFinished).toHaveBeenCalledWith(record);
	});

	it("releases listeners on completion", () => {
		const { record } = createAgentWithWorktrees();
		const unsub = vi.fn();
		record.attachObserver(unsub);
		record.completeRun(createRunResult());
		expect(unsub).toHaveBeenCalledOnce();
	});
});

describe("Agent — failRun", () => {
	it("transitions to error state", () => {
		const { record } = createAgentWithWorktrees();
		record.failRun(new Error("boom"));
		expect(record.status).toBe("error");
		expect(record.error).toBe("boom");
	});

	it("performs best-effort worktree cleanup", () => {
		const worktrees = createMockWorktrees();
		const { record } = createAgentWithWorktrees({ worktrees });
		record.worktreeState = new WorktreeState({ path: "/tmp/wt", branch: "pi-agent-x" });
		record.failRun(new Error("boom"));
		expect(worktrees.cleanup).toHaveBeenCalledOnce();
	});

	it("does not throw when worktree cleanup fails", () => {
		const worktrees = createMockWorktrees();
		worktrees.cleanup.mockImplementation(() => { throw new Error("cleanup failed"); });
		const { record } = createAgentWithWorktrees({ worktrees });
		record.worktreeState = new WorktreeState({ path: "/tmp/wt", branch: "pi-agent-x" });
		expect(() => record.failRun(new Error("boom"))).not.toThrow();
		expect(record.status).toBe("error");
	});

	it("fires observer.onRunFinished on failure", () => {
		const onRunFinished = vi.fn();
		const { record } = createAgentWithWorktrees({ observer: { onRunFinished } });
		record.failRun(new Error("boom"));
		expect(onRunFinished).toHaveBeenCalledOnce();
		expect(onRunFinished).toHaveBeenCalledWith(record);
	});

	it("releases listeners on failure", () => {
		const { record } = createAgentWithWorktrees();
		const unsub = vi.fn();
		record.attachObserver(unsub);
		record.failRun(new Error("boom"));
		expect(unsub).toHaveBeenCalledOnce();
	});
});

describe("Agent — wireSignal", () => {
	it("calls onAbort when the signal fires", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		const controller = new AbortController();
		const onAbort = vi.fn();
		record.wireSignal(controller.signal, onAbort);
		controller.abort();
		expect(onAbort).toHaveBeenCalledOnce();
	});

	it("does nothing when signal is undefined", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		expect(() => record.wireSignal(undefined, vi.fn())).not.toThrow();
	});

	it("releaseListeners detaches the signal listener", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		const controller = new AbortController();
		const onAbort = vi.fn();
		record.wireSignal(controller.signal, onAbort);
		record.releaseListeners();
		controller.abort();
		expect(onAbort).not.toHaveBeenCalled();
	});
});

describe("Agent — attachObserver / releaseListeners", () => {
	it("stores unsub and calls it on releaseListeners", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		const unsub = vi.fn();
		record.attachObserver(unsub);
		record.releaseListeners();
		expect(unsub).toHaveBeenCalledOnce();
	});

	it("is idempotent — second release does not call unsub again", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		const unsub = vi.fn();
		record.attachObserver(unsub);
		record.releaseListeners();
		record.releaseListeners();
		expect(unsub).toHaveBeenCalledOnce();
	});
});

describe("Agent — resetForResume releases listeners", () => {
	it("releases listeners on reset", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test", status: "running" });
		const unsub = vi.fn();
		record.attachObserver(unsub);
		record.markCompleted("done");
		record.resetForResume(Date.now());
		expect(unsub).toHaveBeenCalledOnce();
	});
});

// ── Agent.run() ──────────────────────────────────────────────────────────────

/** Create a mock runner for Agent.run() tests. */
function createMockRunner(overrides?: Partial<AgentRunner>): AgentRunner {
	const session = createMockSession();
	return {
		run: vi.fn((_snapshot, _type, _prompt, opts: { onSessionCreated?: (s: any) => void }) => {
			opts.onSessionCreated?.(toAgentSession(session));
			return Promise.resolve({
				responseText: "done",
				session: toAgentSession(session),
				aborted: false,
				steered: false,
			});
		}) as AgentRunner["run"],
		resume: vi.fn().mockResolvedValue("resumed"),
		...overrides,
	};
}

/** Create a complete Agent ready for run(). */
function createRunnableAgent(overrides?: {
	runner?: AgentRunner;
	worktrees?: WorktreeManager;
	observer?: AgentLifecycleObserver;
	getRunConfig?: () => { defaultMaxTurns: number | undefined; graceTurns: number };
	isolation?: "worktree";
	parentSession?: { toolCallId?: string; parentSessionFile?: string; parentSessionId?: string };
	signal?: AbortSignal;
}) {
	const runner = overrides?.runner ?? createMockRunner();
	const worktrees: WorktreeManager = overrides?.worktrees ?? { create: vi.fn(), cleanup: vi.fn(() => ({ hasChanges: false })), prune: vi.fn() };
	const observer = overrides?.observer ?? {};
	return new Agent({
		id: "run-1",
		type: "general-purpose",
		description: "run test",
		runner,
		worktrees,
		observer,
		snapshot: STUB_SNAPSHOT,
		prompt: "do something",
		getRunConfig: overrides?.getRunConfig,
		isolation: overrides?.isolation,
		parentSession: overrides?.parentSession,
		signal: overrides?.signal,
	});
}

describe("Agent.run() — happy path", () => {
	it("transitions through running → completed", async () => {
		const agent = createRunnableAgent();
		await agent.run();
		expect(agent.status).toBe("completed");
		expect(agent.result).toBe("done");
	});

	it("fires observer callbacks in order: onStarted → onSessionCreated → onRunFinished", async () => {
		const callOrder: string[] = [];
		const observer: AgentLifecycleObserver = {
			onStarted: () => callOrder.push("started"),
			onSessionCreated: () => callOrder.push("sessionCreated"),
			onRunFinished: () => callOrder.push("runFinished"),
		};
		const agent = createRunnableAgent({ observer });
		await agent.run();
		expect(callOrder).toEqual(["started", "sessionCreated", "runFinished"]);
	});

	it("sets execution state with session and outputFile", async () => {
		const agent = createRunnableAgent();
		await agent.run();
		expect(agent.execution).toBeDefined();
		expect(agent.execution!.session).toBeDefined();
	});

	it("flushes pending steers when session is created", async () => {
		const agent = createRunnableAgent();
		agent.queueSteer("hurry up");
		expect(agent.pendingSteerCount).toBe(1);
		await agent.run();
		expect(agent.pendingSteerCount).toBe(0);
	});
});

describe("Agent.run() — worktree", () => {
	it("sets up worktree when isolation is 'worktree'", async () => {
		const worktrees: WorktreeManager = {
			create: vi.fn(() => ({ path: "/tmp/wt", branch: "pi-agent-run-1" })),
			cleanup: vi.fn(() => ({ hasChanges: false })),
			prune: vi.fn(),
		};
		const agent = createRunnableAgent({ worktrees, isolation: "worktree" });
		await agent.run();
		expect(worktrees.create).toHaveBeenCalledWith("run-1");
		expect(agent.worktreeState).toBeDefined();
		expect(worktrees.cleanup).toHaveBeenCalledOnce();
	});

	it("marks error and fires onRunFinished when worktree setup fails", async () => {
		const worktrees: WorktreeManager = {
			create: vi.fn(() => undefined),
			cleanup: vi.fn(() => ({ hasChanges: false })),
			prune: vi.fn(),
		};
		const onRunFinished = vi.fn();
		const agent = createRunnableAgent({ worktrees, isolation: "worktree", observer: { onRunFinished } });
		await agent.run();
		expect(agent.status).toBe("error");
		expect(agent.error).toContain("Cannot run with isolation");
		expect(onRunFinished).toHaveBeenCalledOnce();
	});
});

describe("Agent.run() — error handling", () => {
	it("transitions to error when runner throws", async () => {
		const runner = createMockRunner();
		(runner.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("runner exploded"));
		const agent = createRunnableAgent({ runner });
		await agent.run();
		expect(agent.status).toBe("error");
		expect(agent.error).toBe("runner exploded");
	});

	it("throws when runner is missing", async () => {
		const agent = new Agent({ id: "1", type: "general-purpose", description: "test", snapshot: STUB_SNAPSHOT, prompt: "go" });
		await expect(agent.run()).rejects.toThrow(/missing runner/);
	});
});

describe("Agent.run() — abort signal forwarding", () => {
	it("wires parent signal so aborting it stops the agent", async () => {
		const parentController = new AbortController();
		const runner = createMockRunner({
			run: vi.fn(() => {
				parentController.abort();
				return Promise.reject(new Error("aborted"));
			}),
		});
		const agent = createRunnableAgent({ runner, signal: parentController.signal });
		await agent.run();
		expect(agent.abortController.signal.aborted).toBe(true);
	});
});

describe("Agent.run() — RunConfig threading", () => {
	it("passes defaultMaxTurns and graceTurns to runner.run", async () => {
		const runner = createMockRunner();
		const agent = createRunnableAgent({ runner, getRunConfig: () => ({ defaultMaxTurns: 10, graceTurns: 3 }) });
		await agent.run();
		const runOpts = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0][3];
		expect(runOpts.defaultMaxTurns).toBe(10);
		expect(runOpts.graceTurns).toBe(3);
	});
});
