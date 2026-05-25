import { vi } from "vitest";
import type { AgentConfig } from "#src/types";

/** Default AgentConfig used in the UI test files (agent-menu and agent-config-editor). */
const DEFAULT_TEST_AGENT_CONFIG: AgentConfig = {
	name: "test-agent",
	description: "A test agent",
	systemPrompt: "You are a test agent.",
	promptMode: "replace",
	extensions: true,
	skills: true,
	isDefault: true,
	source: "default",
};

/**
 * FileOps stub — character-for-character identical across all three UI test files.
 *
 * Return type unannotated so vi.fn() stubs retain their Mock<...> methods.
 */
export function makeFileOps() {
	return {
		exists: vi.fn((_path: string): boolean => false),
		read: vi.fn((_path: string): string | undefined => undefined),
		write: vi.fn((_path: string, _content: string): void => {}),
		remove: vi.fn((_path: string): void => {}),
		ensureDir: vi.fn((_path: string): void => {}),
		findAgentFile: vi.fn((_name: string, _dirs: string[]): string | undefined => undefined),
	};
}

/**
 * MenuUI stub with sequential select responses.
 *
 * Returns the flat UI shape (select, input, confirm, editor, notify, custom).
 * Callers that need to wrap this in a larger context object (e.g. AgentsMenuHandler's
 * { ui, modelRegistry, parentSnapshot }) do so locally in their own test file.
 *
 * Return type unannotated so vi.fn() stubs retain their Mock<...> methods.
 */
export function makeMenuUI(selectResults: (string | undefined)[] = []) {
	let selectIdx = 0;
	return {
		select: vi.fn().mockImplementation(() => selectResults[selectIdx++]),
		input: vi.fn(),
		confirm: vi.fn(),
		editor: vi.fn(),
		notify: vi.fn(),
		custom: vi.fn(),
	};
}

/**
 * Manager stub for UI tests — provides listAgents, getRecord, and spawnAndWait.
 *
 * Used by agent-menu and agent-creation-wizard tests.
 * Return type unannotated so vi.fn() stubs retain their Mock<...> methods.
 */
export function makeMenuManager() {
	return {
		listAgents: vi.fn().mockReturnValue([]),
		getRecord: vi.fn(),
		spawnAndWait: vi.fn(),
	};
}

/**
 * AgentConfig factory with sensible defaults and override support.
 *
 * Default values match the `testDefaultAgentConfig` used in agent-menu.test.ts
 * and agent-config-editor.test.ts (identical in both files).
 */
export function createTestAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
	return { ...DEFAULT_TEST_AGENT_CONFIG, ...overrides };
}
