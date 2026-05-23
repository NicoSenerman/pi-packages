import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { Theme } from "#src/ui/display";
import type { WidgetActivity, WidgetAgent } from "#src/ui/widget-renderer";
import { renderFinishedLine, renderRunningLines, renderWidgetLines } from "#src/ui/widget-renderer";

/** Minimal theme stub — wraps text with markup tags for assertion. */
function stubTheme(): Theme {
	return {
		fg: (color: string, text: string) => `[${color}:${text}]`,
		bold: (text: string) => `**${text}**`,
	};
}

const testRegistry = new AgentTypeRegistry(() => new Map());

function makeAgent(overrides: Partial<WidgetAgent> = {}): WidgetAgent {
	return {
		id: "agent-1",
		type: "general-purpose",
		status: "completed",
		description: "test task",
		toolUses: 5,
		startedAt: 1000,
		completedAt: 6000,
		compactionCount: 0,
		...overrides,
	};
}

function makeActivity(overrides: Partial<WidgetActivity> = {}): WidgetActivity {
	return {
		activeTools: new Map(),
		responseText: "",
		turnCount: 3,
		maxTurns: 10,
		...overrides,
	};
}

describe("renderFinishedLine", () => {
	const theme = stubTheme();

	it("renders completed agent with success icon and stats", () => {
		const agent = makeAgent();
		const activity = makeActivity();
		const line = renderFinishedLine(agent, activity, testRegistry, theme);

		// Success icon
		expect(line).toContain("[success:✓]");
		// Display name (general-purpose → "Agent")
		expect(line).toContain("[dim:Agent]");
		// Description
		expect(line).toContain("[dim:test task]");
		// Tool uses
		expect(line).toContain("5 tool uses");
		// Duration (5000ms = 5.0s)
		expect(line).toContain("5.0s");
		// Turn count with max
		expect(line).toContain("⟳3≤10");
		// No trailing status text for completed
		expect(line).not.toContain("error");
		expect(line).not.toContain("aborted");
		expect(line).not.toContain("stopped");
	});

	it("renders singular tool use", () => {
		const agent = makeAgent({ toolUses: 1 });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		expect(line).toContain("1 tool use");
		expect(line).not.toContain("1 tool uses");
	});

	it("omits tool uses when zero", () => {
		const agent = makeAgent({ toolUses: 0 });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		expect(line).not.toContain("tool use");
	});

	it("omits turn count when no activity provided", () => {
		const agent = makeAgent();
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		expect(line).not.toContain("⟳");
	});

	it("uses Date.now() for duration when completedAt is undefined", () => {
		const now = Date.now();
		const agent = makeAgent({ startedAt: now - 2000, completedAt: undefined });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		// Should show ~2.0s (may vary slightly due to test execution time)
		expect(line).toMatch(/[12]\.\ds/);
	});

	it("renders error status with error icon and message", () => {
		const agent = makeAgent({ status: "error", error: "something broke" });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		expect(line).toContain("[error:✗]");
		expect(line).toContain("[error: error: something broke]");
	});

	it("renders error status without message when error is undefined", () => {
		const agent = makeAgent({ status: "error" });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		expect(line).toContain("[error:✗]");
		expect(line).toContain("[error: error]");
	});

	it("truncates long error messages to 60 chars", () => {
		const longError = "a".repeat(80);
		const agent = makeAgent({ status: "error", error: longError });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		// Error message should be sliced to 60 chars
		expect(line).toContain("a".repeat(60));
		expect(line).not.toContain("a".repeat(61));
	});

	it("renders aborted status with error icon and warning text", () => {
		const agent = makeAgent({ status: "aborted" });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		expect(line).toContain("[error:✗]");
		expect(line).toContain("[warning: aborted]");
	});

	it("renders steered status with warning icon and turn limit text", () => {
		const agent = makeAgent({ status: "steered" });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		expect(line).toContain("[warning:✓]");
		expect(line).toContain("[warning: (turn limit)]");
	});

	it("renders stopped status with dim icon and text", () => {
		const agent = makeAgent({ status: "stopped" });
		const line = renderFinishedLine(agent, undefined, testRegistry, theme);

		expect(line).toContain("[dim:■]");
		expect(line).toContain("[dim: stopped]");
	});
});

