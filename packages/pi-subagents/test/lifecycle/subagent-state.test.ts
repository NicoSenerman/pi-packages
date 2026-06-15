import { describe, expect, it } from "vitest";
import { SubagentState } from "#src/lifecycle/subagent-state";

describe("SubagentState — constructor", () => {
	it("defaults status to 'queued'", () => {
		const state = new SubagentState();
		expect(state.status).toBe("queued");
	});

	it("defaults startedAt to Date.now() when not provided", () => {
		const before = Date.now();
		const state = new SubagentState();
		const after = Date.now();
		expect(state.startedAt).toBeGreaterThanOrEqual(before);
		expect(state.startedAt).toBeLessThanOrEqual(after);
	});

	it("defaults numeric counters to zero", () => {
		const state = new SubagentState();
		expect(state.toolUses).toBe(0);
		expect(state.compactionCount).toBe(0);
		expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
	});

	it("passes through optional transition fields", () => {
		const state = new SubagentState({
			status: "completed",
			result: "done",
			error: "oops",
			startedAt: 1000,
			completedAt: 2000,
		});
		expect(state.status).toBe("completed");
		expect(state.result).toBe("done");
		expect(state.error).toBe("oops");
		expect(state.startedAt).toBe(1000);
		expect(state.completedAt).toBe(2000);
	});

	it("leaves optional fields undefined when not provided", () => {
		const state = new SubagentState();
		expect(state.result).toBeUndefined();
		expect(state.error).toBeUndefined();
		expect(state.completedAt).toBeUndefined();
	});
});

describe("SubagentState — markRunning", () => {
	it("sets status to 'running' and updates startedAt", () => {
		const state = new SubagentState({ status: "queued", startedAt: 1000 });
		state.markRunning(2000);
		expect(state.status).toBe("running");
		expect(state.startedAt).toBe(2000);
	});
});

describe("SubagentState — markCompleted", () => {
	it("sets status, result, and completedAt", () => {
		const state = new SubagentState({ status: "running" });
		state.markCompleted("all done", 5000);
		expect(state.status).toBe("completed");
		expect(state.result).toBe("all done");
		expect(state.completedAt).toBe(5000);
	});

	it("defaults completedAt to Date.now() when not provided", () => {
		const state = new SubagentState({ status: "running" });
		const before = Date.now();
		state.markCompleted("done");
		const after = Date.now();
		expect(state.completedAt).toBeGreaterThanOrEqual(before);
		expect(state.completedAt).toBeLessThanOrEqual(after);
	});

	it("preserves existing completedAt (??= semantics)", () => {
		const state = new SubagentState({ status: "running", completedAt: 1000 });
		state.markCompleted("done", 9999);
		expect(state.completedAt).toBe(1000);
	});

	it("preserves status when already stopped, but still sets result and completedAt", () => {
		const state = new SubagentState({ status: "stopped", completedAt: 1000 });
		state.markCompleted("late result", 2000);
		expect(state.status).toBe("stopped");
		expect(state.result).toBe("late result");
		expect(state.completedAt).toBe(1000);
	});
});

describe("SubagentState — markAborted", () => {
	it("sets status to 'aborted' with result and completedAt", () => {
		const state = new SubagentState({ status: "running" });
		state.markAborted("partial result", 3000);
		expect(state.status).toBe("aborted");
		expect(state.result).toBe("partial result");
		expect(state.completedAt).toBe(3000);
	});

	it("preserves status when already stopped, but still sets result", () => {
		const state = new SubagentState({ status: "stopped", completedAt: 500 });
		state.markAborted("partial", 2000);
		expect(state.status).toBe("stopped");
		expect(state.result).toBe("partial");
		expect(state.completedAt).toBe(500);
	});
});

