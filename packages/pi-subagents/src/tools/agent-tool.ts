import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type { AgentSpawnConfig } from "../agent-manager.js";
import { AgentTypeRegistry } from "../agent-types.js";

import type { AgentRecord, SubagentType } from "../types.js";
import { AgentActivityTracker } from "../ui/agent-activity-tracker.js";
import { type UICtx } from "../ui/agent-widget.js";
import {
  type AgentDetails,
  formatMs,
  formatTurns,
  getDisplayName,
  SPINNER,
} from "../ui/display.js";
import { spawnBackground } from "./background-spawner.js";
import { runForeground } from "./foreground-runner.js";
import { buildDetails, buildTypeListText, textResult } from "./helpers.js";
import { resolveSpawnConfig } from "./spawn-config.js";

// ---- Deps interface ----

/** Narrow manager interface — only the methods the Agent tool calls. */
export interface AgentToolManager {
  spawn: (ctx: ExtensionContext, type: string, prompt: string, opts: AgentSpawnConfig) => string;
  spawnAndWait: (ctx: ExtensionContext, type: string, prompt: string, opts: Omit<AgentSpawnConfig, "isBackground">) => Promise<AgentRecord>;
  resume: (id: string, prompt: string, signal: AbortSignal) => Promise<AgentRecord | undefined>;
  getRecord: (id: string) => AgentRecord | undefined;
  getMaxConcurrent: () => number;
}

/** Narrow widget interface — only the methods the Agent tool calls. */
export interface AgentToolWidget {
  setUICtx: (ctx: unknown) => void;
  ensureTimer: () => void;
  update: () => void;
  markFinished: (id: string) => void;
}

/**
 * Narrow read/write interface for the agent-tool's agentActivity access.
 * The full Map satisfies this structurally — no wrapper needed.
 */
export interface AgentActivityAccess {
  get(id: string): AgentActivityTracker | undefined;
  set(id: string, tracker: AgentActivityTracker): void;
  delete(id: string): void;
}

export interface AgentToolDeps {
  manager: AgentToolManager;
  widget: AgentToolWidget;
  agentActivity: AgentActivityAccess;
  registry: AgentTypeRegistry;
  agentDir: string;
  /** Narrow settings accessor — only the default max turns is needed here. */
  settings: { readonly defaultMaxTurns: number | undefined };
}

// ---- Factory ----

/** Create the Agent tool definition (without Pi SDK wrapper). */
export function createAgentTool(deps: AgentToolDeps) {
  const typeListText = buildTypeListText(deps.registry, deps.agentDir);
  const availableTypesText = deps.registry.getAvailableTypes().join(", ");
  return {
    name: "Agent" as const,
    label: "Agent",
    promptSnippet: "Agent: Launch a specialized agent for complex, multi-step tasks.",
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.
- Use Explore for codebase searches and code understanding.
- Use Plan for architecture and implementation planning.
- Use general-purpose for complex tasks that need file editing.
- Provide clear, detailed prompts so the agent can work autonomously.
- Agent results are returned as text — summarize them for the user.
- Use run_in_background for work you don't need immediately. You will be notified when it completes.
- Use resume with an agent ID to continue a previous agent's work.
- Use steer_subagent to send mid-run messages to a running background agent.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications).`,
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${availableTypesText}. Custom agents from .pi/agents/<name>.md (project) or ${deps.agentDir}/agents/<name>.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description:
            "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description:
            "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description:
            "Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description:
            "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      isolation: Type.Optional(
        Type.Literal("worktree", {
          description:
            'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Changes are saved to a branch on completion.',
        }),
      ),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args: Record<string, unknown>, theme: any) {
      const displayName = args.subagent_type
        ? getDisplayName(args.subagent_type as string, deps.registry)
        : "Agent";
      const desc = (args.description as string) ?? "";
      return new Text(
        "▸ " +
          theme.fg("toolTitle", theme.bold(displayName)) +
          (desc ? "  " + theme.fg("muted", desc) : ""),
        0,
        0,
      );
    },

    renderResult(result: any, { expanded, isPartial }: any, theme: any) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ⟳5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0)
          parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        return parts
          .map((p) => theme.fg("dim", p))
          .join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        let line = theme.fg("accent", frame) + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
        return new Text(line, 0, 0);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(
          theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`),
          0,
          0,
        );
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText =
            result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line +=
                "\n" +
                theme.fg(
                  "muted",
                  "  ... (use get_subagent_result with verbose for full output)",
                );
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: ((update: AgentToolResult<any>) => void) | undefined,
      ctx: any,
    ) => {
      // Ensure we have UI context for widget rendering
      deps.widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new .pi/agents/*.md files are picked up without restart
      deps.registry.reload();

      // ---- Config resolution (pure) ----
      const config = resolveSpawnConfig(
        params,
        deps.registry,
        { parentModel: ctx.model, modelRegistry: ctx.modelRegistry },
        deps.settings,
      );
      if ("error" in config) return textResult(config.error);

      // ---- Resume existing agent ----
      if (params.resume) {
        const existing = deps.manager.getRecord(params.resume as string);
        if (!existing) {
          return textResult(
            `Agent not found: "${params.resume}". It may have been cleaned up.`,
          );
        }
        if (!existing.execution?.session) {
          return textResult(
            `Agent "${params.resume}" has no active session to resume.`,
          );
        }
        const record = await deps.manager.resume(
          params.resume as string,
          params.prompt as string,
          signal ?? new AbortController().signal,
        );
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        return textResult(
          record.result?.trim() || record.error?.trim() || "No output.",
          buildDetails(config.detailBase, record),
        );
      }

      // ---- Background execution ----
      if (config.runInBackground) {
        return spawnBackground(
          { manager: deps.manager, widget: deps.widget, agentActivity: deps.agentActivity },
          {
            ctx,
            subagentType: config.subagentType,
            prompt: config.prompt,
            description: config.description,
            displayName: config.displayName,
            toolCallId,
            detailBase: config.detailBase,
            model: config.model,
            effectiveMaxTurns: config.effectiveMaxTurns,
            isolated: config.isolated,
            inheritContext: config.inheritContext,
            thinking: config.thinking,
            isolation: config.isolation,
            agentInvocation: config.agentInvocation,
          },
        );
      }

      // ---- Foreground execution — stream progress via onUpdate ----
      return runForeground(
        { manager: deps.manager, widget: deps.widget, agentActivity: deps.agentActivity },
        {
          ctx,
          subagentType: config.subagentType,
          prompt: config.prompt,
          description: config.description,
          detailBase: config.detailBase,
          rawType: config.rawType,
          fellBack: config.fellBack,
          model: config.model,
          effectiveMaxTurns: config.effectiveMaxTurns,
          isolated: config.isolated,
          inheritContext: config.inheritContext,
          thinking: config.thinking,
          isolation: config.isolation,
          agentInvocation: config.agentInvocation,
        },
        signal,
        onUpdate,
      );
    },
  };
}
