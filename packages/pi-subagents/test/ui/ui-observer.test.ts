import { describe, expect, it, vi } from "vitest";
import type { AgentActivity } from "../../src/ui/agent-widget.js";
import { subscribeUIObserver } from "../../src/ui/ui-observer.js";

/** Minimal mock session with subscribable event bus. */
function mockSession() {
  const subscribers = new Set<(event: any) => void>();
  return {
    subscribe: vi.fn((fn: (event: any) => void) => {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    }),
    emit(event: any) {
      for (const fn of subscribers) fn(event);
    },
  };
}

function makeActivity(overrides?: Partial<AgentActivity>): AgentActivity {
  return {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    responseText: "",
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    ...overrides,
  };
}

describe("subscribeUIObserver", () => {
  it("adds to activeTools on tool_execution_start and calls onUpdate", () => {
    const session = mockSession();
    const state = makeActivity();
    const onUpdate = vi.fn();
    subscribeUIObserver(session, state, onUpdate);

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    expect(state.activeTools.size).toBe(1);
    expect([...state.activeTools.values()]).toContain("Read");
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("removes from activeTools on tool_execution_end and increments toolUses", () => {
    const session = mockSession();
    const state = makeActivity();
    const onUpdate = vi.fn();
    subscribeUIObserver(session, state, onUpdate);

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    session.emit({ type: "tool_execution_end", toolName: "Read" });

    expect(state.activeTools.size).toBe(0);
    expect(state.toolUses).toBe(1);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("resets responseText on message_start", () => {
    const session = mockSession();
    const state = makeActivity({ responseText: "previous text" });
    subscribeUIObserver(session, state);

    session.emit({ type: "message_start" });
    expect(state.responseText).toBe("");
  });

  it("appends to responseText on message_update text_delta and calls onUpdate", () => {
    const session = mockSession();
    const state = makeActivity();
    const onUpdate = vi.fn();
    subscribeUIObserver(session, state, onUpdate);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    expect(state.responseText).toBe("Hello ");
    expect(onUpdate).toHaveBeenCalledOnce();

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });
    expect(state.responseText).toBe("Hello world");
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("ignores message_update with non-text_delta events", () => {
    const session = mockSession();
    const state = makeActivity();
    const onUpdate = vi.fn();
    subscribeUIObserver(session, state, onUpdate);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "tool_use", name: "Read" },
    });
    expect(state.responseText).toBe("");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("increments turnCount on turn_end and calls onUpdate", () => {
    const session = mockSession();
    const state = makeActivity();
    const onUpdate = vi.fn();
    subscribeUIObserver(session, state, onUpdate);

    expect(state.turnCount).toBe(1);
    session.emit({ type: "turn_end" });
    expect(state.turnCount).toBe(2);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("accumulates lifetimeUsage on message_end with assistant usage", () => {
    const session = mockSession();
    const state = makeActivity();
    const onUpdate = vi.fn();
    subscribeUIObserver(session, state, onUpdate);

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });
    expect(onUpdate).toHaveBeenCalledOnce();

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
  });

  it("ignores message_end without usage", () => {
    const session = mockSession();
    const state = makeActivity();
    const onUpdate = vi.fn();
    subscribeUIObserver(session, state, onUpdate);

    session.emit({ type: "message_end", message: { role: "assistant" } });
    expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("returned function unsubscribes from session", () => {
    const session = mockSession();
    const state = makeActivity();
    const unsubscribe = subscribeUIObserver(session, state);

    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.toolUses).toBe(1);

    unsubscribe();

    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(state.toolUses).toBe(1); // unchanged
  });

  it("works without onUpdate callback", () => {
    const session = mockSession();
    const state = makeActivity();
    subscribeUIObserver(session, state);

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    session.emit({ type: "tool_execution_end", toolName: "Read" });
    session.emit({ type: "turn_end" });

    expect(state.toolUses).toBe(1);
    expect(state.turnCount).toBe(2);
  });
});
