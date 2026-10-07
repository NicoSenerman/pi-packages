import { sanitizeTaskFields } from "../tool/sanitize.js";
import type { Task } from "../tool/types.js";
import { writeState } from "./persistence.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * In-memory live state.
 *
 * `state` is the **active** cell — the session that owns the UI overlay (the
 * parent orchestrator). `childStates` holds per-session cells for in-process
 * BACH child sessions, which share this module instance via pi's
 * process-global extension cache but must NOT clobber the parent's overlay.
 *
 * Pre-refactor this was a single module-level singleton; a BACH child's
 * `todo` tool `execute` called `commitState(childSessionId, next)` which
 * overwrote the singleton, flipping the parent's overlay to the child's
 * tasks (H2). The per-session routing below preserves the file-isolation
 * contract (already scoped by sessionId) for the in-memory cell too.
 *
 * `activeSessionId` is set by the `session_start` handler (the parent path —
 * the child handler short-circuits via `isChildSession()`). The no-arg
 * accessors (`getTodos`/`getState`/`getNextId`) read the active cell so the
 * overlay, `/todos`, and `before_agent_start` system-prompt block keep their
 * existing behavior. Session-scoped access (`getStateFor`/`getTodosFor`) is
 * used by the `todo` tool `execute` so a child reads and writes its own cell.
 */
let state: TaskState = {
	tasks: [...EMPTY_STATE.tasks],
	nextId: EMPTY_STATE.nextId,
};

/** The session id that owns the active cell. Set at `session_start`. */
let activeSessionId: string | undefined;

/** Per-session cells for non-active (child) sessions sharing this module. */
const childStates = new Map<string, TaskState>();

/**
 * Declare the active (overlay-owning) session. Called by the `session_start`
 * handler for the parent session. A child session never calls this, so the
 * active cell stays the parent's and the child's `todo` commits route to
 * `childStates` instead.
 */
export function setActiveSession(sessionId: string): void {
	activeSessionId = sessionId;
	// If a child cell was speculatively created for this id, adopt it as the
	// active cell so a parent's first tool call doesn't lose prior writes.
	const pending = childStates.get(sessionId);
	if (pending) {
		state = pending;
		childStates.delete(sessionId);
	}
}

/** Whether `sessionId` is the active (overlay-owning) session. */
function isActiveSession(sessionId: string | undefined): boolean {
	return sessionId !== undefined && sessionId === activeSessionId;
}

/**
 * Live tasks accessor. Returned `readonly Task[]` so callers (overlay render
 * hook, `/todos` command, `renderCall` subject lookup) cannot mutate the live
 * cell. Consumers must not cast back.
 *
 * Reads the active (parent) cell. Use {@link getTodosFor} when the caller has
 * a specific session id (e.g. the `todo` tool `execute`) so a BACH child reads
 * its own cell instead of the parent's.
 */
export function getTodos(): readonly Task[] {
	return state.tasks;
}

/** Session-scoped tasks accessor — reads `sessionId`'s own cell. */
export function getTodosFor(sessionId: string): readonly Task[] {
	if (isActiveSession(sessionId)) return state.tasks;
	return (childStates.get(sessionId) ?? EMPTY_STATE).tasks;
}

export function getNextId(): number {
	return state.nextId;
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(): TaskState {
	return state;
}

/**
 * Session-scoped snapshot accessor. Returns `sessionId`'s own cell so the
 * `todo` tool `execute` computes mutations from the correct session's state
 * (a BACH child starts from EMPTY_STATE, not the parent's list).
 */
export function getStateFor(sessionId: string): TaskState {
	if (isActiveSession(sessionId)) return state;
	return childStates.get(sessionId) ?? EMPTY_STATE;
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot. Operates on the active
 * cell — all three handlers are guarded by `isChildSession()` so a child
 * never reaches this path.
 */
export function replaceState(next: TaskState): void {
	state = next;
}

/**
 * Post-reducer commit seam. Tool execute() calls this with the reducer's
 * `state` output to publish the new canonical state to live readers (overlay,
 * `/todos`, renderCall) and to snapshot it to the calling session's own
 * persistence file (scoped by `sessionId` so concurrent sessions — incl.
 * in-process BACH subagents — never share a file). The disk write is
 * fire-and-forget and wrapped so a persistence failure never breaks a tool
 * call — the session must not crash over persistence.
 *
 * In-memory routing: the active session's commit updates the live `state`
 * cell (so the overlay reflects it); a non-active (child) session's commit
 * writes to `childStates` so the parent's overlay is unaffected (H2). The
 * per-session file is always written either way.
 */
export function commitState(sessionId: string, next: TaskState): void {
	const clean: TaskState = {
		nextId: next.nextId,
		tasks: next.tasks.map(sanitizeTaskFields),
	};
	if (isActiveSession(sessionId)) {
		state = clean;
	} else {
		childStates.set(sessionId, clean);
	}
	try {
		writeState(sessionId, clean);
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: commitState write failed: ${String(e)}\n`);
	}
}

/**
 * Test-setup reset. Wired into the global `test/setup.ts` `beforeEach` via
 * the existing `__resetState` import path. Name preserved verbatim — see
 * Plan §Decisions §Decision 7.
 */
export function __resetState(): void {
	state = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	activeSessionId = undefined;
	childStates.clear();
}
