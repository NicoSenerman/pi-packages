import type { AgentSpawnConfig } from "#src/lifecycle/agent-manager";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { AgentActivityAccess } from "#src/tools/agent-tool";
import { textResult } from "#src/tools/helpers";
import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";
import type { AgentRecord } from "#src/types";
import { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { subscribeUIObserver } from "#src/ui/ui-observer";

/** Narrow manager interface for the background spawner. */
export interface BackgroundManagerDeps {
  spawn(snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig): string;
  getRecord(id: string): AgentRecord | undefined;
  getMaxConcurrent(): number;
}

/** Narrow widget interface for the background spawner. */
export interface BackgroundWidgetDeps {
  ensureTimer(): void;
  update(): void;
}

/** All values the background spawner needs beyond the resolved config. */
export interface BackgroundParams {
  config: ResolvedSpawnConfig;
  snapshot: ParentSnapshot;
  parentSessionFile: string;
  parentSessionId: string;
  toolCallId: string;
}

/**
 * Spawn a background agent and return the tool result immediately.
 * Owns: activity tracker creation, UI observer subscription, activity map
 * registration, widget update, and launch message formatting.
 */
export function spawnBackground(
  manager: BackgroundManagerDeps,
  widget: BackgroundWidgetDeps,
  agentActivity: AgentActivityAccess,
  params: BackgroundParams,
) {
  const { config } = params;
  const bgState = new AgentActivityTracker(config.effectiveMaxTurns);

  let id: string;
  try {
    id = manager.spawn(params.snapshot, config.subagentType, config.prompt, {
      parentSessionFile: params.parentSessionFile,
      parentSessionId: params.parentSessionId,
      description: config.description,
      model: config.model,
      maxTurns: config.effectiveMaxTurns,
      isolated: config.isolated,
      inheritContext: config.inheritContext,
      thinkingLevel: config.thinking,
      isBackground: true,
      isolation: config.isolation,
      invocation: config.agentInvocation,
      toolCallId: params.toolCallId,
      onSessionCreated: (session) => {
        bgState.setSession(session);
        subscribeUIObserver(session, bgState);
      },
    });
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err));
  }

  const record = manager.getRecord(id);

  agentActivity.set(id, bgState);
  widget.ensureTimer();
  widget.update();

  const isQueued = record?.status === "queued";
  return textResult(
    `Agent ${isQueued ? "queued" : "started"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${config.displayName}\n` +
      `Description: ${config.description}\n` +
      (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
      (isQueued
        ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n`
        : "") +
      `\nYou will be notified when this agent completes.\n` +
      `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
      `Do not duplicate this agent's work.`,
    {
      ...config.detailBase,
      toolUses: 0,
      tokens: "",
      durationMs: 0,
      status: "background" as const,
      agentId: id,
    },
  );
}
