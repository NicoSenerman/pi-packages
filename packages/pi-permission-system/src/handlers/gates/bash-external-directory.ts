import { getNonEmptyString, toRecord } from "#src/common";
import { getExternalDirectoryPolicyValues } from "#src/path-utils";
import type { ScopedPermissionResolver } from "#src/permission-resolver";
import { SessionApproval } from "#src/session-approval";
import { deriveApprovalPattern } from "#src/session-rules";
import type { PermissionCheckResult } from "#src/types";
import type { BashProgram } from "./bash-program";
import { pickMostRestrictive } from "./candidate-check";
import type { GateResult } from "./descriptor";
import { formatBashExternalDirectoryAskPrompt } from "./external-directory-messages";
import type { ToolCallContext } from "./types";

/**
 * Build a pure descriptor for the bash external-directory permission gate.
 *
 * Reads the external paths from the injected `BashProgram` and checks whether
 * any reference directories outside the working directory. Returns `null` when the gate
 * does not apply (tool is not bash, no CWD, or no external paths found).
 * Returns a `GateBypass` when all paths are allowed (by config or session rule).
 * Returns a `GateDescriptor` with multi-pattern sessionApproval for uncovered paths.
 */
export function describeBashExternalDirectoryGate(
  tcc: ToolCallContext,
  bashProgram: BashProgram | null,
  resolver: ScopedPermissionResolver,
): GateResult {
  if (tcc.toolName !== "bash" || !tcc.cwd) return null;

  const command = getNonEmptyString(toRecord(tcc.input).command);
  if (!command) return null;

  if (!bashProgram) return null;

  const externalPaths = bashProgram.externalPaths(tcc.cwd);
  if (externalPaths.length === 0) return null;

  // Collect paths whose resolved state is not already "allow".
  // Checking state (not source) ensures config-level allow rules (source: "special")
  // suppress the prompt just as session-level allow rules (source: "session") do.
  const uncoveredEntries: Array<{
    path: string;
    check: PermissionCheckResult;
  }> = [];
  for (const p of externalPaths) {
    // Match each path against both its typed and symlink-resolved aliases on
    // the external_directory surface, so a config pattern on either form
    // applies (#418).
    const check = resolver.resolvePathPolicy(
      getExternalDirectoryPolicyValues(p, tcc.cwd),
      tcc.agentName ?? undefined,
      "external_directory",
    );
    if (check.state !== "allow") {
      uncoveredEntries.push({ path: p, check });
    }
  }
  const uncoveredPaths = uncoveredEntries.map(({ path }) => path);

  if (uncoveredPaths.length === 0) {
    return {
      action: "allow",
      log: {
        event: "permission_request.session_approved",
        details: {
          source: "tool_call",
          toolCallId: tcc.toolCallId,
          toolName: tcc.toolName,
          agentName: tcc.agentName,
          command,
          externalPaths,
          resolution: "session_approved",
        },
      },
    };
  }

  // Use the most restrictive check among uncovered paths as the pre-check result.
  // This ensures a config-level "deny" rule is not downgraded to "ask" by the
  // generic "*" catch-all that the old path-less checkPermission call returned.
  const worstCheck =
    pickMostRestrictive(uncoveredEntries.map(({ check }) => check)) ??
    uncoveredEntries[0].check;

  const bashExtMessage = formatBashExternalDirectoryAskPrompt(
    command,
    uncoveredPaths,
    tcc.cwd,
    tcc.agentName ?? undefined,
  );

  const patterns = uncoveredPaths.map((p) => deriveApprovalPattern(p));

  return {
    surface: "external_directory",
    input: {},
    denialContext: {
      kind: "bash_external_directory",
      command,
      externalPaths: uncoveredPaths,
      cwd: tcc.cwd,
      agentName: tcc.agentName ?? undefined,
    },
    sessionApproval: SessionApproval.multiple("external_directory", patterns),
    promptDetails: {
      source: "tool_call",
      agentName: tcc.agentName,
      message: bashExtMessage,
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      command,
    },
    logContext: {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      agentName: tcc.agentName,
      command,
      externalPaths: uncoveredPaths,
      message: bashExtMessage,
    },
    decision: {
      surface: "external_directory",
      value: command,
    },
    preCheck: worstCheck,
  };
}
