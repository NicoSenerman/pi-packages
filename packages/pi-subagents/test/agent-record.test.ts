import { describe, expect, it } from "vitest";
import { AgentRecord } from "../src/agent-record.js";

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

	it("passes through optional non-transition fields", () => {
		const controller = new AbortController();
		const record = new AgentRecord({
			id: "1",
			type: "general-purpose",
			description: "test",
			toolUses: 5,
			compactionCount: 2,
			lifetimeUsage: { input: 100, output: 50, cacheWrite: 10 },
			abortController: controller,
			invocation: { modelName: "haiku" },
		});
		expect(record.toolUses).toBe(5);
		expect(record.compactionCount).toBe(2);
		expect(record.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });
		expect(record.abortController).toBe(controller);
		expect(record.invocation).toEqual({ modelName: "haiku" });
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
		expect(record.session).toBeUndefined();
		expect(record.promise).toBeUndefined();
		expect(record.worktree).toBeUndefined();
		expect(record.outputFile).toBeUndefined();
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
