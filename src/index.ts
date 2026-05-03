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
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";
import {
  getActiveAgentName,
  getActiveAgentNameFromSystemPrompt,
} from "./active-agent";
import {
  createActiveToolsCacheKey,
  createBeforeAgentStartPromptStateKey,
  shouldApplyCachedAgentStartState,
} from "./before-agent-start-cache";
import { getNonEmptyString, toRecord } from "./common";
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
import {
  extractExternalPathsFromBashCommand,
  formatBashExternalDirectoryAskPrompt,
  formatBashExternalDirectoryDenyReason,
  formatExternalDirectoryAskPrompt,
  formatExternalDirectoryDenyReason,
  formatExternalDirectoryHardStopHint,
  formatExternalDirectoryUserDeniedReason,
  getPathBearingToolPath,
  isPathOutsideWorkingDirectory,
  normalizePathForComparison,
  PATH_BEARING_TOOLS,
} from "./external-directory";
import { setForwardedPermissionLogger } from "./forwarded-permissions/io";
import {
  confirmPermission,
  type PermissionForwardingDeps,
  processForwardedPermissionRequests,
} from "./forwarded-permissions/polling";
import { createPermissionSystemLogger } from "./logging";
import {
  type PermissionPromptDecision,
  requestPermissionDecisionFromUi,
} from "./permission-dialog";
import { PERMISSION_FORWARDING_POLL_INTERVAL_MS } from "./permission-forwarding";
import { applyPermissionGate } from "./permission-gate";
import { PermissionManager } from "./permission-manager";
import {
  formatAskPrompt,
  formatDenyReason,
  formatMissingToolNameReason,
  formatSkillAskPrompt,
  formatSkillPathAskPrompt,
  formatSkillPathDenyReason,
  formatUnknownToolReason,
  formatUserDeniedReason,
} from "./permission-prompts";
import {
  deriveApprovalPrefix,
  SessionApprovalCache,
} from "./session-approval-cache";
import {
  findSkillPathMatch,
  resolveSkillPromptEntries,
  type SkillPromptEntry,
} from "./skill-prompt-sanitizer";
import {
  PERMISSION_SYSTEM_STATUS_KEY,
  syncPermissionSystemStatus,
} from "./status";
import { isSubagentExecutionContext } from "./subagent-context";
import { sanitizeAvailableToolsSection } from "./system-prompt-sanitizer";
import { getPermissionLogContext } from "./tool-input-preview";
import {
  checkRequestedToolRegistration,
  getToolNameFromValue,
} from "./tool-registry";
import {
  canResolveAskPermissionRequest,
  shouldAutoApprovePermissionState,
} from "./yolo-mode";

const PI_AGENT_DIR = getAgentDir();
const SESSIONS_DIR = join(PI_AGENT_DIR, "sessions");
const SUBAGENT_SESSIONS_DIR = join(PI_AGENT_DIR, "subagent-sessions");
const PERMISSION_FORWARDING_DIR = join(SESSIONS_DIR, "permission-forwarding");

type PermissionReviewSource = "tool_call" | "skill_input" | "skill_read";

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

function extractSkillNameFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/skill:")) {
    return null;
  }

  const afterPrefix = trimmed.slice("/skill:".length);
  if (!afterPrefix) {
    return null;
  }

  const firstWhitespace = afterPrefix.search(/\s/);
  const skillName = (
    firstWhitespace === -1 ? afterPrefix : afterPrefix.slice(0, firstWhitespace)
  ).trim();
  return skillName || null;
}

function getEventToolName(event: unknown): string | null {
  return getToolNameFromValue(event);
}

function getEventInput(event: unknown): unknown {
  const record = toRecord(event);

  if (record.input !== undefined) {
    return record.input;
  }

  if (record.arguments !== undefined) {
    return record.arguments;
  }

  return {};
}

