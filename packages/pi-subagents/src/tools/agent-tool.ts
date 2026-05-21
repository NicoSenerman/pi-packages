import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type { SpawnOptions } from "../agent-manager.js";
import { normalizeMaxTurns } from "../agent-runner.js";
import { AgentTypeRegistry } from "../agent-types.js";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import { resolveInvocationModel } from "../model-resolver.js";

import type { AgentInvocation, AgentRecord, SubagentType } from "../types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  describeActivity,
  formatMs,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type UICtx,
} from "../ui/agent-widget.js";
import { subscribeUIObserver } from "../ui/ui-observer.js";
import type { LifetimeUsage } from "../usage.js";
import { formatLifetimeTokens, textResult } from "./helpers.js";

// ---- Agent-tool-specific helpers ----

/** Create a fresh AgentActivity state for tracking UI progress. */
function createAgentActivity(maxTurns?: number): AgentActivity {
  return {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };
}

/** Parenthetical status note for completed agent result text. */
export function getStatusNote(status: string): string {
  switch (status) {
    case "aborted":
      return " (aborted — max turns exceeded, output may be incomplete)";
    case "steered":
      return " (wrapped up — reached turn limit)";
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
    session?: any;
    lifetimeUsage: LifetimeUsage;
  },
  activity?: AgentActivity,
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

// ---- Deps interface ----

/** Narrow manager interface — only the methods the Agent tool calls. */
export interface AgentToolManager {
  spawn: (ctx: ExtensionContext, type: string, prompt: string, opts: SpawnOptions) => string;
  spawnAndWait: (ctx: ExtensionContext, type: string, prompt: string, opts: Omit<SpawnOptions, "isBackground">) => Promise<AgentRecord>;
  resume: (id: string, prompt: string, signal: AbortSignal) => Promise<AgentRecord | undefined>;
  getRecord: (id: string) => AgentRecord | undefined;
  getMaxConcurrent: () => number;
  listAgents: () => AgentRecord[];
}

/** Narrow widget interface — only the methods the Agent tool calls. */
export interface AgentToolWidget {
  setUICtx: (ctx: unknown) => void;
  ensureTimer: () => void;
  update: () => void;
  markFinished: (id: string) => void;
}

export interface AgentToolDeps {
  manager: AgentToolManager;
  widget: AgentToolWidget;
  agentActivity: Map<string, AgentActivity>;
  emitEvent: (name: string, data: unknown) => void;
  registry: AgentTypeRegistry;
  typeListText: string;
  availableTypesText: string;
  agentDir: string;
  /** Returns the runtime default max turns (undefined = unlimited). */
  getDefaultMaxTurns: () => number | undefined;
}

// ---- Factory ----

/** Create the Agent tool definition (without Pi SDK wrapper). */
export function createAgentTool(deps: AgentToolDeps) {
  return {
    name: "Agent" as const,
    label: "Agent",
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${deps.typeListText}

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
        description: `The type of specialized agent to use. Available types: ${deps.availableTypesText}. Custom agents from .pi/agents/<name>.md (project) or ${deps.agentDir}/agents/<name>.md (global) are also available.`,
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

      const rawType = params.subagent_type as SubagentType;
      const resolved = deps.registry.resolveType(rawType);
      const subagentType = resolved ?? "general-purpose";
      const fellBack = resolved === undefined;

      const displayName = getDisplayName(subagentType, deps.registry);

      // Get agent config for invocation resolution
      const customConfig = deps.registry.resolveAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

      // Resolve model from agent config first; tool-call params only fill gaps.
      const resolution = resolveInvocationModel(
        ctx.model,
        resolvedConfig.modelInput,
        resolvedConfig.modelFromParams,
        ctx.modelRegistry,
      );
      if (resolution.error) return textResult(resolution.error);
      const model = resolution.model;

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;

      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const modelName =
        effectiveModelId && effectiveModelId !== parentModelId
          ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
          : undefined;
      const effectiveMaxTurns = normalizeMaxTurns(
        resolvedConfig.maxTurns ?? deps.getDefaultMaxTurns(),
      );
      const agentInvocation: AgentInvocation = {
        modelName,
        thinking,
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
        isolation,
      };
      const modeLabel = getPromptModeLabel(subagentType, deps.registry);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: params.description as string,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      // Resume existing agent
      if (params.resume) {
        const existing = deps.manager.getRecord(params.resume as string);
        if (!existing) {
          return textResult(
            `Agent not found: "${params.resume}". It may have been cleaned up.`,
          );
        }
        if (!existing.session) {
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
          buildDetails(detailBase, record),
        );
      }

      // Background execution
      if (runInBackground) {
        const bgState = createAgentActivity(effectiveMaxTurns);

        let id: string;

        try {
          id = deps.manager.spawn(ctx, subagentType, params.prompt as string, {
            parentSessionFile: ctx.sessionManager.getSessionFile(),
            parentSessionId: ctx.sessionManager.getSessionId(),
            description: params.description as string,
            model,
            maxTurns: effectiveMaxTurns,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            isBackground: true,
            isolation,
            invocation: agentInvocation,
            onSessionCreated: (session: any) => {
              bgState.session = session;
              subscribeUIObserver(session, bgState);
            },
          });
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }

        const record = deps.manager.getRecord(id);
        if (record) {
          record.toolCallId = toolCallId;
        }

        deps.agentActivity.set(id, bgState);
        deps.widget.ensureTimer();
        deps.widget.update();

        // Emit created event
        deps.emitEvent("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `Agent ${isQueued ? "queued" : "started"} in background.\n` +
            `Agent ID: ${id}\n` +
            `Type: ${displayName}\n` +
            `Description: ${params.description}\n` +
            (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
            (isQueued
              ? `Position: queued (max ${deps.manager.getMaxConcurrent()} concurrent)\n`
              : "") +
            `\nYou will be notified when this agent completes.\n` +
            `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
            `Do not duplicate this agent's work.`,
          {
            ...detailBase,
            toolUses: 0,
            tokens: "",
            durationMs: 0,
            status: "background" as const,
            agentId: id,
          },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;

      const fgState = createAgentActivity(effectiveMaxTurns);
      let unsubUI: (() => void) | undefined;

      const streamUpdate = () => {
        const details: AgentDetails = {
          ...detailBase,
          toolUses: fgState.toolUses,
          tokens: formatLifetimeTokens(fgState),
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as any,
        });
      };

      // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      let record: AgentRecord;
      try {
        record = await deps.manager.spawnAndWait(
          ctx,
          subagentType,
          params.prompt as string,
          {
            description: params.description as string,
            model,
            maxTurns: effectiveMaxTurns,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            isolation,
            invocation: agentInvocation,
            signal,
            parentSessionFile: ctx.sessionManager.getSessionFile(),
            parentSessionId: ctx.sessionManager.getSessionId(),
            onSessionCreated: (session: any) => {
              fgState.session = session;
              unsubUI = subscribeUIObserver(session, fgState, streamUpdate);
              for (const a of deps.manager.listAgents()) {
                if (a.session === session) {
                  fgId = a.id;
                  deps.agentActivity.set(a.id, fgState);
                  deps.widget.ensureTimer();
                  break;
                }
              }
            },
          },
        );
      } catch (err) {
        clearInterval(spinnerInterval);
        unsubUI?.();
        return textResult(err instanceof Error ? err.message : String(err));
      }

      clearInterval(spinnerInterval);
      unsubUI?.();

      // Clean up foreground agent from widget
      if (fgId) {
        deps.agentActivity.delete(fgId);
        deps.widget.markFinished(fgId);
      }

      // Get final token count
      const tokenText = formatLifetimeTokens(fgState);

      const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });

      const fallbackNote = fellBack
        ? `Note: Unknown agent type "${rawType}" — using general-purpose.\n\n`
        : "";

      if (record.status === "error") {
        return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
          (record.result?.trim() || "No output."),
        details,
      );
    },
  };
}
