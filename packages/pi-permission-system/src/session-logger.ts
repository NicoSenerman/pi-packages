import { join } from "node:path";
import { DEBUG_LOG_FILENAME, REVIEW_LOG_FILENAME } from "./config-paths";
import {
  ensurePermissionSystemLogsDirectory,
  type PermissionSystemExtensionConfig,
} from "./extension-config";
import { createPermissionSystemLogger } from "./logging";

/**
 * Narrowest logging seam — consumers that only write review-log entries.
 * Injected into `PermissionPrompter` and the RPC handlers.
 */
export interface ReviewLogger {
  review(event: string, details?: Record<string, unknown>): void;
}

/**
 * Logging seam for consumers that write both debug and review entries.
 * Injected into `ConfigStore` and `PermissionForwarder`.
 */
export interface DebugReviewLogger extends ReviewLogger {
  debug(event: string, details?: Record<string, unknown>): void;
}

/**
 * Unified logging + notification surface for handler deps.
 *
 * Replaces three separate logging fields (`writeDebugLog`,
 * `writeReviewLog`, `notifyWarning`) with a single typed collaborator.
 * This is an intermediate abstraction on the path to PermissionSession (#129).
 */
export interface SessionLogger extends DebugReviewLogger {
  warn(message: string): void;
}

/** Narrow dependencies for constructing a {@link SessionLogger}. */
export interface SessionLoggerDeps {
  /** Root logs directory; the debug + review log file paths derive from it. */
  globalLogsDir: string;
  /** Reads current config for the debug/review write toggles (call-time). */
  getConfig: () => PermissionSystemExtensionConfig;
  /** Surfaces a warning message to the user; called at warn/IO-failure time. */
  notify: (message: string) => void;
}

/**
 * Create a SessionLogger from narrow dependencies.
 *
 * Composes the JSONL log writer, owns the IO-failure warning dedup Set,
 * and routes both IO-failure warnings and explicit warn() calls through
 * the injected notify sink. No ExtensionRuntime reference required.
 */
export function createSessionLogger(deps: SessionLoggerDeps): SessionLogger {
  const writer = createPermissionSystemLogger({
    getConfig: deps.getConfig,
    debugLogPath: join(deps.globalLogsDir, DEBUG_LOG_FILENAME),
    reviewLogPath: join(deps.globalLogsDir, REVIEW_LOG_FILENAME),
    ensureLogsDirectory: () =>
      ensurePermissionSystemLogsDirectory(deps.globalLogsDir),
  });

  const reported = new Set<string>();
  const reportOnce = (warning: string): void => {
    if (reported.has(warning)) return;
    reported.add(warning);
    deps.notify(warning);
  };

  return {
    debug: (event, details) => {
      const warning = writer.debug(event, details);
      if (warning) reportOnce(warning);
    },
    review: (event, details) => {
      const warning = writer.review(event, details);
      if (warning) reportOnce(warning);
    },
    warn: (message) => deps.notify(message),
  };
}
