import { debugLog } from "#src/debug";
import { getLifetimeTotal } from "#src/lifecycle/usage";
import type { Agent } from "#src/types";
import type { AgentActivityTracker } from "#src/ui/agent-activity-tracker";

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
}

// ---- Pure helpers (exported for unit testing) ----

/** Escape XML special characters to prevent injection in structured notifications. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Human-readable status label for agent completion. */
export function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error":
      return `Error: ${error ?? "unknown"}`;
    case "aborted":
      return "Aborted (max turns exceeded)";
    case "steered":
      return "Wrapped up (turn limit)";
    case "stopped":
      return "Stopped";
    default:
      return "Done";
  }
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
export function formatTaskNotification(record: Agent, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = record.getContextPercent();
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  const toolCallId = record.notification?.toolCallId;
  const outputFile = record.outputFile;
  return [
    "<task-notification>",
    `<task-id>${record.id}</task-id>`,
    toolCallId ? `<tool-use-id>${escapeXml(toolCallId)}</tool-use-id>` : null,
    outputFile ? `<output-file>${escapeXml(outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    "</task-notification>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build notification details for the custom message renderer. */
export function buildNotificationDetails(
  record: Agent,
  resultMaxLen: number,
  activity?: AgentActivityTracker,
): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

/** Build event data for lifecycle events from an Agent. */
export function buildEventData(record: Agent) {
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  const tokens =
    total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    tokens,
  };
}

// ---- Notification system factory ----

export interface NotificationSystem {
  cancelNudge: (key: string) => void;
  sendCompletion: (record: Agent) => void;
  cleanupCompleted: (id: string) => void;
  dispose: () => void;
}

const NUDGE_HOLD_MS = 200;

export class NotificationManager implements NotificationSystem {
  private pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private sendMessage: (
      msg: { customType: string; content: string; display: boolean; details?: unknown },
      opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ) => void,
    private agentActivity: Map<string, AgentActivityTracker>,
    private markFinished: (id: string) => void,
    private updateWidget: () => void,
  ) {}

  cancelNudge(key: string): void {
    const timer = this.pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      this.pendingNudges.delete(key);
    }
  }

  sendCompletion(record: Agent): void {
    this.agentActivity.delete(record.id);
    this.markFinished(record.id);
    this.scheduleNudge(record.id, () => this.emitIndividualNudge(record));
    this.updateWidget();
  }

  cleanupCompleted(id: string): void {
    this.agentActivity.delete(id);
    this.markFinished(id);
    this.updateWidget();
  }

  dispose(): void {
    for (const timer of this.pendingNudges.values()) clearTimeout(timer);
    this.pendingNudges.clear();
  }

  private scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS): void {
    this.cancelNudge(key);
    this.pendingNudges.set(
      key,
      setTimeout(() => {
        this.pendingNudges.delete(key);
        try {
          send();
        } catch (err) {
          debugLog("notification render", err);
        }
      }, delay),
    );
  }

  private emitIndividualNudge(record: Agent): void {
    if (record.notification?.resultConsumed) return;

    const notification = formatTaskNotification(record, 500);
    const outputFile = record.outputFile;
    const footer = outputFile ? `\nFull transcript available at: ${outputFile}` : "";

    this.sendMessage(
      {
        customType: "subagent-notification",
        content: notification + footer,
        display: true,
        details: buildNotificationDetails(record, 500, this.agentActivity.get(record.id)),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }
}
