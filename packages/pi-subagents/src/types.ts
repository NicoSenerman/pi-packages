/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";


export { AgentRecord } from "#src/lifecycle/agent-record";
export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

/** UI display and agent listing — name, display name, description, prompt mode. */
export interface AgentIdentity {
  name: string;
  displayName?: string;
  description: string;
  promptMode: "replace" | "append";
}

/** Prompt assembly — name, prompt mode, system prompt. */
export interface AgentPromptConfig {
  name: string;
  promptMode: "replace" | "append";
  systemPrompt: string;
}

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig extends AgentIdentity, AgentPromptConfig {
  builtinToolNames?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope;
  /** Isolation mode — "worktree" runs the agent in a temporary git worktree */
  isolation?: IsolationMode;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolation?: IsolationMode;
}

/**
 * Narrow shell-exec callback replacing `ExtensionAPI` in `detectEnv()`.
 * Matches the shape of `pi.exec()` without carrying an SDK dependency.
 */
export type ShellExec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;