function canRequestPermissionConfirmation(ctx: ExtensionContext): boolean {
  return canResolveAskPermissionRequest({
    config: extensionConfig,
    hasUI: ctx.hasUI,
    isSubagent: isSubagentExecutionContext(ctx, SUBAGENT_SESSIONS_DIR),
  });
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

  const invalidateAgentStartCache = (): void => {
    activeSkillEntries = [];
    lastActiveToolsCacheKey = null;
    lastPromptStateCacheKey = null;
  };

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

    // Load existing global config and merge runtime knobs into it
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

  const createPermissionRequestId = (prefix: string): string => {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
  };

  const reviewPermissionDecision = (
    event: string,
    details: {
      requestId: string;
      source: PermissionReviewSource;
      agentName: string | null;
      message: string;
      toolCallId?: string;
      toolName?: string;
      skillName?: string;
      path?: string;
      command?: string;
      target?: string;
      toolInputPreview?: string;
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
    details: {
      requestId: string;
      source: PermissionReviewSource;
      agentName: string | null;
      message: string;
      toolCallId?: string;
      toolName?: string;
      skillName?: string;
      path?: string;
      command?: string;
      target?: string;
      toolInputPreview?: string;
    },
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

  const shouldExposeTool = (
    toolName: string,
    agentName: string | null,
  ): boolean => {
    // Use tool-level permission check for tool injection decisions
    // This ensures that agent-specific tool deny rules (e.g., bash: deny) are respected
    // before any command-level permissions are considered
    const toolPermission = permissionManager.getToolPermission(
      toolName,
      agentName ?? undefined,
    );
    return toolPermission !== "deny";
  };

  const logResolvedConfigPaths = (): void => {
    const policyPaths = permissionManager.getResolvedPolicyPaths();
    const cwd = runtimeContext?.cwd ?? null;

    // Detect legacy files for the log entry
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

  pi.on("session_start", async (event, ctx) => {
    runtimeContext = ctx;
    refreshExtensionConfig(ctx);
    permissionManager = createPermissionManagerForCwd(ctx.cwd);
    invalidateAgentStartCache();
    lastKnownActiveAgentName = getActiveAgentName(ctx);
    startForwardedPermissionPolling(ctx);
    logResolvedConfigPaths();

    const policyIssues = permissionManager.getConfigIssues(
      lastKnownActiveAgentName,
    );
    for (const issue of policyIssues) {
      notifyWarning(issue);
    }

    if (event.reason === "reload") {
      writeDebugLog("lifecycle.reload", {
        triggeredBy: "session_start",
        reason: event.reason,
        cwd: ctx.cwd,
      });
    }
  });

  pi.on("resources_discover", async (event, _ctx) => {
    if (event.reason === "reload") {
      permissionManager = runtimeContext
        ? createPermissionManagerForCwd(runtimeContext.cwd)
        : new PermissionManager();
      invalidateAgentStartCache();
      writeDebugLog("lifecycle.reload", {
        triggeredBy: "resources_discover",
        reason: event.reason,
        cwd: runtimeContext?.cwd ?? null,
      });
    }
  });

  pi.on("session_shutdown", async () => {
    runtimeContext?.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, undefined);
    runtimeContext = null;
    invalidateAgentStartCache();
    sessionApprovalCache.clear();
    stopForwardedPermissionPolling();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    runtimeContext = ctx;
    refreshExtensionConfig(ctx);
    startForwardedPermissionPolling(ctx);
    const agentName = resolveAgentName(ctx, event.systemPrompt);
    const allTools = pi.getAllTools();
    const allowedTools: string[] = [];

    for (const tool of allTools) {
      const toolName = getEventToolName(tool);
      if (!toolName) {
        continue;
      }

      if (shouldExposeTool(toolName, agentName)) {
        allowedTools.push(toolName);
      }
    }

    const activeToolsCacheKey = createActiveToolsCacheKey(allowedTools);
    if (
      shouldApplyCachedAgentStartState(
        lastActiveToolsCacheKey,
        activeToolsCacheKey,
      )
    ) {
      pi.setActiveTools(allowedTools);
      lastActiveToolsCacheKey = activeToolsCacheKey;
    }

    const promptStateCacheKey = createBeforeAgentStartPromptStateKey({
      agentName,
      cwd: ctx.cwd,
      permissionStamp: permissionManager.getPolicyCacheStamp(
        agentName ?? undefined,
      ),
      systemPrompt: event.systemPrompt,
      allowedToolNames: allowedTools,
    });

    if (
      !shouldApplyCachedAgentStartState(
        lastPromptStateCacheKey,
        promptStateCacheKey,
      )
    ) {
      return {};
    }

    lastPromptStateCacheKey = promptStateCacheKey;
    const toolPromptResult = sanitizeAvailableToolsSection(
      event.systemPrompt,
      allowedTools,
    );
    const skillPromptResult = resolveSkillPromptEntries(
      toolPromptResult.prompt,
      permissionManager,
      agentName,
      ctx.cwd,
    );
    activeSkillEntries = skillPromptResult.entries;

    if (skillPromptResult.prompt !== event.systemPrompt) {
      return { systemPrompt: skillPromptResult.prompt };
    }

    return {};
  });

  pi.on("input", async (event, ctx) => {
    runtimeContext = ctx;
    startForwardedPermissionPolling(ctx);
    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    const agentName = resolveAgentName(ctx);
    const check = permissionManager.checkPermission(
      "skill",
      { name: skillName },
      agentName ?? undefined,
    );

    if (check.state === "deny" && ctx.hasUI) {
      const notifyMessage = agentName
        ? `Skill '${skillName}' is not permitted for agent '${agentName}'.`
        : `Skill '${skillName}' is not permitted by the current skill policy.`;
      ctx.ui.notify(notifyMessage, "warning");
    }

    const skillInputMessage = formatSkillAskPrompt(
      skillName,
      agentName ?? undefined,
    );
    const skillInputGate = await applyPermissionGate({
      state: check.state,
      canConfirm: canRequestPermissionConfirmation(ctx),
      promptForApproval: () =>
        promptPermission(ctx, {
          requestId: createPermissionRequestId("skill-input"),
          source: "skill_input",
          agentName,
          message: skillInputMessage,
          skillName,
        }),
      writeLog: writeReviewLog,
      logContext: {
        source: "skill_input",
        skillName,
        agentName,
        message: skillInputMessage,
      },
      messages: {
        denyReason: skillInputMessage,
        unavailableReason:
          "Skill requires approval, but no interactive UI is available.",
        userDeniedReason: () => "User denied skill.",
      },
    });
    if (skillInputGate.action === "block") {
      return { action: "handled" };
    }

    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    runtimeContext = ctx;
    startForwardedPermissionPolling(ctx);
    const agentName = resolveAgentName(ctx);
    const toolName = getEventToolName(event);

    if (!toolName) {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    const registrationCheck = checkRequestedToolRegistration(
      toolName,
      pi.getAllTools(),
    );
    if (registrationCheck.status === "missing-tool-name") {
      return { block: true, reason: formatMissingToolNameReason() };
    }

    if (registrationCheck.status === "unregistered") {
      return {
        block: true,
        reason: formatUnknownToolReason(
          registrationCheck.requestedToolName,
          registrationCheck.availableToolNames,
        ),
      };
    }

    if (isToolCallEventType("read", event) && activeSkillEntries.length > 0) {
      const normalizedReadPath = normalizePathForComparison(
        event.input.path,
        ctx.cwd,
      );
      const matchedSkill = findSkillPathMatch(
        normalizedReadPath,
        activeSkillEntries,
      );

      if (matchedSkill) {
        const skillReadMessage = formatSkillPathAskPrompt(
          matchedSkill,
          event.input.path,
          agentName ?? undefined,
        );
        const skillReadGate = await applyPermissionGate({
          state: matchedSkill.state,
          canConfirm: canRequestPermissionConfirmation(ctx),
          promptForApproval: () =>
            promptPermission(ctx, {
              requestId: event.toolCallId,
              source: "skill_read",
              agentName,
              message: skillReadMessage,
              toolCallId: event.toolCallId,
              toolName: toolName,
              skillName: matchedSkill.name,
              path: event.input.path,
            }),
          writeLog: writeReviewLog,
          logContext: {
            source: "skill_read",
            skillName: matchedSkill.name,
            agentName,
            path: event.input.path,
            message: skillReadMessage,
          },
          messages: {
            denyReason: formatSkillPathDenyReason(
              matchedSkill,
              event.input.path,
              agentName ?? undefined,
            ),
            unavailableReason: `Accessing skill '${matchedSkill.name}' requires approval, but no interactive UI is available.`,
            userDeniedReason: (decision) => {
              const denialReason = decision.denialReason
                ? ` Reason: ${decision.denialReason}.`
                : "";
              return `User denied access to skill '${matchedSkill.name}'.${denialReason}`;
            },
          },
        });
        if (skillReadGate.action === "block") {
          return { block: true, reason: skillReadGate.reason };
        }
      }
    }

    const input = getEventInput(event);
    const externalDirectoryPath = ctx.cwd
      ? getPathBearingToolPath(toolName, input)
      : null;

    if (
      ctx.cwd &&
      externalDirectoryPath &&
      isPathOutsideWorkingDirectory(externalDirectoryPath, ctx.cwd)
    ) {
      const normalizedExtPath = normalizePathForComparison(
        externalDirectoryPath,
        ctx.cwd,
      );
      const sessionPrefix = sessionApprovalCache.findMatchingPrefix(
        "external_directory",
        normalizedExtPath,
      );

      if (sessionPrefix) {
        writeReviewLog("permission_request.session_approved", {
          source: "tool_call",
          toolCallId: event.toolCallId,
          toolName,
          agentName,
          path: externalDirectoryPath,
          resolution: "session_approved",
          sessionApprovalPrefix: sessionPrefix,
        });
        // Fall through to normal permission check
      } else {
        const extCheck = permissionManager.checkPermission(
          "external_directory",
          {},
          agentName ?? undefined,
        );

        let extDirDecision: PermissionPromptDecision | null = null;
        const extDirMessage = formatExternalDirectoryAskPrompt(
          toolName,
          externalDirectoryPath,
          ctx.cwd,
          agentName ?? undefined,
        );
        const extDirGate = await applyPermissionGate({
          state: extCheck.state,
          canConfirm: canRequestPermissionConfirmation(ctx),
          promptForApproval: async () => {
            const decision = await promptPermission(ctx, {
              requestId: event.toolCallId,
              source: "tool_call",
              agentName,
              message: extDirMessage,
              toolCallId: event.toolCallId,
              toolName,
              path: externalDirectoryPath,
            });
            extDirDecision = decision;
            return decision;
          },
          writeLog: writeReviewLog,
          logContext: {
            source: "tool_call",
            toolCallId: event.toolCallId,
            toolName,
            agentName,
            path: externalDirectoryPath,
            message: extDirMessage,
          },
          messages: {
            denyReason: formatExternalDirectoryDenyReason(
              toolName,
              externalDirectoryPath,
              ctx.cwd,
              agentName ?? undefined,
            ),
            unavailableReason: `Accessing '${externalDirectoryPath}' outside the working directory requires approval, but no interactive UI is available.`,
            userDeniedReason: (decision) =>
              formatExternalDirectoryUserDeniedReason(
                toolName,
                externalDirectoryPath,
                decision.denialReason,
              ),
          },
        });
        if (extDirGate.action === "block") {
          return { block: true, reason: extDirGate.reason };
        }

        if (extDirDecision?.state === "approved_for_session") {
          const prefix = deriveApprovalPrefix(normalizedExtPath);
          sessionApprovalCache.approve("external_directory", prefix);
        }
      }
      // Fall through to normal permission check
    }

    // Bash external directory gate: extract paths from bash commands
    if (ctx.cwd && toolName === "bash") {
      const command = getNonEmptyString(toRecord(input).command);
      if (command) {
        const externalPaths = extractExternalPathsFromBashCommand(
          command,
          ctx.cwd,
        );
        if (externalPaths.length > 0) {
          // Filter out paths already covered by session approvals
          const uncoveredPaths = externalPaths.filter(
            (p) => !sessionApprovalCache.has("external_directory", p),
          );

          if (uncoveredPaths.length === 0) {
            // All external paths are session-approved
            writeReviewLog("permission_request.session_approved", {
              source: "tool_call",
              toolCallId: event.toolCallId,
              toolName,
              agentName,
              command,
              externalPaths,
              resolution: "session_approved",
            });
            // Fall through to normal bash permission check
          } else {
            const extCheck = permissionManager.checkPermission(
              "external_directory",
              {},
              agentName ?? undefined,
            );

            let bashExtDecision: PermissionPromptDecision | null = null;
            const bashExtMessage = formatBashExternalDirectoryAskPrompt(
              command,
              uncoveredPaths,
              ctx.cwd,
              agentName ?? undefined,
            );
            const bashExtGate = await applyPermissionGate({
              state: extCheck.state,
              canConfirm: canRequestPermissionConfirmation(ctx),
              promptForApproval: async () => {
                const decision = await promptPermission(ctx, {
                  requestId: event.toolCallId,
                  source: "tool_call",
                  agentName,
                  message: bashExtMessage,
                  toolCallId: event.toolCallId,
                  toolName,
                  command,
                });
                bashExtDecision = decision;
                return decision;
              },
              writeLog: writeReviewLog,
              logContext: {
                source: "tool_call",
                toolCallId: event.toolCallId,
                toolName,
                agentName,
                command,
                externalPaths: uncoveredPaths,
                message: bashExtMessage,
              },
              messages: {
                denyReason: formatBashExternalDirectoryDenyReason(
                  command,
                  uncoveredPaths,
                  ctx.cwd,
                  agentName ?? undefined,
                ),
                unavailableReason: `Bash command '${command}' references path(s) outside the working directory and requires approval, but no interactive UI is available.`,
                userDeniedReason: (decision) => {
                  const reasonSuffix = decision.denialReason
                    ? ` Reason: ${decision.denialReason}.`
                    : "";
                  return `User denied external directory access for bash command '${command}'.${reasonSuffix} ${formatExternalDirectoryHardStopHint()}`;
                },
              },
            });
            if (bashExtGate.action === "block") {
              return { block: true, reason: bashExtGate.reason };
            }

            if (bashExtDecision?.state === "approved_for_session") {
              for (const extPath of uncoveredPaths) {
                const prefix = deriveApprovalPrefix(extPath);
                sessionApprovalCache.approve("external_directory", prefix);
              }
            }
          }
          // Fall through to normal bash permission check
        }
      }
    }

    const check = permissionManager.checkPermission(
      toolName,
      input,
      agentName ?? undefined,
    );
    const permissionLogContext = getPermissionLogContext(
      check,
      input,
      PATH_BEARING_TOOLS,
    );

    const toolUnavailableReason =
      toolName === "bash" && isToolCallEventType("bash", event)
        ? `Running bash command '${event.input.command}' requires approval, but no interactive UI is available.`
        : toolName === "mcp"
          ? "Using tool 'mcp' requires approval, but no interactive UI is available."
          : `Using tool '${toolName}' requires approval, but no interactive UI is available.`;

    const toolAskMessage = formatAskPrompt(
      check,
      agentName ?? undefined,
      input,
    );
    const toolGate = await applyPermissionGate({
      state: check.state,
      canConfirm: canRequestPermissionConfirmation(ctx),
      promptForApproval: () =>
        promptPermission(ctx, {
          requestId: event.toolCallId,
          source: "tool_call",
          agentName,
          message: toolAskMessage,
          toolCallId: event.toolCallId,
          toolName,
          ...permissionLogContext,
        }),
      writeLog: writeReviewLog,
      logContext: {
        source: "tool_call",
        toolCallId: event.toolCallId,
        toolName,
        agentName,
        message: toolAskMessage,
        ...permissionLogContext,
      },
      messages: {
        denyReason: formatDenyReason(check, agentName ?? undefined),
        unavailableReason: toolUnavailableReason,
        userDeniedReason: (decision) =>
          formatUserDeniedReason(check, decision.denialReason),
      },
    });
    if (toolGate.action === "block") {
      return { block: true, reason: toolGate.reason };
    }

    return {};
  });
}
