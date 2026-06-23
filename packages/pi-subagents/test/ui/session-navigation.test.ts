import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { SessionMessage } from "#src/types";
import { listNavigableAgents, liveSource, type NavigableSubagent, type TranscriptSource } from "#src/ui/session-navigation";

const registry = new AgentTypeRegistry(() => new Map());

function makeNavigable(overrides: Partial<NavigableSubagent> = {}): NavigableSubagent {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "Test task",
    status: "completed",
    startedAt: 1000,
    completedAt: 4000,
    toolUses: 2,
    activeTools: new Map(),
    responseText: "",
    agentMessages: [],
    isSessionReady: () => true,
    subscribeToUpdates: vi.fn(() => () => {}),
    getToolDefinition: vi.fn(() => undefined),
    ...overrides,
  };
}

describe("listNavigableAgents", () => {
  it("returns an empty list for no agents", () => {
    expect(listNavigableAgents([], registry)).toEqual([]);
  });

  it("keeps only session-ready records", () => {
    const ready = makeNavigable({ id: "ready", isSessionReady: () => true });
    const notReady = makeNavigable({ id: "not-ready", isSessionReady: () => false });
    const entries = listNavigableAgents([ready, notReady], registry);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.record).toBe(ready);
  });

  it("builds a label with name, description, tool count, status, and duration", () => {
    const record = makeNavigable({
      type: "general-purpose",
      description: "Investigate the bug",
      toolUses: 3,
      status: "completed",
      startedAt: 1000,
      completedAt: 4000,
    });
    const [entry] = listNavigableAgents([record], registry);
    // getDisplayName resolves "general-purpose" against the empty registry to its fallback display name.
    expect(entry.label).toBe("Agent (Investigate the bug) · 3 tools · completed · 3.0s");
  });
});

describe("liveSource", () => {
  it("getMessages returns the record's agentMessages", () => {
    const messages = [{ role: "user", content: "hi" }] as unknown as SessionMessage[];
    const record = makeNavigable({ agentMessages: messages });
    expect(liveSource(record).getMessages()).toBe(messages);
  });

  it("subscribe delegates to subscribeToUpdates and forwards change notifications", () => {
    let captured: ((event: unknown) => void) | undefined;
    const unsub = vi.fn();
    const record = makeNavigable({
      subscribeToUpdates: vi.fn((fn: (event: unknown) => void) => {
        captured = fn;
        return unsub;
      }) as NavigableSubagent["subscribeToUpdates"],
    });
    const onChange = vi.fn();
    const returned = liveSource(record).subscribe(onChange);
    expect(record.subscribeToUpdates).toHaveBeenCalledOnce();
    captured?.({ type: "turn_end" });
    expect(onChange).toHaveBeenCalledOnce();
    expect(returned).toBe(unsub);
  });

  it("streaming returns activity state only while running", () => {
    const activeTools = new Map([["k", "read"]]);
    const running = makeNavigable({ status: "running", activeTools, responseText: "working" });
    expect(liveSource(running).streaming()).toEqual({ activeTools, responseText: "working" });

    const completed = makeNavigable({ status: "completed" });
    expect(liveSource(completed).streaming()).toBeUndefined();
  });

  it("getToolDefinition delegates to the record's getToolDefinition", () => {
    const def = { name: "read" } as unknown as ReturnType<TranscriptSource["getToolDefinition"]>;
    const record = makeNavigable({ getToolDefinition: vi.fn(() => def) });
    expect(liveSource(record).getToolDefinition("read")).toBe(def);
    expect(record.getToolDefinition).toHaveBeenCalledWith("read");
  });
});
