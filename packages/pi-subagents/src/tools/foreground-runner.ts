import type { Model } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentSpawnConfig } from "../agent-manager.js";
import type { AgentInvocation, AgentRecord, IsolationMode, ThinkingLevel } from "../types.js";
import { AgentActivityTracker } from "../ui/agent-activity-tracker.js";
import {
  type AgentDetails,
  describeActivity,
  formatMs,
  SPINNER,
} from "../ui/display.js";
import { subscribeUIObserver } from "../ui/ui-observer.js";
import type { AgentActivityAccess } from "./agent-tool.js";
import {
  buildDetails,
  formatLifetimeTokens,
  getStatusNote,
  textResult,
} from "./helpers.js";

/** Narrow manager interface for the foreground runner. */
export interface ForegroundManagerDeps {
  spawnAndWait(
    ctx: any,
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

/** Injected collaborators for runForeground. */
export interface ForegroundDeps {
  manager: ForegroundManagerDeps;
  widget: ForegroundWidgetDeps;
  agentActivity: AgentActivityAccess;
}

/** All values the foreground runner needs, bundled from shared execute setup. */
export interface ForegroundParams {
  ctx: {
    sessionManager: {
      getSessionFile(): string;
      getSessionId(): string;
    };
  };
  subagentType: string;
  prompt: string;
  description: string;
  detailBase: Pick<
    AgentDetails,
    "displayName" | "description" | "subagentType" | "modelName" | "tags"
  >;
  rawType: string;
  fellBack: boolean;
  model: Model<any> | undefined;
  effectiveMaxTurns: number | undefined;
  isolated: boolean | undefined;
  inheritContext: boolean | undefined;
  thinking: ThinkingLevel | undefined;
  isolation: IsolationMode | undefined;
  agentInvocation: AgentInvocation;
}

/**
 * Run an agent synchronously in the foreground, streaming spinner updates.
 * Owns: spinner interval, AgentActivityTracker creation, UI observer subscription,
 * streaming onUpdate callbacks, cleanup, and result formatting.
 */
export async function runForeground(
  deps: ForegroundDeps,
  params: ForegroundParams,
  signal: AbortSignal | undefined,
  onUpdate: ((update: AgentToolResult<any>) => void) | undefined,
) {
  let spinnerFrame = 0;
  const startedAt = Date.now();
  let fgId: string | undefined;

  const fgState = new AgentActivityTracker(params.effectiveMaxTurns);
  let unsubUI: (() => void) | undefined;

  const streamUpdate = () => {
    const details: AgentDetails = {
      ...params.detailBase,
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
      params.ctx,
      params.subagentType,
      params.prompt,
      {
        description: params.description,
        model: params.model,
        maxTurns: params.effectiveMaxTurns,
        isolated: params.isolated,
        inheritContext: params.inheritContext,
        thinkingLevel: params.thinking,
        isolation: params.isolation,
        invocation: params.agentInvocation,
        signal,
        parentSessionFile: params.ctx.sessionManager.getSessionFile(),
        parentSessionId: params.ctx.sessionManager.getSessionId(),
        onSessionCreated: (session, record) => {
          fgState.setSession(session);
          unsubUI = subscribeUIObserver(session, fgState, streamUpdate);
          fgId = record.id;
          deps.agentActivity.set(record.id, fgState);
          deps.widget.ensureTimer();
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

  const tokenText = formatLifetimeTokens(fgState);
  const details = buildDetails(params.detailBase, record, fgState, { tokens: tokenText });

  const fallbackNote = params.fellBack
    ? `Note: Unknown agent type "${params.rawType}" \u2014 using general-purpose.\n\n`
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
}
