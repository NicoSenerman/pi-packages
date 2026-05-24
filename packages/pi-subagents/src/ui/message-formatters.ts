/**
 * message-formatters.ts — Pure formatting functions for each session message type.
 *
 * Each function converts a single message or content block into display lines.
 * Returns null for empty/skippable content (caller skips the separator).
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { extractText } from "#src/session/context";
import type { Theme } from "#src/ui/display";

// ── Types ────────────────────────────────────────────────────────────────────

/** Narrow context shared by all message formatters. */
export interface FormatterContext {
  theme: Theme;
  wrapText: (text: string, width: number) => string[];
}

// ── File-local types and guards ─────────────────────────────────────────────

/** Tool-call content item — SDK exposes this variant at runtime but doesn't export the narrow type. */
interface ToolCallContent {
  type: "toolCall";
  name?: string;
  toolName?: string;
}

/** Extracts the tool name from a toolCall content item, falling back to 'unknown'. */
function getToolCallName(c: { type: string }): string {
  if (c.type !== "toolCall") return "unknown";
  const tc = c as ToolCallContent;
  return tc.name ?? tc.toolName ?? "unknown";
}

// ── formatUserMessage ─────────────────────────────────────────────────────────

/**
 * Format a user message into display lines.
 * Returns null when the message text is empty (caller should skip separator).
 */
export function formatUserMessage(
  content: string | unknown[],
  width: number,
  ctx: FormatterContext,
): string[] | null {
  const { theme, wrapText } = ctx;
  const text = typeof content === "string" ? content : extractText(content);
  if (!text.trim()) return null;
  return [
    theme.fg("accent", "[User]"),
    ...wrapText(text.trim(), width),
  ];
}

// ── formatAssistantMessage ───────────────────────────────────────────────────

/**
 * Format an assistant message into display lines.
 * Always returns at least the [Assistant] header line.
 */
export function formatAssistantMessage(
  content: { type: string; [key: string]: unknown }[],
  width: number,
  ctx: FormatterContext,
): string[] {
  const { theme, wrapText } = ctx;
  const textParts: string[] = [];
  const toolCalls: string[] = [];
  for (const c of content) {
    if (c.type === "text" && c.text) textParts.push(c.text as string);
    else if (c.type === "toolCall") toolCalls.push(getToolCallName(c));
  }
  const lines: string[] = [theme.bold("[Assistant]")];
  if (textParts.length > 0) {
    lines.push(...wrapText(textParts.join("\n").trim(), width));
  }
  for (const name of toolCalls) {
    lines.push(truncateToWidth(theme.fg("muted", `  [Tool: ${name}]`), width));
  }
  return lines;
}
