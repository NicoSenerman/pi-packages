/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildParentContext, extractText } from "./context.js";
import { detectEnv } from "./env.js";
import { assembleSessionConfig } from "./session-config.js";
import { deriveSubagentSessionDir } from "./session-dir.js";
import type { ShellExec, SubagentType, ThinkingLevel } from "./types.js";

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"];

/**
 * Filter the session's active tool names according to extension/denylist rules.
 *
 * Run twice — once before `bindExtensions` (filters built-in tools) and once after
 * (filters extension-registered tools, which only join the active set during
 * `bindExtensions`). Extracting this keeps the two callsites consistent and makes
 * the post-bind re-filter trivial.
 *
 * @param activeTools  Names currently active on the session.
 * @param toolNames    The built-in tool name allowlist for this agent type.
 * @param extensions   Agent config `extensions` field: false | true | string[] (allowlist).
 * @param disallowedSet  Optional denylist from agent config.
 */
function filterActiveTools(
  activeTools: string[],
  toolNames: string[],
  extensions: boolean | string[],
  disallowedSet: Set<string> | undefined,
): string[] {
  if (extensions === false) {
    // Extensions disabled: only apply the denylist to built-in tools.
    if (!disallowedSet) return activeTools;
    return activeTools.filter((t) => !disallowedSet.has(t));
  }
  const builtinToolNameSet = new Set(toolNames);
  return activeTools.filter((t) => {
    if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
    if (disallowedSet?.has(t)) return false;
    if (builtinToolNameSet.has(t)) return true;
    if (Array.isArray(extensions)) {
      return extensions.some((ext) => t.startsWith(ext) || t.includes(ext));
    }
    return true;
  });
}

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}


/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** Shell-exec callback for detectEnv — injected from pi.exec(). */
  exec: ShellExec;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /** Path to the parent session's JSONL file (for deriving the subagent session directory). */
  parentSessionFile?: string;
  /** Session ID of the parent agent (stored in the child session's parentSession header). */
  parentSessionId?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   */
  onAssistantUsage?: (usage: {
    input: number;
    output: number;
    cacheWrite: number;
  }) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: {
    reason: "manual" | "threshold" | "overflow";
    tokensBefore: number;
  }) => void;
  /**
   * Default max turns from runtime config. Falls back to the module-scope
   * `defaultMaxTurns` during the lift-and-shift migration; superseded by
   * per-call `maxTurns` and per-agent `agentConfig.maxTurns`.
   */
  defaultMaxTurns?: number;
  /**
   * Grace turns after the soft-limit steer message. Falls back to the
   * module-scope `graceTurns` during migration.
   */
  graceTurns?: number;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /** Path to the persisted session JSONL file, if the session was persisted. */
  sessionFile?: string;
}

/** Options for resuming an existing agent session. */
export interface ResumeOptions {
  onToolActivity?: (activity: ToolActivity) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  signal?: AbortSignal;
}

/**
 * Execution boundary: decouples AgentManager (lifecycle management) from the
 * SDK session orchestration in runAgent/resumeAgent.
 */
