import { vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { type AgentToolManager, type AgentToolRuntime, type AgentToolSettings } from "#src/tools/agent-tool";
import { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { createTestSubagent } from "./make-subagent";
import { STUB_SNAPSHOT } from "./stub-ctx";

/** Minimal registry with no user agents — sufficient for tool tests that don't exercise agent-type lookup. */
const defaultRegistry = new AgentTypeRegistry(() => new Map());

/**
 * Fixture shape returned by `createToolDeps`.
 * Contains the five `AgentTool` constructor params as separate fields so tests
 * can construct the class directly or use individual pieces for spawner/runner tests.
 */
export type AgentToolFixture = {
	manager: AgentToolManager;
	/**
	 * Mock runtime satisfying `AgentToolRuntime`.
	 * Also satisfies `BackgroundWidgetDeps` and `ForegroundWidgetDeps` structurally
	 * (both use a subset of the runtime's widget delegation methods).
	 * `runtime.agentActivity` replaces the old top-level `agentActivity` field.
	 */
	runtime: AgentToolRuntime;
	settings: AgentToolSettings;
	registry: AgentTypeRegistry;
	agentDir: string;
};

/**
 * Shared test fixture: builds a full `AgentToolFixture` with mock stubs and sensible defaults.
 *
 * Pass `overrides` to replace top-level fields.
 * To override a single nested method, spread the default nested object:
 * ```typescript
 * createToolDeps({ manager: { ...createToolDeps().manager, spawn: vi.fn().mockReturnValue("x") } })
 * ```
 */
export function createToolDeps(overrides: Partial<AgentToolFixture> = {}): AgentToolFixture {
	const agentActivity = new Map<string, AgentActivityTracker>();

	const runtime: AgentToolRuntime = {
		agentActivity,
		setUICtx: vi.fn(),
		ensureTimer: vi.fn(),
		update: vi.fn(),
		markFinished: vi.fn(),
		buildSnapshot: vi.fn((_inheritContext: boolean): ParentSnapshot => STUB_SNAPSHOT),
		getModelInfo: vi.fn(() => ({
			parentModel: { id: "claude-sonnet", name: "Claude Sonnet" },
			modelRegistry: { getAll: () => [], getAvailable: () => [] },
		})),
		getSessionInfo: vi.fn(() => ({
			parentSessionFile: "/sessions/parent.jsonl",
			parentSessionId: "session-1",
		})),
	};

	return {
		manager: {
			spawn: vi.fn().mockReturnValue("agent-1"),
			spawnAndWait: vi.fn().mockResolvedValue(createTestSubagent()),
			resume: vi.fn().mockResolvedValue(createTestSubagent()),
			getRecord: vi.fn().mockReturnValue(createTestSubagent()),
		},
		runtime,
		settings: { defaultMaxTurns: undefined as number | undefined, maxConcurrent: 4 },
		registry: defaultRegistry,
		agentDir: "/home/user/.pi",
		...overrides,
	};
}
