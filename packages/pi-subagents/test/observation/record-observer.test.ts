import { describe, expect, it, vi } from "vitest";
import { SubagentState } from "#src/lifecycle/subagent-state";
import { subscribeSubagentObserver } from "#src/observation/record-observer";
import { createMockSession } from "#test/helpers/mock-session";

function makeState() {
  return new SubagentState({ status: "running" });
}

describe("subscribeSubagentObserver", () => {
  it("increments state.toolUses on tool_execution_end", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    expect(state.toolUses).toBe(0);
    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.toolUses).toBe(1);
    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(state.toolUses).toBe(2);
  });

  it("accumulates lifetimeUsage on message_end with assistant usage", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
  });

  it("ignores message_end from non-assistant roles", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_end",
      message: { role: "user", usage: { input: 999, output: 999, cacheWrite: 999 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("increments compactionCount on compaction_end (not aborted)", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12345 },
      reason: "threshold",
    });
    expect(state.compactionCount).toBe(1);

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 22222 },
      reason: "manual",
    });
    expect(state.compactionCount).toBe(2);
  });

  it("calls onCompact with info on compaction_end", () => {
    const session = createMockSession();
    const state = makeState();
    const onCompact = vi.fn();
    subscribeSubagentObserver(session, state, { onCompact });

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12345 },
      reason: "threshold",
    });

    expect(onCompact).toHaveBeenCalledWith({
      reason: "threshold",
      tokensBefore: 12345,
    });
  });

  it("ignores compaction_end with aborted: true", () => {
    const session = createMockSession();
    const state = makeState();
    const onCompact = vi.fn();
    subscribeSubagentObserver(session, state, { onCompact });

    session.emit({
      type: "compaction_end",
      aborted: true,
      result: { tokensBefore: 5000 },
      reason: "overflow",
    });
    expect(state.compactionCount).toBe(0);
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("ignores compaction_end without result", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "compaction_end",
      aborted: false,
      reason: "threshold",
    });
    expect(state.compactionCount).toBe(0);
  });

  it("returned function unsubscribes from session", () => {
    const session = createMockSession();
    const state = makeState();
    const unsubscribe = subscribeSubagentObserver(session, state);

    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.toolUses).toBe(1);

    unsubscribe();

    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(state.toolUses).toBe(1); // unchanged
  });
});
