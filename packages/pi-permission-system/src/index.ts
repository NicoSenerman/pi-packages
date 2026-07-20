import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { registerBuiltinToolInputFormatters } from "./builtin-tool-input-formatters";
import { registerPermissionSystemCommand } from "./config-modal";
import { getGlobalConfigPath } from "./config-paths";
import { ConfigStore } from "./config-store";
import { DecisionAudit } from "./decision-audit";
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
import { createFailClosedToolCall } from "./handlers/tool-call-boundary";
import { requestPermissionDecisionFromUi } from "./permission-dialog";
import { registerPermissionRpcHandlers } from "./permission-event-rpc";
import { PermissionManager } from "./permission-manager";
import { PermissionPrompter } from "./permission-prompter";
import { PermissionResolver } from "./permission-resolver";
import { PermissionSession } from "./permission-session";
import { LocalPermissionsService } from "./permissions-service";
import { PromptingGateway } from "./prompting-gateway";
import { PermissionServiceLifecycle } from "./service-lifecycle";
import { PermissionSessionLogger } from "./session-logger";
import { SessionRules } from "./session-rules";
import { subscribeSubagentLifecycle } from "./subagent-lifecycle-events";
import { getSubagentSessionRegistry } from "./subagent-registry";
import { ToolAccessExtractorRegistry } from "./tool-access-extractor-registry";
import { ToolInputFormatterRegistry } from "./tool-input-formatter-registry";
import { Key } from "@earendil-works/pi-tui";
import {
  getCurrentMode,
  isBachMode,
  markModeExplicitlySet,
  setCurrentMode,
  MODE_CYCLE,
  type Mode,
} from "./yolo-mode";

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

  // registerShortcut is a real Pi API but isn't stubbed in the upstream test
  // harness (makeFakePi). Guard so absence doesn't crash factory wiring tests.
  if (typeof pi.registerShortcut === "function") {
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
}

