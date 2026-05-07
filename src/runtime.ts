import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import {
  getActiveAgentName,
  getActiveAgentNameFromSystemPrompt,
} from "./active-agent";
import { loadAndMergeConfigs, loadUnifiedConfig } from "./config-loader";
import {
  DEBUG_LOG_FILENAME,
  getGlobalConfigPath,
  getGlobalLogsDir,
  getLegacyExtensionConfigPath,
  getLegacyGlobalPolicyPath,
  getLegacyProjectPolicyPath,
  getProjectConfigPath,
  REVIEW_LOG_FILENAME,
} from "./config-paths";
import { buildResolvedConfigLogEntry } from "./config-reporter";
import {
  DEFAULT_EXTENSION_CONFIG,
  EXTENSION_ROOT,
  ensurePermissionSystemLogsDirectory,
  normalizePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "./extension-config";
import {
  type PermissionForwardingDeps,
  processForwardedPermissionRequests,
} from "./forwarded-permissions/polling";
import { createPermissionSystemLogger } from "./logging";
import { discoverGlobalNodeModulesRoot } from "./node-modules-discovery";
import { PERMISSION_FORWARDING_POLL_INTERVAL_MS } from "./permission-forwarding";
import { PermissionManager } from "./permission-manager";
import { SessionRules } from "./session-rules";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer";
import { syncPermissionSystemStatus } from "./status";
import { isSubagentExecutionContext } from "./subagent-context";

/**
 * Mutable session state — the subset of ExtensionRuntime that handlers
 * read and write. Lifecycle handlers reset fields here on session
 * start/shutdown; gate adapters read permissionManager and sessionRules.
 */
export interface SessionState {
  runtimeContext: ExtensionContext | null;
  permissionManager: PermissionManager;
  readonly sessionRules: SessionRules;
  activeSkillEntries: SkillPromptEntry[];
  lastKnownActiveAgentName: string | null;
  lastActiveToolsCacheKey: string | null;
  lastPromptStateCacheKey: string | null;
}

/**
 * Runtime context object created once inside `piPermissionSystemExtension()`.
 *
 * Holds all path constants (derived from `getAgentDir()` at construction time),
 * mutable extension state, and the log-writing methods — eliminating the
 * module-scope cached constants and setter-injection pattern that previously
 * lived in `src/index.ts`.
 *
 * Tests construct this via `createExtensionRuntime({ agentDir: tmpDir })`
 * without timing issues around `PI_CODING_AGENT_DIR`.
 */
export interface ExtensionRuntime extends SessionState {
  // ── Immutable paths (derived from agentDir at construction) ───────────
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly subagentSessionsDir: string;
  readonly forwardingDir: string;
  readonly globalLogsDir: string;
  /**
   * Static Pi infrastructure directories used for external-directory
   * read auto-allow. Computed once at construction from `agentDir` and
   * `discoverGlobalNodeModulesRoot()`. Config-based extras
   * (`piInfrastructureReadPaths`) are read from `runtime.config` at
   * call time in the handler so they pick up config reloads.
   */
  readonly piInfrastructureDirs: string[];

  // ── Mutable state (beyond SessionState) ───────────────────────────────────
  config: PermissionSystemExtensionConfig;
  lastConfigWarning: string | null;

  // ── Forwarding polling state ───────────────────────────────────────────
  permissionForwardingContext: ExtensionContext | null;
  permissionForwardingTimer: NodeJS.Timeout | null;
  isProcessingForwardedRequests: boolean;

  // ── Logging (backed by logger created at construction) ─────────────────
  writeDebugLog(event: string, details?: Record<string, unknown>): void;
  writeReviewLog(event: string, details?: Record<string, unknown>): void;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Derive Pi project-level config and agents paths from a working directory.
 * Returns null when cwd is absent (headless / global-only config).
 */
export function derivePiProjectPaths(cwd: string | undefined | null): {
  projectGlobalConfigPath: string;
  projectAgentsDir: string;
} | null {
  if (!cwd) {
    return null;
  }
  return {
    projectGlobalConfigPath: getProjectConfigPath(cwd),
    projectAgentsDir: join(cwd, ".pi", "agent", "agents"),
  };
}

/**
 * Create a new PermissionManager scoped to a working directory's config hierarchy.
 * Pass `cwd` as null/undefined to use global config only.
 */
export function createPermissionManagerForCwd(
  agentDir: string,
  cwd: string | undefined | null,
): PermissionManager {
  const projectPaths = derivePiProjectPaths(cwd);
  return new PermissionManager({
    globalConfigPath: getGlobalConfigPath(agentDir),
    projectGlobalConfigPath: projectPaths?.projectGlobalConfigPath,
    projectAgentsDir: projectPaths?.projectAgentsDir,
  });
}

/**
 * Reload merged config from disk into the runtime.
 * If `ctx` is provided, updates `runtime.runtimeContext` first.
 */
export function refreshExtensionConfig(
  runtime: ExtensionRuntime,
  ctx?: ExtensionContext,
): void {
  if (ctx) {
    runtime.runtimeContext = ctx;
  }
  const cwd = runtime.runtimeContext?.cwd ?? null;
  const mergeResult = loadAndMergeConfigs(
    runtime.agentDir,
    cwd ?? "",
    EXTENSION_ROOT,
  );
  const runtimeConfig = normalizePermissionSystemConfig(mergeResult.merged);
  runtime.config = runtimeConfig;

  if (runtime.runtimeContext?.hasUI) {
    syncPermissionSystemStatus(runtime.runtimeContext, runtimeConfig);
  }

  const warning =
    mergeResult.issues.length > 0 ? mergeResult.issues.join("\n") : undefined;

  if (warning && warning !== runtime.lastConfigWarning) {
    runtime.lastConfigWarning = warning;
    runtime.runtimeContext?.ui.notify(warning, "warning");
  } else if (!warning) {
    runtime.lastConfigWarning = null;
  }

  runtime.writeDebugLog("config.loaded", {
    warning: warning ?? null,
    debugLog: runtimeConfig.debugLog,
    permissionReviewLog: runtimeConfig.permissionReviewLog,
    yoloMode: runtimeConfig.yoloMode,
  });
}

/**
 * Save updated runtime knobs (debugLog, permissionReviewLog, yoloMode) to the
 * global config file, then update runtime.config and sync UI status.
 */
export function saveExtensionConfig(
  runtime: ExtensionRuntime,
  next: PermissionSystemExtensionConfig,
  ctx: ExtensionCommandContext,
): void {
  const normalized = normalizePermissionSystemConfig(next);
  const globalPath = getGlobalConfigPath(runtime.agentDir);

  const existing = loadUnifiedConfig(globalPath);
  const merged = {
    ...existing.config,
    debugLog: normalized.debugLog,
    permissionReviewLog: normalized.permissionReviewLog,
    yoloMode: normalized.yoloMode,
  };

  const tmpPath = `${globalPath}.tmp`;
  try {
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, globalPath);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup failures.
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `Failed to save permission-system config at '${globalPath}': ${message}`,
      "error",
    );
    return;
  }

  runtime.config = normalized;
  syncPermissionSystemStatus(ctx, normalized);
  runtime.lastConfigWarning = null;

  runtime.writeDebugLog("config.saved", {
    debugLog: normalized.debugLog,
    permissionReviewLog: normalized.permissionReviewLog,
    yoloMode: normalized.yoloMode,
  });
}

