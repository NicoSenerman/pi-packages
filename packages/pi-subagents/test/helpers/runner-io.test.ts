import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "#src/types";
import { createAgentLookup, createRunnerIO } from "./runner-io";

describe("createRunnerIO", () => {
	it("returns a stub with all EnvironmentIO methods", () => {
		const io = createRunnerIO();
		expect(typeof io.detectEnv).toBe("function");
		expect(typeof io.getAgentDir).toBe("function");
		expect(typeof io.deriveSessionDir).toBe("function");
	});

	it("returns a stub with all SessionFactoryIO methods", () => {
		const io = createRunnerIO();
		expect(typeof io.createResourceLoader).toBe("function");
		expect(typeof io.createSessionManager).toBe("function");
		expect(typeof io.createSettingsManager).toBe("function");
		expect(typeof io.createSession).toBe("function");
	});

	it("assemblerIO has preloadSkills and buildAgentPrompt only", () => {
		const io = createRunnerIO();
		expect(typeof io.assemblerIO.preloadSkills).toBe("function");
		expect(typeof io.assemblerIO.buildAgentPrompt).toBe("function");
		expect(Object.keys(io.assemblerIO)).toEqual(["preloadSkills", "buildAgentPrompt"]);
	});

	it("assemblerIO defaults return sensible stub values", () => {
		const io = createRunnerIO();
		expect(io.assemblerIO.preloadSkills([], "/cwd")).toEqual([]);
		expect(io.assemblerIO.buildAgentPrompt).toBeDefined();
	});

	it("detectEnv resolves to a stub EnvInfo", async () => {
		const io = createRunnerIO();
		const env = await io.detectEnv(vi.fn(), "/cwd");
		expect(env).toEqual({ isGitRepo: false, branch: "", platform: "linux" });
	});

	it("getAgentDir returns /mock/agent-dir", () => {
		const io = createRunnerIO();
		expect(io.getAgentDir()).toBe("/mock/agent-dir");
	});

	it("createSessionManager returns a stub with newSession and getSessionFile", () => {
		const io = createRunnerIO();
		const mgr = io.createSessionManager("/cwd", "/sessions");
		expect(typeof mgr.newSession).toBe("function");
		expect(typeof mgr.getSessionFile).toBe("function");
	});

	it("assemblerIO methods can be configured after creation", () => {
		const io = createRunnerIO();
		io.assemblerIO.buildAgentPrompt.mockReturnValue("custom prompt");
		const result = io.assemblerIO.buildAgentPrompt({}, "/cwd", {});
		expect(result).toBe("custom prompt");
	});

	it("stubs retain Mock methods (vi.fn())", () => {
		const io = createRunnerIO();
		io.detectEnv.mockResolvedValue({ isGitRepo: true, branch: "main", platform: "darwin" });
		expect(io.detectEnv.mock).toBeDefined();
	});
});

describe("createAgentLookup", () => {
	it("resolveAgentConfig returns the default Explore config", () => {
		const lookup = createAgentLookup();
		const config = lookup.resolveAgentConfig("Explore");
		expect(config.name).toBe("Explore");
		expect(config.promptMode).toBe("replace");
		expect(config.extensions).toBe(false);
		expect(config.skills).toBe(false);
	});

	it("default config builtinToolNames includes 'read'", () => {
		const lookup = createAgentLookup();
		const config = lookup.resolveAgentConfig("Explore");
		expect(config.builtinToolNames).toContain("read");
	});

	it("getToolNamesForType returns ['read'] by default", () => {
		const lookup = createAgentLookup();
		expect(lookup.getToolNamesForType("Explore")).toEqual(["read"]);
	});

	it("accepts a partial config override", () => {
		const override: Partial<AgentConfig> = { name: "Custom", extensions: true };
		const lookup = createAgentLookup(override);
		const config = lookup.resolveAgentConfig("Custom");
		expect(config.name).toBe("Custom");
		expect(config.extensions).toBe(true);
		// other defaults still present
		expect(config.promptMode).toBe("replace");
	});

	it("resolveAgentConfig and getToolNamesForType are vi.fn() stubs", () => {
		const lookup = createAgentLookup();
		expect(lookup.resolveAgentConfig.mock).toBeDefined();
		expect(lookup.getToolNamesForType.mock).toBeDefined();
	});
});
