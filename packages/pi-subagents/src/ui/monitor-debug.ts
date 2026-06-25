/**
 * monitor-debug.ts — File-based debug logging for the agent monitor overlay.
 *
 * Permanently enabled (no env var needed) — just reload Pi.
 * Set PI_SUBAGENTS_DEBUG=0 to explicitly disable if it ever gets noisy.
 * Writes to ~/.pi/agent/logs/monitor-debug.log.
 * All entries are timestamped (date + time) and include the source location.
 *
 * Retention: on stream open (once per session), the existing log file is
 * trimmed to keep only entries from the last 24 hours. This bounds the file
 * size across sessions without an external rotation daemon. Trimming is
 * best-effort — any IO failure is swallowed and logging continues in
 * append-only mode on whatever survived.
 *
 * Safe to call when debug is off — ultra-cheap early return (no string formatting).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Always on by default; disable with PI_SUBAGENTS_DEBUG=0.
const DEBUG = process.env.PI_SUBAGENTS_DEBUG !== "0";
const LOG_DIR = path.join(os.homedir(), ".pi", "agent", "logs");
const LOG_PATH = path.join(LOG_DIR, "monitor-debug.log");

// Trim window: keep entries newer than this many ms. 24h by default.
const RETENTION_MS = 24 * 60 * 60 * 1000;

// Match the leading timestamp of a log line: [YYYY-MM-DDTHH:mm:ss.SSS]
// Lines that don't match (e.g. malformed/legacy) are conservatively kept.
const TS_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\]/;

let logStream: fs.WriteStream | undefined;

/**
 * Trim the log file in place to keep only entries from the last RETENTION_MS.
 * Best-effort: any IO error is swallowed. Runs synchronously once per session
 * at stream creation. If the file doesn't exist or is unreadable, does nothing
 * (a fresh append-only file is created by the caller).
 */
function trimOldEntries(): void {
  let content: string;
  try {
    content = fs.readFileSync(LOG_PATH, "utf8");
  } catch {
    // File doesn't exist yet, or can't be read — nothing to trim.
    return;
  }
  if (!content) return;

  const cutoff = Date.now() - RETENTION_MS;
  const lines = content.split("\n");
  let changed = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const m = TS_RE.exec(line);
    if (m) {
      // Parse the ISO timestamp. If older than the cutoff, drop it.
      const t = Date.parse(m[1] + "Z"); // treat as UTC
      if (Number.isFinite(t) && t < cutoff) {
        changed = true;
        continue;
      }
    }
    // Unparseable or newer — keep it (conservative).
    kept.push(line);
  }
  if (!changed) return;

  try {
    fs.writeFileSync(LOG_PATH, kept.join("\n") + "\n");
  } catch {
    /* trim is best-effort; fall through to normal append */
  }
}

function getStream(): fs.WriteStream {
  if (!logStream) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch {}
    // Once per session: drop entries older than the retention window so the
    // log can't grow without bound across Pi restarts.
    try {
      trimOldEntries();
    } catch {
      /* trim is best-effort */
    }
    logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  }
  return logStream;
}

export function mlog(
  source: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (!DEBUG) return;
  // Full ISO timestamp (date + time, UTC) so the log is self-describing for
  // age-based trimming and for cross-session correlation.
  const ts = new Date().toISOString().slice(0, 23); // YYYY-MM-DDTHH:mm:ss.SSS
  const line = data
    ? `[${ts}] [${source}] ${msg} ${JSON.stringify(data)}\n`
    : `[${ts}] [${source}] ${msg}\n`;
  try {
    getStream().write(line);
  } catch {
    /* file log best-effort */
  }
}

/** Flush and close the log stream. Call from dispose(). */
export function mlogClose(): void {
  if (logStream) {
    try {
      logStream.end();
    } catch {
      /* file log best-effort */
    }
    logStream = undefined;
  }
}
