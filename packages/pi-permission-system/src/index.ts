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
  isAutoApproveMode,
  isBachMode,
  setCurrentMode,
  MODE_CYCLE,
  type Mode,
} from "./yolo-mode";

const MODE_DESCRIPTIONS: Record<Mode, string> = {
  yolo: "Full access — all permissions auto-approved",
  bach: "Orchestrator — auto-approve, delegate to subagents",
  gated: "Gated — asks before dangerous operations",
};

function registerModeCommand(
  pi: ExtensionAPI,
  configStore: ConfigStore,
): void {
  pi.registerCommand("mode", {
    description: "Cycle between yolo, bach (orchestrator), and gated mode",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const options: Array<{ value: Mode; label: string; description: string }> = [
        { value: "yolo", label: "yolo", description: "Full access, no permission gates" },
        { value: "bach", label: "bach", description: "Orchestrator mode, delegate to subagents" },
        { value: "gated", label: "gated", description: "Permission gates active, ask before dangerous operations" },
      ];
      const filtered = options.filter((o) => o.value.startsWith(normalized));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const current = getCurrentMode();
      const arg = args.trim().toLowerCase() as Mode;

      let next: Mode;
      if (arg === "yolo" || arg === "bach" || arg === "gated") {
        next = arg;
      } else {
        // Cycle: yolo → bach → gated → yolo
        const idx = MODE_CYCLE.indexOf(current);
        next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
      }

      if (next === current && !arg) {
        const idx = MODE_CYCLE.indexOf(current);
        next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
      }

      setCurrentMode(next, ctx, configStore.current());

      const label = next.toUpperCase();
      ctx.ui.notify(`${label} mode: ${MODE_DESCRIPTIONS[next]}`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "Cycle yolo/bach/gated mode forward",
    handler: async (ctx) => {
      const current = getCurrentMode();
      const idx = MODE_CYCLE.indexOf(current);
      const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
      setCurrentMode(next, ctx, configStore.current());

      const label = next.toUpperCase();
      ctx.ui.notify(`${label} mode`, "info");
    },
  });

  pi.registerShortcut(Key.ctrlAlt("n"), {
    description: "Cycle yolo/bach/gated mode backward",
    handler: async (ctx) => {
      const current = getCurrentMode();
      const idx = MODE_CYCLE.indexOf(current);
      const next = MODE_CYCLE[(idx - 1 + MODE_CYCLE.length) % MODE_CYCLE.length];
      setCurrentMode(next, ctx, configStore.current());

      const label = next.toUpperCase();
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
      isAutoApproveMode(),
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

    if (isBachMode()) {
      return {
        message: {
          customType: "bach-mode-context",
          content: `BACH MODE RULE #1: DO IT YOURSELF. Subagents are the exception, not the default.

BACH MODE RULE #2: IF THE USER TELLS YOU TO DELEGATE, DO IT. No ask_user_question, no hesitation. The user's instruction always overrides the default.

You are in BACH mode. Your default action is to implement directly. You only delegate to subagents when there is genuine parallelism or when delegating frees you to do other work.

BEFORE calling the subagent tool, ask yourself: "Are there 2+ independent tasks that can run in parallel? OR is this a self-contained research/investigation task?" If the answer is NO to both, do not call subagent. Just do the work.

BEFORE delegating ANY work to a subagent (except when the user told you to, see Rule #2), use the ask_user_question tool to present your delegation strategy and let the user decide. Tailor the options to the actual task breakdown:
- "Parallel: Task A → worker, Task B → worker" — fan out independent tasks to separate subagents concurrently
- "All to one subagent" — single worker handles everything sequentially
- "Do it directly (no subagents)" — the main agent implements everything itself, no delegation
- "Mix: main agent does X, delegate Y" — main agent handles the part needing conversation context, worker handles the rest
Pick the option labels and descriptions that match the situation — these are examples, not a fixed template. The user should see the actual task assignments in each option, not generic labels.
ask_user_question is ONLY for delegation decisions. Do not use it for task scoping, approach selection, or bikeshedding — make the decision yourself.
ask_user_question constraints: 1 question per call, 2-4 options per question, labels max 60 chars.
Reviewers are exempt from this confirmation — launching subagent({ agent: "reviewer" }) never needs ask_user_question.

Common anti-pattern — DO NOT do this unless the user explicitly asks:
  User reports a bug → you understand the fix → you delegate to a worker
  This is wasteful. You have the context, you understand the fix, just fix it.
  Delegating a single task when you already have context is always slower.

When subagents ARE appropriate:
- 2+ genuinely independent tasks (fix auth.ts AND fix api.ts simultaneously) — parallel fan-out
- Self-contained research or investigation (delegate to researcher or scout) — frees you to do other work while the subagent investigates
- Fresh-context code review of non-trivial changes (subagent({ agent: "reviewer", context: "fresh" })) — no ask_user_question needed for reviewers
- Long-running tasks where the main agent can continue other work asynchronously (async: true)

When subagents are NOT appropriate:
- One task (a bug fix, a feature, a refactor) — just do it
- Sequential work where later steps depend on earlier outputs
- You already have full conversation context — forking is overhead
- A single coherent change across related files

Critical prohibitions (BACH auto-approves tool calls, so these bear repeating):
- NEVER deploy (wrangler deploy, git push to prod, etc.)
- NEVER use sudo
- NEVER start dev servers (npm run dev, vite, etc.)
- NEVER search from ~/ or ~ (use specific project paths only)
- NEVER run database clients locally

Workflow:
1. Analyze — identify whether tasks are parallelizable or sequential
2. Do sequential work yourself — you already have the context
3. If 2+ independent tasks exist, ask_user_question first, then fan out concurrently (async: true)
4. Review — for non-trivial subagent work, launch a fresh-context reviewer (no confirmation needed for reviewers)
5. Synthesize — combine outputs, apply small fixes directly

Write self-contained tasks. The subagent starts blank — include file paths, line numbers, function names, design decisions, and acceptance criteria. Never assume the worker "already knows" from your conversation.

For orchestration patterns (feature flow, acceptance contracts, review loops), see the Subagents section of AGENTS.md. Key agent names: worker, reviewer, scout, researcher, planner, oracle. Full list: run subagent({ action: "list" }).

Subagents use the global default model from ~/.pi/settings.json, NOT your current session model. If that differs, pass model: explicitly. To find available models, read ~/.pi/agent/models.json (keys are provider names, each has a models array with id fields). Do NOT pass thinking: or reasoning parameters — use the model's default behavior.`,
          display: false,
        },
      };
    }

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
