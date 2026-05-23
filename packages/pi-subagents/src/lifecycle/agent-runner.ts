/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { extractText } from "#src/session/context";
import type { EnvInfo } from "#src/session/env";
import { type AssemblerIO, assembleSessionConfig } from "#src/session/session-config";
import type { ShellExec, SubagentType, ThinkingLevel } from "#src/types";

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"];

// ── Local message-shape types ───────────────────────────────────────────────
// The Pi SDK does not export a narrow type for tool-call content variants.

/** Tool-call content item — SDK exposes this variant at runtime but doesn’t export the narrow type. */
interface ToolCallContent {
  type: "toolCall";
  name?: string;
  toolName?: string;
}

/** Extracts the display name from a tool-call content item. */
function getToolCallName(c: { type: string }): string {
  if (c.type !== "toolCall") return "unknown";
  const tc = c as ToolCallContent;
  return tc.name ?? tc.toolName ?? "unknown";
}

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

// ── IO boundary ───────────────────────────────────────────────────────────────

/** Minimal resource-loader contract used by the runner. */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** Minimal session-manager contract used by the runner. */
export interface SessionManagerLike {
  newSession(opts: { parentSession?: string }): void;
  getSessionFile(): string | undefined;
}

/** Options passed to RunnerIO.createResourceLoader. */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  noExtensions?: boolean;
  noSkills?: boolean;
  noPromptTemplates?: boolean;
  noThemes?: boolean;
  noContextFiles?: boolean;
  systemPromptOverride?: () => string;
  /** Override the append system prompt. Receives the current base value; return the replacement. */
  appendSystemPromptOverride?: (base: string[]) => string[];
}

/** Options passed to RunnerIO.createSession. */
export interface CreateSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManagerLike;
  settingsManager: SettingsManager;
  modelRegistry: unknown;
  model?: unknown;
  tools: string[];
  resourceLoader: ResourceLoaderLike;
  thinkingLevel?: ThinkingLevel;
}

/**
 * IO boundary injected into runAgent().
 *
 * Decouples the runner from direct Pi SDK imports and sibling-module IO,
 * making it testable via plain stub objects without vi.mock().
 */
export interface RunnerIO {
  detectEnv: (exec: ShellExec, cwd: string) => Promise<EnvInfo>;
  getAgentDir: () => string;
  createResourceLoader: (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  deriveSessionDir: (parentSessionFile: string | undefined, effectiveCwd: string) => string;
  createSessionManager: (cwd: string, sessionDir: string) => SessionManagerLike;
  createSettingsManager: (cwd: string, agentDir: string) => SettingsManager;
  createSession: (opts: CreateSessionOptions) => Promise<{ session: AgentSession }>;
  assemblerIO: AssemblerIO;
}

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface RunOptions {
  /** Shell-exec callback for detectEnv — injected from pi.exec(). */
  exec: ShellExec;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /** Path to the parent session's JSONL file (for deriving the subagent session directory). */
  parentSessionFile?: string;
  /** Session ID of the parent agent (stored in the child session's parentSession header). */
  parentSessionId?: string;
  /** Called once after session creation — session delivery mechanism. */
  onSessionCreated?: (session: AgentSession) => void;
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
  /** Agent config lookup — provides resolveAgentConfig and getToolNamesForType. */
  registry: AgentConfigLookup;
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
  signal?: AbortSignal;
}

/**
 * Execution boundary: decouples AgentManager (lifecycle management) from the
 * SDK session orchestration in runAgent/resumeAgent.
 */
export interface AgentRunner {
  run(snapshot: ParentSnapshot, type: SubagentType, prompt: string, options: RunOptions): Promise<RunResult>;
  resume(session: AgentSession, prompt: string, options?: ResumeOptions): Promise<string>;
}

/**
 * Create an AgentRunner backed by the given IO boundary.
 *
 * Captures io at construction time so AgentManager remains IO-unaware.
 */
export function createAgentRunner(io: RunnerIO): AgentRunner {
  return {
    run: (snapshot, type, prompt, options) => runAgent(snapshot, type, prompt, options, io),
    resume: resumeAgent,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

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

// ── Public functions ──────────────────────────────────────────────────────────

export async function runAgent(
  snapshot: ParentSnapshot,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
  io: RunnerIO,
): Promise<RunResult> {
  // Resolve working directory upfront — needed for detectEnv before assembly.
  const effectiveCwd = options.cwd ?? snapshot.cwd;
  const env = await io.detectEnv(options.exec, effectiveCwd);

  // Assemble session configuration (synchronous, no SDK objects).
  const cfg = assembleSessionConfig(
    type,
    {
      cwd: snapshot.cwd,
      parentSystemPrompt: snapshot.systemPrompt,
      parentModel: snapshot.model,
      modelRegistry: snapshot.modelRegistry,
    },
    {
      cwd: options.cwd,
      isolated: options.isolated,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
    },
    env,
    options.registry,
    io.assemblerIO,
  );

  const agentDir = io.getAgentDir();

  // Load extensions/skills: true or string[] → load; false → don't.
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  const loader = io.createResourceLoader({
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
  const sessionDir = io.deriveSessionDir(options.parentSessionFile, cfg.effectiveCwd);
  const sessionManager = io.createSessionManager(cfg.effectiveCwd, sessionDir);
  sessionManager.newSession({ parentSession: options.parentSessionId });

  const { session } = await io.createSession({
    cwd: cfg.effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager: io.createSettingsManager(cfg.effectiveCwd, agentDir),
    modelRegistry: snapshot.modelRegistry,
    model: cfg.model,
    tools: cfg.toolNames,
    resourceLoader: loader,
    thinkingLevel: cfg.thinkingLevel,
  });

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
  await session.bindExtensions({});

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

  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
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
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Prepend parent context if it was captured at spawn time
  let effectivePrompt = prompt;
  if (snapshot.parentContext) {
    effectivePrompt = snapshot.parentContext + prompt;
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

  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
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
          toolCalls.push(`  Tool: ${getToolCallName(c)}`);
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