/**
 * Resolve the active agent name from the Pi session, system prompt, or last
 * known name. Updates `runtime.lastKnownActiveAgentName` as a side effect.
 */
export function resolveAgentName(
  runtime: ExtensionRuntime,
  ctx: ExtensionContext,
  systemPrompt?: string,
): string | null {
  const fromSession = getActiveAgentName(ctx);
  if (fromSession) {
    runtime.lastKnownActiveAgentName = fromSession;
    return fromSession;
  }
  const fromSystemPrompt = getActiveAgentNameFromSystemPrompt(systemPrompt);
  if (fromSystemPrompt) {
    runtime.lastKnownActiveAgentName = fromSystemPrompt;
    return fromSystemPrompt;
  }
  return runtime.lastKnownActiveAgentName;
}

/**
 * Write the resolved config path set (global, project, legacy) to the review
 * and debug logs.
 */
export function logResolvedConfigPaths(runtime: ExtensionRuntime): void {
  const policyPaths = runtime.permissionManager.getResolvedPolicyPaths();
  const cwd = runtime.runtimeContext?.cwd ?? null;
  const { agentDir } = runtime;
  const legacyGlobalPolicyDetected = existsSync(
    getLegacyGlobalPolicyPath(agentDir),
  );
  const legacyProjectPolicyDetected = cwd
    ? existsSync(getLegacyProjectPolicyPath(cwd))
    : false;
  const legacyExtConfigPath = getLegacyExtensionConfigPath(EXTENSION_ROOT);
  const newGlobalPath = getGlobalConfigPath(agentDir);
  const legacyExtensionConfigDetected =
    normalize(legacyExtConfigPath) !== normalize(newGlobalPath) &&
    existsSync(legacyExtConfigPath);
  const entry = buildResolvedConfigLogEntry({
    policyPaths,
    legacyGlobalPolicyDetected,
    legacyProjectPolicyDetected,
    legacyExtensionConfigDetected,
  });
  runtime.writeReviewLog(
    "config.resolved",
    entry as unknown as Record<string, unknown>,
  );
  runtime.writeDebugLog(
    "config.resolved",
    entry as unknown as Record<string, unknown>,
  );
}

