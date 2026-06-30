import type { AgentConfig, ThinkingLevel } from "#src/types";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as
      ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext:
      agentConfig?.inheritContext ?? params.inherit_context ?? false,
    // Default to non-blocking: a `subagent` call with no `run_in_background`
    // field spawns in the background, freeing the parent turn immediately.
    // Foreground (blocking) mode is opt-in via explicit `run_in_background: false`.
    runInBackground:
      agentConfig?.runInBackground ?? params.run_in_background ?? true,
  };
}
