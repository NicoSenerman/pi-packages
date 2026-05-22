import type { AgentConfigLookup } from "../agent-types.js";
import { AgentActivityTracker } from "../ui/agent-activity-tracker.js";
import { type AgentDetails, formatTokens } from "../ui/display.js";
import { getLifetimeTotal, type LifetimeUsage } from "../usage.js";

/** Parenthetical status note for completed agent result text. */
export function getStatusNote(status: string): string {
  switch (status) {
    case "aborted":
      return " (aborted \u2014 max turns exceeded, output may be incomplete)";
    case "steered":
      return " (wrapped up \u2014 reached turn limit)";
    case "stopped":
      return " (stopped by user)";
    default:
      return "";
  }
}

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number;
    status: string;
    error?: string;
    id?: string;
    lifetimeUsage: LifetimeUsage;
  },
  activity?: AgentActivityTracker,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Narrow registry interface needed by buildTypeListText.
 * Extends AgentConfigLookup with the two name-listing methods.
 */
export interface TypeListRegistry extends AgentConfigLookup {
  getDefaultAgentNames(): string[];
  getUserAgentNames(): string[];
}

/**
 * Build the full agent-type list text for the Agent tool description.
 * Extracted from index.ts so it can be called inside createAgentTool.
 */
export function buildTypeListText(registry: TypeListRegistry, agentDir: string): string {
  const defaultNames = registry.getDefaultAgentNames();
  const userNames = registry.getUserAgentNames();

  const defaultDescs = defaultNames.map((name) => {
    const cfg = registry.resolveAgentConfig(name);
    const modelSuffix = cfg.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
    return `- ${name}: ${cfg.description}${modelSuffix}`;
  });

  const customDescs = userNames.map((name) => {
    const cfg = registry.resolveAgentConfig(name);
    return `- ${name}: ${cfg.description}`;
  });

  return [
    "Default agents:",
    ...defaultDescs,
    ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
    "",
    `Custom agents can be defined in .pi/agents/<name>.md (project) or ${agentDir}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.`,
  ].join("\n");
}

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.includes("/") ? model.split("/").pop()! : model;
  // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  return name.replace(/-\d{8}$/, "");
}
