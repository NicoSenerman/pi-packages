import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";
import {
  getActiveAgentName,
  getActiveAgentNameFromSystemPrompt,
} from "./active-agent";
import { loadAndMergeConfigs, loadUnifiedConfig } from "./config-loader";
import { registerPermissionSystemCommand } from "./config-modal";
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
import { setForwardedPermissionLogger } from "./forwarded-permissions/io";
import {
  confirmPermission,
  type PermissionForwardingDeps,
  processForwardedPermissionRequests,
} from "./forwarded-permissions/polling";
import {
  type HandlerDeps,
  handleBeforeAgentStart,
  handleInput,
  handleResourcesDiscover,
  handleSessionShutdown,
  handleSessionStart,
  handleToolCall,
} from "./handlers";
import type { PromptPermissionDetails } from "./handlers/types";
import { createPermissionSystemLogger } from "./logging";
import {
  type PermissionPromptDecision,
  requestPermissionDecisionFromUi,
} from "./permission-dialog";
import { PERMISSION_FORWARDING_POLL_INTERVAL_MS } from "./permission-forwarding";
import { PermissionManager } from "./permission-manager";
import type { ExtensionRuntime } from "./runtime";
import { SessionApprovalCache } from "./session-approval-cache";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer";
import {
  PERMISSION_SYSTEM_STATUS_KEY,
  syncPermissionSystemStatus,
} from "./status";
import { isSubagentExecutionContext } from "./subagent-context";
import {
  canResolveAskPermissionRequest,
  shouldAutoApprovePermissionState,
} from "./yolo-mode";

const PI_AGENT_DIR = getAgentDir();
const SESSIONS_DIR = join(PI_AGENT_DIR, "sessions");
const SUBAGENT_SESSIONS_DIR = join(PI_AGENT_DIR, "subagent-sessions");
const PERMISSION_FORWARDING_DIR = join(SESSIONS_DIR, "permission-forwarding");

let extensionConfig: PermissionSystemExtensionConfig = {
  ...DEFAULT_EXTENSION_CONFIG,
};
const GLOBAL_LOGS_DIR = getGlobalLogsDir(PI_AGENT_DIR);
const extensionLogger = createPermissionSystemLogger({
  getConfig: () => extensionConfig,
  debugLogPath: join(GLOBAL_LOGS_DIR, DEBUG_LOG_FILENAME),
  reviewLogPath: join(GLOBAL_LOGS_DIR, REVIEW_LOG_FILENAME),
  ensureLogsDirectory: () =>
    ensurePermissionSystemLogsDirectory(GLOBAL_LOGS_DIR),
});
const reportedLoggingWarnings = new Set<string>();
let loggingWarningReporter: ((message: string) => void) | null = null;

function setExtensionConfig(config: PermissionSystemExtensionConfig): void {
  extensionConfig = normalizePermissionSystemConfig(config);
}

function setLoggingWarningReporter(
  reporter: ((message: string) => void) | null,
): void {
  loggingWarningReporter = reporter;
}

function reportLoggingWarning(message: string): void {
  if (!loggingWarningReporter || reportedLoggingWarnings.has(message)) {
    return;
  }
  reportedLoggingWarnings.add(message);
  loggingWarningReporter(message);
}

function writeDebugLog(
  event: string,
  details: Record<string, unknown> = {},
): void {
  const warning = extensionLogger.debug(event, details);
  if (warning) {
    reportLoggingWarning(warning);
  }
}

function writeReviewLog(
  event: string,
  details: Record<string, unknown> = {},
): void {
  const warning = extensionLogger.review(event, details);
  if (warning) {
    reportLoggingWarning(warning);
  }
}

