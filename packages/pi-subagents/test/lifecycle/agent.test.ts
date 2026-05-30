import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentLifecycleObserver } from "#src/lifecycle/agent";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import type { Workspace, WorkspaceProvider } from "#src/lifecycle/workspace";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

type SessionFactory = (params: CreateSubagentSessionParams) => Promise<SubagentSession>;

/** Build a factory plus the SubagentSession stub it resolves to. */
function createFactory(): { factory: SessionFactory; stub: ReturnType<typeof createSubagentSessionStub> } {
	const stub = createSubagentSessionStub();
	const factory = vi.fn(async (_params: CreateSubagentSessionParams) => toSubagentSession(stub));
	return { factory, stub };
}

/** A factory resolving to a default (done) SubagentSession stub. */
function defaultFactory(): SessionFactory {
	return createFactory().factory;
}

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
		expect(record.subagentSession).toBeUndefined();
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
		it("returns undefined when subagentSession is not set", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(record.session).toBeUndefined();
		});

		it("returns session from subagentSession when set", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			const session = createMockSession();
			record.subagentSession = toSubagentSession(createSubagentSessionStub(session));
			expect(record.session).toBe(session);
		});
	});

	describe("outputFile", () => {
		it("returns undefined when subagentSession is not set", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(record.outputFile).toBeUndefined();
		});

		it("returns outputFile from subagentSession when set", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession(), "/path/to/session.jsonl"));
			expect(record.outputFile).toBe("/path/to/session.jsonl");
		});

		it("returns undefined when subagentSession is set but outputFile is undefined", () => {
			const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
			record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
			expect(record.outputFile).toBeUndefined();
		});
	});
});

