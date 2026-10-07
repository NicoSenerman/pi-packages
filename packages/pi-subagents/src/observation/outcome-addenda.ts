/**
 * outcome-addenda.ts — The trailing "what next" tail every outcome carrier
 * appends: the updates a child sent mid-run that no announcement delivered,
 * then the ask-back affordance when a child ended its turn with a question.
 *
 * Ported from upstream pi-subagents 21.3 (gotgenes/pi-packages #858) onto the
 * pitui fork's carrier set (foreground tool result, background completion
 * notification, get_subagent_result report). Pure functions over the three
 * facts they need, so any carrier can call them.
 */

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
