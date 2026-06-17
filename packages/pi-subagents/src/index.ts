/* eslint-disable @typescript-eslint/no-unsafe-argument -- Pi SDK types are not fully exported; see upstream Pi SDK for type improvements */
/**
 * pi-agents — A pi extension providing focused, in-process autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SettingsManager as SdkSettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { loadCustomAgents } from "#src/config/custom-agents";
import { InterruptHandler, SessionLifecycleHandler, ToolStartHandler } from "#src/handlers/index";
import { createChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { createSubagentSession, type SubagentSessionDeps } from "#src/lifecycle/create-subagent-session";
import { buildParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { type NotificationDetails, NotificationManager } from "#src/observation/notification";
import { createNotificationRenderer } from "#src/observation/renderer";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { createSubagentRuntime } from "#src/runtime";
import { publishSubagentsService, unpublishSubagentsService } from "#src/service/service";
import { SubagentsServiceAdapter } from "#src/service/service-adapter";
import { detectEnv } from "#src/session/env";

import { resolveModel } from "#src/session/model-resolver";
import { buildAgentPrompt } from "#src/session/prompts";
import { deriveSubagentSessionDir } from "#src/session/session-dir";
import { SettingsManager } from "#src/settings";
import { AgentTool } from "#src/tools/agent-tool";
import { GetResultTool } from "#src/tools/get-result-tool";
import { SteerTool } from "#src/tools/steer-tool";
import { FsAgentFileOps } from "#src/ui/agent-file-ops";
import { AgentsMenuHandler } from "#src/ui/agent-menu";
import { AgentWidget } from "#src/ui/agent-widget";

export default function (pi: ExtensionAPI) {
  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>("subagent-notification", createNotificationRenderer());

  const registry = new AgentTypeRegistry(() => loadCustomAgents(process.cwd()));

  // ---- Runtime: all mutable extension state in one place ----
  const runtime = createSubagentRuntime();

  // ---- Notification system ----
  // Owns completion nudges and live-activity cleanup. The widget detects finished
  // agents itself (AgentWidget.update self-seeds), so NotificationManager has no
  // widget dependency — keeping the construction graph a cycle-free DAG.
  const notifications = new NotificationManager(
    (msg, opts) => pi.sendMessage(msg, opts),
    runtime.agentActivity,
  );

  // Settings: owns all three in-memory values and handles load/save/emit.
  // onMaxConcurrentChanged is wired to the limiter directly (closure captures by reference).
  const settings = new SettingsManager({
    emit: (event, payload) => pi.events.emit(event, payload),
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    onMaxConcurrentChanged: () => limiter.recheck(),
  });
  settings.load();

  // Observer: receives agent lifecycle notifications and dispatches events/notifications.
  const observer = new SubagentEventsObserver({
    emit: (channel, data) => pi.events.emit(channel, data),
    appendEntry: (customType, data) => pi.appendEntry(customType, data),
    notifications,
  });

  const subagentSessionDeps: SubagentSessionDeps = {
    io: {
      detectEnv,
      getAgentDir,
      createResourceLoader: (opts) => new DefaultResourceLoader(opts),
      deriveSessionDir: deriveSubagentSessionDir,
      createSessionManager: (cwd, dir) => SessionManager.create(cwd, dir),
      createSettingsManager: (cwd, dir) => SdkSettingsManager.create(cwd, dir),
      createSession: (opts) => createAgentSession(opts as any),
      assemblerIO: {
        buildAgentPrompt,
      },
    },
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    registry,
    lifecycle: createChildLifecyclePublisher((channel, data) => pi.events.emit(channel, data)),
  };

  // ConcurrencyLimiter: schedules background run thunks FIFO against the limit.
  // It knows nothing about agents or the manager — dependency direction is strictly manager → limiter.
  const limiter = new ConcurrencyLimiter(() => settings.maxConcurrent);

  const manager = new SubagentManager({
    createSubagentSession: (params) => createSubagentSession(params, subagentSessionDeps),
    baseCwd: process.cwd(),
    observer,
    limiter,
    getRunConfig: () => settings,
  });

  // Typed service published via Symbol.for() for cross-extension access.
  // Consumers: const { getSubagentsService } = await import("@gotgenes/pi-subagents");
  const service = new SubagentsServiceAdapter(manager, resolveModel, runtime);
  publishSubagentsService(service);

  const lifecycle = new SessionLifecycleHandler(
    runtime,
    manager,
    () => notifications.dispose(),
    unpublishSubagentsService,
  );

  pi.on("session_start", (event, ctx) => lifecycle.handleSessionStart(event, ctx));
  pi.on("session_before_switch", () => lifecycle.handleSessionBeforeSwitch());
  pi.on("session_shutdown", () => lifecycle.handleSessionShutdown());

  // Live widget: constructed after the manager (it polls listAgents()) and
  // injected directly into its consumers — no post-construction field write.
  const widget = new AgentWidget(manager, registry);

  // Grab UI context from first tool execution + clear lingering widget on new turn
  const toolStart = new ToolStartHandler(widget);
  pi.on("tool_execution_start", (event, ctx) => toolStart.handleToolExecutionStart(event, ctx));

  // Abort all subagents when the parent agent loop is interrupted (ESC).
  const interrupt = new InterruptHandler(manager);
  pi.on("turn_start", (_event, ctx) => interrupt.handleTurnStart(ctx));

  // ---- Agent tool ----

  pi.registerTool(new AgentTool(manager, runtime, widget, settings, registry, getAgentDir()).toToolDefinition());

  // ---- get_subagent_result tool ----

  pi.registerTool(new GetResultTool(manager, notifications, registry).toToolDefinition());

  // ---- steer_subagent tool ----

  pi.registerTool(new SteerTool(manager, pi.events).toToolDefinition());

  // ---- /agents interactive menu ----

  const agentsMenu = new AgentsMenuHandler(
    manager,
    registry,
    settings,
    new FsAgentFileOps(),
    join(getAgentDir(), "agents"),
    join(process.cwd(), ".pi", "agents"),
  );

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => {
      await agentsMenu.handle({
        ui: ctx.ui,
        modelRegistry: ctx.modelRegistry,
        parentSnapshot: buildParentSnapshot(ctx),
      });
    },
  });
}
