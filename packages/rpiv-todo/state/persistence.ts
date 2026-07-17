/**
 * Per-session file-backed persistence fallback for the todo store.
 *
 * The upstream rpiv-todo rebuilds live state solely from the session branch
 * (the last `todo` toolResult whose `details` matches `TaskDetails`). That
 * breaks for BACH-mode subagent forks: a forked subagent's branch has no
 * `todo` toolResult, so `replayFromBranch` returns `EMPTY_STATE` and the
 * model's plan is wiped. This module snapshots the store to a JSON file on
 * every `commitState` and lets the lifecycle handlers fall back to it when
 * branch replay comes up empty.
 *
 * SESSION ISOLATION (the critical fix): the persistence file is scoped per
 * session via `ctx.sessionManager.getSessionId()` (a stable per-session UUID).
 * Each session — including every in-process BACH subagent, which gets its own
 * SessionManager + UUID via `newSession()` — reads and writes ONLY its own
 * file. This was previously a single fixed-path file shared process-wide,
 * which caused concurrent sessions to clobber one another's snapshots and to
 * inherit the wrong session's todos on the empty-replay fallback path.
 *
 * The BACH cross-session channel for open TODOs is NOT the persistence file —
 * it is the parent's `before_agent_start` `## Open TODOs` system-prompt block,
 * which is unaffected here.
 *
 * Never throws: a disk error at write time is logged to stderr and the bad
 * file is quarantined so the session keeps running. Mirrors the
 * corrupt-recovery philosophy — never crash the session over persistence.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskState } from "./state.js";

/**
 * Directory holding the per-session state files. Created 0o700. Files are
 * named `<sessionId>.json` (one per session UUID). Overridable via
 * `RPIV_TODO_STATE_DIR` for tests so they don't touch the real `~/.pi`.
 */
const STATE_DIR =
	process.env.RPIV_TODO_STATE_DIR ??
	join(homedir(), ".pi", "agent", "extensions", "rpiv-todo");

/**
 * Legacy fixed-path file from before per-session isolation. Only used by
 * `orphanLegacyState()` on the first run after the cut-over so a stale global
 * snapshot is never mis-attributed to the wrong session.
 */
const LEGACY_PATH = process.env.RPIV_TODO_STATE_DIR
	? join(process.env.RPIV_TODO_STATE_DIR, "rpiv-todo-state.json")
	: join(homedir(), ".pi", "agent", "extensions", "rpiv-todo-state.json");

interface PersistedState {
	tasks: unknown;
	nextId: unknown;
	version: number;
}

/** Sanitize a session UUID into a safe file basename (UUID is already safe). */
function fileNameFor(sessionId: string): string {
	// UUID chars only; strip anything else defensively in case getSessionId()
	// ever returns a non-UUID shape across pi versions.
	return `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}.json`;
}

/** Absolute path of a session's own state snapshot. */
export function persistPathFor(sessionId: string): string {
	return join(STATE_DIR, fileNameFor(sessionId));
}

/**
 * Move the legacy global `rpiv-todo-state.json` aside so a stale process-wide
 * snapshot can never be mis-attributed to whichever session happens to load
 * first after the cut-over. Idempotent: no-op when the legacy file is absent.
 * Returns true when a legacy snapshot was orphaned (for logging/tests).
 */
export function orphanLegacyState(): boolean {
	try {
		if (!existsSync(LEGACY_PATH)) return false;
		const backup = `rpiv-todo-state.json.legacy-${Date.now()}`;
		renameSync(LEGACY_PATH, join(STATE_DIR, backup));
		return true;
	} catch {
		return false;
	}
}

/**
 * Atomic write of the full task state for a given session. Serializes to a
 * temp file in the same directory (mode 0o600) then `rename` over the target
 * — rename is atomic on POSIX so a crash mid-write never leaves a truncated
 * state file. On any failure: log to stderr, quarantine an unwritable/corrupt
 * target, and retry with a fresh file. Never throws.
 */
export function writeState(sessionId: string, state: TaskState): void {
	if (!sessionId) return;
	try {
		mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	} catch (e) {
		process.stderr.write(
			`rpiv-todo persistence: could not create state dir: ${String(e)}\n`,
		);
	}
	const target = persistPathFor(sessionId);
	const payload = JSON.stringify({
		tasks: state.tasks,
		nextId: state.nextId,
		version: 1,
	});
	const temp = `${target}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, payload, { mode: 0o600 });
		renameSync(temp, target);
		return;
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: write failed: ${String(e)}\n`);
	}
	// Recovery: if the target itself is corrupt/unwritable, quarantine it and
	// try once more from scratch so the next session starts clean.
	try {
		rmSync(temp, { force: true });
	} catch {
		// best effort
	}
	if (existsSync(target)) {
		try {
			const backup = `${fileNameFor(sessionId)}.bad-${Date.now()}`;
			renameSync(target, join(STATE_DIR, backup));
			writeFileSync(target, payload, { mode: 0o600 });
		} catch (e2) {
			process.stderr.write(
				`rpiv-todo persistence: recovery write failed: ${String(e2)}\n`,
			);
		}
	}
}

/**
 * Read and validate the persisted state for a given session. Returns `null`
 * when the file is missing, unparseable, or the wrong shape (quarantining the
 * bad file so the next write starts fresh). Never throws. A child session
 * (fresh UUID, no file yet) returns `null` — it starts from an empty slate.
 */
export function readState(sessionId: string): TaskState | null {
	if (!sessionId) return null;
	const target = persistPathFor(sessionId);
	let raw: string | null;
	try {
		raw = readFileSyncSafe(target);
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: read failed: ${String(e)}\n`);
		return null;
	}
	if (raw === null) return null;
	let parsed: PersistedState;
	try {
		parsed = JSON.parse(raw) as PersistedState;
	} catch (e) {
		process.stderr.write(
			`rpiv-todo persistence: JSON parse failed: ${String(e)} — quarantining\n`,
		);
		quarantine(sessionId);
		return null;
	}
	if (!Array.isArray(parsed.tasks) || typeof parsed.nextId !== "number") {
		process.stderr.write("rpiv-todo persistence: bad shape — quarantining\n");
		quarantine(sessionId);
		return null;
	}
	return { tasks: parsed.tasks as TaskState["tasks"], nextId: parsed.nextId };
}

/**
 * Delete the persisted state file for a given session (used by the
 * auto-clear-all-completed path and `/new`). Only the current session's file
 * is affected — sibling/parent/child sessions keep their own files. Never
 * throws.
 */
export function clearState(sessionId: string): void {
	if (!sessionId) return;
	try {
		rmSync(persistPathFor(sessionId), { force: true });
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: clear failed: ${String(e)}\n`);
	}
}

/** Quarantine a session's state file under a `.bad-<ts>` name. Never throws. */
function quarantine(sessionId: string): void {
	try {
		const target = persistPathFor(sessionId);
		if (!existsSync(target)) return;
		renameSync(
			target,
			join(STATE_DIR, `${fileNameFor(sessionId)}.bad-${Date.now()}`),
		);
	} catch (e) {
		process.stderr.write(
			`rpiv-todo persistence: quarantine failed: ${String(e)}\n`,
		);
	}
}

/** `readFileSync` wrapper that returns `null` on ENOENT instead of throwing. */
function readFileSyncSafe(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		if (isNotFound(e)) return null;
		throw e;
	}
}

function isNotFound(e: unknown): boolean {
	return (
		typeof e === "object" &&
		e !== null &&
		(e as NodeJS.ErrnoException).code === "ENOENT"
	);
}
