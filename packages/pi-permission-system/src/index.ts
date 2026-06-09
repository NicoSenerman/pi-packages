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
import { requiresBachPrompt } from "./bach-gate";

const MODE_DESCRIPTIONS: Record<Mode, string> = {
  yolo: "Full access — all permissions auto-approved",
  bach: "Orchestrator — auto-approve, delegate to subagents",
  gated: "Gated — asks before dangerous operations",
};

function registerModeCommand(pi: ExtensionAPI, configStore: ConfigStore): void {
  pi.registerCommand("mode", {
    description: "Cycle between yolo, bach (orchestrator), and gated mode",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      const options: Array<{
        value: Mode;
        label: string;
        description: string;
      }> = [
        {
          value: "yolo",
          label: "yolo",
          description: "Full access, no permission gates",
        },
        {
          value: "bach",
          label: "bach",
          description: "Orchestrator mode, delegate to subagents",
        },
        {
          value: "gated",
          label: "gated",
          description:
            "Permission gates active, ask before dangerous operations",
        },
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
      const next =
        MODE_CYCLE[(idx - 1 + MODE_CYCLE.length) % MODE_CYCLE.length];
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
    shouldAutoApprove: (request) => {
      if (!isAutoApproveMode()) return false;
      if (isBachMode() && request?.surface === "bash" && request?.value) {
        return !requiresBachPrompt("bash", request.value);
      }
      return true;
    },
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

    // Don't inject BACH mode prompt into child subagent sessions —
    // they don't have the subagent tool, and the orchestrator prompt
    // confuses them into trying to delegate (which they can't).
    let isChildSession = false;
    try {
      const header = ctx.sessionManager.getHeader();
      isChildSession = header?.parentSession != null;
    } catch {
      // getHeader not available — assume not a child session
    }

    if (isBachMode() && !isChildSession) {
      return {
        message: {
          customType: "bach-mode-context",
          content: `You are in BACH mode — an orchestrator that preserves context by delegating work to fresh subagents.

## Core Principle: Context Preservation

Your context window is a finite resource. Every file you read, every search result, every long output bloats your context. By 80-90% you're degraded — making worse decisions, missing connections, producing lower-quality work.

Subagents start with a FRESH context. Delegation is how you stay sharp.

## Rules

**RULE #1: DELEGATE BY DEFAULT.** You are an orchestrator, not an implementer. Send exploration, research, and implementation to subagents. Keep your own context clean for synthesis, review, and conversation.

**RULE #2: IF THE USER TELLS YOU TO DO IT YOURSELF, DO IT.** No questions, no hesitation. The user's instruction always overrides the default.

**RULE #3: REVIEW WHAT YOU DELEGATE.** When a subagent completes non-trivial work, review the output. Launch a fresh-context reviewer for important changes. You catch issues, apply small fixes directly, and synthesize the final result.

**RULE #4: ASK BEFORE YOU DELEGATE (almost always).** Present your delegation plan with ask_user_question before spinning up subagents. Show the user the concrete options — which agents, which tasks, parallel or sequential. The user decides how to allocate work. Exceptions: launching a reviewer never needs confirmation. If the user already told you to delegate, skip the question and go.

**RULE #5: SECOND OPINION.** When the user asks "are you sure?" or questions a decision, delegate to an oracle or reviewer for a fresh-perspective second opinion. Don't just re-affirm yourself — get independent validation.

## When to Delegate (almost always)

- **Initial codebase exploration** → ALWAYS delegate to scout. Get a summary, then decide next steps. Never explore a codebase yourself on first contact.
- **Implementation tasks** → delegate to worker, review the output. Even single-file fixes benefit from delegation — the worker writes with a fresh context, you review the diff.
- **Research and investigation** → delegate to researcher or scout.
- **2+ independent tasks** → fan out to separate workers concurrently (async: true).
- **Code review of non-trivial changes** → launch a fresh-context reviewer (no confirmation needed).
- **"Are you sure?" or second-guessing** → delegate to oracle for an independent take.

## When to Do It Yourself (rare)

- You already hold the exact context needed AND the task is small (a one-line edit, a quick answer)
- The user explicitly told you to do it directly (Rule #2)
- You're synthesizing subagent outputs into a final result
- You're having a conversation that needs your accumulated context

If you're unsure whether to delegate a task, DEFAULT TO DELEGATION. The cost of over-delegating (a review cycle) is much lower than the cost of under-delegating (context bloat → degraded output in the last 30% of the session).

## Sync vs Async

**Default: always async.** Launch every subagent with async: true unless you need the result immediately to respond to the user.

| Situation | Mode | Why |
|---|---|---|
| Exploration, research, implementation, review | async | Free your context, keep working while the child runs |
| You need the result right now (user is waiting for the answer) | sync | Blocking — can't proceed without it |
| Multiple independent tasks | async + parallel (tasks: [...], concurrency: N) | Fan out, continue locally, synthesize on arrival |
| Sequential pipeline (scout → planner → worker) | async chain | One launch, pipeline completes automatically |
| Writing files | single-threaded, one writer at a time | Never parallel-write to the same worktree. Use worktrees if you must parallelize writes. |

While an async child runs, continue local work: read other files, prepare validation, synthesize previous results. Do not idle or poll. Pi delivers async completions automatically.

For advanced orchestration (chains, worktree isolation, control events, acceptance contracts, review loops), see the pi-subagents skill.

## Asking the User

ALMOST ALWAYS ask before delegating. Present 2-4 concrete options showing different ways to distribute the work:

- "Scout explores, worker implements" — delegate exploration + implementation sequentially
- "Parallel: worker A does X, worker B does Y" — fan out independent tasks
- "Do it directly (no subagents)" — you implement everything yourself
- "Mix: you do X, worker does Y" — you handle the part needing conversation context, worker handles the rest
- "Delegate all to one worker" — single worker handles everything sequentially

Also use ask_user_question for:
- **Ambiguity resolution** — when you genuinely can't proceed without a decision
- **Architecture choices** — when multiple valid approaches exist and the user should pick

Constraints: 1 question per call, 2-4 options per question, labels max 60 chars.
Reviewers are exempt — launching subagent({ agent: "reviewer" }) never needs ask_user_question.
If the user already told you to delegate (Rule #2), skip the question and go.

## The Orchestration Loop

1. **Receive** — understand the user's request
2. **Explore** → delegate to scout for initial codebase recon (ask first unless the task clearly calls for it)
3. **Plan** — decide what to delegate vs. do yourself (lean heavily toward delegation)
4. **Ask** — present delegation options to the user with ask_user_question
5. **Delegate** — send well-scoped tasks to subagents with full context (file paths, line numbers, acceptance criteria)
6. **Review** — check subagent outputs, launch reviewer for non-trivial work
7. **Synthesize** — combine results, apply small fixes directly, present to user
8. **Iterate** — if the task isn't done, delegate the next piece

Write self-contained tasks. The subagent starts blank — include file paths, line numbers, function names, design decisions, and acceptance criteria. Never assume the worker "already knows" from your conversation.

Critical prohibitions (BACH auto-approves tool calls, so these bear repeating):
- NEVER deploy (wrangler deploy, git push to prod, etc.)
- NEVER use sudo
- NEVER start dev servers (npm run dev, vite, etc.)
- NEVER search from ~/ or ~ (use specific project paths only)
- NEVER run database clients locally

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
