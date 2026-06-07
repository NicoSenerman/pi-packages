import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerBuiltinToolInputFormatters } from "./builtin-tool-input-formatters";
import { registerPermissionSystemCommand } from "./config-modal";
import { getGlobalConfigPath } from "./config-paths";
import { ConfigStore } from "./config-store";
import { GateDecisionReporter } from "./decision-reporter";
import { computeExtensionPaths } from "./extension-paths";
import {
  PermissionForwarder,
  type PermissionForwarderDeps,
} from "./forwarded-permissions/permission-forwarder";
import { ForwardingManager } from "./forwarding-manager";
import {
  AgentPrepHandler,
  PermissionGateHandler,
  SessionLifecycleHandler,
} from "./handlers";
import { GateRunner } from "./handlers/gates/runner";
import { SkillInputGatePipeline } from "./handlers/gates/skill-input-gate-pipeline";
import { ToolCallGatePipeline } from "./handlers/gates/tool-call-gate-pipeline";
import { requestPermissionDecisionFromUi } from "./permission-dialog";
import { registerPermissionRpcHandlers } from "./permission-event-rpc";
import { PermissionManager } from "./permission-manager";
import { PermissionPrompter } from "./permission-prompter";
import { PermissionSession } from "./permission-session";
import { LocalPermissionsService } from "./permissions-service";
import { PermissionServiceLifecycle } from "./service-lifecycle";
import { createSessionLogger } from "./session-logger";
import { SessionRules } from "./session-rules";
import { isSubagentExecutionContext } from "./subagent-context";
import { subscribeSubagentLifecycle } from "./subagent-lifecycle-events";
import { getSubagentSessionRegistry } from "./subagent-registry";
import { ToolInputFormatterRegistry } from "./tool-input-formatter-registry";
import { Key } from "@earendil-works/pi-tui";
import {
  canResolveAskPermissionRequest,
  getCurrentMode,
  setCurrentMode,
  shouldAutoApprovePermissionState,
} from "./yolo-mode";

