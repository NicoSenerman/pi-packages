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
import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { AgentManager, type AgentManagerObserver } from "./agent-manager.js";
import { getAgentConversation, resumeAgent, runAgent, steerAgent } from "./agent-runner.js";
import { AgentTypeRegistry } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { SessionLifecycleHandler, ToolStartHandler } from "./handlers/index.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { buildEventData, createNotificationSystem } from "./notification.js";
import { createNotificationRenderer } from "./renderer.js";
import { createSubagentRuntime } from "./runtime.js";
import { publishSubagentsService, unpublishSubagentsService } from "./service.js";
import { createSubagentsService } from "./service-adapter.js";
import { SettingsManager } from "./settings.js";
import { createAgentTool } from "./tools/agent-tool.js";
import { createGetResultTool } from "./tools/get-result-tool.js";
import { getModelLabelFromConfig } from "./tools/helpers.js";
import { createSteerTool } from "./tools/steer-tool.js";
import { type NotificationDetails } from "./types.js";
import { createAgentsMenuHandler } from "./ui/agent-menu.js";
import {
  AgentWidget,
  type UICtx,
} from "./ui/agent-widget.js";
import { GitWorktreeManager } from "./worktree.js";

export default function (pi: ExtensionAPI) {
  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>("subagent-notification", createNotificationRenderer());

  const registry = new AgentTypeRegistry(() => loadCustomAgents(process.cwd()));

  // ---- Runtime: all mutable extension state in one place ----
  const runtime = createSubagentRuntime();

  // ---- Notification system ----
  // runtime.widget is assigned after AgentManager construction; arrow closures
  // capture `runtime` by reference so they always read the current value.
  const notifications = createNotificationSystem({
    sendMessage: (msg, opts) => pi.sendMessage(msg, opts),
    agentActivity: runtime.agentActivity,
    markFinished: (id) => runtime.markFinished(id),
    updateWidget: () => runtime.updateWidget(),
  });

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
    onAgentCreated(_record) {
      // Placeholder — wired to emit subagents:created in a subsequent step.
    },
  };

  const manager = new AgentManager({
    runner: { run: runAgent, resume: resumeAgent },
    worktrees: new GitWorktreeManager(process.cwd()),
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    registry,
    observer,
    getMaxConcurrent: () => settings.maxConcurrent,
    getRunConfig: () => settings,
  });

  // Typed service published via Symbol.for() for cross-extension access.
  // Consumers: const { getSubagentsService } = await import("@gotgenes/pi-subagents");
  const service = createSubagentsService({
    manager,
    resolveModel,
    getCtx: () => runtime.currentCtx,
    getModelRegistry: () => (runtime.currentCtx?.ctx as { modelRegistry?: ModelRegistry } | undefined)?.modelRegistry,
  });
  publishSubagentsService(service);

  const lifecycle = new SessionLifecycleHandler(
    pi,
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

  /** Build the full type list text dynamically from the unified registry. */
  const buildTypeListText = () => {
    const defaultNames = registry.getDefaultAgentNames();
    const userNames = registry.getUserAgentNames();

    const defaultDescs = defaultNames.map((name) => {
      const cfg = registry.resolveAgentConfig(name);
      const modelSuffix = cfg.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      return `- ${name}: ${cfg.description}${modelSuffix}`;
    });

    const customDescs = userNames.map((name) => {
      const cfg = registry.resolveAgentConfig(name);
      return `- ${name}: ${cfg.description}`;
    });

    return [
      "Default agents:",
      ...defaultDescs,
      ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
      "",
      `Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.`,
    ].join("\n");
  };

  const typeListText = buildTypeListText();

  // ---- Agent tool ----

  pi.registerTool(defineTool(createAgentTool({
    manager: {
      spawn: (ctx, type, prompt, opts) => manager.spawn(ctx, type, prompt, opts),
      spawnAndWait: (ctx, type, prompt, opts) => manager.spawnAndWait(ctx, type, prompt, opts),
      resume: (id, prompt, signal) => manager.resume(id, prompt, signal),
      getRecord: (id) => manager.getRecord(id),
      getMaxConcurrent: () => settings.maxConcurrent,
      listAgents: () => manager.listAgents(),
    },
    widget: {
      setUICtx: (ctx) => runtime.setUICtx(ctx as UICtx),
      ensureTimer: () => runtime.ensureTimer(),
      update: () => runtime.updateWidget(),
      markFinished: (id) => runtime.markFinished(id),
    },
    agentActivity: runtime.agentActivity,
    emitEvent: (name, data) => pi.events.emit(name, data),
    registry,
    typeListText,
    availableTypesText: registry.getAvailableTypes().join(", "),
    agentDir: getAgentDir(),
    settings,
  })));

  // ---- get_subagent_result tool ----

  pi.registerTool(defineTool(createGetResultTool({
    getRecord: (id) => manager.getRecord(id),
    cancelNudge: (key) => notifications.cancelNudge(key),
    getConversation: (session) => getAgentConversation(session),
    registry,
  })));

  // ---- steer_subagent tool ----

  pi.registerTool(defineTool(createSteerTool({
    getRecord: (id) => manager.getRecord(id),
    emitEvent: (name, data) => pi.events.emit(name, data),
    steerAgent: (session, message) => steerAgent(session, message),
    queueSteer: (id, message) => manager.queueSteer(id, message),
  })));

  // ---- /agents interactive menu ----

  const agentsMenuHandler = createAgentsMenuHandler({
    manager: {
      listAgents: () => manager.listAgents(),
      getRecord: (id) => manager.getRecord(id),
      spawnAndWait: (ctx, type, prompt, opts) => manager.spawnAndWait(ctx, type, prompt, opts),
    },
    registry,
    agentActivity: runtime.agentActivity,
    getModelLabel: (type, modelRegistry) => {
      const cfg = registry.resolveAgentConfig(type);
      if (!cfg.model) return 'inherit';
      if (modelRegistry) {
        const resolved = resolveModel(cfg.model, modelRegistry);
        if (typeof resolved === 'string') return 'inherit';
      }
      return getModelLabelFromConfig(cfg.model);
    },
    settings,
    emitEvent: (name, data) => pi.events.emit(name, data),
    personalAgentsDir: join(getAgentDir(), 'agents'),
    projectAgentsDir: join(process.cwd(), '.pi', 'agents'),
  });

  pi.registerCommand('agents', {
    description: 'Manage agents',
    handler: async (_args, ctx) => { await agentsMenuHandler(ctx); },
  });
}
