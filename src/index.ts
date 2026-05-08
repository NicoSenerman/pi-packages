import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPermissionSystemCommand } from "./config-modal";
import { getGlobalConfigPath } from "./config-paths";
import type { PermissionForwardingDeps } from "./forwarded-permissions/polling";
import {
  type HandlerDeps,
  handleBeforeAgentStart,
  handleInput,
  handleResourcesDiscover,
  handleSessionShutdown,
  handleSessionStart,
  handleToolCall,
} from "./handlers";
import { requestPermissionDecisionFromUi } from "./permission-dialog";
import { registerPermissionRpcHandlers } from "./permission-event-rpc";
import { emitReadyEvent } from "./permission-events";
import { PermissionPrompter } from "./permission-prompter";
import {
  createExtensionRuntime,
  createPermissionManagerForCwd,
  logResolvedConfigPaths,
  refreshExtensionConfig,
  resolveAgentName,
  saveExtensionConfig,
  startForwardedPermissionPolling,
  stopForwardedPermissionPolling,
} from "./runtime";
import { createSessionLogger } from "./session-logger";
import { isSubagentExecutionContext } from "./subagent-context";
import {
  canResolveAskPermissionRequest,
  shouldAutoApprovePermissionState,
} from "./yolo-mode";

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  const runtime = createExtensionRuntime();

  const prompter = new PermissionPrompter({
    getConfig: () => runtime.config,
    writeReviewLog: runtime.writeReviewLog.bind(runtime),
    subagentSessionsDir: runtime.subagentSessionsDir,
    forwardingDir: runtime.forwardingDir,
    requestPermissionDecisionFromUi,
  });

  const forwardingDeps: PermissionForwardingDeps = {
    forwardingDir: runtime.forwardingDir,
    subagentSessionsDir: runtime.subagentSessionsDir,
    logger: {
      writeReviewLog: runtime.writeReviewLog.bind(runtime),
      writeDebugLog: runtime.writeDebugLog.bind(runtime),
    },
    writeReviewLog: runtime.writeReviewLog.bind(runtime),
    requestPermissionDecisionFromUi,
    shouldAutoApprove: () =>
      shouldAutoApprovePermissionState("ask", runtime.config),
  };

  refreshExtensionConfig(runtime);
  registerPermissionSystemCommand(pi, {
    getConfig: () => runtime.config,
    setConfig: (next, ctx) => saveExtensionConfig(runtime, next, ctx),
    getConfigPath: () => getGlobalConfigPath(runtime.agentDir),
    getComposedRules: () =>
      runtime.permissionManager.getComposedConfigRules(
        runtime.lastKnownActiveAgentName ?? undefined,
      ),
  });

  const createPermissionRequestId = (prefix: string): string =>
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;

  const rpcHandles = registerPermissionRpcHandlers(pi.events, {
    getPermissionManager: () => runtime.permissionManager,
    getSessionRules: () => runtime.sessionRules.getRuleset(),
    getRuntimeContext: () => runtime.runtimeContext,
    requestPermissionDecisionFromUi,
    writeReviewLog: runtime.writeReviewLog.bind(runtime),
  });

  const deps: HandlerDeps = {
    session: runtime,
    logger: createSessionLogger(runtime),
    piInfrastructureDirs: runtime.piInfrastructureDirs,
    getPiInfrastructureReadPaths: () =>
      runtime.config.piInfrastructureReadPaths ?? [],
    events: pi.events,
    createPermissionManagerForCwd: (cwd) =>
      createPermissionManagerForCwd(runtime.agentDir, cwd),
    refreshExtensionConfig: (ctx) => refreshExtensionConfig(runtime, ctx),
    logResolvedConfigPaths: () => logResolvedConfigPaths(runtime),
    resolveAgentName: (ctx, systemPrompt) =>
      resolveAgentName(runtime, ctx, systemPrompt),
    canRequestPermissionConfirmation: (ctx) =>
      canResolveAskPermissionRequest({
        config: runtime.config,
        hasUI: ctx.hasUI,
        isSubagent: isSubagentExecutionContext(
          ctx,
          runtime.subagentSessionsDir,
        ),
      }),
    promptPermission: (ctx, details) => prompter.prompt(ctx, details),
    createPermissionRequestId,
    startForwardedPermissionPolling: (ctx) =>
      startForwardedPermissionPolling(runtime, forwardingDeps, ctx),
    stopForwardedPermissionPolling: () =>
      stopForwardedPermissionPolling(runtime),
    stopPermissionRpcHandlers: () => {
      rpcHandles.unsubCheck();
      rpcHandles.unsubPrompt();
    },
    getAllTools: () => pi.getAllTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
  };

  emitReadyEvent(pi.events);

  pi.on("session_start", (event, ctx) => handleSessionStart(deps, event, ctx));
  pi.on("resources_discover", (event) => handleResourcesDiscover(deps, event));
  pi.on("session_shutdown", () => handleSessionShutdown(deps));
  pi.on("before_agent_start", (event, ctx) =>
    handleBeforeAgentStart(deps, event, ctx),
  );
  pi.on("input", (event, ctx) => handleInput(deps, event, ctx));
  pi.on("tool_call", (event, ctx) => handleToolCall(deps, event, ctx));
}
