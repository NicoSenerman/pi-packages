import { debugLog } from "./debug.js";
import type { AgentRecord, NotificationDetails } from "./types.js";
import type { AgentActivityTracker } from "./ui/agent-activity-tracker.js";
import { getLifetimeTotal, getSessionContextPercent } from "./usage.js";

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
export function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    "<task-notification>",
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
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
  record: AgentRecord,
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

/** Build event data for lifecycle events from an AgentRecord. */
export function buildEventData(record: AgentRecord) {
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

/** Narrow deps for the notification system — only the methods it actually calls. */
export interface NotificationDeps {
  sendMessage: (
    msg: { customType: string; content: string; display: boolean; details?: unknown },
    opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => void;
  agentActivity: Map<string, AgentActivityTracker>;
  markFinished: (id: string) => void;
  updateWidget: () => void;
}

export interface NotificationSystem {
  cancelNudge: (key: string) => void;
  sendCompletion: (record: AgentRecord) => void;
  cleanupCompleted: (id: string) => void;
  dispose: () => void;
}

const NUDGE_HOLD_MS = 200;

export function createNotificationSystem(deps: NotificationDeps): NotificationSystem {
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(
      key,
      setTimeout(() => {
        pendingNudges.delete(key);
        try {
          send();
        } catch (err) {
          debugLog("notification render", err);
        }
      }, delay),
    );
  }

  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;

    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";

    deps.sendMessage(
      {
        customType: "subagent-notification",
        content: notification + footer,
        display: true,
        details: buildNotificationDetails(record, 500, deps.agentActivity.get(record.id)),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  function sendCompletion(record: AgentRecord) {
    deps.agentActivity.delete(record.id);
    deps.markFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    deps.updateWidget();
  }

  function cleanupCompleted(id: string) {
    deps.agentActivity.delete(id);
    deps.markFinished(id);
    deps.updateWidget();
  }

  function dispose() {
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
  }

  return { cancelNudge, sendCompletion, cleanupCompleted, dispose };
}