describe("Agent — session-encapsulation methods", () => {
	describe("isSessionReady", () => {
		it("returns false when no subagentSession", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(agent.isSessionReady()).toBe(false);
		});

		it("returns true when subagentSession is set", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			agent.subagentSession = toSubagentSession(createSubagentSessionStub());
			expect(agent.isSessionReady()).toBe(true);
		});
	});

	describe("steer", () => {
		it("buffers message and returns false when session not ready", async () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			const delivered = await agent.steer("hello");
			expect(delivered).toBe(false);
			expect(agent.pendingSteerCount).toBe(1);
		});

		it("delivers message to session and returns true when session is ready", async () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			const stub = createSubagentSessionStub();
			agent.subagentSession = toSubagentSession(stub);
			const delivered = await agent.steer("go faster");
			expect(delivered).toBe(true);
			expect(stub.steer).toHaveBeenCalledWith("go faster");
			expect(agent.pendingSteerCount).toBe(0);
		});
	});

	describe("getConversation", () => {
		it("returns undefined when no session", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(agent.getConversation()).toBeUndefined();
		});

		it("delegates to SubagentSession.getConversation when session is ready", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			const stub = createSubagentSessionStub();
			stub.getConversation.mockReturnValue("[User]: hi");
			agent.subagentSession = toSubagentSession(stub);
			expect(agent.getConversation()).toBe("[User]: hi");
		});
	});

	describe("getContextPercent", () => {
		it("returns null when no session", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(agent.getContextPercent()).toBeNull();
		});

		it("delegates to SubagentSession.getContextPercent when session is ready", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			const stub = createSubagentSessionStub();
			stub.getContextPercent.mockReturnValue(55);
			agent.subagentSession = toSubagentSession(stub);
			expect(agent.getContextPercent()).toBe(55);
		});
	});

	describe("subscribeToUpdates", () => {
		it("returns undefined when no session", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(agent.subscribeToUpdates(vi.fn())).toBeUndefined();
		});

		it("delegates to SubagentSession.subscribe when session is ready", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			const stub = createSubagentSessionStub();
			agent.subagentSession = toSubagentSession(stub);
			const fn = vi.fn();
			const unsub = agent.subscribeToUpdates(fn);
			expect(stub.subscribe).toHaveBeenCalledWith(fn);
			expect(typeof unsub).toBe("function");
		});
	});

	describe("messages", () => {
		it("returns empty array when no session", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			expect(agent.messages).toEqual([]);
		});

		it("delegates to SubagentSession.messages when session is ready", () => {
			const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
			const session = createMockSession();
			session.messages.push({ role: "user", content: "hi" });
			const stub = createSubagentSessionStub(session);
			agent.subagentSession = toSubagentSession(stub);
			expect(agent.messages).toEqual([{ role: "user", content: "hi" }]);
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

describe("Agent — flushPendingSteers", () => {
	it("delegates each buffered message to subagentSession.steer and clears the buffer", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		record.queueSteer("msg1");
		record.queueSteer("msg2");

		const stub = createSubagentSessionStub();
		record.subagentSession = toSubagentSession(stub);
		record.flushPendingSteers();

		expect(stub.steer.mock.calls.map((c) => c[0])).toEqual(["msg1", "msg2"]);
		expect(record.pendingSteerCount).toBe(0);
	});

	it("does nothing when the buffer is empty", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		const stub = createSubagentSessionStub();
		record.subagentSession = toSubagentSession(stub);
		record.flushPendingSteers();
		expect(stub.steer).not.toHaveBeenCalled();
	});
});

/** Create an Agent for completeRun / failRun tests. */
function createCompletionAgent(overrides?: { observer?: AgentLifecycleObserver }) {
	return {
		record: new Agent({ id: "1", type: "general-purpose", description: "test", status: "running", observer: overrides?.observer }),
	};
}

function createTurnLoopResult(overrides?: Partial<TurnLoopResult>): TurnLoopResult {
	return {
		responseText: "done",
		aborted: false,
		steered: false,
		...overrides,
	};
}

describe("Agent — completeRun", () => {
	it("transitions to completed for a normal result", () => {
		const { record } = createCompletionAgent();
		record.completeRun(createTurnLoopResult());
		expect(record.status).toBe("completed");
		expect(record.result).toBe("done");
	});

	it("transitions to aborted when result.aborted is true", () => {
		const { record } = createCompletionAgent();
		record.completeRun(createTurnLoopResult({ aborted: true }));
		expect(record.status).toBe("aborted");
	});

	it("transitions to steered when result.steered is true", () => {
		const { record } = createCompletionAgent();
		record.completeRun(createTurnLoopResult({ steered: true }));
		expect(record.status).toBe("steered");
	});

	it("fires observer.onRunFinished on completion", () => {
		const onRunFinished = vi.fn();
		const { record } = createCompletionAgent({ observer: { onRunFinished } });
		record.completeRun(createTurnLoopResult());
		expect(onRunFinished).toHaveBeenCalledOnce();
		expect(onRunFinished).toHaveBeenCalledWith(record);
	});

	it("releases listeners on completion", () => {
		const { record } = createCompletionAgent();
		const unsub = vi.fn();
		record.attachObserver(unsub);
		record.completeRun(createTurnLoopResult());
		expect(unsub).toHaveBeenCalledOnce();
	});
});

describe("Agent — failRun", () => {
	it("transitions to error state", () => {
		const { record } = createCompletionAgent();
		record.failRun(new Error("boom"));
		expect(record.status).toBe("error");
		expect(record.error).toBe("boom");
	});

	it("fires observer.onRunFinished on failure", () => {
		const onRunFinished = vi.fn();
		const { record } = createCompletionAgent({ observer: { onRunFinished } });
		record.failRun(new Error("boom"));
		expect(onRunFinished).toHaveBeenCalledOnce();
		expect(onRunFinished).toHaveBeenCalledWith(record);
	});

	it("releases listeners on failure", () => {
		const { record } = createCompletionAgent();
		const unsub = vi.fn();
		record.attachObserver(unsub);
		record.failRun(new Error("boom"));
		expect(unsub).toHaveBeenCalledOnce();
	});
});

describe("Agent — disposeSession", () => {
	it("disposes the wrapped SubagentSession", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		const stub = createSubagentSessionStub();
		record.subagentSession = toSubagentSession(stub);
		record.disposeSession();
		expect(stub.dispose).toHaveBeenCalledOnce();
	});

	it("is a no-op when no session was created", () => {
		const record = new Agent({ id: "1", type: "general-purpose", description: "test" });
		expect(() => record.disposeSession()).not.toThrow();
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

/** Create a complete Agent ready for run(). */
function createRunnableAgent(overrides?: {
	createSubagentSession?: SessionFactory;
	observer?: AgentLifecycleObserver;
	getRunConfig?: () => { defaultMaxTurns: number | undefined; graceTurns: number };
	parentSession?: { toolCallId?: string; parentSessionFile?: string; parentSessionId?: string };
	signal?: AbortSignal;
	baseCwd?: string;
	workspaceProvider?: WorkspaceProvider;
}) {
	const createSubagentSession = overrides?.createSubagentSession ?? defaultFactory();
	const observer = overrides?.observer ?? {};
	const provider = overrides?.workspaceProvider;
	return new Agent({
		id: "run-1",
		type: "general-purpose",
		description: "run test",
		createSubagentSession,
		observer,
		snapshot: STUB_SNAPSHOT,
		prompt: "do something",
		getRunConfig: overrides?.getRunConfig,
		parentSession: overrides?.parentSession,
		signal: overrides?.signal,
		baseCwd: overrides?.baseCwd ?? "/base",
		getWorkspaceProvider: provider ? () => provider : undefined,
	});
}

/** Build a Workspace with a recorded dispose. */
function makeWorkspace(cwd: string, disposeResult?: { resultAddendum?: string }): Workspace {
	return { cwd, dispose: vi.fn(() => disposeResult) };
}

/** Build a WorkspaceProvider whose prepare resolves to the given workspace. */
function makeWorkspaceProvider(workspace: Workspace | undefined): WorkspaceProvider {
	return { prepare: vi.fn(async () => workspace) };
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

	it("sets the subagentSession with a session", async () => {
		const agent = createRunnableAgent();
		await agent.run();
		expect(agent.subagentSession).toBeDefined();
		expect(agent.subagentSession!.session).toBeDefined();
	});

	it("flushes pending steers when session is created", async () => {
		const agent = createRunnableAgent();
		agent.queueSteer("hurry up");
		expect(agent.pendingSteerCount).toBe(1);
		await agent.run();
		expect(agent.pendingSteerCount).toBe(0);
	});
});

describe("Agent.run() — workspace provider", () => {
	it("prepares the workspace and threads its cwd into the factory params", async () => {
		const { factory } = createFactory();
		const provider = makeWorkspaceProvider(makeWorkspace("/ws/dir"));
		const agent = createRunnableAgent({ createSubagentSession: factory, workspaceProvider: provider });
		await agent.run();
		const params = (factory as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(params.cwd).toBe("/ws/dir");
	});

	it("calls prepare with the run-start context", async () => {
		const provider = makeWorkspaceProvider(makeWorkspace("/ws/dir"));
		const agent = createRunnableAgent({ workspaceProvider: provider, baseCwd: "/parent" });
		await agent.run();
		expect(provider.prepare).toHaveBeenCalledWith({
			agentId: "run-1",
			agentType: "general-purpose",
			baseCwd: "/parent",
			invocation: undefined,
		});
	});

	it("appends the dispose resultAddendum to the result", async () => {
		const workspace = makeWorkspace("/ws/dir", { resultAddendum: "\n\n---\nsaved to branch foo" });
		const agent = createRunnableAgent({ workspaceProvider: makeWorkspaceProvider(workspace) });
		await agent.run();
		expect(agent.result).toBe("done\n\n---\nsaved to branch foo");
		expect(workspace.dispose).toHaveBeenCalledWith({ status: "completed", description: "run test" });
	});

	it("falls back to baseCwd (cwd undefined) when prepare returns undefined", async () => {
		const { factory } = createFactory();
		const provider = makeWorkspaceProvider(undefined);
		const agent = createRunnableAgent({ createSubagentSession: factory, workspaceProvider: provider });
		await agent.run();
		const params = (factory as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(params.cwd).toBeUndefined();
		expect(agent.status).toBe("completed");
	});

	it("marks error and fires onRunFinished when prepare rejects", async () => {
		const onRunFinished = vi.fn();
		const provider: WorkspaceProvider = { prepare: vi.fn(() => Promise.reject(new Error("prepare failed"))) };
		const agent = createRunnableAgent({ workspaceProvider: provider, observer: { onRunFinished } });
		await agent.run();
		expect(agent.status).toBe("error");
		expect(agent.error).toBe("prepare failed");
		expect(onRunFinished).toHaveBeenCalledOnce();
	});

	it("disposes with status error when the turn loop throws", async () => {
		const { factory, stub } = createFactory();
		stub.runTurnLoop.mockRejectedValue(new Error("turn loop exploded"));
		const workspace = makeWorkspace("/ws/dir", { resultAddendum: "\nshould be discarded" });
		const agent = createRunnableAgent({ createSubagentSession: factory, workspaceProvider: makeWorkspaceProvider(workspace) });
		await agent.run();
		expect(agent.status).toBe("error");
		expect(workspace.dispose).toHaveBeenCalledWith({ status: "error", description: "run test" });
		expect(agent.result).toBeUndefined();
	});
});

describe("Agent.run() — error handling", () => {
	it("transitions to error when the turn loop throws", async () => {
		const { factory, stub } = createFactory();
		stub.runTurnLoop.mockRejectedValue(new Error("turn loop exploded"));
		const agent = createRunnableAgent({ createSubagentSession: factory });
		await agent.run();
		expect(agent.status).toBe("error");
		expect(agent.error).toBe("turn loop exploded");
	});

	it("transitions to error when the factory throws", async () => {
		const factory: SessionFactory = vi.fn().mockRejectedValue(new Error("creation failed"));
		const agent = createRunnableAgent({ createSubagentSession: factory });
		await agent.run();
		expect(agent.status).toBe("error");
		expect(agent.error).toBe("creation failed");
	});

	it("throws when the session factory is missing", async () => {
		const agent = new Agent({ id: "1", type: "general-purpose", description: "test", snapshot: STUB_SNAPSHOT, prompt: "go" });
		await expect(agent.run()).rejects.toThrow(/missing session factory/);
	});
});

describe("Agent.run() — abort signal forwarding", () => {
	it("wires parent signal so aborting it stops the agent", async () => {
		const parentController = new AbortController();
		const { factory, stub } = createFactory();
		stub.runTurnLoop.mockImplementation(() => {
			parentController.abort();
			return Promise.reject(new Error("aborted"));
		});
		const agent = createRunnableAgent({ createSubagentSession: factory, signal: parentController.signal });
		await agent.run();
		expect(agent.abortController.signal.aborted).toBe(true);
	});
});

describe("Agent.run() — RunConfig threading", () => {
	it("passes defaultMaxTurns and graceTurns to runTurnLoop", async () => {
		const { factory, stub } = createFactory();
		const agent = createRunnableAgent({ createSubagentSession: factory, getRunConfig: () => ({ defaultMaxTurns: 10, graceTurns: 3 }) });
		await agent.run();
		const turnOpts = stub.runTurnLoop.mock.calls[0][1];
		expect(turnOpts.defaultMaxTurns).toBe(10);
		expect(turnOpts.graceTurns).toBe(3);
	});
});

// ── Agent.resume() ─────────────────────────────────────────────────────────────

/** Create an Agent with a SubagentSession already attached, ready for resume(). */
function createResumableAgent(overrides?: {
	observer?: AgentLifecycleObserver;
	session?: ReturnType<typeof createMockSession>;
	stub?: ReturnType<typeof createSubagentSessionStub>;
}) {
	const session = overrides?.session ?? createMockSession();
	const stub = overrides?.stub ?? createSubagentSessionStub(session);
	const agent = new Agent({
		id: "resume-1",
		type: "general-purpose",
		description: "resume test",
		status: "completed",
		result: "first",
		observer: overrides?.observer ?? {},
	});
	agent.subagentSession = toSubagentSession(stub);
	return { agent, session, stub };
}

describe("Agent.resume() — happy path", () => {
	it("transitions to completed and sets result from the resume response", async () => {
		const { agent } = createResumableAgent();
		await agent.resume("continue");
		expect(agent.status).toBe("completed");
		expect(agent.result).toBe("resumed");
	});

	it("passes the prompt and signal straight through to resumeTurnLoop", async () => {
		const { agent, stub } = createResumableAgent();
		const signal = new AbortController().signal;
		await agent.resume("continue", signal);
		expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
		expect(stub.resumeTurnLoop.mock.calls[0][0]).toBe("continue");
		expect(stub.resumeTurnLoop.mock.calls[0][1]).toBe(signal);
	});

	it("resets transition state before resuming", async () => {
		const { agent } = createResumableAgent();
		await agent.resume("continue");
		expect(agent.error).toBeUndefined();
	});
});

describe("Agent.resume() — observer lifecycle", () => {
	it("accumulates usage and compactions from session events during resume", async () => {
		const session = createMockSession();
		const stub = createSubagentSessionStub(session);
		stub.resumeTurnLoop.mockImplementation(async () => {
			session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 70, output: 30, cacheWrite: 5 } } });
			session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 999 }, reason: "overflow" });
			return "second";
		});
		const { agent } = createResumableAgent({ session, stub });
		await agent.resume("more");
		expect(agent.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
		expect(agent.compactionCount).toBe(1);
	});

	it("forwards compaction events through observer.onCompacted", async () => {
		const session = createMockSession();
		const seen: Array<{ reason: string; tokensBefore: number }> = [];
		const observer: AgentLifecycleObserver = {
			onCompacted: (_agent, info) => seen.push({ reason: info.reason, tokensBefore: info.tokensBefore }),
		};
		const stub = createSubagentSessionStub(session);
		stub.resumeTurnLoop.mockImplementation(async () => {
			session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 123 }, reason: "threshold" });
			return "second";
		});
		const { agent } = createResumableAgent({ observer, session, stub });
		await agent.resume("more");
		expect(seen).toEqual([{ reason: "threshold", tokensBefore: 123 }]);
	});

	it("releases the observer subscription after resume completes", async () => {
		const session = createMockSession();
		const { agent } = createResumableAgent({ session });
		await agent.resume("more");
		// Events emitted after resume must not accumulate — subscription released.
		session.emit({ type: "tool_execution_end" });
		expect(agent.toolUses).toBe(0);
	});
});

describe("Agent.resume() — error handling", () => {
	it("transitions to error without throwing when resumeTurnLoop rejects", async () => {
		const stub = createSubagentSessionStub();
		stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
		const { agent } = createResumableAgent({ stub });
		await agent.resume("more");
		expect(agent.status).toBe("error");
		expect(agent.error).toBe("resume exploded");
	});

	it("releases the observer subscription after resume errors", async () => {
		const session = createMockSession();
		const stub = createSubagentSessionStub(session);
		stub.resumeTurnLoop.mockRejectedValue(new Error("boom"));
		const { agent } = createResumableAgent({ session, stub });
		await agent.resume("more");
		session.emit({ type: "tool_execution_end" });
		expect(agent.toolUses).toBe(0);
	});

	it("throws when no session exists", async () => {
		const agent = new Agent({ id: "1", type: "general-purpose", description: "test" });
		await expect(agent.resume("more")).rejects.toThrow(/missing session/);
	});
});
