/**
 * content-items.ts — Shared parsing utilities for Pi SDK message content items.
 *
 * Provides type-safe extraction of text parts and tool-call names from
 * assistant message content arrays. Pure functions — no IO.
 */

import type { ThinkingContent, TextContent, ToolCall } from "@earendil-works/pi-ai";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Extracted text parts, tool calls, and thinking texts from assistant message content. */
export interface AssistantContentParts {
  textParts: string[];
  toolCalls: ToolCall[];
  thinkingTexts: string[];
}

// ── Functions ─────────────────────────────────────────────────────────────────

/**
 * Extracts the display name from a tool-call content item.
 *
 * Returns 'unknown' for non-toolCall items.
 * The Pi SDK's ToolCall.name is always present — no fallback chain needed.
 */
export function getToolCallName(c: { type: string }): string {
  if (c.type !== "toolCall") return "unknown";
  return (c as ToolCall).name;
}

/**
 * Extract text parts, tool calls, and thinking texts from assistant message content items.
 *
 * Accepts any array whose elements carry a `type` discriminant — all Pi SDK
 * content types (TextContent, ThinkingContent, ToolCall) satisfy this constraint.
 * Pure data extraction — consumers apply their own presentation formatting.
 * Skips items of unknown types (e.g. images) and empty text.
 */
export function extractAssistantContent(
  content: ReadonlyArray<{ type: string }>,
): AssistantContentParts {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const thinkingTexts: string[] = [];
  for (const c of content) {
    if (c.type === "text") {
      const text = (c as TextContent).text;
      if (text) textParts.push(text);
    } else if (c.type === "toolCall") {
      toolCalls.push(c as ToolCall);
    } else if (c.type === "thinking") {
      const thinking = (c as ThinkingContent).thinking;
      if (thinking) thinkingTexts.push(thinking);
    }
  }
  return { textParts, toolCalls, thinkingTexts };
}
