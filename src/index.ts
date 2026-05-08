import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPermissionSystemCommand } from "./config-modal";
import { getGlobalConfigPath } from "./config-paths";
import type { PermissionForwardingDeps } from "./forwarded-permissions/polling";
import { ForwardingManager } from "./forwarding-manager";
import {
  AgentPrepHandler,
  type HandlerDeps,
  handleInput,
  handleToolCall,
  SessionLifecycleHandler,
} from "./handlers";
import { requestPermissionDecisionFromUi } from "./permission-dialog";
import { registerPermissionRpcHandlers } from "./permission-event-rpc";
import { emitReadyEvent } from "./permission-events";
import { PermissionPrompter } from "./permission-prompter";
import { PermissionSession } from "./permission-session";
import {
  createExtensionRuntime,
  logResolvedConfigPaths,
  refreshExtensionConfig,
  saveExtensionConfig,
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

  const session = new PermissionSession(
    runtime,
    createSessionLogger(runtime),
    new ForwardingManager(runtime.subagentSessionsDir, forwardingDeps),
    {
      refreshExtensionConfig: (ctx) => refreshExtensionConfig(runtime, ctx),
      logResolvedConfigPaths: () => logResolvedConfigPaths(runtime),
      getConfig: () => runtime.config,
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
    },
  );

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
    session,
    events: pi.events,
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
    stopPermissionRpcHandlers: () => {
      rpcHandles.unsubCheck();
      rpcHandles.unsubPrompt();
    },
    getAllTools: () => pi.getAllTools(),
    setActiveTools: (names) => pi.setActiveTools(names),
  };

  emitReadyEvent(pi.events);

  const lifecycle = new SessionLifecycleHandler(session, () => {
    rpcHandles.unsubCheck();
    rpcHandles.unsubPrompt();
  });

  pi.on("session_start", (event, ctx) =>
    lifecycle.handleSessionStart(event, ctx),
  );
  pi.on("resources_discover", (event) =>
    lifecycle.handleResourcesDiscover(event),
  );
  pi.on("session_shutdown", () => lifecycle.handleSessionShutdown());
  const agentPrep = new AgentPrepHandler(session, {
    getAll: () => pi.getAllTools(),
    setActive: (names) => pi.setActiveTools(names),
  });

  pi.on("before_agent_start", (event, ctx) => agentPrep.handle(event, ctx));
  pi.on("input", (event, ctx) => handleInput(deps, event, ctx));
  pi.on("tool_call", (event, ctx) => handleToolCall(deps, event, ctx));
}
