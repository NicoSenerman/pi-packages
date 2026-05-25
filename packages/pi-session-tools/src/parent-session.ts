/**
 * parent-session.ts — Utilities for discovering and reading parent session files.
 *
 * Subagent sessions are stored at `<parent-dir>/<parent-basename>/tasks/<child>.jsonl`.
 * This module derives the parent session file from that convention.
 */

import { basename, dirname } from "node:path";

/**
 * Derive the parent session file path from a subagent's session file.
 *
 * Returns undefined when the session file is not inside a `tasks/` directory
 * (i.e., the current session is not a subagent).
 */
export function deriveParentSessionFile(
  sessionFile: string | undefined,
): string | undefined {
  if (!sessionFile) return undefined;

  const tasksDir = dirname(sessionFile);
  if (basename(tasksDir) !== "tasks") return undefined;

  const parentBase = dirname(tasksDir);
  return `${parentBase}.jsonl`;
}
