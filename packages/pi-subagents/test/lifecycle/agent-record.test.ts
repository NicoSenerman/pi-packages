import { describe, expect, it, vi } from "vitest";
import { AgentRecord } from "#src/lifecycle/agent-record";

describe("AgentRecord — constructor", () => {
	it("sets required fields from init", () => {
		const record = new AgentRecord({
			id: "abc-123",
			type: "Explore",
			description: "Find stale TODOs",
		});
		expect(record.id).toBe("abc-123");
		expect(record.type).toBe("Explore");
		expect(record.description).toBe("Find stale TODOs");
	});

	it("defaults status to 'queued'", () => {
		const record = new AgentRecord({
			id: "1",
			type: "general-purpose",
			description: "test",
		});
		expect(record.status).toBe("queued");
	});

	it("defaults numeric counters to zero", () => {
		const record = new AgentRecord({
			id: "1",
			type: "general-purpose",
			description: "test",
		});
		expect(record.toolUses).toBe(0);
		expect(record.compactionCount).toBe(0);
		expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
	});

	it("passes through optional transition fields", () => {
		const record = new AgentRecord({
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
		const controller = new AbortController();
		const record = new AgentRecord({
			id: "1",
			type: "general-purpose",
			description: "test",
			abortController: controller,
			invocation: { modelName: "haiku" },
		});
		expect(record.abortController).toBe(controller);
		expect(record.invocation).toEqual({ modelName: "haiku" });
		// Stats always start at zero — set via mutation methods after construction
		expect(record.toolUses).toBe(0);
		expect(record.compactionCount).toBe(0);
		expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
	});

	it("leaves optional fields undefined when not provided", () => {
		const record = new AgentRecord({
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
});

describe("AgentRecord — markRunning", () => {
	it("sets status to 'running' and updates startedAt", () => {
		const record = new AgentRecord({
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

describe("AgentRecord — markCompleted", () => {
	it("sets status, result, and completedAt", () => {
		const record = new AgentRecord({
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
		const record = new AgentRecord({
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
		const record = new AgentRecord({
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
		const record = new AgentRecord({
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

describe("AgentRecord — markAborted", () => {
	it("sets status to 'aborted' with result and completedAt", () => {
		const record = new AgentRecord({
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
		const record = new AgentRecord({
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

describe("AgentRecord — markSteered", () => {
	it("sets status to 'steered' with result and completedAt", () => {
		const record = new AgentRecord({
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
		const record = new AgentRecord({
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

describe("AgentRecord — markError", () => {
	it("sets status to 'error' and formats Error objects to .message", () => {
		const record = new AgentRecord({
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
		const record = new AgentRecord({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "running",
		});
		record.markError(42, 6000);
		expect(record.error).toBe("42");
	});

	it("preserves status when already stopped, but still sets error and completedAt", () => {
		const record = new AgentRecord({
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
		const record = new AgentRecord({
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

describe("AgentRecord — markStopped", () => {
	it("sets status to 'stopped' and completedAt", () => {
		const record = new AgentRecord({
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
		const record = new AgentRecord({
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
		const record = new AgentRecord({
			id: "1",
			type: "general-purpose",
			description: "test",
			status: "completed",
		});
		record.markStopped(8000);
		expect(record.status).toBe("stopped");
	});
});

describe("AgentRecord — incrementToolUses", () => {
	it("starts at 0 and increments by 1 each call", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
		expect(record.toolUses).toBe(0);
		record.incrementToolUses();
		expect(record.toolUses).toBe(1);
		record.incrementToolUses();
		expect(record.toolUses).toBe(2);
	});
});

describe("AgentRecord — addUsage", () => {
	it("accumulates usage deltas into lifetimeUsage", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
		expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
		record.addUsage({ input: 100, output: 50, cacheWrite: 10 });
		expect(record.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });
		record.addUsage({ input: 200, output: 80, cacheWrite: 20 });
		expect(record.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
	});
});

describe("AgentRecord — incrementCompactions", () => {
	it("starts at 0 and increments by 1 each call", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
		expect(record.compactionCount).toBe(0);
		record.incrementCompactions();
		expect(record.compactionCount).toBe(1);
		record.incrementCompactions();
		expect(record.compactionCount).toBe(2);
	});
});

describe("AgentRecord — resetForResume", () => {
	it("sets status to 'running' and new startedAt", () => {
		const record = new AgentRecord({
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
		const record = new AgentRecord({
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
			const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
			expect(record.session).toBeUndefined();
		});

		it("returns session from execution when set", () => {
			const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
			const fakeSession = {} as any;
			record.execution = { session: fakeSession, outputFile: undefined };
			expect(record.session).toBe(fakeSession);
		});
	});

	describe("outputFile", () => {
		it("returns undefined when execution is not set", () => {
			const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
			expect(record.outputFile).toBeUndefined();
		});

		it("returns outputFile from execution when set", () => {
			const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
			record.execution = { session: {} as any, outputFile: "/path/to/session.jsonl" };
			expect(record.outputFile).toBe("/path/to/session.jsonl");
		});

		it("returns undefined when execution is set but outputFile is undefined", () => {
			const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
			record.execution = { session: {} as any, outputFile: undefined };
			expect(record.outputFile).toBeUndefined();
		});
	});
});

describe("AgentRecord — queueSteer", () => {
	it("buffers a steer message", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
		record.queueSteer("hello");
		record.queueSteer("world");
		expect(record.pendingSteerCount).toBe(2);
	});

	it("starts with an empty steer buffer", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
		expect(record.pendingSteerCount).toBe(0);
	});
});

describe("AgentRecord — abort", () => {
	it("returns false and does nothing when not running", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test", status: "queued" });
		expect(record.abort()).toBe(false);
		expect(record.status).toBe("queued");
	});

	it("fires the AbortController, marks stopped, and returns true when running", () => {
		const abortController = new AbortController();
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test", status: "running", abortController });
		expect(record.abort()).toBe(true);
		expect(abortController.signal.aborted).toBe(true);
		expect(record.status).toBe("stopped");
	});

	it("marks stopped and returns true even without an AbortController", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test", status: "running" });
		expect(record.abort()).toBe(true);
		expect(record.status).toBe("stopped");
	});

	it("returns false when already stopped", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test", status: "stopped" });
		expect(record.abort()).toBe(false);
	});

	it("returns false when completed", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test", status: "completed" });
		expect(record.abort()).toBe(false);
	});
});

describe("AgentRecord — flushPendingSteers", () => {
	it("calls session.steer for each buffered message and clears the buffer", async () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
		record.queueSteer("msg1");
		record.queueSteer("msg2");

		const steered: string[] = [];
		const session = { steer: (m: string) => { steered.push(m); return Promise.resolve(); } };
		record.flushPendingSteers(session as any);

		expect(steered).toEqual(["msg1", "msg2"]);
		expect(record.pendingSteerCount).toBe(0);
	});

	it("does nothing when the buffer is empty", () => {
		const record = new AgentRecord({ id: "1", type: "general-purpose", description: "test" });
		const session = { steer: vi.fn(() => Promise.resolve()) };
		record.flushPendingSteers(session as any);
		expect(session.steer).not.toHaveBeenCalled();
	});
});
