import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SnapshotEmitter } from "#src/observation/snapshot-emitter";
import { createTestSubagent } from "#test/helpers/make-subagent";
import type { Subagent } from "#src/lifecycle/subagent";
import type { SubagentManager } from "#src/lifecycle/subagent-manager";

// Pins the durable-write cadence of the pitui bridge. Every appendEntry is
// a session-file line pi re-parses on every resume, so a 2-minute single-agent
// workload must produce a bounded number of snapshot entries (the pre-floor
// emitter wrote ~800: one per 150ms event burst).

const RUN_MS = 120_000;
const EVENT_EVERY_MS = 150;
const MIN_INTERVAL_MS = 5_000;

function makeManager(agents: Subagent[]): SubagentManager {
  return { listAgents: () => agents } as unknown as SubagentManager;
}

describe("SnapshotEmitter durable-write cadence", () => {
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

  it("bounds event-driven writes to one per MIN_INTERVAL_MS", () => {
    const agent = createTestSubagent({ id: "a1", status: "running" });
    let responseText = "";
    let toolUses = 0;
    vi.spyOn(agent, "responseText", "get").mockImplementation(
      () => responseText,
    );
    vi.spyOn(agent, "toolUses", "get").mockImplementation(() => toolUses);
    const entries: { agents: { responseText: string }[] }[] = [];
    const emitter = new SnapshotEmitter({
      manager: makeManager([agent]),
      appendEntry: (_customType, data) => {
        entries.push(data as { agents: { responseText: string }[] });
      },
    });
    let sink: ((e: AgentSessionEvent) => void) | undefined;
    vi.spyOn(agent, "subscribeToUpdates").mockImplementation((fn) => {
      sink = fn;
      return () => {};
    });
    emitter.onSubagentStarted(agent);
    const before = entries.length;
    const events = RUN_MS / EVENT_EVERY_MS;
    for (let i = 0; i < events; i++) {
      vi.advanceTimersByTime(EVENT_EVERY_MS);
      responseText += "x".repeat(40_000 / events);
      if (i % 10 === 0) toolUses++;
      sink?.({ type: "message_delta" } as AgentSessionEvent);
    }
    vi.advanceTimersByTime(2 * MIN_INTERVAL_MS);
    const writes = entries.length - before;
    // Floor: 2 minutes of continuous churn → ~RUN_MS/MIN_INTERVAL_MS writes,
    // never the ~800 the debounce-only policy produced.
    expect(writes).toBe(RUN_MS / MIN_INTERVAL_MS);
    expect(writes).toBeLessThan(30);
    // Cap: responseText is truncated in the durable payload.
    for (const e of entries) {
      expect(e.agents[0].responseText.length).toBeLessThanOrEqual(512);
    }
  });

  it("skips identical payloads even across material emits", () => {
    const agent = createTestSubagent({ id: "a1", status: "running" });
    let writes = 0;
    const emitter = new SnapshotEmitter({
      manager: makeManager([agent]),
      appendEntry: () => {
        writes++;
      },
    });
    emitter.onSubagentStarted(agent);
    emitter.onSubagentCompleted(agent);
    emitter.onSubagentFinished(agent);
    expect(writes).toBe(1);
  });
});
