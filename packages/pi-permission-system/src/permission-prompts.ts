import { getNonEmptyString, toRecord } from "./common";
import { matchQualifier } from "./denial-messages";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer";
import type { ToolPreviewFormatter } from "./tool-preview-formatter";
import type { PermissionCheckResult } from "./types";

// NOTE: formatDenyReason, formatUserDeniedReason, and
// formatPermissionHardStopHint have been moved to denial-messages.ts.
// This module retains only pre-check messages and user-facing ask prompts.

export function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

export function formatUnknownToolReason(
  toolName: string,
  availableToolNames: readonly string[],
): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList =
    preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint =
    toolName === "mcp"
      ? ""
      : ' If this was intended as an MCP server tool, call the registered \'mcp\' tool when available (for example: {"tool":"server:tool"}).';

  return `Tool '${toolName}' is not registered in this runtime and was blocked before permission checks.${mcpHint} Registered tools: ${availableList}.`;
}

export function formatAskPrompt(
  result: PermissionCheckResult,
  agentName?: string,
  input?: unknown,
  formatter?: ToolPreviewFormatter,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";

  // Long commands (heredocs, embedded python, curl|python scripts) blow the
  // Confirm dialog out vertically. Cap the body at 3 lines in the modal; the
  // full command still lives in the audit log and in the tool-call card that
  // follows.
  const truncateCommand = (command: string | null): string => {
    if (!command) return "";
    // A trailing newline is a terminator, not an extra line — exclude it when
    // counting so `cat <<EOF\nhello\nEOF` shows 3 lines, not 4.
    const trailing = command.endsWith("\n") ? 1 : 0;
    const lines = command.split("\n");
    const contentLines = lines.length - trailing;
    if (contentLines <= 3) return command;
    return `${lines.slice(0, 3).join("\n")}\n  … (${contentLines - 3} more lines)`;
  };

  if (result.toolName === "bash") {
    const subCommand = truncateCommand(result.command ?? "");
    const qualifier = matchQualifier(
      result.matchedPattern,
      result.commandContext,
    );
    const qualifierInfo = qualifier ? ` ${qualifier}` : "";
    const fullCommandRaw = getNonEmptyString(toRecord(input).command);
    const fullCommand = truncateCommand(fullCommandRaw);
    // Place the actual command on its own indented line. The TUI renders
    // select bodies as plain text, so a blank line before the command and a
    // 2-space indent make the eye anchor on it instead of losing it inside
    // the wrapping sentence.
    if (fullCommand && fullCommand !== subCommand) {
      return `${subject} requested bash command${qualifierInfo}. Allow this command?\n\n${fullCommand
        .split("\n")
        .map((l) => (l.trim() ? `  ${l}` : l))
        .join("\n")}`;
    }
    return `${subject} requested bash command${qualifierInfo}. Allow this command?\n\n${subCommand
      .split("\n")
      .map((l) => (l.trim() ? `  ${l}` : l))
      .join("\n")}`;
  }

  if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
    const patternInfo = result.matchedPattern
      ? ` (matched '${result.matchedPattern}')`
      : "";
    const mcpPreview = formatter
      ? formatter.formatToolInputForPrompt("mcp", input)
      : "";
    const previewSuffix = mcpPreview ? ` ${mcpPreview}` : "";
    return `${subject} requested MCP target '${result.target}'${patternInfo}${previewSuffix}. Allow this call?`;
  }

  const patternInfo = result.matchedPattern
    ? ` (matched '${result.matchedPattern}')`
    : "";
  const inputPreview = formatter
    ? formatter.formatToolInputForPrompt(result.toolName, input)
    : "";
  const inputSuffix = inputPreview ? ` ${inputPreview}` : "";
  return `${subject} requested tool '${result.toolName}'${patternInfo}${inputSuffix}. Allow this call?`;
}

export function formatSkillAskPrompt(
  skillName: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested skill '${skillName}'. Allow loading this skill?`;
}

export function formatSkillPathAskPrompt(
  skill: SkillPromptEntry,
  readPath: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested access to skill '${skill.name}' via '${readPath}'. Allow this read?`;
}

// formatSkillPathDenyReason has been moved to denial-messages.ts.
