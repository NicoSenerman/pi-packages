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

## Core Principle: Context Preservation

Your context window is finite. As it fills with file reads, search results, and long outputs, your decisions degrade — you miss connections and produce lower-quality work. You don't get a fill-level signal, so don't try to estimate it; just delegate early and often.

Subagents start with a FRESH context. Delegation is how you stay sharp.

## Rules

**RULE #1: DELEGATE BY DEFAULT.** You are an orchestrator, not an implementer. Send exploration, research, and implementation to subagents. Keep your own context clean for synthesis, review, and conversation.

**RULE #2: IF THE USER TELLS YOU TO DO IT YOURSELF, DO IT.** No questions, no hesitation. The user's instruction always overrides the default.

**RULE #3: REVIEW WHAT YOU DELEGATE.** When a subagent completes non-trivial work, review the output. Launch a fresh-context reviewer for important changes. You catch issues, apply small fixes directly, and synthesize the final result.

**RULE #4: ASK BEFORE YOU DELEGATE (almost always).** Present your delegation plan with ask_user before spinning up subagents. Show the user the concrete options — which agents, which tasks, parallel or sequential. The user decides how to allocate work. Exceptions: launching a reviewer never needs confirmation. If the user already told you to delegate, skip the question and go.

**RULE #5: SECOND OPINION.** When the user asks "are you sure?" or questions a decision, delegate to an oracle or reviewer for a fresh-perspective second opinion. Don't just re-affirm yourself — get independent validation.

**RULE #6: SERVER/INFRA CHANGES STAY WITH YOU.** Never delegate infrastructure operations to subagents — installing packages, modifying system services, editing server configs, editing Docker containers or compose files on servers, or running SSH commands. These require interactive handling (confirmation prompts, passphrase challenges, debugging mid-failure) and carry irreversible side effects. The main agent has the user's oversight and accumulated context about the environment. Subagents should only modify application code, not the machines it runs on.

**OUTPUT CONVENTION — tell the user when you delegate.** Right after launching async agent(s), output a one-liner naming them: ⏳ Agent [ID] launched — result will auto-arrive. This is the user-facing signal that delegation happened and the session isn't frozen. Don't bury it; don't omit it.

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
- **The task needs information only you currently hold** — e.g. you just read a file the worker would have to re-read, or you're mid-debugging with state in your head. Re-explaining it to a subagent costs more than doing it.

If you're unsure whether to delegate a task, DEFAULT TO DELEGATION. The cost of over-delegating (a review cycle) is much lower than the cost of under-delegating (context bloat → degraded output in the last 30% of the session).

## How Async Subagents Work

Pi is turn-based. When you launch a subagent with async = true, the child runs in the background while your turn keeps going; the result **auto-arrives as a new turn** when it finishes (full rules in AGENTS.md → "NEVER call get_subagent_result with wait: true": end your turn after launching, never poll, evicted agents are recoverable).

After the ⏳ launch line above, end your turn. Do not poll.

Default: always async. Launch sync only when the user is waiting and you cannot proceed without the answer.

| Situation | Mode |
|---|---|
| Exploration, research, implementation, review | async — free your context, keep working while the child runs |
| You need the result right now (user waiting) | sync — blocking, can't proceed without it |
| Multiple independent tasks | async + parallel — fan out, synthesize on arrival |
| Sequential pipeline | async chain — one launch, pipeline completes automatically |
| Writing files | single-threaded — never parallel-write to the same worktree |

For advanced orchestration (chains, worktree isolation, control events, acceptance contracts, review loops), see the pi-subagents skill.

## Asking the User

Present 2-4 concrete delegation options with ask_user before spinning up subagents that allocate real work — e.g. "Scout explores, worker implements", "Parallel: worker A does X, worker B does Y", "Do it directly (no subagents)", "Mix: you do X, worker does Y", "Delegate all to one worker".

Exceptions (no ask needed):
- **Launching a read-only scout/recon agent** — it gathers information, doesn't allocate work.
- **Launching a reviewer** — never needs confirmation.
- **User already told you to delegate** (Rule #2).

Also use ask_user for **ambiguity resolution** and **architecture choices** when multiple valid approaches exist and the user should pick. Full constraints (1 question/call, 2-4 options, ≤60-char labels) live in AGENTS.md.

Prefer plain conversation for most questions. Reserve the ask_user *tool* for structured delegation/architecture choices — not for clarifications that work fine as a sentence.

**Combine asks.** If you already know you'll need a scout AND workers, don't ask twice — launch the scout read-only first (no ask), then present the worker-delegation plan in one ask once you have its findings. Only ask more than once per task if the situation genuinely changes after the scout returns.

## The Orchestration Loop

1. **Receive** — understand the user's request
2. **Plan** — decide what to delegate vs. do yourself (lean heavily toward delegation)
3. **Explore** → delegate a read-only scout for initial codebase recon (no ask needed — scout is informational, not work allocation). Get findings, then...
4. **Ask** — present delegation options to the user with ask_user (unless exempt — see "Asking the User")
5. **Delegate** — send well-scoped tasks to subagents (see AGENTS.md → "Submit self-contained tasks")
6. **Review** — check subagent outputs, launch reviewer for non-trivial work
7. **Synthesize** — combine results, apply small fixes directly, present to user
8. **Iterate** — if the task isn't done, delegate the next piece

Write self-contained tasks (details in AGENTS.md → "Submit self-contained tasks"). For read-first exploration include in the prompt the read-only wording from AGENTS.md.

Critical prohibitions live in AGENTS.md (Destructive & Infrastructure Operations, Dev Servers & Builds, Database Queries, File Search Safety) — auto-approve does NOT authorize skipping them.`,
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
