import {
  formatExternalDirectoryAskPrompt,
  formatExternalDirectoryDenyReason,
  formatExternalDirectoryUserDeniedReason,
  getPathBearingToolPath,
  isPathOutsideWorkingDirectory,
  isPiInfrastructureRead,
  normalizePathForComparison,
} from "../../external-directory";
import type { PermissionPromptDecision } from "../../permission-dialog";
import { applyPermissionGate } from "../../permission-gate";
import { deriveApprovalPattern } from "../../session-rules";
import { deriveResolution } from "./helpers";
import type {
  ExternalDirectoryGateDeps,
  GateOutcome,
  ToolCallContext,
} from "./types";

/**
 * Evaluate the external-directory permission gate for file tools.
 *
 * Returns `null` when the gate does not apply (no CWD, tool is not
 * path-bearing, or path is inside the working directory).
 */
export async function evaluateExternalDirectoryGate(
  tcc: ToolCallContext,
  deps: ExternalDirectoryGateDeps,
): Promise<GateOutcome | null> {
  if (!tcc.cwd) return null;

  const externalDirectoryPath = getPathBearingToolPath(tcc.toolName, tcc.input);
  if (!externalDirectoryPath) return null;

  if (!isPathOutsideWorkingDirectory(externalDirectoryPath, tcc.cwd)) {
    return null;
  }

  const normalizedExtPath = normalizePathForComparison(
    externalDirectoryPath,
    tcc.cwd,
  );

  // ── Pi infrastructure read bypass ──────────────────────────────────────
  const allInfraDirs = deps.getInfrastructureDirs();
  if (
    isPiInfrastructureRead(
      tcc.toolName,
      normalizedExtPath,
      allInfraDirs,
      tcc.cwd,
    )
  ) {
    deps.writeReviewLog("permission_request.infrastructure_auto_allowed", {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      agentName: tcc.agentName,
      path: externalDirectoryPath,
    });
    deps.emitDecision({
      surface: tcc.toolName,
      value: externalDirectoryPath,
      result: "allow",
      resolution: "infrastructure_auto_allowed",
      origin: null,
      agentName: tcc.agentName ?? null,
      matchedPattern: null,
    });
    return { action: "allow" };
  }

  // ── Policy check ───────────────────────────────────────────────────────
  const extCheck = deps.checkPermission(
    "external_directory",
    { path: normalizedExtPath },
    tcc.agentName ?? undefined,
    deps.getSessionRuleset(),
  );

  // Session-rule hit
  if (extCheck.source === "session") {
    deps.writeReviewLog("permission_request.session_approved", {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      agentName: tcc.agentName,
      path: externalDirectoryPath,
      resolution: "session_approved",
      sessionApprovalPattern: extCheck.matchedPattern,
    });
    deps.emitDecision({
      surface: "external_directory",
      value: externalDirectoryPath,
      result: "allow",
      resolution: "session_approved",
      origin: extCheck.origin ?? null,
      agentName: tcc.agentName ?? null,
      matchedPattern: extCheck.matchedPattern ?? null,
    });
    return { action: "allow" };
  }

  // ── Interactive gate ───────────────────────────────────────────────────
  let extDirDecision: PermissionPromptDecision | null = null;
  const extDirMessage = formatExternalDirectoryAskPrompt(
    tcc.toolName,
    externalDirectoryPath,
    tcc.cwd,
    tcc.agentName ?? undefined,
  );
  const extDirCanConfirm = deps.canConfirm();
  const extDirGateResult = await applyPermissionGate({
    state: extCheck.state,
    canConfirm: extDirCanConfirm,
    promptForApproval: async () => {
      const decision = await deps.promptPermission({
        requestId: tcc.toolCallId,
        source: "tool_call",
        agentName: tcc.agentName,
        message: extDirMessage,
        toolCallId: tcc.toolCallId,
        toolName: tcc.toolName,
        path: externalDirectoryPath,
      });
      extDirDecision = decision;
      return decision;
    },
    writeLog: deps.writeReviewLog,
    logContext: {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      agentName: tcc.agentName,
      path: externalDirectoryPath,
      message: extDirMessage,
    },
    messages: {
      denyReason: formatExternalDirectoryDenyReason(
        tcc.toolName,
        externalDirectoryPath,
        tcc.cwd,
        tcc.agentName ?? undefined,
      ),
      unavailableReason: `Accessing '${externalDirectoryPath}' outside the working directory requires approval, but no interactive UI is available.`,
      userDeniedReason: (decision) =>
        formatExternalDirectoryUserDeniedReason(
          tcc.toolName,
          externalDirectoryPath,
          decision.denialReason,
        ),
    },
  });

  deps.emitDecision({
    surface: "external_directory",
    value: externalDirectoryPath,
    result: extDirGateResult.action === "allow" ? "allow" : "deny",
    resolution: deriveResolution(
      extCheck.state,
      extDirGateResult.action,
      extDirDecision?.state === "approved_for_session",
      extDirCanConfirm,
    ),
    origin: extCheck.origin ?? null,
    agentName: tcc.agentName ?? null,
    matchedPattern: extCheck.matchedPattern ?? null,
  });

  if (extDirGateResult.action === "block") {
    return { action: "block", reason: extDirGateResult.reason };
  }

  if (extDirDecision?.state === "approved_for_session") {
    const pattern = deriveApprovalPattern(normalizedExtPath);
    deps.approveSessionRule("external_directory", pattern);
  }

  return { action: "allow" };
}
