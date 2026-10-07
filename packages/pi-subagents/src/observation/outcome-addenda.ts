/**
 * outcome-addenda.ts — The trailing "what next" tail every outcome carrier
 * appends (the updates a child sent mid-run that no announcement delivered,
 * then the ask-back affordance when a child ended its turn with a question),
 * plus the shared reading of WHAT a terminal status means — one source of
 * truth, since the fork's carriers disagreed on it ("max turns exceeded" vs
 * "output may be incomplete"...).
 *
 * Ported from upstream pi-subagents 21.3 + 23.0 (gotgenes/pi-packages #858,
 * #1021, #1022) onto the pitui fork's carrier set. Pure functions over the
 * facts they need, so any carrier can call them.
 */

import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import { type TurnBudget, wrappedUpAtTurnLimit } from "#src/lifecycle/turn-limits";

/** What a terminal status means, independent of how a carrier renders it. */
export interface StatusMeaning {
  /** Sentence-initial label, e.g. "Wrapped up". */
  label: string;
  /** Why, without terminal punctuation, e.g. "after turn-budget warning". */
  detail: string;
}

// "steered" stays: pre-23.0 persisted records and older forks can carry it;
// the turn-budget engine no longer produces it, but a carrier must still render one.
const STATUS_MEANINGS: Partial<Record<SubagentStatus, StatusMeaning>> = {
  aborted: { label: "Aborted", detail: "turn limit reached, output may be incomplete" },
  stopped: { label: "Stopped", detail: "user request" },
  steered: { label: "Wrapped up", detail: "reached turn limit" },
};

/** A run that finished on its own after the harness warned it about its turn limit. */
const WRAPPED_UP: StatusMeaning = { label: "Wrapped up", detail: "after turn-budget warning" };

/** Only what the status presentations read: status, the error an error label names, the budget that qualifies a completed run. */
export interface StatusOutcome {
  status: string;
  error?: string;
  turnBudget?: TurnBudget;
}

function statusMeaning(outcome: StatusOutcome): StatusMeaning | undefined {
  return wrappedUpAtTurnLimit(outcome)
    ? WRAPPED_UP
    : STATUS_MEANINGS[outcome.status as SubagentStatus];
}

/**
 * Standalone label form, e.g. "Wrapped up (after turn-budget warning)".
 * An error reports its message instead: the status alone does not say what went wrong.
 */
export function renderStatusLabel(outcome: StatusOutcome): string {
  if (outcome.status === "error") return `Error: ${outcome.error ?? "unknown"}`;
  const meaning = statusMeaning(outcome);
  return meaning ? `${meaning.label} (${meaning.detail})` : "Done";
}

/**
 * Parenthetical suffix form, e.g. " (wrapped up — after turn-budget warning)", for a
 * carrier appending to its own sentence. Empty when the status is unremarkable.
 */
export function renderStatusNote(outcome: StatusOutcome): string {
  const meaning = statusMeaning(outcome);
  if (!meaning) return "";
  return ` (${meaning.label.toLowerCase()} \u2014 ${meaning.detail})`;
}

/** A turn budget rendered as a stats-line part, e.g. "Turns: 7/20" (or "7" with no limit). */
export function renderTurnBudget(budget: TurnBudget | undefined): string | undefined {
  if (!budget) return undefined;
  return budget.maxTurns !== undefined
    ? `Turns: ${budget.used}/${budget.maxTurns}`
    : `Turns: ${budget.used}`;
}

/** Why a resume is unavailable, worded for the affordance sentence. */
export type ResumeRefusal =
  /** The child is mid-run; the refusal lifts when it settles. */
  | "still-running"
  /** No session exists to resume into. */
  | "no-session"
  /** The session was explicitly released after its retention window. */
  | "session-released"
  /** The run lived in an isolated workspace that has since been removed. */
  | "workspace-disposed";

/** Standalone clauses, matching upstream wording where the fork's reason set overlaps. */
const RESUME_REFUSAL_CLAUSES: Record<Exclude<ResumeRefusal, "still-running">, string> = {
  // Deliberately not "...no session to resume": the clause sits next to the
  // resume call the parent must not be offered.
  "no-session": "it has no active session",
  "session-released": "its session was released after its retention window",
  "workspace-disposed": "it ran in an isolated workspace that has since been removed",
};

/**
 * The trailing affordance for a child that ended its turn with a question.
 * Empty when the child asked nothing. Names the exact resume call that answers
 * it when a resume would be accepted, why it cannot be answered when one would
 * be refused for good, and what to wait for when the child is still running —
 * the parent is never told to make a call this extension declines.
 */
export function renderQuestionAffordance(
  agentId: string,
  question: string | undefined,
  refusal: ResumeRefusal | undefined,
): string {
  if (!question) return "";
  const quoted = question
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  if (refusal === "still-running") {
    return (
      "\n\nThis agent asked a question before it finished running, so it cannot be " +
      `resumed yet:\n\n${quoted}\n\n` +
      "Wait for it to settle — get_subagent_result with wait: true returns when it " +
      "does — then answer it."
    );
  }
  if (refusal) {
    return (
      "\n\nThis agent ended its run with a question that can no longer be answered — " +
      `${RESUME_REFUSAL_CLAUSES[refusal]}:\n\n${quoted}\n\n` +
      "Spawn a new agent with the context it needs; this one cannot be resumed."
    );
  }
  return (
    `\n\nThis agent is waiting on an answer:\n\n${quoted}\n\n` +
    `Answer by calling subagent with resume: "${agentId}" and your answer as the prompt.`
  );
}

/**
 * The updates a child sent while a carrier held this run's outcome, quoted the
 * way the ask-back affordance quotes the child's question. Empty when every
 * update already reached the parent through the announcement channel.
 */
export function renderRunUpdates(updates: readonly string[] | undefined): string {
  if (!updates?.length) return "";
  const quoted = updates
    .map((update) =>
      update
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    )
    .join("\n\n");
  return `\n\nUpdates this agent sent while it worked:\n\n${quoted}`;
}

/**
 * The addenda tail every outcome carrier appends, in one order: what the agent
 * flagged along the way, then the call to action that follows.
 */
export function renderOutcomeAddenda(outcome: {
  id: string;
  runUpdates?: readonly string[];
  pendingQuestion?: string;
  resumeRefusal: ResumeRefusal | undefined;
}): string {
  return (
    renderRunUpdates(outcome.runUpdates) +
    renderQuestionAffordance(outcome.id, outcome.pendingQuestion, outcome.resumeRefusal)
  );
}

/**
 * Derive the current resume refusal for a record, for `renderOutcomeAddenda`'s
 * required refusal slot. Undefined when a resume would be accepted.
 */
export function currentResumeRefusal(record: {
  isRunning(): boolean;
  status: string;
  isSessionReady(): boolean;
  sessionReleased: boolean;
}): ResumeRefusal | undefined {
  if (record.isRunning() || record.status === "queued") return "still-running";
  if (!record.isSessionReady()) {
    return record.sessionReleased ? "session-released" : "no-session";
  }
  return undefined;
}
