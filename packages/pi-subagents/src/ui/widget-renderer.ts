/**
 * widget-renderer.ts — Pure rendering functions for the agent widget.
 *
 * All functions are stateless: they receive data and return formatted strings.
 * No timers, no SDK types, no side effects. Consumed by AgentWidget.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { LifetimeUsage, SessionLike } from "#src/lifecycle/usage";
import { getLifetimeTotal, getSessionContextPercent } from "#src/lifecycle/usage";
import type { SubagentType } from "#src/types";
import {
	describeActivity,
	formatMs,
	formatSessionTokens,
	formatTurns,
	getDisplayName,
	getPromptModeLabel,
	SPINNER,
	type Theme,
} from "#src/ui/display";

// ── Data interfaces ──────────────────────────────────────────────────────────

/** Minimal agent snapshot for rendering — no class methods, no mutation surface. */
export interface WidgetAgent {
	readonly id: string;
	readonly type: SubagentType;
	readonly status: string;
	readonly description: string;
	readonly toolUses: number;
	readonly startedAt: number;
	readonly completedAt?: number;
	readonly error?: string;
	readonly lifetimeUsage?: Readonly<LifetimeUsage>;
	readonly compactionCount: number;
}

/** Read-only activity snapshot for widget rendering. */
export interface WidgetActivity {
	readonly activeTools: ReadonlyMap<string, string>;
	readonly responseText: string;
	readonly turnCount: number;
	readonly maxTurns?: number;
	readonly session?: SessionLike;
}

// ── Per-agent rendering ──────────────────────────────────────────────────────

