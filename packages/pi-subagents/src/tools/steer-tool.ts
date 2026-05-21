import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentRecord } from "../types.js";
import { getSessionContextPercent } from "../usage.js";
import { formatLifetimeTokens, textResult } from "./helpers.js";

/** Narrow deps — only the methods this tool's execute callback calls. */
export interface SteerToolDeps {
  getRecord: (id: string) => AgentRecord | undefined;
  emitEvent: (name: string, data: unknown) => void;
  steerAgent: (session: AgentSession, message: string) => Promise<void>;
  /** Buffer a steer for an agent whose session isn't ready yet. */
  queueSteer: (id: string, message: string) => boolean;
}

/** Create the steer_subagent tool definition (without Pi SDK wrapper). */
export function createSteerTool(deps: SteerToolDeps) {
  return {
    name: "steer_subagent" as const,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running).",
      }),
      message: Type.String({
        description:
          "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (
      _toolCallId: string,
      params: { agent_id: string; message: string },
      _signal: AbortSignal,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      const record = deps.getRecord(params.agent_id);
      if (!record) {
        return textResult(
          `Agent not found: "${params.agent_id}". It may have been cleaned up.`,
        );
      }
      if (record.status !== "running") {
        return textResult(
          `Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`,
        );
      }
      if (!record.session) {
        // Session not ready yet — queue via manager for delivery once initialized
        deps.queueSteer(record.id, params.message);
        deps.emitEvent("subagents:steered", { id: record.id, message: params.message });
        return textResult(
          `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
        );
      }

      try {
        await deps.steerAgent(record.session, params.message);
        deps.emitEvent("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null)
          stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount)
          stateParts.push(
            `${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`,
          );
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
            `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(
          `Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
