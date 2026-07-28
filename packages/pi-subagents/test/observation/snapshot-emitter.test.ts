import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SnapshotEmitter } from "#src/observation/snapshot-emitter";
import { createTestSubagent } from "#test/helpers/make-subagent";
import type { Subagent } from "#src/lifecycle/subagent";
import type { SubagentManager } from "#src/lifecycle/subagent-manager";

/** Minimal manager stub: only listAgents() is used by the emitter. */
function makeManagerStub(agents: Subagent[]): SubagentManager {
  return { listAgents: () => agents } as unknown as SubagentManager;
}

/** Build an emitter with a spyable appendEntry. */
function makeEmitter(agents: Subagent[]) {
  const appendEntry = vi.fn();
  const emitter = new SnapshotEmitter({
    manager: makeManagerStub(agents),
    appendEntry,
  });
  return { emitter, appendEntry };
}

/** Wire subscribeToUpdates to a controllable per-agent event sink. */
function wireSubscription(agent: Subagent) {
  let sink: ((event: AgentSessionEvent) => void) | undefined;
  const unsub = vi.fn(() => {
    sink = undefined;
  });
  vi.spyOn(agent, "subscribeToUpdates").mockImplementation((fn) => {
    sink = fn;
    return unsub;
  });
  return {
    unsub,
    emit: (event: AgentSessionEvent) => sink?.(event),
    isSubscribed: () => sink !== undefined,
  };
}

describe("SnapshotEmitter", () => {
  const ORIG = process.env.PITUI_BRIDGE;
  beforeEach(() => {
    process.env.PITUI_BRIDGE = "1";
    vi.useFakeTimers();
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PITUI_BRIDGE;
    else process.env.PITUI_BRIDGE = ORIG;
    vi.useRealTimers();
  });

  it("is a no-op when PITUI_BRIDGE is unset", () => {
    delete process.env.PITUI_BRIDGE;
    const agent = createTestSubagent({ id: "a1" });
    const { emitter, appendEntry } = makeEmitter([agent]);
    emitter.onSubagentStarted(agent);
    emitter.onSubagentCreated(agent);
    emitter.onSubagentCompleted(agent);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("emits on created and started", () => {
    const agent = createTestSubagent({ id: "a1", status: "running" });
    wireSubscription(agent);
    const { emitter, appendEntry } = makeEmitter([agent]);
    emitter.onSubagentCreated(agent);
    emitter.onSubagentStarted(agent);
    expect(appendEntry).toHaveBeenCalledTimes(2);
    const payload = appendEntry.mock.calls[1][1] as {
      agents: { id: string }[];
    };
    expect(payload.agents.map((a) => a.id)).toEqual(["a1"]);
  });

  it("subscribes on start and unsubscribes on completed", () => {
    const agent = createTestSubagent({ id: "a1", status: "running" });
    const sub = wireSubscription(agent);
    const { emitter } = makeEmitter([agent]);
    emitter.onSubagentStarted(agent);
    expect(sub.isSubscribed()).toBe(true);
    emitter.onSubagentCompleted(agent);
    expect(sub.unsub).toHaveBeenCalled();
  });

  it("coalesces a burst of session events into one debounced snapshot", () => {
    const agent = createTestSubagent({ id: "a1", status: "running" });
    const sub = wireSubscription(agent);
    const { emitter, appendEntry } = makeEmitter([agent]);
    emitter.onSubagentStarted(agent);
    appendEntry.mockClear();
    for (let i = 0; i < 20; i++)
      sub.emit({
        type: "tool_execution_start",
        toolCallId: `c${i}`,
        toolName: "read",
        args: {},
      });
    expect(appendEntry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(appendEntry).toHaveBeenCalledTimes(1);
  });

  it("detaches on completed (background completion path)", () => {
    const agent = createTestSubagent({ id: "a1", status: "running" });
    const sub = wireSubscription(agent);
    const { emitter } = makeEmitter([agent]);
    emitter.onSubagentStarted(agent);
    expect(sub.isSubscribed()).toBe(true);
    emitter.onSubagentCompleted(agent);
    expect(sub.unsub).toHaveBeenCalled();
  });

  it("emits the current state on completed (completed agents remain visible; pitui clears on SessionStart)", () => {
    const agent = createTestSubagent({ id: "a1", status: "completed" });
    wireSubscription(agent);
    const { emitter, appendEntry } = makeEmitter([agent]);
    emitter.onSubagentStarted(agent);
    appendEntry.mockClear();
    emitter.onSubagentCompleted(agent);
    const last = appendEntry.mock.calls.at(-1)?.[1] as {
      agents: { id: string; status: string }[];
    };
    expect(last.agents.map((a) => a.id)).toEqual(["a1"]);
    expect(last.agents[0].status).toBe("completed");
  });

  it("does not emit a clear while agents are still active", () => {
    const a1 = createTestSubagent({ id: "a1", status: "completed" });
    const a2 = createTestSubagent({ id: "a2", status: "running" });
    wireSubscription(a1);
    wireSubscription(a2);
    const { emitter, appendEntry } = makeEmitter([a1, a2]);
    emitter.onSubagentStarted(a1);
    emitter.onSubagentStarted(a2);
    appendEntry.mockClear();
    emitter.onSubagentCompleted(a1);
    const calls = appendEntry.mock.calls.map((c) =>
      (c[1] as { agents: { id: string }[] }).agents.map((a) => a.id),
    );
    expect(calls.every((ids) => ids.includes("a2"))).toBe(true);
  });

  it("dispose tears down subscriptions and pending timers", () => {
    const agent = createTestSubagent({ id: "a1", status: "running" });
    const sub = wireSubscription(agent);
    const { emitter, appendEntry } = makeEmitter([agent]);
    emitter.onSubagentStarted(agent);
    sub.emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: {},
    });
    emitter.dispose();
    expect(sub.unsub).toHaveBeenCalled();
    vi.advanceTimersByTime(120);
    expect(appendEntry).toHaveBeenCalledTimes(1); // only the onSubagentStarted emit
  });
});
