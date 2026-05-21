import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEventData,
  buildNotificationDetails,
  createNotificationSystem,
  escapeXml,
  formatTaskNotification,
  getStatusLabel,
} from "../src/notification.js";
import { AgentActivityTracker } from "../src/ui/agent-activity-tracker.js";
import { createTestRecord } from "./helpers/make-record.js";

// ---- Pure helper tests ----

describe("escapeXml", () => {
  it("escapes &, <, >", () => {
    expect(escapeXml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("returns unchanged string with no special chars", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });
});

describe("getStatusLabel", () => {
  it('returns error message for "error"', () => {
    expect(getStatusLabel("error", "timeout")).toBe("Error: timeout");
  });

  it('returns "unknown" when error is undefined', () => {
    expect(getStatusLabel("error")).toBe("Error: unknown");
  });

  it('returns label for "aborted"', () => {
    expect(getStatusLabel("aborted")).toBe("Aborted (max turns exceeded)");
  });

  it('returns label for "steered"', () => {
    expect(getStatusLabel("steered")).toBe("Wrapped up (turn limit)");
  });

  it('returns "Done" for completed', () => {
    expect(getStatusLabel("completed")).toBe("Done");
  });
});

describe("formatTaskNotification", () => {
  const baseRecord = createTestRecord();

  it("produces valid XML structure", () => {
    const xml = formatTaskNotification(baseRecord, 500);
    expect(xml).toContain("<task-notification>");
    expect(xml).toContain("</task-notification>");
    expect(xml).toContain("<task-id>agent-1</task-id>");
    expect(xml).toContain("<status>Done</status>");
  });

  it("truncates long results", () => {
    const longResult = "x".repeat(600);
    const record = createTestRecord({ result: longResult });
    const xml = formatTaskNotification(record, 100);
    expect(xml).toContain("truncated");
    expect(xml).not.toContain(longResult);
  });

  it("shows No output when result is undefined", () => {
    const record = createTestRecord({ result: undefined });
    const xml = formatTaskNotification(record, 500);
    expect(xml).toContain("No output.");
  });

  it("includes toolCallId when present", () => {
    const record = createTestRecord({ toolCallId: "tc-123" });
    const xml = formatTaskNotification(record, 500);
    expect(xml).toContain("<tool-use-id>tc-123</tool-use-id>");
  });

  it("excludes toolCallId when absent", () => {
    const xml = formatTaskNotification(baseRecord, 500);
    expect(xml).not.toContain("tool-use-id");
  });
});

describe("buildNotificationDetails", () => {
  const baseRecord = createTestRecord({
    description: "Test",
    result: "Done.",
    toolUses: 2,
    completedAt: 3000,
    lifetimeUsage: { input: 100, output: 200, cacheWrite: 0 },
  });

  it("maps record fields to notification shape", () => {
    const details = buildNotificationDetails(baseRecord, 500);
    expect(details.id).toBe("agent-1");
    expect(details.description).toBe("Test");
    expect(details.status).toBe("completed");
    expect(details.toolUses).toBe(2);
    expect(details.durationMs).toBe(2000);
    expect(details.totalTokens).toBe(300);
    expect(details.resultPreview).toBe("Done.");
  });

  it("uses activity turnCount when provided", () => {
    const activity = new AgentActivityTracker(10);
    for (let i = 0; i < 6; i++) activity.onTurnEnd(); // turnCount starts at 1, 6 increments → 7
    const details = buildNotificationDetails(baseRecord, 500, activity);
    expect(details.turnCount).toBe(7);
    expect(details.maxTurns).toBe(10);
  });

  it("truncates long result previews with ellipsis", () => {
    const record = createTestRecord({ description: "Test", result: "x".repeat(600), toolUses: 2, completedAt: 3000, lifetimeUsage: { input: 100, output: 200, cacheWrite: 0 } });
    const details = buildNotificationDetails(record, 100);
    expect(details.resultPreview).toHaveLength(101); // 100 chars + "…"
    expect(details.resultPreview.endsWith("…")).toBe(true);
  });
});

describe("buildEventData", () => {
  const baseRecord = createTestRecord({
    type: "Explore",
    description: "Search files",
    result: "Found 3 files",
    toolUses: 5,
    lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 },
  });

  it("includes all expected fields", () => {
    const data = buildEventData(baseRecord);
    expect(data).toEqual({
      id: "agent-1",
      type: "Explore",
      description: "Search files",
      result: "Found 3 files",
      error: undefined,
      status: "completed",
      toolUses: 5,
      durationMs: 1000,
      tokens: { input: 1000, output: 500, total: 1500 },
    });
  });

  it("omits tokens when total is zero", () => {
    const record = createTestRecord({ type: "Explore", description: "Search files", result: "Found 3 files", toolUses: 5, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } });
    const data = buildEventData(record);
    expect(data.tokens).toBeUndefined();
  });

  it("uses Date.now() fallback when completedAt is undefined", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const record = createTestRecord({ type: "Explore", description: "Search files", result: "Found 3 files", toolUses: 5, lifetimeUsage: { input: 1000, output: 500, cacheWrite: 0 }, completedAt: undefined });
    const data = buildEventData(record);
    expect(data.durationMs).toBe(4000); // 5000 - 1000
    vi.useRealTimers();
  });
});

// ---- Factory tests ----

describe("createNotificationSystem", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeps() {
    return {
      sendMessage: vi.fn(),
      agentActivity: new Map<string, AgentActivityTracker>(),
      markFinished: vi.fn(),
      updateWidget: vi.fn(),
    };
  }

  const baseRecord = createTestRecord({
    description: "Test",
    result: "Done.",
    toolUses: 2,
    lifetimeUsage: { input: 100, output: 200, cacheWrite: 0 },
  });

  it("cancelNudge prevents a scheduled nudge from firing", () => {
    const deps = makeDeps();
    const system = createNotificationSystem(deps);
    system.sendCompletion(baseRecord);
    system.cancelNudge("agent-1");
    vi.advanceTimersByTime(300);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("sendCompletion cleans up activity and widget, then schedules nudge", () => {
    const deps = makeDeps();
    deps.agentActivity.set("agent-1", new AgentActivityTracker());
    const system = createNotificationSystem(deps);
    system.sendCompletion(baseRecord);
    expect(deps.agentActivity.has("agent-1")).toBe(false);
    expect(deps.markFinished).toHaveBeenCalledWith("agent-1");
    expect(deps.updateWidget).toHaveBeenCalled();
    // Nudge fires after hold delay
    vi.advanceTimersByTime(300);
    expect(deps.sendMessage).toHaveBeenCalledOnce();
  });

  it("sendCompletion skips nudge when resultConsumed", () => {
    const deps = makeDeps();
    const system = createNotificationSystem(deps);
    const record = createTestRecord({ resultConsumed: true });
    system.sendCompletion(record);
    vi.advanceTimersByTime(300);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("cleanupCompleted removes activity and marks finished without nudge", () => {
    const deps = makeDeps();
    deps.agentActivity.set("agent-1", new AgentActivityTracker());
    const system = createNotificationSystem(deps);
    system.cleanupCompleted("agent-1");
    expect(deps.agentActivity.has("agent-1")).toBe(false);
    expect(deps.markFinished).toHaveBeenCalledWith("agent-1");
    expect(deps.updateWidget).toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("dispose clears all pending timers", () => {
    const deps = makeDeps();
    const system = createNotificationSystem(deps);
    system.sendCompletion(baseRecord);
    system.dispose();
    vi.advanceTimersByTime(300);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
