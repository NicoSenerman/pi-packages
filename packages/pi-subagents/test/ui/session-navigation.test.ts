import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { SessionMessage } from "#src/types";
import {
  listNavigableAgents,
  liveSource,
  type NavigableSubagent,
  renderTranscriptLines,
  type TranscriptSource,
} from "#src/ui/session-navigation";

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
});

describe("renderTranscriptLines", () => {
  function staticSource(messages: SessionMessage[], streaming?: ReturnType<TranscriptSource["streaming"]>): TranscriptSource {
    return {
      getMessages: () => messages,
      subscribe: () => undefined,
      streaming: () => streaming,
    };
  }

  it("returns a placeholder for an empty history", () => {
    expect(renderTranscriptLines(staticSource([]))).toEqual(["(no messages yet)"]);
  });

  it("renders the serialized conversation split into lines", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ] as unknown as SessionMessage[];
    const lines = renderTranscriptLines(staticSource(messages));
    expect(lines.some((l) => l.includes("Hello"))).toBe(true);
    expect(lines.some((l) => l.includes("Hi there"))).toBe(true);
  });

  it("appends a streaming-activity line while running", () => {
    const messages = [{ role: "user", content: "go" }] as unknown as SessionMessage[];
    const lines = renderTranscriptLines(
      staticSource(messages, { activeTools: new Map([["k", "read"]]), responseText: "" }),
    );
    expect(lines.at(-1)).toContain("reading");
  });
});
