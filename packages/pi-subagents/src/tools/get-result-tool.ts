import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentConfigLookup } from "../config/agent-types";
import type { AgentRecord } from "../types";
import { formatDuration, getDisplayName } from "../ui/display";
import { getSessionContextPercent } from "../usage";
import { formatLifetimeTokens, textResult } from "./helpers";

/** Create the get_subagent_result tool definition (without Pi SDK wrapper). */
export function createGetResultTool(
  getRecord: (id: string) => AgentRecord | undefined,
  cancelNudge: (key: string) => void,
  getConversation: (session: AgentSession) => string | undefined,
  registry: AgentConfigLookup,
) {
  return {
    name: "get_subagent_result" as const,
    label: "Get Agent Result",
    promptSnippet: "get_subagent_result: Check status and retrieve results from a background agent.",
    description:
      "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description:
            "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { agent_id: string; wait?: boolean; verbose?: boolean },
      _signal: AbortSignal,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      const record = getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // Wait for completion if requested.
      // Pre-mark resultConsumed BEFORE awaiting: onComplete fires inside .then()
      // (attached earlier at spawn time) and always runs before this await resumes.
      // Setting the flag here prevents a redundant follow-up notification.
      if (params.wait && record.status === "running" && record.promise) {
        // Pre-mark consumed BEFORE awaiting — onComplete fires inside .then() and
        // always runs before this await resumes. Prevents a redundant notification.
        record.notification?.markConsumed();
        cancelNudge(params.agent_id);
        await record.promise;
      }

      const displayName = getDisplayName(record.type, registry);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued") {
        record.notification?.markConsumed();
        cancelNudge(params.agent_id);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  };
}
