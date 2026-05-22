import type { Model } from "@earendil-works/pi-ai";
import type { AgentSpawnConfig } from "../agent-manager.js";
import type { AgentInvocation, AgentRecord, IsolationMode, ThinkingLevel } from "../types.js";
import { AgentActivityTracker } from "../ui/agent-activity-tracker.js";
import type { AgentDetails } from "../ui/display.js";
import { subscribeUIObserver } from "../ui/ui-observer.js";
import type { AgentActivityAccess } from "./agent-tool.js";
import { textResult } from "./helpers.js";

/** Narrow manager interface for the background spawner. */
export interface BackgroundManagerDeps {
  spawn(ctx: any, type: string, prompt: string, opts: AgentSpawnConfig): string;
  getRecord(id: string): AgentRecord | undefined;
  getMaxConcurrent(): number;
}

/** Narrow widget interface for the background spawner. */
export interface BackgroundWidgetDeps {
  ensureTimer(): void;
  update(): void;
}

/** Injected collaborators for spawnBackground. */
export interface BackgroundDeps {
  manager: BackgroundManagerDeps;
  widget: BackgroundWidgetDeps;
  agentActivity: AgentActivityAccess;
}

/** All values the background spawner needs, bundled from shared execute setup. */
export interface BackgroundParams {
  ctx: {
    sessionManager: {
      getSessionFile(): string;
      getSessionId(): string;
    };
  };
  subagentType: string;
  prompt: string;
  description: string;
  displayName: string;
  toolCallId: string;
  detailBase: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">;
  model: Model<any> | undefined;
  effectiveMaxTurns: number | undefined;
  isolated: boolean | undefined;
  inheritContext: boolean | undefined;
  thinking: ThinkingLevel | undefined;
  isolation: IsolationMode | undefined;
  agentInvocation: AgentInvocation;
}

/**
 * Spawn a background agent and return the tool result immediately.
 * Owns: activity tracker creation, UI observer subscription, activity map
 * registration, widget update, and launch message formatting.
 */
export function spawnBackground(
  deps: BackgroundDeps,
  params: BackgroundParams,
) {
  const bgState = new AgentActivityTracker(params.effectiveMaxTurns);

  let id: string;
  try {
    id = deps.manager.spawn(params.ctx, params.subagentType, params.prompt, {
      parentSessionFile: params.ctx.sessionManager.getSessionFile(),
      parentSessionId: params.ctx.sessionManager.getSessionId(),
      description: params.description,
      model: params.model,
      maxTurns: params.effectiveMaxTurns,
      isolated: params.isolated,
      inheritContext: params.inheritContext,
      thinkingLevel: params.thinking,
      isBackground: true,
      isolation: params.isolation,
      invocation: params.agentInvocation,
      toolCallId: params.toolCallId,
      onSessionCreated: (session) => {
        bgState.setSession(session);
        subscribeUIObserver(session, bgState);
      },
    });
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err));
  }

  const record = deps.manager.getRecord(id);

  deps.agentActivity.set(id, bgState);
  deps.widget.ensureTimer();
  deps.widget.update();

  const isQueued = record?.status === "queued";
  return textResult(
    `Agent ${isQueued ? "queued" : "started"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${params.displayName}\n` +
      `Description: ${params.description}\n` +
      (record?.execution?.outputFile ? `Output file: ${record.execution.outputFile}\n` : "") +
      (isQueued
        ? `Position: queued (max ${deps.manager.getMaxConcurrent()} concurrent)\n`
        : "") +
      `\nYou will be notified when this agent completes.\n` +
      `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
      `Do not duplicate this agent's work.`,
    {
      ...params.detailBase,
      toolUses: 0,
      tokens: "",
      durationMs: 0,
      status: "background" as const,
      agentId: id,
    },
  );
}
