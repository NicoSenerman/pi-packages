import type { TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { extractAssistantContent, getToolCallName } from "#src/session/content-items";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid TextContent fixture. */
const text = (t: string): TextContent => ({ type: "text", text: t });

/** Minimal valid ToolCall fixture. */
const toolCall = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  type: "toolCall",
  id: "call_1",
  name,
  arguments: args,
});

/** Minimal valid ThinkingContent fixture. */
const thinking = (text: string): ThinkingContent => ({ type: "thinking", thinking: text });

// ── getToolCallName ───────────────────────────────────────────────────────────

describe("getToolCallName", () => {
  it("returns the tool name", () => {
    expect(getToolCallName(toolCall("Bash"))).toBe("Bash");
  });

  it("returns 'unknown' for non-toolCall type", () => {
    expect(getToolCallName({ type: "text" })).toBe("unknown");
  });
});

// ── extractAssistantContent ───────────────────────────────────────────────────

describe("extractAssistantContent", () => {
  it("returns empty arrays for empty content", () => {
    expect(extractAssistantContent([])).toEqual({ textParts: [], toolCalls: [], thinkingTexts: [] });
  });

  it("collects text items", () => {
    expect(extractAssistantContent([text("Hello"), text("World")])).toEqual({
      textParts: ["Hello", "World"],
      toolCalls: [],
      thinkingTexts: [],
    });
  });

  it("collects toolCall items as full ToolCall objects", () => {
    const tc1 = toolCall("Bash");
    const tc2 = toolCall("Read");
    expect(extractAssistantContent([tc1, tc2])).toEqual({
      textParts: [],
      toolCalls: [tc1, tc2],
      thinkingTexts: [],
    });
  });

  it("collects mixed text, thinking, and toolCall items", () => {
    const tc1 = toolCall("Bash");
    const tc2 = toolCall("Write");
    const content = [text("Some analysis"), tc1, text("More text"), tc2];
    expect(extractAssistantContent(content)).toEqual({
      textParts: ["Some analysis", "More text"],
      toolCalls: [tc1, tc2],
      thinkingTexts: [],
    });
  });

  it("collects thinking content", () => {
    const think = thinking("Let me reason about this...");
    const tc = toolCall("Read");
    expect(extractAssistantContent([text("Before"), think, tc])).toEqual({
      textParts: ["Before"],
      toolCalls: [tc],
      thinkingTexts: ["Let me reason about this..."],
    });
  });

  it("skips text items with empty text", () => {
    expect(extractAssistantContent([text(""), text("Real content")])).toEqual({
      textParts: ["Real content"],
      toolCalls: [],
      thinkingTexts: [],
    });
  });

  it("skips thinking with empty text", () => {
    expect(extractAssistantContent([thinking("")])).toEqual({
      textParts: [],
      toolCalls: [],
      thinkingTexts: [],
    });
  });

  it("preserves tool call arguments", () => {
    const tc = toolCall("read", { path: "src/index.ts", offset: 10, limit: 20 });
    expect(extractAssistantContent([tc])).toEqual({
      textParts: [],
      toolCalls: [tc],
      thinkingTexts: [],
    });
  });
});