// ── Forwarding polling lifecycle ───────────────────────────────────────────

/** Stop the forwarded-permission polling interval and clear related state. */
export function stopForwardedPermissionPolling(
  runtime: ExtensionRuntime,
): void {
  if (runtime.permissionForwardingTimer) {
    clearInterval(runtime.permissionForwardingTimer);
    runtime.permissionForwardingTimer = null;
  }
  runtime.permissionForwardingContext = null;
  runtime.isProcessingForwardedRequests = false;
}

/**
 * Start the forwarded-permission polling interval.
 * No-ops (and stops any existing poll) when the context has no UI or is a
 * subagent execution context.
 */
export function startForwardedPermissionPolling(
  runtime: ExtensionRuntime,
  forwardingDeps: PermissionForwardingDeps,
  ctx: ExtensionContext,
): void {
  if (
    !ctx.hasUI ||
    isSubagentExecutionContext(ctx, runtime.subagentSessionsDir)
  ) {
    stopForwardedPermissionPolling(runtime);
    return;
  }
  runtime.permissionForwardingContext = ctx;
  if (runtime.permissionForwardingTimer) {
    return;
  }
  runtime.permissionForwardingTimer = setInterval(() => {
    if (
      !runtime.permissionForwardingContext ||
      runtime.isProcessingForwardedRequests
    ) {
      return;
    }
    runtime.isProcessingForwardedRequests = true;
    void processForwardedPermissionRequests(
      runtime.permissionForwardingContext,
      forwardingDeps,
    ).finally(() => {
      runtime.isProcessingForwardedRequests = false;
    });
  }, PERMISSION_FORWARDING_POLL_INTERVAL_MS);
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a fully-initialized `ExtensionRuntime`.
 *
 * Calls `getAgentDir()` at invocation time (never at module scope), so tests
 * may set `PI_CODING_AGENT_DIR` before calling the factory.
 */
export function createExtensionRuntime(options?: {
  agentDir?: string;
}): ExtensionRuntime {
  const agentDir = options?.agentDir ?? getAgentDir();
  const sessionsDir = join(agentDir, "sessions");
  const subagentSessionsDir = join(agentDir, "subagent-sessions");
  const forwardingDir = join(sessionsDir, "permission-forwarding");
  const globalLogsDir = getGlobalLogsDir(agentDir);

  const globalNodeModulesRoot = discoverGlobalNodeModulesRoot();
  const piInfrastructureDirs: string[] = [
    agentDir,
    join(agentDir, "git"),
    ...(globalNodeModulesRoot ? [globalNodeModulesRoot] : []),
  ];

  // Build a plain-object runtime first so the logger's `getConfig` closure
  // can reference `runtime.config` directly (always reads current value).
  const runtime: ExtensionRuntime = {
    agentDir,
    sessionsDir,
    subagentSessionsDir,
    forwardingDir,
    globalLogsDir,
    piInfrastructureDirs,
    config: { ...DEFAULT_EXTENSION_CONFIG },
    runtimeContext: null,
    permissionManager: createPermissionManagerForCwd(agentDir, undefined),
    activeSkillEntries: [],
    lastKnownActiveAgentName: null,
    lastActiveToolsCacheKey: null,
    lastPromptStateCacheKey: null,
    lastConfigWarning: null,
    sessionRules: new SessionRules(),
    permissionForwardingContext: null,
    permissionForwardingTimer: null,
    isProcessingForwardedRequests: false,
    // Logging methods are replaced below after the logger is constructed.
    writeDebugLog: () => {},
    writeReviewLog: () => {},
  };

  const reportedLoggingWarnings = new Set<string>();
  const logger = createPermissionSystemLogger({
    // Reads runtime.config at call time — always current.
    getConfig: () => runtime.config,
    debugLogPath: join(globalLogsDir, DEBUG_LOG_FILENAME),
    reviewLogPath: join(globalLogsDir, REVIEW_LOG_FILENAME),
    ensureLogsDirectory: () =>
      ensurePermissionSystemLogsDirectory(globalLogsDir),
  });

  const reportLoggingWarning = (message: string): void => {
    if (reportedLoggingWarnings.has(message)) {
      return;
    }
    reportedLoggingWarnings.add(message);
    // Reads runtime.runtimeContext at call time — always current.
    runtime.runtimeContext?.ui.notify(message, "warning");
  };

  runtime.writeDebugLog = (
    event: string,
    details: Record<string, unknown> = {},
  ): void => {
    const warning = logger.debug(event, details);
    if (warning) {
      reportLoggingWarning(warning);
    }
  };

  runtime.writeReviewLog = (
    event: string,
    details: Record<string, unknown> = {},
  ): void => {
    const warning = logger.review(event, details);
    if (warning) {
      reportLoggingWarning(warning);
    }
  };

  return runtime;
}
