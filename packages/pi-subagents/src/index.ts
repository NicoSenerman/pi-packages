/* eslint-disable @typescript-eslint/no-unsafe-argument -- Pi SDK types are not fully exported; see upstream Pi SDK for type improvements */
/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
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
import { SessionLifecycleHandler, ToolStartHandler } from "#src/handlers/index";
import { AgentManager, type AgentManagerObserver } from "#src/lifecycle/agent-manager";
import { ConcreteAgentRunner, type RunnerIO } from "#src/lifecycle/agent-runner";
import { buildParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { GitWorktreeManager } from "#src/lifecycle/worktree";
import { buildEventData, type NotificationDetails, NotificationManager } from "#src/observation/notification";
import { createNotificationRenderer } from "#src/observation/renderer";
import { createSubagentRuntime } from "#src/runtime";
import { publishSubagentsService, unpublishSubagentsService } from "#src/service/service";
import { createSubagentsService } from "#src/service/service-adapter";
import { detectEnv } from "#src/session/env";

import { resolveModel } from "#src/session/model-resolver";
import { buildAgentPrompt } from "#src/session/prompts";
import { deriveSubagentSessionDir } from "#src/session/session-dir";
import { preloadSkills } from "#src/session/skill-loader";
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
  // runtime.widget is assigned after AgentManager construction; arrow closures
  // capture `runtime` by reference so they always read the current value.
  const notifications = new NotificationManager(
    (msg, opts) => pi.sendMessage(msg, opts),
    runtime.agentActivity,
    (id) => runtime.markFinished(id),
    () => runtime.update(),
  );

  // Settings: owns all three in-memory values and handles load/save/emit.
  // onMaxConcurrentChanged is wired after manager is constructed (closure captures by reference).
  const settings = new SettingsManager({
    emit: (event, payload) => pi.events.emit(event, payload),
    cwd: process.cwd(),
    onMaxConcurrentChanged: () => manager.notifyConcurrencyChanged(),
  });
  settings.load();

  // Observer: receives agent lifecycle notifications and dispatches events/notifications.
  const observer: AgentManagerObserver = {
    onAgentStarted(record) {
      // Emit started event when agent transitions to running (including from queue).
      pi.events.emit("subagents:started", {
        id: record.id,
        type: record.type,
        description: record.description,
      });
    },
    onAgentCompleted(record) {
      // Emit lifecycle event based on terminal status.
      const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
      const eventData = buildEventData(record);
      if (isError) {
        pi.events.emit("subagents:failed", eventData);
      } else {
        pi.events.emit("subagents:completed", eventData);
      }

      // Persist final record for cross-extension history reconstruction.
      pi.appendEntry("subagents:record", {
        id: record.id, type: record.type, description: record.description,
        status: record.status, result: record.result, error: record.error,
        startedAt: record.startedAt, completedAt: record.completedAt,
      });

      // Skip notification if result was already consumed via get_subagent_result.
      if (record.notification?.resultConsumed) {
        notifications.cleanupCompleted(record.id);
        return;
      }

      notifications.sendCompletion(record);
    },
    onAgentCompacted(record, info) {
      // Emit compacted event when agent's session compacts (preserves count on record).
      pi.events.emit("subagents:compacted", {
        id: record.id,
        type: record.type,
        description: record.description,
        reason: info.reason,
        tokensBefore: info.tokensBefore,
        compactionCount: record.compactionCount,
      });
    },
    onAgentCreated(record) {
      // Emit created event for background agents (before startAgent / queue drain).
      pi.events.emit("subagents:created", {
        id: record.id,
        type: record.type,
        description: record.description,
        isBackground: true,
      });
    },
  };

  const runnerIO: RunnerIO = {
    detectEnv,
    getAgentDir,
    createResourceLoader: (opts) => new DefaultResourceLoader(opts),
    deriveSessionDir: deriveSubagentSessionDir,
    createSessionManager: (cwd, dir) => SessionManager.create(cwd, dir),
    createSettingsManager: (cwd, dir) => SdkSettingsManager.create(cwd, dir),
    createSession: (opts) => createAgentSession(opts as any),
    assemblerIO: {
      preloadSkills,
      buildAgentPrompt,
    },
  };

  const manager = new AgentManager({
    runner: new ConcreteAgentRunner(runnerIO),
    worktrees: new GitWorktreeManager(process.cwd()),
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    registry,
    observer,
    getMaxConcurrent: () => settings.maxConcurrent,
    getRunConfig: () => settings,
  });

  // Typed service published via Symbol.for() for cross-extension access.
  // Consumers: const { getSubagentsService } = await import("@gotgenes/pi-subagents");
  const service = createSubagentsService(manager, resolveModel, runtime);
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

  // Live widget: show running agents above editor
  runtime.widget = new AgentWidget(manager, runtime.agentActivity, registry);

  // Grab UI context from first tool execution + clear lingering widget on new turn
  const toolStart = new ToolStartHandler(runtime);
  pi.on("tool_execution_start", (event, ctx) => toolStart.handleToolExecutionStart(event, ctx));

  // ---- Agent tool ----

  pi.registerTool(new AgentTool(manager, runtime, settings, registry, getAgentDir()).toToolDefinition());

  // ---- get_subagent_result tool ----

  pi.registerTool(new GetResultTool(manager, notifications, registry).toToolDefinition());

  // ---- steer_subagent tool ----

  pi.registerTool(new SteerTool(manager, pi.events).toToolDefinition());

  // ---- /agents interactive menu ----

  const agentsMenu = new AgentsMenuHandler(
    manager,
    registry,
    runtime.agentActivity,
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