function registerModeCommand(
  pi: ExtensionAPI,
  configStore: ConfigStore,
): void {
  pi.registerCommand("mode", {
    description: "Toggle between yolo (full access) and gated (permission gates) mode",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const options = ["yolo", "gated"];
      const filtered = options.filter((o) => o.startsWith(normalized));
      return filtered.length > 0
        ? filtered.map((o) => ({ value: o, label: o, description: o === "yolo" ? "Full access, no permission gates" : "Permission gates active, ask before dangerous operations" }))
        : null;
    },
    handler: async (args, ctx) => {
      const current = getCurrentMode();
      const arg = args.trim().toLowerCase();

      let next: "yolo" | "gated";
      if (arg === "yolo" || arg === "gated") {
        next = arg;
      } else {
        next = current === "yolo" ? "gated" : "yolo";
      }

      if (next === current && !arg) {
        next = current === "yolo" ? "gated" : "yolo";
      }

      setCurrentMode(next, ctx, configStore.current());

      const label = next === "yolo" ? "YOLO" : "GATED";
      const description =
        next === "yolo"
          ? "Full access — all permissions auto-approved"
          : "Gated — asks before dangerous operations";
      ctx.ui.notify(`${label} mode: ${description}`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "Toggle yolo/plan mode",
    handler: async (ctx) => {
      const current = getCurrentMode();
      const next = current === "yolo" ? "gated" : "yolo";
      setCurrentMode(next, ctx, configStore.current());

      const label = next === "yolo" ? "YOLO" : "GATED";
      ctx.ui.notify(`${label} mode`, "info");
    },
  });
}

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const paths = computeExtensionPaths(agentDir);
  const permissionManager = new PermissionManager({ agentDir });
  const sessionRules = new SessionRules();
  const subagentRegistry = getSubagentSessionRegistry();
  const formatterRegistry = new ToolInputFormatterRegistry();
  registerBuiltinToolInputFormatters(formatterRegistry);

  // Forward reference: configStore is declared before the logger so the
  // logger's getConfig thunk can close over the variable; assigned immediately
  // after. Typed via cast so the closure compiles without assertions.
  // The same null-at-init pattern used in the former createExtensionRuntime.
  let configStore = null as unknown as ConfigStore;

  // sessionNotify is a mutable holder so the logger's notify closure can
  // reach the UI once PermissionSession is constructed. Starts as null;
  // notify is a best-effort sink (no-op at factory-init when there is no UI).
  let sessionNotify: PermissionSession | null = null;

  const logger = createSessionLogger({
    globalLogsDir: paths.globalLogsDir,
    getConfig: () => configStore.current(),
    notify: (message) =>
      sessionNotify?.getRuntimeContext()?.ui.notify(message, "warning"),
  });

  configStore = new ConfigStore({
    agentDir,
    policyPaths: permissionManager,
    logger: {
      writeDebugLog: (e, d) => logger.debug(e, d),
      writeReviewLog: (e, d) => logger.review(e, d),
    },
  });

  const forwardingDeps: PermissionForwarderDeps = {
    forwardingDir: paths.forwardingDir,
    subagentSessionsDir: paths.subagentSessionsDir,
    registry: subagentRegistry,
    events: pi.events,
    logger: {
      writeReviewLog: (event, details) => logger.review(event, details),
      writeDebugLog: (event, details) => logger.debug(event, details),
    },
    writeReviewLog: (event, details) => logger.review(event, details),
    requestPermissionDecisionFromUi,
    shouldAutoApprove: () =>
      shouldAutoApprovePermissionState("ask", configStore.current()),
  };
  const forwarder = new PermissionForwarder(forwardingDeps);

  const prompter = new PermissionPrompter({
    config: configStore,
    writeReviewLog: (event, details) => logger.review(event, details),
    events: pi.events,
    forwarder,
  });

  configStore.refresh();

  const session = new PermissionSession(
    paths,
    logger,
    new ForwardingManager(
      paths.subagentSessionsDir,
      forwarder,
      subagentRegistry,
    ),
    permissionManager,
    sessionRules,
    configStore,
    {
      canRequestPermissionConfirmation: (ctx) =>
        canResolveAskPermissionRequest({
          config: configStore.current(),
          hasUI: ctx.hasUI,
          isSubagent: isSubagentExecutionContext(
            ctx,
            paths.subagentSessionsDir,
            subagentRegistry,
          ),
        }),
      promptPermission: (ctx, details) => prompter.prompt(ctx, details),
    },
  );

  // Connect the notify sink now that session is available.
  sessionNotify = session;

  registerPermissionSystemCommand(pi, {
    config: configStore,
    getConfigPath: () => getGlobalConfigPath(agentDir),
    getComposedRules: () =>
      permissionManager.getComposedConfigRules(
        session.lastKnownActiveAgentName ?? undefined,
      ),
  });

  registerModeCommand(pi, configStore);

  const rpcHandles = registerPermissionRpcHandlers(pi.events, {
    getPermissionManager: () => permissionManager,
    getSessionRules: () => sessionRules.getRuleset(),
    getRuntimeContext: () => session.getRuntimeContext(),
    requestPermissionDecisionFromUi,
    writeReviewLog: (event, details) => logger.review(event, details),
  });

  const permissionsService = new LocalPermissionsService(
    permissionManager,
    sessionRules,
    formatterRegistry,
  );

  // Subscribe to @gotgenes/pi-subagents' child lifecycle events so child
  // sessions register/unregister without the core calling us (ADR 0002).
  const unsubSubagentLifecycle = subscribeSubagentLifecycle(
    pi.events,
    subagentRegistry,
  );

  // PermissionServiceLifecycle owns the process-global service publication:
  // activate() publishes (skipped for registered subagent children — see #302)
  // and emits ready; teardown() unsubscribes all session listeners and
  // unpublishes. Deferred to session_start because identifying a child
  // requires the session id from ctx, unavailable at factory-init time.
  const serviceLifecycle = new PermissionServiceLifecycle(
    permissionsService,
    subagentRegistry,
    pi.events,
    [rpcHandles.unsubCheck, rpcHandles.unsubPrompt, unsubSubagentLifecycle],
  );

  const toolRegistry = {
    getAll: () => pi.getAllTools(),
    setActive: (names: string[]) => pi.setActiveTools(names),
  };

  const lifecycle = new SessionLifecycleHandler(session, serviceLifecycle);
  const agentPrep = new AgentPrepHandler(session, toolRegistry);
  const reporter = new GateDecisionReporter(session.logger, pi.events);
  const gateRunner = new GateRunner(session, session, session, reporter);
  const toolCallGatePipeline = new ToolCallGatePipeline(
    session,
    formatterRegistry,
  );
  const skillInputGatePipeline = new SkillInputGatePipeline(session);
  const gates = new PermissionGateHandler(
    session,
    toolRegistry,
    toolCallGatePipeline,
    skillInputGatePipeline,
    gateRunner,
  );

  pi.on("session_start", (event, ctx) =>
    lifecycle.handleSessionStart(event, ctx),
  );
  pi.on("resources_discover", (event) =>
    lifecycle.handleResourcesDiscover(event),
  );
  pi.on("session_shutdown", () => lifecycle.handleSessionShutdown());
  pi.on("before_agent_start", (event, ctx) => {
    agentPrep.handle(event, ctx);

    if (getCurrentMode() === "gated") {
      return {
        message: {
          customType: "gated-mode-context",
          content: `You are in GATED mode — the user is actively participating in this session. Every file mutation and destructive command requires their approval. Share your reasoning before acting: explain what you find, propose next steps, and wait for direction. This may be an investigation session with no changes needed — follow the user's lead. Ask questions, surface findings, and treat each permission prompt as a checkpoint to confirm you're on the right track.`,
          display: false,
        },
      };
    }
    return undefined;
  });
  pi.on("input", (event, ctx) => gates.handleInput(event, ctx));
  pi.on("tool_call", (event, ctx) => gates.handleToolCall(event, ctx));
}
