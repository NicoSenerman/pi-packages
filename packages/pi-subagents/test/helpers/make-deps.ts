import { vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/parent-snapshot";
import { type AgentToolDeps } from "#src/tools/agent-tool";
import { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { createTestRecord } from "./make-record";
import { STUB_SNAPSHOT } from "./stub-ctx";

/** Minimal registry with no user agents — sufficient for tool tests that don't exercise agent-type lookup. */
const defaultRegistry = new AgentTypeRegistry(() => new Map());

/**
 * Shared test fixture: builds a full `AgentToolDeps` with mock stubs and sensible defaults.
 *
 * `AgentToolDeps` is a structural superset of `BackgroundDeps` and `ForegroundDeps`,
 * so the returned value satisfies all three types without casting.
 *
 * Pass `overrides` to replace top-level fields.
 * To override a single nested method, spread the default nested object:
 * ```typescript
 * createToolDeps({ manager: { ...createToolDeps().manager, spawn: vi.fn().mockReturnValue("x") } })
 * ```
 */
export function createToolDeps(overrides: Partial<AgentToolDeps> = {}): AgentToolDeps {
	return {
		manager: {
			spawn: vi.fn().mockReturnValue("agent-1"),
			spawnAndWait: vi.fn().mockResolvedValue(createTestRecord()),
			resume: vi.fn().mockResolvedValue(createTestRecord()),
			getRecord: vi.fn().mockReturnValue(createTestRecord()),
			getMaxConcurrent: vi.fn().mockReturnValue(4),
		},
		widget: {
			setUICtx: vi.fn(),
			ensureTimer: vi.fn(),
			update: vi.fn(),
			markFinished: vi.fn(),
		},
		agentActivity: new Map<string, AgentActivityTracker>(),
		registry: defaultRegistry,
		agentDir: "/home/user/.pi",
		settings: { defaultMaxTurns: undefined as number | undefined },
		buildSnapshot: vi.fn((_inheritContext: boolean): ParentSnapshot => STUB_SNAPSHOT),
		getModelInfo: vi.fn(() => ({ parentModel: { id: "claude-sonnet", name: "Claude Sonnet" }, modelRegistry: { getAll: () => [], getAvailable: () => [] } })),
		getSessionInfo: vi.fn(() => ({ parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "session-1" })),
		...overrides,
	};
}
