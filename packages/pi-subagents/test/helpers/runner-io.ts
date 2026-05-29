import { vi } from "vitest";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { PreloadedSkill } from "#src/session/skill-loader";
import type { AgentConfig, ShellExec } from "#src/types";

/** Default AgentConfig returned by createAgentLookup. Matches the Explore stub used in runner tests. */
const DEFAULT_AGENT_CONFIG: AgentConfig = {
	name: "Explore",
	description: "Explore",
	builtinToolNames: ["read"],
	extensions: false,
	skills: false,
	systemPrompt: "You are Explore.",
	promptMode: "replace",
	inheritContext: false,
	runInBackground: false,
	isolated: false,
};

/**
 * Shared RunnerIO stub factory for agent-runner tests.
 *
 * Return type is deliberately unannotated so vi.fn() stubs retain their
 * Mock<...> methods (mockResolvedValue, mock.calls, etc.).
 *
 * The assemblerIO sub-object only includes the two methods that exist on the
 * production AssemblerIO interface. The stale buildMemoryBlock and
 * buildReadOnlyMemoryBlock stubs from older test files are intentionally omitted.
 *
 * To customize assemblerIO methods after creation, configure the returned Mock:
 *   const io = createRunnerIO();
 *   io.assemblerIO.buildAgentPrompt.mockReturnValue("custom");
 */
export function createRunnerIO() {
	return {
		detectEnv: vi.fn().mockResolvedValue({ isGitRepo: false, branch: "", platform: "linux" }),
		getAgentDir: vi.fn().mockReturnValue("/mock/agent-dir"),
		createResourceLoader: vi.fn().mockReturnValue({ reload: vi.fn().mockResolvedValue(undefined) }),
		deriveSessionDir: vi.fn().mockReturnValue("/mock/session-dir/tasks"),
		createSessionManager: vi.fn().mockReturnValue({
			newSession: vi.fn(),
			getSessionFile: vi.fn().mockReturnValue("/sessions/child.jsonl"),
		}),
		createSettingsManager: vi.fn().mockReturnValue({}),
		createSession: vi.fn(),
		assemblerIO: {
			preloadSkills: vi.fn((_skills: string[], _cwd: string): PreloadedSkill[] => []),
			buildAgentPrompt: vi.fn((..._args: unknown[]): string => "system prompt"),
		},
	};
}

/**
 * Shared AgentConfigLookup stub.
 *
 * Returns the default Explore config (same as the static mock used in
 * agent-runner.test.ts and concrete-agent-runner.test.ts). Pass a partial
 * config to override specific fields.
 *
 * Tests that need per-test config mutation (agent-runner-extension-tools)
 * keep their local mutable wrapper and use DEFAULT_AGENT_CONFIG as a starting
 * point if needed.
 */
export function createAgentLookup(configOverrides?: Partial<AgentConfig>) {
	const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG, ...configOverrides };
	return {
		resolveAgentConfig: vi.fn((_type: string): AgentConfig => config),
		getToolNamesForType: vi.fn((_type: string): string[] => config.builtinToolNames ?? ["read"]),
	};
}

/**
 * Shared RunnerDeps stub factory for tests that call runAgent() or construct ConcreteAgentRunner.
 *
 * Bundles createRunnerIO(), a no-op exec stub, and a default agent lookup
 * into the RunnerDeps shape expected by runAgent() and ConcreteAgentRunner.
 *
 * Each field accepts an override so tests can supply a locally-configured `io`
 * (e.g. one whose createSession mock is pre-armed), a shared exec, or a custom
 * agent lookup. The `io` override keeps its mock methods (the param type is the
 * unannotated createRunnerIO() shape), so callers can still assert on it.
 */
export function createRunnerDeps(overrides?: {
	io?: ReturnType<typeof createRunnerIO>;
	exec?: ShellExec;
	registry?: AgentConfigLookup;
}) {
	return {
		io: overrides?.io ?? createRunnerIO(),
		exec: overrides?.exec ?? vi.fn(),
		registry: overrides?.registry ?? createAgentLookup(),
	};
}

/** The default agent config, exported for tests that build mutable wrappers around it. */
export { DEFAULT_AGENT_CONFIG };
