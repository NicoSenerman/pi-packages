import { Subagent, type SubagentInit } from "#src/lifecycle/subagent";

export function createTestSubagent(overrides: Partial<SubagentInit> & {
	/** Legacy shorthand: set toolUses via incrementToolUses(). */
	toolUses?: number;
	/** Legacy shorthand: set lifetimeUsage via addUsage(). */
	lifetimeUsage?: { input: number; output: number; cacheWrite: number };
	/** Legacy shorthand: set compactionCount via incrementCompactions(). */
	compactionCount?: number;
} = {}): Subagent {
	const { toolUses, lifetimeUsage, compactionCount, ...init } = overrides;
	const record = new Subagent({
		id: "agent-1",
		type: "general-purpose",
		description: "Test task",
		status: "completed",
		result: "All done.",
		startedAt: 1000,
		completedAt: 2000,
		...init,
	});
	// Apply stat overrides via mutation methods
	if (toolUses !== undefined) {
		for (let i = 0; i < toolUses; i++) record.incrementToolUses();
	} else {
		// Factory default: 3 tool uses
		for (let i = 0; i < 3; i++) record.incrementToolUses();
	}
	if (lifetimeUsage !== undefined) {
		record.addUsage(lifetimeUsage);
	} else {
		// Factory default
		record.addUsage({ input: 500, output: 500, cacheWrite: 0 });
	}
	if (compactionCount !== undefined) {
		for (let i = 0; i < compactionCount; i++) record.incrementCompactions();
	}
	return record;
}
