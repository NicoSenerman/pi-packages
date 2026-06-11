/**
 * monitor-debug.ts — File-based debug logging for the agent monitor overlay.
 *
 * Set PI_SUBAGENTS_DEBUG=1 to activate. Writes to ~/.pi/agent/logs/monitor-debug.log.
 * All entries are timestamped and include the source location.
 *
 * Safe to call when debug is off — ultra-cheap early return (no string formatting).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEBUG = process.env.PI_SUBAGENTS_DEBUG === "1";
const LOG_DIR = path.join(os.homedir(), ".pi", "agent", "logs");
const LOG_PATH = path.join(LOG_DIR, "monitor-debug.log");

let logStream: fs.WriteStream | undefined;

function getStream(): fs.WriteStream {
	if (!logStream) {
		try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
		logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
	}
	return logStream;
}

export function mlog(source: string, msg: string, data?: Record<string, unknown>): void {
	if (!DEBUG) return;
	const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
	const line = data ? `[${ts}] [${source}] ${msg} ${JSON.stringify(data)}\n` : `[${ts}] [${source}] ${msg}\n`;
	try { getStream().write(line); } catch { /* file log best-effort */ }
}

/** Flush and close the log stream. Call from dispose(). */
export function mlogClose(): void {
	if (logStream) {
		try { logStream.end(); } catch { /* file log best-effort */ }
		logStream = undefined;
	}
}