/** Render a single finished agent line (no tree connector prefix). */
export function renderFinishedLine(
	agent: WidgetAgent,
	activity: WidgetActivity | undefined,
	registry: AgentConfigLookup,
	theme: Theme,
): string {
	const name = getDisplayName(agent.type, registry);
	const modeLabel = getPromptModeLabel(agent.type, registry);
	const duration = formatMs((agent.completedAt ?? Date.now()) - agent.startedAt);

	let icon: string;
	let statusText: string;
	if (agent.status === "completed") {
		icon = theme.fg("success", "✓");
		statusText = "";
	} else if (agent.status === "steered") {
		icon = theme.fg("warning", "✓");
		statusText = theme.fg("warning", " (turn limit)");
	} else if (agent.status === "stopped") {
		icon = theme.fg("dim", "■");
		statusText = theme.fg("dim", " stopped");
	} else if (agent.status === "error") {
		icon = theme.fg("error", "✗");
		const errMsg = agent.error ? `: ${agent.error.slice(0, 60)}` : "";
		statusText = theme.fg("error", ` error${errMsg}`);
	} else {
		// aborted
		icon = theme.fg("error", "✗");
		statusText = theme.fg("warning", " aborted");
	}

	const parts: string[] = [];
	if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
	if (agent.toolUses > 0) parts.push(`${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`);
	parts.push(duration);

	const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
	return `${icon} ${theme.fg("dim", name)}${modeTag}  ${theme.fg("dim", agent.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
}

/** Render a single running agent as header + activity line pair (no tree connector prefix). */
export function renderRunningLines(
	agent: WidgetAgent,
	activity: WidgetActivity | undefined,
	registry: AgentConfigLookup,
	spinnerFrame: number,
	theme: Theme,
): [header: string, activity: string] {
	const name = getDisplayName(agent.type, registry);
	const modeLabel = getPromptModeLabel(agent.type, registry);
	const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
	const elapsed = formatMs(Date.now() - agent.startedAt);

	const tokens = getLifetimeTotal(agent.lifetimeUsage);
	const contextPercent = activity?.session ? getSessionContextPercent(activity.session) : null;
	const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, agent.compactionCount) : "";

	const parts: string[] = [];
	if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
	if (agent.toolUses > 0) parts.push(`${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`);
	if (tokenText) parts.push(tokenText);
	parts.push(elapsed);
	const statsText = parts.join(" · ");

	const frame = SPINNER[spinnerFrame % SPINNER.length];
	const activityText = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking\u2026";

	const header = `${theme.fg("accent", frame)} ${theme.bold(name)}${modeTag}  ${theme.fg("muted", agent.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", statsText)}`;
	const activityLine = theme.fg("dim", `  \u23BF  ${activityText}`);

	return [header, activityLine];
}

// ── Full widget rendering ────────────────────────────────────────────────────

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

interface AgentCategories {
	running: WidgetAgent[];
	queued: WidgetAgent[];
	finished: WidgetAgent[];
}

/** Partition agents into rendering buckets. */
function categorizeAgents(
	agents: readonly WidgetAgent[],
	shouldShowFinished: (agentId: string, status: string) => boolean,
): AgentCategories {
	return {
		running: agents.filter(a => a.status === "running"),
		queued: agents.filter(a => a.status === "queued"),
		finished: agents.filter(
			a => a.status !== "running" && a.status !== "queued" && a.completedAt != null
				&& shouldShowFinished(a.id, a.status),
		),
	};
}

interface WidgetSections {
	finishedLines: string[];
	runningLines: [string, string][];
	queuedLine: string | undefined;
}

/** Render each agent bucket into pre-formatted lines with ├─ tree connectors. */
function buildSections(
	categories: AgentCategories,
	activityMap: ReadonlyMap<string, WidgetActivity>,
	registry: AgentConfigLookup,
	spinnerFrame: number,
	theme: Theme,
	truncate: (line: string) => string,
): WidgetSections {
	const finishedLines: string[] = [];
	for (const a of categories.finished) {
		finishedLines.push(truncate(theme.fg("dim", "\u251C\u2500") + " " + renderFinishedLine(a, activityMap.get(a.id), registry, theme)));
	}

	const runningLines: [string, string][] = [];
	for (const a of categories.running) {
		const [header, act] = renderRunningLines(a, activityMap.get(a.id), registry, spinnerFrame, theme);
		runningLines.push([
			truncate(theme.fg("dim", "\u251C\u2500") + ` ${header}`),
			truncate(theme.fg("dim", "\u2502  ") + act),
		]);
	}

	const queuedLine = categories.queued.length > 0
		? truncate(theme.fg("dim", "\u251C\u2500") + ` ${theme.fg("muted", "\u25E6")} ${theme.fg("dim", `${categories.queued.length} queued`)}`)
		: undefined;

	return { finishedLines, runningLines, queuedLine };
}

/** Pure rendering of the widget body. Returns lines to display. */
export function renderWidgetLines(params: {
	agents: readonly WidgetAgent[];
	activityMap: ReadonlyMap<string, WidgetActivity>;
	registry: AgentConfigLookup;
	spinnerFrame: number;
	terminalWidth: number;
	theme: Theme;
	shouldShowFinished: (agentId: string, status: string) => boolean;
}): string[] {
	const { agents, activityMap, registry, spinnerFrame, terminalWidth, theme, shouldShowFinished } = params;

	const { running, queued, finished } = categorizeAgents(agents, shouldShowFinished);

	const hasActive = running.length > 0 || queued.length > 0;
	const hasFinished = finished.length > 0;

	if (!hasActive && !hasFinished) return [];

	const truncate = (line: string) => truncateToWidth(line, terminalWidth);
	const headingColor = hasActive ? "accent" : "dim";
	const headingIcon = hasActive ? "\u25CF" : "\u25CB";

	const { finishedLines, runningLines, queuedLine } = buildSections(
		{ running, queued, finished },
		activityMap,
		registry,
		spinnerFrame,
		theme,
		truncate,
	);

	// Assemble with overflow cap (heading takes 1 line).
	const maxBody = MAX_WIDGET_LINES - 1;
	const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0);

	const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];

	if (totalBody <= maxBody) {
		lines.push(...finishedLines);
		for (const pair of runningLines) lines.push(...pair);
		if (queuedLine) lines.push(queuedLine);

		// Fix last connector: swap \u251C\u2500 \u2192 \u2514\u2500 and \u2502 \u2192 space for activity lines.
		if (lines.length > 1) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("\u251C\u2500", "\u2514\u2500");
			if (runningLines.length > 0 && !queuedLine) {
				if (last >= 2) {
					lines[last - 1] = lines[last - 1].replace("\u251C\u2500", "\u2514\u2500");
					lines[last] = lines[last].replace("\u2502  ", "   ");
				}
			}
		}
	} else {
		// Overflow — prioritize: running > queued > finished.
		let budget = maxBody - 1;
		let hiddenRunning = 0;
		let hiddenFinished = 0;

		for (const pair of runningLines) {
			if (budget >= 2) {
				lines.push(...pair);
				budget -= 2;
			} else {
				hiddenRunning++;
			}
		}

		if (queuedLine && budget >= 1) {
			lines.push(queuedLine);
			budget--;
		}

		for (const fl of finishedLines) {
			if (budget >= 1) {
				lines.push(fl);
				budget--;
			} else {
				hiddenFinished++;
			}
		}

		const overflowParts: string[] = [];
		if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
		if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
		const overflowText = overflowParts.join(", ");
		lines.push(truncate(theme.fg("dim", "\u2514\u2500") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`));
	}

	return lines;
}
