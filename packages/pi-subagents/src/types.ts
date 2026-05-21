/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

export type { AgentRecordInit, AgentRecordStatus } from "./agent-record.js";

export { AgentRecord } from "./agent-record.js";
export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
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
  systemPrompt: string;
  promptMode: "replace" | "append";
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

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;

}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
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
