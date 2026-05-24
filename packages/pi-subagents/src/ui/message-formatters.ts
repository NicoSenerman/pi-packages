/**
 * message-formatters.ts — Pure formatting functions for each session message type.
 *
 * Each function converts a single message or content block into display lines.
 * Returns null for empty/skippable content (caller skips the separator).
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { extractAssistantContent } from "#src/session/content-items";
import { extractText } from "#src/session/context";
import type { Theme } from "#src/ui/display";
import { describeActivity } from "#src/ui/display";

// ── Types ────────────────────────────────────────────────────────────────────

/** Narrow context shared by all message formatters. */
export interface FormatterContext {
  theme: Theme;
  wrapText: (text: string, width: number) => string[];
}

// ── File-local types and guards ─────────────────────────────────────────────

export { getToolCallName } from "#src/session/content-items";

/** Bash execution message — 'bashExecution' role is not in the SDK's AgentSession message role union. */
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output?: string;
}

/** Type guard for bash execution messages. */
export function isBashExecution(msg: { role: string }): msg is BashExecutionMessage {
  return msg.role === "bashExecution";
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

// ── formatBashExecution ───────────────────────────────────────────────────────

/**
 * Format a bash execution message into display lines.
 * Always returns at least the command line.
 */
export function formatBashExecution(
  msg: BashExecutionMessage,
  width: number,
  ctx: FormatterContext,
): string[] {
  const { theme, wrapText } = ctx;
  const lines: string[] = [
    truncateToWidth(theme.fg("muted", `  $ ${msg.command}`), width),
  ];
  const output = msg.output ?? "";
  if (output.trim()) {
    const out = output.length > 500 ? output.slice(0, 500) + "... (truncated)" : output;
    lines.push(...wrapText(out.trim(), width).map(l => theme.fg("dim", l)));
  }
  return lines;
}

// ── formatStreamingIndicator ──────────────────────────────────────────────

/**
 * Format the streaming activity indicator for a running agent.
 * Returns exactly two lines: an empty spacer and the indicator line.
 */
export function formatStreamingIndicator(
  activeTools: ReadonlyMap<string, string>,
  responseText: string | undefined,
  width: number,
  theme: Theme,
): string[] {
  const act = describeActivity(activeTools, responseText);
  return [
    "",
    truncateToWidth(theme.fg("accent", "\u25cd ") + theme.fg("dim", act), width),
  ];
}

// ── formatToolResult ────────────────────────────────────────────────────────────

/**
 * Format a tool result message into display lines.
 * Returns null when the result text is empty (caller should skip separator).
 */
export function formatToolResult(
  content: unknown[],
  width: number,
  ctx: FormatterContext,
): string[] | null {
  const { theme, wrapText } = ctx;
  const text = extractText(content);
  const truncated = text.length > 500 ? text.slice(0, 500) + "... (truncated)" : text;
  if (!truncated.trim()) return null;
  return [
    theme.fg("dim", "[Result]"),
    ...wrapText(truncated.trim(), width).map(l => theme.fg("dim", l)),
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
  const { textParts, toolNames } = extractAssistantContent(content);
  const lines: string[] = [theme.bold("[Assistant]")];
  if (textParts.length > 0) {
    lines.push(...wrapText(textParts.join("\n").trim(), width));
  }
  for (const name of toolNames) {
    lines.push(truncateToWidth(theme.fg("muted", `  [Tool: ${name}]`), width));
  }
  return lines;
}

// ── formatMessage dispatcher ───────────────────────────────────────────────

/**
 * Dispatch a session message to the appropriate formatter.
 * Returns null for empty/skippable messages and unknown roles.
 */
export function formatMessage(
  msg: { role: string; [key: string]: unknown },
  width: number,
  ctx: FormatterContext,
): string[] | null {
  if (msg.role === "user") {
    return formatUserMessage(msg.content as string | unknown[], width, ctx);
  }
  if (msg.role === "assistant") {
    return formatAssistantMessage(
      msg.content as { type: string; [key: string]: unknown }[],
      width,
      ctx,
    );
  }
  if (msg.role === "toolResult") {
    return formatToolResult(msg.content as unknown[], width, ctx);
  }
  if (isBashExecution(msg)) {
    return formatBashExecution(msg, width, ctx);
  }
  return null;
}
