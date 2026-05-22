import { describe, expect, it, vi } from "vitest";
import type { BackgroundDeps } from "../../src/tools/background-spawner.js";
import type { ForegroundDeps } from "../../src/tools/foreground-runner.js";
import { AgentActivityTracker } from "../../src/ui/agent-activity-tracker.js";
import { createToolDeps } from "./make-deps.js";
import { STUB_CTX } from "./stub-ctx.js";

describe("createToolDeps", () => {
	describe("manager defaults", () => {
		it("spawn returns 'agent-1'", () => {
			const { manager } = createToolDeps();
			expect(manager.spawn(STUB_CTX, "general-purpose", "prompt", { description: "test" })).toBe("agent-1");
		});

		it("spawnAndWait resolves to a completed record", async () => {
			const { manager } = createToolDeps();
			const record = await manager.spawnAndWait(STUB_CTX, "general-purpose", "prompt", { description: "test" });
			expect(record.status).toBe("completed");
		});

		it("resume resolves to a completed record", async () => {
			const { manager } = createToolDeps();
			const record = await manager.resume("id-1", "prompt", new AbortController().signal);
			expect(record?.status).toBe("completed");
		});

		it("getRecord returns a completed record", () => {
			const { manager } = createToolDeps();
			const record = manager.getRecord("id-1");
			expect(record?.status).toBe("completed");
		});

		it("getMaxConcurrent returns 4", () => {
			const { manager } = createToolDeps();
			expect(manager.getMaxConcurrent()).toBe(4);
		});
	});

	describe("widget defaults", () => {
		it("all widget methods are vi.fn stubs", () => {
			const { widget } = createToolDeps();
			widget.setUICtx({});
			widget.ensureTimer();
			widget.update();
			widget.markFinished("id-1");
			expect(widget.setUICtx).toHaveBeenCalledOnce();
			expect(widget.ensureTimer).toHaveBeenCalledOnce();
			expect(widget.update).toHaveBeenCalledOnce();
			expect(widget.markFinished).toHaveBeenCalledWith("id-1");
		});
	});

	describe("other fields", () => {
		it("agentActivity is an empty Map", () => {
			const { agentActivity } = createToolDeps();
			expect(agentActivity).toBeInstanceOf(Map);
			expect(agentActivity.get("x")).toBeUndefined();
		});

		it("agentDir is a non-empty string", () => {
			expect(createToolDeps().agentDir).toBeTypeOf("string");
		});

		it("settings.defaultMaxTurns is undefined by default", () => {
			expect(createToolDeps().settings.defaultMaxTurns).toBeUndefined();
		});

		it("registry accepts agent type lookups without throwing", () => {
			const { registry } = createToolDeps();
			expect(() => registry.resolveAgentConfig("general-purpose")).not.toThrow();
		});
	});

	describe("override merging", () => {
		it("replaces a top-level field when overridden", () => {
			const deps = createToolDeps({ agentDir: "/custom/dir" });
			expect(deps.agentDir).toBe("/custom/dir");
		});

		it("replaces the manager when overridden", () => {
			const customSpawn = vi.fn().mockReturnValue("custom-id");
			const deps = createToolDeps({
				manager: { ...createToolDeps().manager, spawn: customSpawn },
			});
			deps.manager.spawn(STUB_CTX, "t", "p", { description: "test" });
			expect(customSpawn).toHaveBeenCalledOnce();
		});

		it("replaces settings when overridden", () => {
			const deps = createToolDeps({ settings: { defaultMaxTurns: 10 } });
			expect(deps.settings.defaultMaxTurns).toBe(10);
		});
	});

	describe("structural compatibility", () => {
		it("satisfies BackgroundDeps structurally", () => {
			// TypeScript compile-time check — runtime just verifies required methods exist.
			const deps = createToolDeps();
			const bgDeps: BackgroundDeps = deps;
			expect(bgDeps.manager.spawn).toBeTypeOf("function");
			expect(bgDeps.manager.getRecord).toBeTypeOf("function");
			expect(bgDeps.manager.getMaxConcurrent).toBeTypeOf("function");
			expect(bgDeps.widget.ensureTimer).toBeTypeOf("function");
			expect(bgDeps.widget.update).toBeTypeOf("function");
		});

		it("satisfies ForegroundDeps structurally", () => {
			const deps = createToolDeps();
			const fgDeps: ForegroundDeps = deps;
			expect(fgDeps.manager.spawnAndWait).toBeTypeOf("function");
			expect(fgDeps.widget.ensureTimer).toBeTypeOf("function");
			expect(fgDeps.widget.markFinished).toBeTypeOf("function");
		});

		it("agentActivity satisfies AgentActivityAccess", () => {
			const deps = createToolDeps();
			const tracker = new AgentActivityTracker();
			deps.agentActivity.set("id-1", tracker);
			expect(deps.agentActivity.get("id-1")).toBe(tracker);
			deps.agentActivity.delete("id-1");
			expect(deps.agentActivity.get("id-1")).toBeUndefined();
		});
	});
});
