import { PATH_BEARING_TOOLS } from "../../path-utils";
import { suggestSessionPattern } from "../../pattern-suggest";
import {
  formatAskPrompt,
  formatDenyReason,
  formatUserDeniedReason,
} from "../../permission-prompts";
import { getPermissionLogContext } from "../../tool-input-preview";
import type { PermissionCheckResult } from "../../types";
import type { GateDescriptor } from "./descriptor";
import { deriveDecisionValue } from "./helpers";
import type { ToolCallContext } from "./types";

/**
 * Build a pure descriptor for the normal tool permission gate.
 *
 * Takes a pre-computed PermissionCheckResult (from checkPermission) and
 * returns a GateDescriptor that the runner can execute. No side effects.
 */
export function describeToolGate(
  tcc: ToolCallContext,
  check: PermissionCheckResult,
): GateDescriptor {
  const permissionLogContext = getPermissionLogContext(
    check,
    tcc.input,
    PATH_BEARING_TOOLS,
  );

  // Compute session approval suggestion for the "for this session" option.
  const suggestionValue =
    tcc.toolName === "bash"
      ? (check.command ?? "")
      : tcc.toolName === "mcp"
        ? (check.target ?? "mcp")
        : "*";
  const suggestion = suggestSessionPattern(tcc.toolName, suggestionValue);

  // Build the unavailable-reason message. Bash gets the command embedded.
  const inputCommand =
    tcc.toolName === "bash" &&
    typeof (tcc.input as Record<string, unknown>)?.command === "string"
      ? ((tcc.input as Record<string, unknown>).command as string)
      : null;
  const unavailableReason = inputCommand
    ? `Running bash command '${inputCommand}' requires approval, but no interactive UI is available.`
    : tcc.toolName === "mcp"
      ? "Using tool 'mcp' requires approval, but no interactive UI is available."
      : `Using tool '${tcc.toolName}' requires approval, but no interactive UI is available.`;

  const askMessage = formatAskPrompt(
    check,
    tcc.agentName ?? undefined,
    tcc.input,
  );

  return {
    surface: tcc.toolName,
    input: tcc.input,
    messages: {
      denyReason: formatDenyReason(check, tcc.agentName ?? undefined),
      unavailableReason,
      userDeniedReason: (decision) =>
        formatUserDeniedReason(check, decision.denialReason),
    },
    sessionApproval: {
      surface: suggestion.surface,
      pattern: suggestion.pattern,
    },
    promptDetails: {
      source: "tool_call",
      agentName: tcc.agentName,
      message: askMessage,
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      sessionLabel: suggestion.label,
      ...permissionLogContext,
    },
    logContext: {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      message: askMessage,
      ...permissionLogContext,
    },
    decision: {
      surface: tcc.toolName,
      value: deriveDecisionValue(tcc.toolName, check),
    },
  };
}
