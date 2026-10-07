import { describe, expect, it } from "vitest";
import { SubagentState } from "#src/lifecycle/subagent-state";
import {
  currentResumeRefusal,
  renderOutcomeAddenda,
  renderQuestionAffordance,
  renderRunUpdates,
} from "#src/observation/outcome-addenda";

describe("SubagentState — pending question and run-update ledger", () => {
  it("records the ask_parent question and carries it into the settled outcome on resume", () => {
    const state = new SubagentState();
    state.markRunning(1000);
    state.setPendingQuestion("which branch should I rebase onto?");
    state.markCompleted("partial findings");
    state.resetForResume(2000);
    // The outgoing run's outcome keeps the question; the fresh run has none yet.
    const superseded = state.supersededOutcome(0);
    expect(superseded?.pendingQuestion).toBe("which branch should I rebase onto?");
    expect(state.pendingQuestion).toBeUndefined();
  });

  it("delivers each update exactly once: announced copies stop being owed", () => {
    const state = new SubagentState();
    state.markRunning(1000);
    state.recordUpdate("checking the auth path");
    state.recordUpdate("auth is fine; the bug is in token refresh");
    expect(state.runUpdates).toEqual([
      "checking the auth path",
      "auth is fine; the bug is in token refresh",
    ]);
    state.markUpdateAnnounced("checking the auth path");
    expect(state.runUpdates).toEqual(["auth is fine; the bug is in token refresh"]);
  });

  it("clears the ledger when a new run begins (markRunning and resetForResume)", () => {
    const state = new SubagentState();
    state.markRunning(1000);
    state.recordUpdate("one");
    state.markCompleted("done");
    state.resetForResume(2000);
    expect(state.runUpdates).toEqual([]);
  });
});

describe("renderQuestionAffordance", () => {
  it("names the exact resume call when a resume would be accepted", () => {
    const out = renderQuestionAffordance("abc123", "proceed with deletion?", undefined);
    expect(out).toContain("waiting on an answer");
    expect(out).toContain('resume: "abc123"');
    expect(out).toContain("  proceed with deletion?");
  });

  it("says why the question can no longer be answered on a refused resume", () => {
    const out = renderQuestionAffordance("abc123", "proceed?", "session-released");
    expect(out).toContain("can no longer be answered");
    expect(out).toContain("session was released");
    expect(out).not.toContain('resume: "abc123"');
  });

  it("is empty when no question was asked", () => {
    expect(renderQuestionAffordance("abc123", undefined, undefined)).toBe("");
  });
});

describe("renderRunUpdates + renderOutcomeAddenda", () => {
  it("quotes undelivered updates and stays empty when all were announced", () => {
    expect(renderRunUpdates(undefined)).toBe("");
    expect(renderRunUpdates([])).toBe("");
    const out = renderRunUpdates(["found the cause", "second note"]);
    expect(out).toContain("Updates this agent sent while it worked:");
    expect(out).toContain("  found the cause");
    expect(out).toContain("  second note");
  });

  it("renders updates before the question affordance", () => {
    const out = renderOutcomeAddenda({
      id: "abc123",
      runUpdates: ["flagging a scope problem"],
      pendingQuestion: "keep going?",
      resumeRefusal: undefined,
    });
    const updatesAt = out.indexOf("flagging a scope problem");
    const questionAt = out.indexOf("keep going?");
    expect(updatesAt).toBeGreaterThan(-1);
    expect(questionAt).toBeGreaterThan(updatesAt);
  });
});

describe("currentResumeRefusal", () => {
  const base = { isRunning: () => false, status: "completed", isSessionReady: () => true, sessionReleased: false };

  it("is still-running while active", () => {
    expect(currentResumeRefusal({ ...base, isRunning: () => true })).toBe("still-running");
    expect(currentResumeRefusal({ ...base, status: "queued" })).toBe("still-running");
  });

  it("distinguishes released sessions from absent ones", () => {
    expect(
      currentResumeRefusal({ ...base, isSessionReady: () => false, sessionReleased: true }),
    ).toBe("session-released");
    expect(currentResumeRefusal({ ...base, isSessionReady: () => false })).toBe("no-session");
  });

  it("is undefined when a resume would be accepted", () => {
    expect(currentResumeRefusal(base)).toBeUndefined();
  });
});
