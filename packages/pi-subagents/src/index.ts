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
  defineTool,
  type ExtensionAPI,
  getAgentDir,
  SettingsManager as SdkSettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { AgentManager, type AgentManagerObserver } from "./agent-manager";
import { createAgentRunner, getAgentConversation, type RunnerIO, steerAgent } from "./agent-runner";
import { AgentTypeRegistry } from "./config/agent-types";
import { loadCustomAgents } from "./config/custom-agents";
import { detectEnv } from "./env";
import { SessionLifecycleHandler, ToolStartHandler } from "./handlers/index";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory";
import { type ModelRegistry, resolveModel } from "./model-resolver";
import { buildEventData, type NotificationDetails, NotificationManager } from "./notification";
import { buildParentSnapshot } from "./parent-snapshot";
import { buildAgentPrompt } from "./prompts";
import { createNotificationRenderer } from "./renderer";
import { createSubagentRuntime } from "./runtime";
import { publishSubagentsService, unpublishSubagentsService } from "./service";
import { createSubagentsService } from "./service-adapter";
import { deriveSubagentSessionDir } from "./session-dir";
import { SettingsManager } from "./settings";
import { preloadSkills } from "./skill-loader";
import { createAgentTool } from "./tools/agent-tool";
import { createGetResultTool } from "./tools/get-result-tool";
import { getModelLabelFromConfig } from "./tools/helpers";
import { createSteerTool } from "./tools/steer-tool";
import { FsAgentFileOps } from "./ui/agent-file-ops";
import { createAgentsMenuHandler } from "./ui/agent-menu";
import {
  AgentWidget,
  type UICtx,
} from "./ui/agent-widget";
import { GitWorktreeManager } from "./worktree";

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
    () => runtime.updateWidget(),
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
      buildMemoryBlock,
      buildReadOnlyMemoryBlock,
      buildAgentPrompt,
    },
  };

  const manager = new AgentManager({
    runner: createAgentRunner(runnerIO),
    worktrees: new GitWorktreeManager(process.cwd()),
    exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
    registry,
    observer,
    getMaxConcurrent: () => settings.maxConcurrent,
    getRunConfig: () => settings,
  });

  // Typed service published via Symbol.for() for cross-extension access.
  // Consumers: const { getSubagentsService } = await import("@gotgenes/pi-subagents");
  const service = createSubagentsService(
    manager,
    resolveModel,
    () => runtime.currentCtx,
    () => (runtime.currentCtx?.ctx as { modelRegistry?: ModelRegistry } | undefined)?.modelRegistry,
  );
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

  // ---- Agent tool ----

  pi.registerTool(defineTool(createAgentTool({
    manager: {
      spawn: (snapshot, type, prompt, opts) => manager.spawn(snapshot, type, prompt, opts),
      spawnAndWait: (snapshot, type, prompt, opts) => manager.spawnAndWait(snapshot, type, prompt, opts),
      resume: (id, prompt, signal) => manager.resume(id, prompt, signal),
      getRecord: (id) => manager.getRecord(id),
      getMaxConcurrent: () => settings.maxConcurrent,
    },
    widget: {
      setUICtx: (ctx) => runtime.setUICtx(ctx as UICtx),
      ensureTimer: () => runtime.ensureTimer(),
      update: () => runtime.updateWidget(),
      markFinished: (id) => runtime.markFinished(id),
    },
    agentActivity: runtime.agentActivity,
    registry,
    agentDir: getAgentDir(),
    settings,
    buildSnapshot: (inheritContext) =>
      buildParentSnapshot(
        runtime.currentCtx?.ctx as import("@earendil-works/pi-coding-agent").ExtensionContext,
        inheritContext,
      ),
    getModelInfo: () => ({
      parentModel: (runtime.currentCtx?.ctx as any)?.model,
      modelRegistry: (runtime.currentCtx?.ctx as any)?.modelRegistry,
    }),
    getSessionInfo: () => ({
      parentSessionFile: (runtime.currentCtx?.ctx as any)?.sessionManager?.getSessionFile() ?? "",
      parentSessionId: (runtime.currentCtx?.ctx as any)?.sessionManager?.getSessionId() ?? "",
    }),
  })));

  // ---- get_subagent_result tool ----

  pi.registerTool(defineTool(createGetResultTool(
    (id) => manager.getRecord(id),
    (key) => notifications.cancelNudge(key),
    (session) => getAgentConversation(session),
    registry,
  )));

  // ---- steer_subagent tool ----

  pi.registerTool(defineTool(createSteerTool(
    (id) => manager.getRecord(id),
    (name, data) => pi.events.emit(name, data),
    (session, message) => steerAgent(session, message),
    (id, message) => manager.queueSteer(id, message),
  )));

  // ---- /agents interactive menu ----

  const agentsMenuHandler = createAgentsMenuHandler({
    manager: {
      listAgents: () => manager.listAgents(),
      getRecord: (id) => manager.getRecord(id),
      spawnAndWait: (snapshot, type, prompt, opts) => manager.spawnAndWait(snapshot, type, prompt, opts),
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
    fileOps: new FsAgentFileOps(),
    personalAgentsDir: join(getAgentDir(), 'agents'),
    projectAgentsDir: join(process.cwd(), '.pi', 'agents'),
  });

  pi.registerCommand('agents', {
    description: 'Manage agents',
    handler: async (_args, ctx) => {
      await agentsMenuHandler({
        ui: ctx.ui,
        modelRegistry: ctx.modelRegistry,
        parentSnapshot: buildParentSnapshot(ctx),
      });
    },
  });
}
