import { describe, expect, it } from "vitest";
import type { AgentConfig } from "#src/types";
import { createTestSubagentConfig, makeFileOps, makeMenuManager, makeMenuUI } from "./ui-stubs";

describe("makeFileOps", () => {
	it("has all required FileOps methods", () => {
		const fileOps = makeFileOps();
		expect(typeof fileOps.exists).toBe("function");
		expect(typeof fileOps.read).toBe("function");
		expect(typeof fileOps.write).toBe("function");
		expect(typeof fileOps.remove).toBe("function");
		expect(typeof fileOps.ensureDir).toBe("function");
		expect(typeof fileOps.findAgentFile).toBe("function");
	});

	it("exists returns false by default", () => {
		expect(makeFileOps().exists("/some/path")).toBe(false);
	});

	it("read returns undefined by default", () => {
		expect(makeFileOps().read("/some/path")).toBeUndefined();
	});

	it("findAgentFile returns undefined by default", () => {
		expect(makeFileOps().findAgentFile("agent", ["/dir"])).toBeUndefined();
	});

	it("stubs are vi.fn() instances", () => {
		const fileOps = makeFileOps();
		expect(fileOps.exists.mock).toBeDefined();
		expect(fileOps.write.mock).toBeDefined();
	});
});

describe("makeMenuUI", () => {
	it("has all required UI methods", () => {
		const ui = makeMenuUI();
		expect(typeof ui.select).toBe("function");
		expect(typeof ui.input).toBe("function");
		expect(typeof ui.confirm).toBe("function");
		expect(typeof ui.editor).toBe("function");
		expect(typeof ui.notify).toBe("function");
		expect(typeof ui.custom).toBe("function");
	});

	it("select returns undefined when no results provided", () => {
		const ui = makeMenuUI();
		expect(ui.select([])).toBeUndefined();
	});

	it("select returns results in sequence", () => {
		const ui = makeMenuUI(["first", "second", undefined]);
		expect(ui.select([])).toBe("first");
		expect(ui.select([])).toBe("second");
		expect(ui.select([])).toBeUndefined();
	});

	it("stubs are vi.fn() instances", () => {
		const ui = makeMenuUI();
		expect(ui.select.mock).toBeDefined();
		expect(ui.input.mock).toBeDefined();
	});
});

describe("makeMenuManager", () => {
	it("has listAgents, getRecord, and spawnAndWait", () => {
		const mgr = makeMenuManager();
		expect(typeof mgr.listAgents).toBe("function");
		expect(typeof mgr.getRecord).toBe("function");
		expect(typeof mgr.spawnAndWait).toBe("function");
	});

	it("listAgents returns empty array by default", () => {
		expect(makeMenuManager().listAgents()).toEqual([]);
	});

	it("stubs are vi.fn() instances", () => {
		const mgr = makeMenuManager();
		expect(mgr.listAgents.mock).toBeDefined();
	});
});

describe("createTestSubagentConfig", () => {
	it("returns a valid AgentConfig with all required fields", () => {
		const config = createTestSubagentConfig();
		// Required fields from AgentConfig
		const _typeCheck: AgentConfig = config;
		expect(_typeCheck).toBeDefined();
	});

	it("default config matches the shared test pattern", () => {
		const config = createTestSubagentConfig();
		expect(config.name).toBe("test-agent");
		expect(config.description).toBe("A test agent");
		expect(config.systemPrompt).toBe("You are a test agent.");
		expect(config.promptMode).toBe("replace");
		expect(config.isDefault).toBe(true);
		expect(config.source).toBe("default");
	});

	it("accepts partial overrides", () => {
		const config = createTestSubagentConfig({ name: "custom", isDefault: false, source: "project" });
		expect(config.name).toBe("custom");
		expect(config.isDefault).toBe(false);
		expect(config.source).toBe("project");
		// other defaults preserved
		expect(config.description).toBe("A test agent");
		expect(config.promptMode).toBe("replace");
	});
});