describe("SubagentState — markSteered", () => {
	it("sets status to 'steered' with result and completedAt", () => {
		const state = new SubagentState({ status: "running" });
		state.markSteered("redirected", 4000);
		expect(state.status).toBe("steered");
		expect(state.result).toBe("redirected");
		expect(state.completedAt).toBe(4000);
	});

	it("preserves status when already stopped, but still sets result", () => {
		const state = new SubagentState({ status: "stopped", completedAt: 500 });
		state.markSteered("redirected", 2000);
		expect(state.status).toBe("stopped");
		expect(state.result).toBe("redirected");
		expect(state.completedAt).toBe(500);
	});
});

describe("SubagentState — markError", () => {
	it("sets status to 'error' and formats Error objects to .message", () => {
		const state = new SubagentState({ status: "running" });
		state.markError(new Error("something broke"), 6000);
		expect(state.status).toBe("error");
		expect(state.error).toBe("something broke");
		expect(state.completedAt).toBe(6000);
	});

	it("formats non-Error values with String()", () => {
		const state = new SubagentState({ status: "running" });
		state.markError(42, 6000);
		expect(state.error).toBe("42");
	});

	it("preserves status when already stopped, but still sets error and completedAt", () => {
		const state = new SubagentState({ status: "stopped", completedAt: 1000 });
		state.markError(new Error("late error"), 2000);
		expect(state.status).toBe("stopped");
		expect(state.error).toBe("late error");
		expect(state.completedAt).toBe(1000);
	});

	it("preserves existing completedAt (??= semantics)", () => {
		const state = new SubagentState({ status: "running", completedAt: 1000 });
		state.markError(new Error("err"), 9999);
		expect(state.completedAt).toBe(1000);
	});
});

describe("SubagentState — markStopped", () => {
	it("sets status to 'stopped' and completedAt", () => {
		const state = new SubagentState({ status: "running" });
		state.markStopped(7000);
		expect(state.status).toBe("stopped");
		expect(state.completedAt).toBe(7000);
	});

	it("defaults completedAt to Date.now() when not provided", () => {
		const state = new SubagentState({ status: "running" });
		const before = Date.now();
		state.markStopped();
		const after = Date.now();
		expect(state.completedAt).toBeGreaterThanOrEqual(before);
		expect(state.completedAt).toBeLessThanOrEqual(after);
	});

	it("overwrites any previous status — no guard", () => {
		const state = new SubagentState({ status: "completed" });
		state.markStopped(8000);
		expect(state.status).toBe("stopped");
	});
});

describe("SubagentState — incrementToolUses", () => {
	it("starts at 0 and increments by 1 each call", () => {
		const state = new SubagentState();
		expect(state.toolUses).toBe(0);
		state.incrementToolUses();
		expect(state.toolUses).toBe(1);
		state.incrementToolUses();
		expect(state.toolUses).toBe(2);
	});
});

describe("SubagentState — addUsage", () => {
	it("accumulates usage deltas into lifetimeUsage", () => {
		const state = new SubagentState();
		expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
		state.addUsage({ input: 100, output: 50, cacheWrite: 10 });
		expect(state.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });
		state.addUsage({ input: 200, output: 80, cacheWrite: 20 });
		expect(state.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
	});
});

describe("SubagentState — incrementCompactions", () => {
	it("starts at 0 and increments by 1 each call", () => {
		const state = new SubagentState();
		expect(state.compactionCount).toBe(0);
		state.incrementCompactions();
		expect(state.compactionCount).toBe(1);
		state.incrementCompactions();
		expect(state.compactionCount).toBe(2);
	});
});

describe("SubagentState — resetForResume", () => {
	it("sets status to 'running' and new startedAt", () => {
		const state = new SubagentState({ status: "completed", startedAt: 1000 });
		state.resetForResume(9000);
		expect(state.status).toBe("running");
		expect(state.startedAt).toBe(9000);
	});

	it("clears completedAt, result, and error", () => {
		const state = new SubagentState({
			status: "error",
			result: "old result",
			error: "old error",
			completedAt: 5000,
		});
		state.resetForResume(9000);
		expect(state.completedAt).toBeUndefined();
		expect(state.result).toBeUndefined();
		expect(state.error).toBeUndefined();
	});
});