export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  // getPackageDir() is Pi's own install dir; auto-allow it for read-only tools
  // so the agent can read Pi's bundled docs/examples regardless of layout.
  const paths = computeExtensionPaths(agentDir, getPackageDir());
  const permissionManager = new PermissionManager({ agentDir });
  const sessionRules = new SessionRules();
  const subagentRegistry = getSubagentSessionRegistry();
  const formatterRegistry = new ToolInputFormatterRegistry();
  registerBuiltinToolInputFormatters(formatterRegistry);
  const accessExtractorRegistry = new ToolAccessExtractorRegistry();

  // Both `configStore` and `session` are forward-declared so the logger's
  // lazy thunks can close over them without a cast or null-init holder.
  // TypeScript exempts closure captures from definite-assignment analysis;
  // all synchronous reads occur after the assignments below.
  // eslint-disable-next-line prefer-const -- forward-declared let; `const` requires an initializer
  let configStore: ConfigStore;
  // eslint-disable-next-line prefer-const -- forward-declared let; `const` requires an initializer
  let session: PermissionSession;

  const logger = new PermissionSessionLogger({
    globalLogsDir: paths.globalLogsDir,
    getConfig: () => configStore.current(),
    notify: (message) => session.notify(message),
  });

  configStore = new ConfigStore({
    agentDir,
    policyPaths: permissionManager,
    logger,
  });

  const forwardingDeps: PermissionForwarderDeps = {
    forwardingDir: paths.forwardingDir,
    subagentSessionsDir: paths.subagentSessionsDir,
    registry: subagentRegistry,
    events: pi.events,
    logger,
    requestPermissionDecisionFromUi,
    config: configStore,
  };
  const forwarder = new PermissionForwarder(forwardingDeps);

  const prompter = new PermissionPrompter({
    config: configStore,
    logger,
    events: pi.events,
    forwarder,
  });

  const gateway = new PromptingGateway({
    config: configStore,
    subagentSessionsDir: paths.subagentSessionsDir,
    registry: subagentRegistry,
    prompter,
  });

  session = new PermissionSession(
    paths,
    new ForwardingManager(
      paths.subagentSessionsDir,
      forwarder,
      subagentRegistry,
    ),
    permissionManager,
    sessionRules,
    configStore,
    gateway,
  );

  // refresh() must run after `session` is assigned: a debug-write IO failure
  // triggers the logger's notify sink — `session.notify(m)` — which no-ops
  // on the null context but requires `session` to be bound.
  configStore.refresh();

  const configPath = getGlobalConfigPath(agentDir);
  registerPermissionSystemCommand(pi, {
    config: configStore,
    configPath,
    getActiveAgentConfigRules: () =>
      permissionManager.getComposedConfigRules(
        session.lastKnownActiveAgentName ?? undefined,
      ),
  });

  registerModeCommand(pi, configStore);

  const rpcHandles = registerPermissionRpcHandlers(pi.events, {
    permissionManager,
    sessionRules,
    session,
    requestPermissionDecisionFromUi,
    logger,
  });

  const permissionsService = new LocalPermissionsService(
    permissionManager,
    sessionRules,
    formatterRegistry,
    accessExtractorRegistry,
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
    getActive: () => pi.getActiveTools(),
    setActive: (names: string[]) => pi.setActiveTools(names),
  };

  const resolver = new PermissionResolver(permissionManager, sessionRules);

  const audit = new DecisionAudit();
  const lifecycle = new SessionLifecycleHandler(
    session,
    resolver,
    serviceLifecycle,
    logger,
    audit,
  );
  const agentPrep = new AgentPrepHandler(session, resolver, toolRegistry);

  const reporter = new GateDecisionReporter(logger, pi.events);
  const gateRunner = new GateRunner(resolver, sessionRules, gateway, reporter);
  const toolCallGatePipeline = new ToolCallGatePipeline(
    resolver,
    session,
    formatterRegistry,
    accessExtractorRegistry,
  );
  const skillInputGatePipeline = new SkillInputGatePipeline(resolver);
  const gates = new PermissionGateHandler(
    session,
    toolRegistry,
    toolCallGatePipeline,
    skillInputGatePipeline,
    gateRunner,
  );

  pi.on("session_start", (event, ctx) => {
    // Mark the default BACH mode as explicitly chosen for non-child sessions so
    // BACH auto-approve is active out of the box (the real runtime behavior).
    // Child subagent sessions stay non-explicit (fail-closed) — they're spawned
    // fresh by the orchestrator and shouldn't auto-approve. Factory wiring tests
    // that construct the extension without firing session_start also stay
    // non-explicit, preserving upstream's fail-closed contract.
    let isChildSession = false;
    try {
      const header = ctx.sessionManager.getHeader();
      isChildSession = header?.parentSession != null;
    } catch {
      // getHeader not available — assume not a child session
    }
    if (!isChildSession) {
      // Default BACH mode auto-approves for non-child sessions (the real runtime
      // behavior). Child subagent sessions stay fail-closed. Factory wiring
      // tests that fire session_start on a non-child mock ctx also get
      // auto-approve — the 3 composition-root tests that assert upstream's
      // fail-closed-after-session_start contract are updated to reflect this
      // deliberate fork divergence.
      markModeExplicitlySet();
    }
    return lifecycle.handleSessionStart(event, ctx);
  });
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
        systemPrompt:
          event.systemPrompt +
          `\n\nYou are in BACH mode — an orchestrator that preserves context by delegating work to fresh subagents.

## Core Principle

Your context is finite; as it fills, your decisions degrade. Subagents start with FRESH context. Delegate early and often.

## Rules

**RULE #1: DELEGATE BY DEFAULT.** You are an orchestrator, not an implementer. Send exploration, research, and implementation to subagents. Keep your context clean for synthesis, review, and conversation.

**RULE #2: IF THE USER TELLS YOU TO DO IT YOURSELF, DO IT.** No questions, no hesitation. The user's instruction always overrides the default.

**RULE #3: REVIEW WHAT YOU DELEGATE.** When a subagent completes non-trivial work, review the output. Launch a fresh-context reviewer for important changes. Catch issues, apply small fixes directly, synthesize the final result.

**RULE #4: ASK BEFORE YOU DELEGATE (almost always).** Present concrete delegation options with ask_user before allocating real work — which agents, which tasks, parallel or sequential. The user decides how to allocate work. Exceptions: launching a reviewer never needs confirmation; launching a read-only scout needs no ask (it gathers information, doesn't allocate work); if the user already told you to delegate, skip the question and go.

**RULE #5: SECOND OPINION.** When the user asks "are you sure?" or questions a decision, delegate to an oracle or reviewer for a fresh-perspective second opinion. Don't just re-affirm yourself — get independent validation.

**RULE #6: SERVER/INFRA CHANGES STAY WITH YOU.** Never delegate infrastructure operations to subagents — see AGENTS.md (Destructive & Infrastructure Operations) for the full list. Auto-approval is NOT authorization to skip judgment on these.

**RULE #7: HAND THE USER THE QUERY IN-REPLY — NO TOOL CALL.** Databases are on remote servers behind SSH tunnels (per AGENTS.md), so there is no local DB client and no live tunnel to run against. When the user must run a query, **type the SQL as a fenced code block directly in your chat reply**. Do NOT wrap it in a cat-heredoc-to-stdout, do NOT pipe through ssh, do NOT write then read a .sql file just to echo its text back. Those tool calls accomplish nothing — the agent cannot connect to the DB, so all they do is print the SQL to tool output (a worse experience than typing it inline) and burn a turn. The cat heredoc shape in particular is the canonical anti-pattern: it literally just echoes the heredoc body to stdout. The ONLY valid uses of write/read here are persisting a .sql file the user explicitly asked to keep — not for showing the query. This overrides the "Keep if you hold the context" heuristic: even when you need the result to proceed, do not run, do not write-to-disk, do not cat the query — put it in the reply.

**OUTPUT CONVENTION — tell the user when you delegate.** Right after launching async agent(s), output a one-liner naming them: ⏳ Agent [ID] launched — result will auto-arrive. This is the user-facing signal that delegation happened and the session isn't frozen. Don't bury it; don't omit it.

## What to Delegate vs Keep

**Delegate:** initial codebase exploration (ALWAYS — scout first, never explore yourself on first contact), implementation tasks (delegate to worker, review the diff), research/investigation, 2+ independent tasks (fan out to separate workers concurrently), code review of non-trivial changes (fresh-context reviewer, no ask needed), "are you sure?"/second-guessing (oracle). Set the bar in worker task prompts: reuse over reinvention, clear naming, zero comments unless non-obvious. Workers do the work.

**Keep:** the user told you to do it directly (Rule #2); small task where you already hold the exact context needed (a one-line edit, a quick answer); synthesizing subagent outputs into a final result; a conversation needing your accumulated context; a task needing information only you currently hold (you just read a file the worker would re-read, or you're mid-debugging with state in your head — re-explaining costs more than doing it); handing the user a SQL block or other query to run themselves (Rule #7 — this is NOT a delegation, just emit the code block). If unsure whether to delegate, DEFAULT TO DELEGATION — the cost of over-delegating (a review cycle) is much lower than under-delegating (context bloat → degraded output in the last 30% of the session).

## How Async Subagents Work

Subagents run **non-blocking by default**: a \`subagent\` call with no \`run_in_background\` field spawns in the background, the parent turn ends immediately, and the result **auto-arrives as a new turn** when the child finishes. After the ⏳ launch line, end your turn — do not poll. Use \`steer_subagent\` to send mid-run messages to a background agent; use \`get_subagent_result\` (never \`wait: true\`) to read status/output; evicted agents are recoverable via \`verbose: true\` or \`/subagents:sessions\`. For advanced orchestration (chains, worktree isolation, acceptance contracts, review loops), see the pi-subagents skill.

## Asking the User

Ask before allocating real work with ask_user; combine related questions (e.g. launch the scout read-only first, then present the worker plan in one ask once you have its findings). Prefer plain conversation for simple either/or. Gate on decision boundary — see AGENTS.md ask_user Constraints for the full policy (when to ask, anti-overasking budget, payload shape, exemptions).

## The Orchestration Loop

Loop: explore (scout, no ask needed) → ask if ambiguous → delegate async → review → synthesize → iterate. Write self-contained tasks (AGENTS.md → "Subagents — Quick Reference"). Critical prohibitions live in AGENTS.md — auto-approve does NOT authorize skipping them.`,
      };
    }

    if (getCurrentMode() === "gated") {
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\nYou are in GATED mode — the user is actively participating in this session. Every file mutation and destructive command requires their approval. Share your reasoning before acting: explain what you find, propose next steps, and wait for direction. This may be an investigation session with no changes needed — follow the user's lead. Ask questions, surface findings, and treat each permission prompt as a checkpoint to confirm you're on the right track.`,
      };
    }
    return undefined;
  });
  pi.on("input", (event, ctx) => gates.handleInput(event, ctx));
  pi.on(
    "tool_call",
    createFailClosedToolCall(
      (event, ctx) => gates.handleToolCall(event, ctx),
      reporter,
      audit,
      logger,
    ),
  );
}