export interface AgentRunner {
  run(ctx: ExtensionContext, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult>;
  resume(session: AgentSession, prompt: string, options?: ResumeOptions): Promise<string>;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(
  session: AgentSession,
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  // Resolve working directory upfront — needed for detectEnv before assembly.
  const effectiveCwd = options.cwd ?? ctx.cwd;
  const env = await detectEnv(options.exec, effectiveCwd);

  // Assemble session configuration (synchronous, no SDK objects).
  const cfg = assembleSessionConfig(
    type,
    {
      cwd: ctx.cwd,
      parentSystemPrompt: ctx.getSystemPrompt(),
      parentModel: ctx.model,
      modelRegistry: ctx.modelRegistry,
    },
    {
      cwd: options.cwd,
      isolated: options.isolated,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
    },
    env,
  );

  const agentDir = getAgentDir();

  // Load extensions/skills: true or string[] → load; false → don't.
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  const loader = new DefaultResourceLoader({
    cwd: cfg.effectiveCwd,
    agentDir,
    noExtensions: cfg.extensions === false,
    noSkills: cfg.noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => cfg.systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // Create a persisted SessionManager so transcripts are written in Pi's
  // official JSONL format. Falls back to a temp directory when the parent
  // session is not persisted (e.g. headless/API mode).
  const sessionDir = deriveSubagentSessionDir(options.parentSessionFile, cfg.effectiveCwd);
  const sessionManager = SessionManager.create(cfg.effectiveCwd, sessionDir);
  sessionManager.newSession({ parentSession: options.parentSessionId });

  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: cfg.effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager: SettingsManager.create(cfg.effectiveCwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model: cfg.model as Model<any> | undefined,
    tools: cfg.toolNames,
    resourceLoader: loader,
  };
  if (cfg.thinkingLevel) {
    sessionOpts.thinkingLevel = cfg.thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);

  // Filter active tools: remove our own tools to prevent nesting,
  // apply extension allowlist if specified, and apply disallowedTools denylist.
  // First pass — over built-in tools, before bindExtensions registers extension tools.
  if (cfg.extensions !== false || cfg.disallowedSet) {
    const filtered = filterActiveTools(
      session.getActiveToolNames(),
      cfg.toolNames,
      cfg.extensions,
      cfg.disallowedSet,
    );
    session.setActiveToolsByName(filtered);
  }

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). Placed after tool filtering
  // so extension-provided skills/prompts from extendResourcesFromExtensions()
  // respect the active tool set. All ExtensionBindings fields are optional.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  // Patch 2 (RepOne #443): re-filter active tools after bindExtensions.
  // Extension-registered tools (added during bindExtensions) are not in the
  // session's active set when the first filter pass runs above. Without this
  // re-filter, the `extensions: string[]` allowlist branch never matches any
  // extension tools and `extensions: true` lets non-allowlisted denylist
  // entries slip in. Run the same filter against the post-bind active set.
  if (cfg.extensions !== false || cfg.disallowedSet) {
    const refiltered = filterActiveTools(
      session.getActiveToolNames(),
      cfg.toolNames,
      cfg.extensions,
      cfg.disallowedSet,
    );
    session.setActiveToolsByName(refiltered);
  }

  options.onSessionCreated?.(session);

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(
    options.maxTurns ?? cfg.agentMaxTurns ?? options.defaultMaxTurns,
  );
  let softLimitReached = false;
  let aborted = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer(
            "You have reached your turn limit. Wrap up immediately — provide your final answer now.",
          );
        } else if (softLimitReached && turnCount >= maxTurns + (options.graceTurns ?? 5)) {
          aborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(
        event.assistantMessageEvent.delta,
        currentMessageText,
      );
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = (event.message as any).usage;
      if (u)
        options.onAssistantUsage?.({
          input: u.input ?? 0,
          output: u.output ?? 0,
          cacheWrite: u.cacheWrite ?? 0,
        });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({
        reason: event.reason,
        tokensBefore: event.result.tokensBefore,
      });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  try {
    await session.prompt(effectivePrompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText =
    collector.getText().trim() || getLastAssistantText(session);
  return {
    responseText,
    session,
    aborted,
    steered: softLimitReached,
    sessionFile: sessionManager.getSessionFile(),
  };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: ResumeOptions = {},
): Promise<string> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubEvents =
    options.onToolActivity || options.onAssistantUsage || options.onCompaction
      ? session.subscribe((event: AgentSessionEvent) => {
          if (event.type === "tool_execution_start")
            options.onToolActivity?.({
              type: "start",
              toolName: event.toolName,
            });
          if (event.type === "tool_execution_end")
            options.onToolActivity?.({ type: "end", toolName: event.toolName });
          if (
            event.type === "message_end" &&
            event.message.role === "assistant"
          ) {
            const u = (event.message as any).usage;
            if (u)
              options.onAssistantUsage?.({
                input: u.input ?? 0,
                output: u.output ?? 0,
                cacheWrite: u.cacheWrite ?? 0,
              });
          }
          if (
            event.type === "compaction_end" &&
            !event.aborted &&
            event.result
          ) {
            options.onCompaction?.({
              reason: event.reason,
              tokensBefore: event.result.tokensBefore,
            });
          }
        })
      : () => {};

  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  return collector.getText().trim() || getLastAssistantText(session);
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall")
          toolCalls.push(
            `  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`,
          );
      }
      if (textParts.length > 0)
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0)
        parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
