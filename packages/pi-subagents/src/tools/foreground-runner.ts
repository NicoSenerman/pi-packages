import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentSpawnConfig, ParentSessionInfo } from "#src/lifecycle/agent-manager";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { AgentActivityAccess } from "#src/tools/agent-tool";
import {
  buildDetails,
  formatLifetimeTokens,
  getStatusNote,
  textResult,
} from "#src/tools/helpers";
import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";
import type { AgentRecord } from "#src/types";
import { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import {
  type AgentDetails,
  describeActivity,
  formatMs,
  SPINNER,
} from "#src/ui/display";
import { subscribeUIObserver } from "#src/ui/ui-observer";

/** Narrow manager interface for the foreground runner. */
export interface ForegroundManagerDeps {
  spawnAndWait(
    snapshot: ParentSnapshot,
    type: string,
    prompt: string,
    opts: Omit<AgentSpawnConfig, "isBackground">,
  ): Promise<AgentRecord>;
}

/** Narrow widget interface for the foreground runner. */
export interface ForegroundWidgetDeps {
  ensureTimer(): void;
  markFinished(id: string): void;
}

/** All values the foreground runner needs beyond the resolved config. */
export interface ForegroundParams {
  config: ResolvedSpawnConfig;
  snapshot: ParentSnapshot;
  parentSession: ParentSessionInfo;
}

/**
 * Run an agent synchronously in the foreground, streaming spinner updates.
 * Owns: spinner interval, AgentActivityTracker creation, UI observer subscription,
 * streaming onUpdate callbacks, cleanup, and result formatting.
 */
export async function runForeground(
  manager: ForegroundManagerDeps,
  widget: ForegroundWidgetDeps,
  agentActivity: AgentActivityAccess,
  params: ForegroundParams,
  signal: AbortSignal | undefined,
  onUpdate: ((update: AgentToolResult<any>) => void) | undefined,
) {
  const { identity, execution, presentation } = params.config;
  let spinnerFrame = 0;
  const startedAt = Date.now();
  let fgId: string | undefined;

  const fgState = new AgentActivityTracker(execution.effectiveMaxTurns);
  let unsubUI: (() => void) | undefined;
  let recordRef: AgentRecord | undefined;

  const streamUpdate = () => {
    const toolUses = recordRef?.toolUses ?? 0;
    const details: AgentDetails = {
      ...presentation.detailBase,
      toolUses,
      tokens: recordRef ? formatLifetimeTokens(recordRef) : "",
      turnCount: fgState.turnCount,
      maxTurns: fgState.maxTurns,
      durationMs: Date.now() - startedAt,
      status: "running",
      activity: describeActivity(fgState.activeTools, fgState.responseText),
      spinnerFrame: spinnerFrame % SPINNER.length,
    };
    onUpdate?.({
      content: [{ type: "text", text: `${toolUses} tool uses...` }],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Pi SDK ToolCallUpdate details type is not exported
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
    record = await manager.spawnAndWait(
      params.snapshot,
      identity.subagentType,
      execution.prompt,
      {
        description: execution.description,
        model: execution.model,
        maxTurns: execution.effectiveMaxTurns,
        isolated: execution.isolated,
        inheritContext: execution.inheritContext,
        thinkingLevel: execution.thinking,
        isolation: execution.isolation,
        invocation: execution.agentInvocation,
        signal,
        parentSession: params.parentSession,
        onSessionCreated: (session, record) => {
          fgState.setSession(session);
          recordRef = record;
          unsubUI = subscribeUIObserver(session, fgState, streamUpdate);
          fgId = record.id;
          agentActivity.set(record.id, fgState);
          widget.ensureTimer();
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
    agentActivity.delete(fgId);
    widget.markFinished(fgId);
  }

  const tokenText = formatLifetimeTokens(record);
  const details = buildDetails(presentation.detailBase, record, fgState, { tokens: tokenText });

  const fallbackNote = identity.fellBack
    ? `Note: Unknown agent type "${identity.rawType}" — using general-purpose.\n\n`
    : "";

  if (record.status === "error") {
    return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  return textResult(
    `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
      (record.result?.trim() ?? "No output."),
    details,
  );
}
