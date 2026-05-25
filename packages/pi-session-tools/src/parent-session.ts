/**
 * parent-session.ts — Utilities for discovering and reading parent session files.
 *
 * Subagent sessions are stored at `<parent-dir>/<parent-basename>/tasks/<child>.jsonl`.
 * This module derives the parent session file from that convention.
 */

import { existsSync, readFileSync } from "node:fs";
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

/** Parsed JSONL entry with at least a `type` discriminant. */
export interface ParsedEntry {
  type: string;
  [key: string]: unknown;
}

/**
 * Read and parse session entries from a JSONL file.
 *
 * Filters out the session header (type: "session") and returns only
 * session entries (messages, compaction, model changes, etc.).
 * Returns undefined if the file does not exist.
 */
export function readParentSessionEntries(
  parentFile: string,
): ParsedEntry[] | undefined {
  if (!existsSync(parentFile)) return undefined;

  const content = readFileSync(parentFile, "utf-8");
  const entries: ParsedEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ParsedEntry;
      // Skip the session header
      if (parsed.type === "session") continue;
      entries.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}