describe("renderRunningLines", () => {
	const theme = stubTheme();

	it("returns header and activity lines", () => {
		const agent = makeAgent({ status: "running", completedAt: undefined });
		const activity = makeActivity({
			activeTools: new Map([["read_1", "read"]]),
			turnCount: 2,
			maxTurns: 10,
		});
		const [header, activityLine] = renderRunningLines(agent, activity, testRegistry, 0, theme);

		// Header contains spinner frame, bold name, description
		expect(header).toContain("[accent:⠋]");
		expect(header).toContain("**Agent**");
		expect(header).toContain("[muted:test task]");
		// Stats: turn count
		expect(header).toContain("⟳2≤10");
		// Tool uses
		expect(header).toContain("5 tool uses");

		// Activity line shows what the agent is doing
		expect(activityLine).toContain("reading");
	});

	it("shows thinking when no activity tracker", () => {
		const agent = makeAgent({ status: "running", completedAt: undefined });
		const [, activityLine] = renderRunningLines(agent, undefined, testRegistry, 0, theme);

		expect(activityLine).toContain("thinking…");
	});

	it("advances spinner frame", () => {
		const agent = makeAgent({ status: "running", completedAt: undefined });
		const [header0] = renderRunningLines(agent, undefined, testRegistry, 0, theme);
		const [header1] = renderRunningLines(agent, undefined, testRegistry, 1, theme);

		expect(header0).toContain("[accent:⠋]");
		expect(header1).toContain("[accent:⠙]");
	});

	it("includes token display when lifetimeUsage has tokens", () => {
		const agent = makeAgent({
			status: "running",
			completedAt: undefined,
			lifetimeUsage: { input: 5000, output: 2000, cacheWrite: 1000 },
			compactionCount: 1,
		});
		const activity = makeActivity({
			session: {
				getSessionStats: () => ({
					tokens: { input: 5000, output: 2000, cacheWrite: 1000 },
					contextUsage: { percent: 45 },
				}),
			},
		});
		const [header] = renderRunningLines(agent, activity, testRegistry, 0, theme);

		// 5000 + 2000 + 1000 = 8000 → "8.0k token"
		expect(header).toContain("8.0k token");
		// Context percent
		expect(header).toContain("45%");
		// Compaction count
		expect(header).toContain("↻1");
	});

	it("omits token display when lifetimeUsage totals zero", () => {
		const agent = makeAgent({
			status: "running",
			completedAt: undefined,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		});
		const [header] = renderRunningLines(agent, undefined, testRegistry, 0, theme);

		expect(header).not.toContain("token");
	});
});

