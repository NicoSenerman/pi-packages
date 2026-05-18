import { describe, expect, it, vi } from "vitest";
import { createNotificationRenderer } from "../src/renderer.js";
import type { NotificationDetails } from "../src/types.js";

/** Minimal theme stub — returns text wrapped with the style name for assertion. */
function stubTheme() {
  return {
    fg: (style: string, text: string) => `[${style}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };
}

function makeDetails(overrides: Partial<NotificationDetails> = {}): NotificationDetails {
  return {
    id: "agent-1",
    description: "Test agent",
    status: "completed",
    toolUses: 3,
    turnCount: 5,
    totalTokens: 1000,
    durationMs: 5000,
    resultPreview: "All done.",
    ...overrides,
  };
}

describe("createNotificationRenderer", () => {
  it("returns undefined when message has no details", () => {
    const renderer = createNotificationRenderer();
    const result = renderer({ details: undefined } as any, { expanded: false }, stubTheme() as any);
    expect(result).toBeUndefined();
  });

  it("renders completed status with success icon", () => {
    const renderer = createNotificationRenderer();
    const result = renderer(
      { details: makeDetails() } as any,
      { expanded: false },
      stubTheme() as any,
    );
    expect(result).toBeDefined();
    expect(result!.text).toContain("[success:✓]");
    expect(result!.text).toContain("**Test agent**");
    expect(result!.text).toContain("completed");
  });

  it("renders error status with error icon", () => {
    const renderer = createNotificationRenderer();
    const result = renderer(
      { details: makeDetails({ status: "error" }) } as any,
      { expanded: false },
      stubTheme() as any,
    );
    expect(result).toBeDefined();
    expect(result!.text).toContain("[error:✗]");
    expect(result!.text).toContain("error");
  });

  it("renders steered status as completed (steered)", () => {
    const renderer = createNotificationRenderer();
    const result = renderer(
      { details: makeDetails({ status: "steered" }) } as any,
      { expanded: false },
      stubTheme() as any,
    );
    expect(result!.text).toContain("completed (steered)");
  });

  it("shows full result lines when expanded", () => {
    const renderer = createNotificationRenderer();
    const result = renderer(
      { details: makeDetails({ resultPreview: "line1\nline2\nline3" }) } as any,
      { expanded: true },
      stubTheme() as any,
    );
    expect(result!.text).toContain("line1");
    expect(result!.text).toContain("line2");
    expect(result!.text).toContain("line3");
  });

  it("shows collapsed preview when not expanded", () => {
    const renderer = createNotificationRenderer();
    const result = renderer(
      { details: makeDetails({ resultPreview: "short result" }) } as any,
      { expanded: false },
      stubTheme() as any,
    );
    expect(result!.text).toContain("⎿");
    expect(result!.text).toContain("short result");
  });

  it("shows output file link when present", () => {
    const renderer = createNotificationRenderer();
    const result = renderer(
      { details: makeDetails({ outputFile: "/tmp/transcript.jsonl" }) } as any,
      { expanded: false },
      stubTheme() as any,
    );
    expect(result!.text).toContain("/tmp/transcript.jsonl");
  });

  it("includes stats line with tool uses and tokens", () => {
    const renderer = createNotificationRenderer();
    const result = renderer(
      { details: makeDetails({ toolUses: 7, totalTokens: 5000 }) } as any,
      { expanded: false },
      stubTheme() as any,
    );
    expect(result!.text).toContain("7 tool uses");
    expect(result!.text).toContain("5.0k token");
  });
});
