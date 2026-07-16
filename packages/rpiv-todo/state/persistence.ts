/**
 * Per-session file-backed persistence fallback for the todo store.
 *
 * The upstream rpiv-todo rebuilds live state solely from the session branch
 * (the last `todo` toolResult whose `details` matches `TaskDetails`). That
 * breaks for BACH-mode subagent forks: a forked subagent's branch has no
 * `todo` toolResult, so `replayFromBranch` returns `EMPTY_STATE` and the
 * model's plan is wiped. This module snapshots the store to a fixed-path JSON
 * file on every `commitState` and lets the lifecycle handlers fall back to it
 * when branch replay comes up empty.
 *
 * There is ONE state file shared by the active session (the path is fixed, not
 * per-cwd) — per-project/per-cwd scoping was explicitly rejected. The file is
 * authoritative for the write path (every commit writes it) and a fallback for
 * the read path (branch replay wins when it has data).
 *
 * Never throws: a disk error at write time is logged to stderr and the bad
 * file is quarantined so the session keeps running. Mirrors the
 * corrupt-recovery philosophy — never crash the session over persistence.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskState } from "./state.js";

/** Directory holding the state file (~/.pi/agent/extensions/). Created 0o700. */
const STATE_DIR = join(homedir(), ".pi", "agent", "extensions");
/** Fixed path of the per-session state snapshot. */
export const PERSIST_PATH = join(STATE_DIR, "rpiv-todo-state.json");

interface PersistedState {
	tasks: unknown;
	nextId: unknown;
	version: number;
}

/**
 * Atomic write of the full task state. Serializes to a temp file in the same
 * directory (mode 0o600) then `rename` over the target — rename is atomic on
 * POSIX so a crash mid-write never leaves a truncated state file. On any
 * failure: log to stderr, quarantine an unwritable/corrupt target, and retry
 * with a fresh file. Never throws.
 */
export function writeState(state: TaskState): void {
	try {
		mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: could not create state dir: ${String(e)}\n`);
	}
	const payload = JSON.stringify({ tasks: state.tasks, nextId: state.nextId, version: 1 });
	const temp = `${PERSIST_PATH}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, payload, { mode: 0o600 });
		renameSync(temp, PERSIST_PATH);
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
	if (existsSync(PERSIST_PATH)) {
		try {
			const backup = `rpiv-todo-state.json.bad-${Date.now()}`;
			renameSync(PERSIST_PATH, join(STATE_DIR, backup));
			writeFileSync(PERSIST_PATH, payload, { mode: 0o600 });
		} catch (e2) {
			process.stderr.write(`rpiv-todo persistence: recovery write failed: ${String(e2)}\n`);
		}
	}
}

/**
 * Read and validate the persisted state. Returns `null` when the file is
 * missing, unparseable, or the wrong shape (quarantining the bad file so the
 * next write starts fresh). Never throws.
 */
export function readState(): TaskState | null {
	let raw: string | null;
	try {
		raw = readFileSyncSafe(PERSIST_PATH);
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: read failed: ${String(e)}\n`);
		return null;
	}
	if (raw === null) return null;
	let parsed: PersistedState;
	try {
		parsed = JSON.parse(raw) as PersistedState;
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: JSON parse failed: ${String(e)} — quarantining\n`);
		quarantine();
		return null;
	}
	if (!Array.isArray(parsed.tasks) || typeof parsed.nextId !== "number") {
		process.stderr.write("rpiv-todo persistence: bad shape — quarantining\n");
		quarantine();
		return null;
	}
	return { tasks: parsed.tasks as TaskState["tasks"], nextId: parsed.nextId };
}

/**
 * Delete the persisted state file (used by the auto-clear-all-completed path
 * on session_start). Never throws.
 */
export function clearState(): void {
	try {
		rmSync(PERSIST_PATH, { force: true });
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: clear failed: ${String(e)}\n`);
	}
}

/** Quarantine the current state file under a `.bad-<ts>` name. Never throws. */
function quarantine(): void {
	try {
		if (!existsSync(PERSIST_PATH)) return;
		renameSync(PERSIST_PATH, join(STATE_DIR, `rpiv-todo-state.json.bad-${Date.now()}`));
	} catch (e) {
		process.stderr.write(`rpiv-todo persistence: quarantine failed: ${String(e)}\n`);
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
	return typeof e === "object" && e !== null && (e as NodeJS.ErrnoException).code === "ENOENT";
}
