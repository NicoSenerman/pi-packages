import { normalize } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { SUBAGENT_ENV_HINT_KEYS } from "./permission-forwarding";
import type { SubagentSessionRegistry } from "./subagent-registry";

export function normalizeFilesystemPath(pathValue: string): string {
  const normalizedPath = normalize(pathValue);
  return process.platform === "win32"
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

function isPathWithinDirectoryForSubagent(
  pathValue: string,
  directory: string,
): boolean {
  if (!pathValue || !directory) {
    return false;
  }

  if (pathValue === directory) {
    return true;
  }

  const sep = process.platform === "win32" ? "\\" : "/";
  const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return pathValue.startsWith(prefix);
}

export function isSubagentExecutionContext(
  ctx: ExtensionContext,
  subagentSessionsDir: string,
  registry?: SubagentSessionRegistry,
): boolean {
  // 1. Explicit registry — in-process subagent extensions register by child
  //    session id before bindExtensions(); checked first so it takes priority
  //    over heuristics. Each concurrent sibling has a unique session id, so
  //    one sibling's disposed event cannot affect another's registration.
  if (registry) {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (sessionId && registry.has(sessionId)) {
        return true;
      }
    } catch {
      // getSessionId() unavailable — fall through to env/filesystem detection.
    }
  }

  const sessionDir = ctx.sessionManager.getSessionDir();

  // 2. Env vars — process-based subagent extensions (nicobailon/pi-subagents,
  //    HazAT/pi-interactive-subagents, pi-agent-router, etc.).
  for (const key of SUBAGENT_ENV_HINT_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return true;
    }
  }

  // 3. Filesystem path — fallback heuristic for extensions that store sessions
  //    under a known subagent root directory.
  if (!sessionDir) {
    return false;
  }

  const normalizedSessionDir = normalizeFilesystemPath(sessionDir);
  const normalizedSubagentRoot = normalizeFilesystemPath(subagentSessionsDir);
  return isPathWithinDirectoryForSubagent(
    normalizedSessionDir,
    normalizedSubagentRoot,
  );
}
