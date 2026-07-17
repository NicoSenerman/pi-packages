import type { TaskDetails } from "../tool/types.js";

/**
 * `custom` entry type written by `/clean-todo` into the session branch. Kept as
 * a local literal (not imported at runtime) so replay.ts stays loadable
 * standalone under node type-stripping for tests; the canonical constant lives
 * in tool/types.ts and must stay byte-identical to this string.
 */
const CLEAR_MARKER_CUSTOM_TYPE = "rpiv-todo-cleared";

import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Discriminator for `details` envelopes that match the persisted `TaskDetails`
 * shape. Defensive — branch entries from older or corrupt sessions are
 * skipped silently.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Whether a branch entry is the durable "todos cleared" marker written by
 * `/clean-todo` (a `custom` entry with `customType === CLEAR_MARKER_CUSTOM_TYPE`).
 * The marker is written via `pi.appendEntry()` so it is stored in the session
 * JSONL and survives `/reload`, compaction, and forks — unlike the
 * persistence file (which only covers a single live session).
 */
function isClearMarker(entry: unknown): boolean {
	const e = entry as { type?: string; customType?: string };
	return e.type === "custom" && e.customType === CLEAR_MARKER_CUSTOM_TYPE;
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === "todo"` and whose `details` shape matches `TaskDetails` wins
 * (last-write-wins) — UNLESS a `/clean-todo` clear marker appears AFTER that
 * last todo toolResult, in which case the session was intentionally emptied
 * and we return `EMPTY_STATE`. The marker wins because it is the most recent
 * write. When no matching todo toolResult exists, returns `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 *
 * Branch entry shape (from SessionManager): `{ type: "message", message: { role, toolName, details } }`
 * or `{ type: "custom", customType, data? }`.
 */
export function replayFromBranch(ctx: {
	sessionManager: { getBranch(): Iterable<unknown> };
}): TaskState {
	let result: TaskState = {
		tasks: [...EMPTY_STATE.tasks],
		nextId: EMPTY_STATE.nextId,
	};
	let sawTodoResult = false;
	let clearedAfterLastResult = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (isClearMarker(entry)) {
			// A clear marker after the last todo toolResult empties state.
			clearedAfterLastResult = sawTodoResult;
			continue;
		}
		const e = entry as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
		if (!isTaskDetails(msg.details)) continue;
		result = {
			tasks: msg.details.tasks.map((t) => ({ ...t })),
			nextId: msg.details.nextId,
		};
		sawTodoResult = true;
		clearedAfterLastResult = false; // a newer todo result supersedes any prior clear
	}
	return clearedAfterLastResult
		? { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId }
		: result;
}
