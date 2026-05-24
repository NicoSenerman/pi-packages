import { describe, expect, it, vi } from "vitest";
import { AgentRecord } from "#src/lifecycle/agent-record";
import { subscribeRecordObserver } from "#src/observation/record-observer";
import { createMockSession } from "#test/helpers/mock-session";

function makeRecord(overrides?: Partial<ConstructorParameters<typeof AgentRecord>[0]>) {
  return new AgentRecord({
    id: "test-1",
    type: "general-purpose",
    description: "test",
    status: "running",
    ...overrides,
  });
}

describe("subscribeRecordObserver", () => {
  it("increments record.toolUses on tool_execution_end", () => {
    const session = createMockSession();
    const record = makeRecord();
    subscribeRecordObserver(session, record);

    expect(record.toolUses).toBe(0);
    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(record.toolUses).toBe(1);
    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(record.toolUses).toBe(2);
  });

  it("accumulates lifetimeUsage on message_end with assistant usage", () => {
    const session = createMockSession();
    const record = makeRecord();
    subscribeRecordObserver(session, record);

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } },
    });
    expect(record.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } },
    });
    expect(record.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
  });

  it("ignores message_end from non-assistant roles", () => {
    const session = createMockSession();
    const record = makeRecord();
    subscribeRecordObserver(session, record);

    session.emit({
      type: "message_end",
      message: { role: "user", usage: { input: 999, output: 999, cacheWrite: 999 } },
    });
    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("ignores message_end without usage", () => {
    const session = createMockSession();
    const record = makeRecord();
    subscribeRecordObserver(session, record);

    session.emit({ type: "message_end", message: { role: "assistant" } });
    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("increments compactionCount on compaction_end (not aborted)", () => {
    const session = createMockSession();
    const record = makeRecord();
    subscribeRecordObserver(session, record);

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12345 },
      reason: "threshold",
    });
    expect(record.compactionCount).toBe(1);

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 22222 },
      reason: "manual",
    });
    expect(record.compactionCount).toBe(2);
  });

  it("calls onCompact with record and info on compaction_end", () => {
    const session = createMockSession();
    const record = makeRecord();
    const onCompact = vi.fn();
    subscribeRecordObserver(session, record, { onCompact });

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12345 },
      reason: "threshold",
    });

    expect(onCompact).toHaveBeenCalledWith(record, {
      reason: "threshold",
      tokensBefore: 12345,
    });
  });

  it("ignores compaction_end with aborted: true", () => {
    const session = createMockSession();
    const record = makeRecord();
    const onCompact = vi.fn();
    subscribeRecordObserver(session, record, { onCompact });

    session.emit({
      type: "compaction_end",
      aborted: true,
      result: { tokensBefore: 5000 },
      reason: "overflow",
    });
    expect(record.compactionCount).toBe(0);
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("ignores compaction_end without result", () => {
    const session = createMockSession();
    const record = makeRecord();
    subscribeRecordObserver(session, record);

    session.emit({
      type: "compaction_end",
      aborted: false,
      reason: "threshold",
    });
    expect(record.compactionCount).toBe(0);
  });

  it("returned function unsubscribes from session", () => {
    const session = createMockSession();
    const record = makeRecord();
    const unsubscribe = subscribeRecordObserver(session, record);

    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(record.toolUses).toBe(1);

    unsubscribe();

    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(record.toolUses).toBe(1); // unchanged
  });
});