describe("renderWidgetLines", () => {
	const theme = stubTheme();

	it("renders a single running agent with heading and tree connectors", () => {
		const agent = makeAgent({ status: "running", completedAt: undefined });
		const activity = makeActivity({ turnCount: 1 });
		const activityMap = new Map<string, WidgetActivity>([["agent-1", activity]]);

		const lines = renderWidgetLines({
			agents: [agent],
			activityMap,
			registry: testRegistry,
			spinnerFrame: 0,
			terminalWidth: 200,
			theme,
			shouldShowFinished: () => true,
		});

		// Heading with active indicator
		expect(lines[0]).toContain("●");
		expect(lines[0]).toContain("Agents");
		// Header line with └─ (last item uses └─ not ├─)
		expect(lines[1]).toContain("└─");
		expect(lines[1]).toContain("**Agent**");
		// Activity line — uses space indent (not │) since it's the last agent
		expect(lines[2]).not.toContain("│");
		expect(lines[2]).toContain("⎿");
		// Total: 3 lines (heading + header + activity)
		expect(lines).toHaveLength(3);
	});

	it("renders mixed running + finished + queued agents", () => {
		const running = makeAgent({ id: "r1", status: "running", completedAt: undefined });
		const finished = makeAgent({ id: "f1", status: "completed", completedAt: 6000 });
		const queued = makeAgent({ id: "q1", status: "queued", completedAt: undefined });
		const activityMap = new Map<string, WidgetActivity>([
			["r1", makeActivity()],
			["f1", makeActivity({ turnCount: 5 })],
		]);

		const lines = renderWidgetLines({
			agents: [running, finished, queued],
			activityMap,
			registry: testRegistry,
			spinnerFrame: 0,
			terminalWidth: 200,
			theme,
			shouldShowFinished: () => true,
		});

		// Heading (active because running+queued exist)
		expect(lines[0]).toContain("[accent:\u25cf]");
		// Finished first, then running, then queued
		// finished line (1 line)
		expect(lines[1]).toContain("[success:\u2713]");
		// running header (1 line) + activity (1 line)
		expect(lines[2]).toContain("**Agent**");
		expect(lines[3]).toContain("\u23bf");
		// queued line (last item, uses \u2514\u2500)
		expect(lines[4]).toContain("\u2514\u2500");
		expect(lines[4]).toContain("1 queued");
		// Total: 5 lines
		expect(lines).toHaveLength(5);
	});

	it("filters finished agents via shouldShowFinished", () => {
		const finished1 = makeAgent({ id: "f1", status: "completed", completedAt: 6000 });
		const finished2 = makeAgent({ id: "f2", status: "error", completedAt: 6000 });
		const activityMap = new Map<string, WidgetActivity>();

		const lines = renderWidgetLines({
			agents: [finished1, finished2],
			activityMap,
			registry: testRegistry,
			spinnerFrame: 0,
			terminalWidth: 200,
			theme,
			// Only show f1, filter out f2
			shouldShowFinished: (id) => id === "f1",
		});

		// Heading + 1 finished line
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("[success:\u2713]");
		expect(lines[1]).not.toContain("error");
	});

	it("overflows when too many agents, prioritizing running > queued > finished", () => {
		// MAX_WIDGET_LINES = 12: heading takes 1, max body = 11.
		// 6 running agents = 12 body lines, which exceeds maxBody (11).
		// With 1 line reserved for overflow indicator, budget = 10.
		// 5 running agents fit (10 lines), 1 hidden.
		const agents: WidgetAgent[] = [];
		const activityMap = new Map<string, WidgetActivity>();
		for (let i = 0; i < 6; i++) {
			const id = `r${i}`;
			agents.push(makeAgent({ id, status: "running", completedAt: undefined }));
			activityMap.set(id, makeActivity());
		}
		// Add a finished agent — should be hidden since running takes priority
		agents.push(makeAgent({ id: "f1", status: "completed", completedAt: 6000 }));

		const lines = renderWidgetLines({
			agents,
			activityMap,
			registry: testRegistry,
			spinnerFrame: 0,
			terminalWidth: 200,
			theme,
			shouldShowFinished: () => true,
		});

		// heading(1) + 5 running*2(10) + overflow(1) = 12
		expect(lines).toHaveLength(12);
		// Last line is overflow indicator
		const lastLine = lines[lines.length - 1];
		expect(lastLine).toContain("+2 more");
		expect(lastLine).toContain("1 running");
		expect(lastLine).toContain("1 finished");
	});

	it("returns empty array when no agents to show", () => {
		const lines = renderWidgetLines({
			agents: [],
			activityMap: new Map(),
			registry: testRegistry,
			spinnerFrame: 0,
			terminalWidth: 200,
			theme,
			shouldShowFinished: () => true,
		});

		expect(lines).toEqual([]);
	});

	it("returns empty when all finished agents are filtered out", () => {
		const agent = makeAgent({ status: "completed", completedAt: 6000 });

		const lines = renderWidgetLines({
			agents: [agent],
			activityMap: new Map(),
			registry: testRegistry,
			spinnerFrame: 0,
			terminalWidth: 200,
			theme,
			shouldShowFinished: () => false,
		});

		expect(lines).toEqual([]);
	});

	it("uses dim heading when only finished agents are visible", () => {
		const agent = makeAgent({ status: "completed", completedAt: 6000 });

		const lines = renderWidgetLines({
			agents: [agent],
			activityMap: new Map(),
			registry: testRegistry,
			spinnerFrame: 0,
			terminalWidth: 200,
			theme,
			shouldShowFinished: () => true,
		});

		// Dim heading with open circle
		expect(lines[0]).toContain("[dim:\u25cb]");
		expect(lines[0]).toContain("[dim:Agents]");
	});
});