function derivePiProjectPaths(cwd: string | undefined | null): {
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

function createPermissionManagerForCwd(
  cwd: string | undefined | null,
): PermissionManager {
  const agentDir = getAgentDir();
  const projectPaths = derivePiProjectPaths(cwd);
  return new PermissionManager({
    globalConfigPath: getGlobalConfigPath(agentDir),
    projectGlobalConfigPath: projectPaths?.projectGlobalConfigPath,
    projectAgentsDir: projectPaths?.projectAgentsDir,
  });
}

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  let permissionManager = new PermissionManager();
  const sessionApprovalCache = new SessionApprovalCache();
  let activeSkillEntries: SkillPromptEntry[] = [];
  let lastKnownActiveAgentName: string | null = null;
  let lastActiveToolsCacheKey: string | null = null;
  let lastPromptStateCacheKey: string | null = null;
  let permissionForwardingContext: ExtensionContext | null = null;
  let permissionForwardingTimer: NodeJS.Timeout | null = null;
  let isProcessingForwardedRequests = false;
  let runtimeContext: ExtensionContext | null = null;
  let lastConfigWarning: string | null = null;

  const notifyWarning = (message: string): void => {
    if (!runtimeContext?.hasUI) {
      return;
    }
    runtimeContext.ui.notify(message, "warning");
  };

  const refreshExtensionConfig = (ctx?: ExtensionContext): void => {
    if (ctx) {
      runtimeContext = ctx;
    }
    const cwd = runtimeContext?.cwd ?? null;
    const agentDir = getAgentDir();
    const mergeResult = loadAndMergeConfigs(
      agentDir,
      cwd ?? "",
      EXTENSION_ROOT,
    );
    const runtimeConfig = normalizePermissionSystemConfig(mergeResult.merged);
    setExtensionConfig(runtimeConfig);

    if (runtimeContext?.hasUI) {
      syncPermissionSystemStatus(runtimeContext, runtimeConfig);
    }

    const warning =
      mergeResult.issues.length > 0 ? mergeResult.issues.join("\n") : undefined;
    if (warning && warning !== lastConfigWarning) {
      lastConfigWarning = warning;
      notifyWarning(warning);
    } else if (!warning) {
      lastConfigWarning = null;
    }

    writeDebugLog("config.loaded", {
      warning: warning ?? null,
      debugLog: runtimeConfig.debugLog,
      permissionReviewLog: runtimeConfig.permissionReviewLog,
      yoloMode: runtimeConfig.yoloMode,
    });
  };

  const saveExtensionConfig = (
    next: PermissionSystemExtensionConfig,
    ctx: ExtensionCommandContext,
  ): void => {
    const normalized = normalizePermissionSystemConfig(next);
    const globalPath = getGlobalConfigPath(getAgentDir());

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

    setExtensionConfig(normalized);
    syncPermissionSystemStatus(ctx, normalized);
    lastConfigWarning = null;

    writeDebugLog("config.saved", {
      debugLog: normalized.debugLog,
      permissionReviewLog: normalized.permissionReviewLog,
      yoloMode: normalized.yoloMode,
    });
  };

  setLoggingWarningReporter(notifyWarning);
  setForwardedPermissionLogger({ writeReviewLog, writeDebugLog });

  const forwardingDeps: PermissionForwardingDeps = {
    forwardingDir: PERMISSION_FORWARDING_DIR,
    subagentSessionsDir: SUBAGENT_SESSIONS_DIR,
    writeReviewLog,
    requestPermissionDecisionFromUi,
    shouldAutoApprove: () =>
      shouldAutoApprovePermissionState("ask", extensionConfig),
  };

  refreshExtensionConfig();
  registerPermissionSystemCommand(pi, {
    getConfig: () => extensionConfig,
    setConfig: saveExtensionConfig,
    getConfigPath: () => getGlobalConfigPath(getAgentDir()),
  });

  const stopForwardedPermissionPolling = (): void => {
    if (permissionForwardingTimer) {
      clearInterval(permissionForwardingTimer);
      permissionForwardingTimer = null;
    }
    permissionForwardingContext = null;
    isProcessingForwardedRequests = false;
  };

  const startForwardedPermissionPolling = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || isSubagentExecutionContext(ctx, SUBAGENT_SESSIONS_DIR)) {
      stopForwardedPermissionPolling();
      return;
    }
    permissionForwardingContext = ctx;
    if (permissionForwardingTimer) {
      return;
    }
    permissionForwardingTimer = setInterval(() => {
      if (!permissionForwardingContext || isProcessingForwardedRequests) {
        return;
      }
      isProcessingForwardedRequests = true;
      void processForwardedPermissionRequests(
        permissionForwardingContext,
        forwardingDeps,
      ).finally(() => {
        isProcessingForwardedRequests = false;
      });
    }, PERMISSION_FORWARDING_POLL_INTERVAL_MS);
  };

  const createPermissionRequestId = (prefix: string): string =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;

  const reviewPermissionDecision = (
    event: string,
    details: PromptPermissionDetails & {
      resolution?: string;
      denialReason?: string;
    },
  ): void => {
    writeReviewLog(event, {
      requestId: details.requestId,
      source: details.source,
      agentName: details.agentName,
      message: details.message,
      toolCallId: details.toolCallId ?? null,
      toolName: details.toolName ?? null,
      skillName: details.skillName ?? null,
      path: details.path ?? null,
      command: details.command ?? null,
      target: details.target ?? null,
      toolInputPreview: details.toolInputPreview ?? null,
      resolution: details.resolution ?? null,
      denialReason: details.denialReason ?? null,
    });
  };

  const promptPermission = async (
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> => {
    if (shouldAutoApprovePermissionState("ask", extensionConfig)) {
      reviewPermissionDecision("permission_request.auto_approved", details);
      return { approved: true, state: "approved" };
    }
    reviewPermissionDecision("permission_request.waiting", details);
    const decision = await confirmPermission(
      ctx,
      details.message,
      forwardingDeps,
    );
    reviewPermissionDecision(
      decision.approved
        ? "permission_request.approved"
        : "permission_request.denied",
      {
        ...details,
        resolution: decision.state,
        denialReason: decision.denialReason,
      },
    );
    return decision;
  };

  const resolveAgentName = (
    ctx: ExtensionContext,
    systemPrompt?: string,
  ): string | null => {
    const fromSession = getActiveAgentName(ctx);
    if (fromSession) {
      lastKnownActiveAgentName = fromSession;
      return fromSession;
    }
    const fromSystemPrompt = getActiveAgentNameFromSystemPrompt(systemPrompt);
    if (fromSystemPrompt) {
      lastKnownActiveAgentName = fromSystemPrompt;
      return fromSystemPrompt;
    }
    return lastKnownActiveAgentName;
  };

  const logResolvedConfigPaths = (): void => {
    const policyPaths = permissionManager.getResolvedPolicyPaths();
    const cwd = runtimeContext?.cwd ?? null;
    const agentDir = getAgentDir();
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
    writeReviewLog(
      "config.resolved",
      entry as unknown as Record<string, unknown>,
    );
    writeDebugLog(
      "config.resolved",
      entry as unknown as Record<string, unknown>,
    );
  };

  const deps: HandlerDeps = {
    runtime: {
      agentDir: PI_AGENT_DIR,
      sessionsDir: SESSIONS_DIR,
      subagentSessionsDir: SUBAGENT_SESSIONS_DIR,
      forwardingDir: PERMISSION_FORWARDING_DIR,
      globalLogsDir: GLOBAL_LOGS_DIR,
      get config() {
        return extensionConfig;
      },
      set config(v) {
        setExtensionConfig(v);
      },
      get runtimeContext() {
        return runtimeContext;
      },
      set runtimeContext(v) {
        runtimeContext = v;
      },
      get permissionManager() {
        return permissionManager;
      },
      set permissionManager(v) {
        permissionManager = v;
      },
      get activeSkillEntries() {
        return activeSkillEntries;
      },
      set activeSkillEntries(v) {
        activeSkillEntries = v;
      },
      get lastKnownActiveAgentName() {
        return lastKnownActiveAgentName;
      },
      set lastKnownActiveAgentName(v) {
        lastKnownActiveAgentName = v;
      },
      get lastActiveToolsCacheKey() {
        return lastActiveToolsCacheKey;
      },
      set lastActiveToolsCacheKey(v) {
        lastActiveToolsCacheKey = v;
      },
      get lastPromptStateCacheKey() {
        return lastPromptStateCacheKey;
      },
      set lastPromptStateCacheKey(v) {
        lastPromptStateCacheKey = v;
      },
      get lastConfigWarning() {
        return lastConfigWarning;
      },
      set lastConfigWarning(v) {
        lastConfigWarning = v;
      },
      sessionApprovalCache,
      get permissionForwardingContext() {
        return permissionForwardingContext;
      },
      set permissionForwardingContext(v) {
        permissionForwardingContext = v;
      },
      get permissionForwardingTimer() {
        return permissionForwardingTimer;
      },
      set permissionForwardingTimer(v) {
        permissionForwardingTimer = v;
      },
      get isProcessingForwardedRequests() {
        return isProcessingForwardedRequests;
      },
      set isProcessingForwardedRequests(v) {
        isProcessingForwardedRequests = v;
      },
      writeDebugLog,
      writeReviewLog,
    },
    getPermissionManager: () => permissionManager,
    setPermissionManager: (pm) => {
      permissionManager = pm;
    },
    getRuntimeContext: () => runtimeContext,
    setRuntimeContext: (ctx) => {
      runtimeContext = ctx;
    },
    getActiveSkillEntries: () => activeSkillEntries,
    setActiveSkillEntries: (entries) => {
      activeSkillEntries = entries;
    },
    getLastKnownActiveAgentName: () => lastKnownActiveAgentName,
    setLastKnownActiveAgentName: (name) => {
      lastKnownActiveAgentName = name;
    },
    getLastActiveToolsCacheKey: () => lastActiveToolsCacheKey,
    setLastActiveToolsCacheKey: (key) => {
      lastActiveToolsCacheKey = key;
    },
    getLastPromptStateCacheKey: () => lastPromptStateCacheKey,
    setLastPromptStateCacheKey: (key) => {
      lastPromptStateCacheKey = key;
    },
    sessionApprovalCache,
    createPermissionManagerForCwd,
    refreshExtensionConfig,
    notifyWarning,
    logResolvedConfigPaths,
    resolveAgentName,
    canRequestPermissionConfirmation: (ctx) =>
      canResolveAskPermissionRequest({
        config: extensionConfig,
        hasUI: ctx.hasUI,
        isSubagent: isSubagentExecutionContext(ctx, SUBAGENT_SESSIONS_DIR),
      }),
    promptPermission,
    createPermissionRequestId,
    startForwardedPermissionPolling,
    stopForwardedPermissionPolling,
    writeReviewLog,
    writeDebugLog,
    getAllTools: () => pi.getAllTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
  };

  pi.on("session_start", (event, ctx) => handleSessionStart(deps, event, ctx));
  pi.on("resources_discover", (event) => handleResourcesDiscover(deps, event));
  pi.on("session_shutdown", () => handleSessionShutdown(deps));
  pi.on("before_agent_start", (event, ctx) =>
    handleBeforeAgentStart(deps, event, ctx),
  );
  pi.on("input", (event, ctx) => handleInput(deps, event, ctx));
  pi.on("tool_call", (event, ctx) => handleToolCall(deps, event, ctx));
}
