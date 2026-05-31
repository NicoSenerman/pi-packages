import {
  formatDenyReason,
  formatUnavailableReason,
  formatUserDeniedReason,
} from "#src/denial-messages";
import type { PermissionPromptDecision } from "#src/permission-dialog";
import { applyPermissionGate } from "#src/permission-gate";
import type { PermissionCheckResult } from "#src/types";
import type { GateDescriptor, GateRunnerDeps } from "./descriptor";
import { buildDecisionEvent, deriveResolution } from "./helpers";
import type { GateOutcome } from "./types";

/**
 * Execute the full check→log→emit→approve cycle for a gate descriptor.
 *
 * This is the single site for:
 * - Permission checking (or using pre-resolved state)
 * - Session-hit fast path
 * - Interactive prompt orchestration
 * - Decision event emission
 * - Session-rule recording
 *
 * Gate functions produce descriptors; this runner executes them.
 */
export async function runGateCheck(
  descriptor: GateDescriptor,
  agentName: string | null,
  toolCallId: string,
  deps: GateRunnerDeps,
): Promise<GateOutcome> {
  // 1. Resolve permission state — pre-check, pre-resolved, or via checkPermission
  let check: PermissionCheckResult;
  if (descriptor.preCheck) {
    check = descriptor.preCheck;
  } else if (descriptor.preResolved) {
    check = {
      state: descriptor.preResolved.state,
      toolName: descriptor.surface,
      source: "tool",
      origin: "builtin",
    };
  } else {
    check = deps.checkPermission(
      descriptor.surface,
      descriptor.input,
      agentName ?? undefined,
      deps.getSessionRuleset(),
    );
  }

  // 2. Session-hit fast path
  if (check.source === "session") {
    deps.writeReviewLog("permission_request.session_approved", {
      ...descriptor.logContext,
      agentName,
      resolution: "session_approved",
      sessionApprovalPattern: check.matchedPattern,
    });
    deps.emitDecision(
      buildDecisionEvent(
        descriptor.decision,
        check,
        agentName,
        "allow",
        "session_approved",
      ),
    );
    return { action: "allow" };
  }

  // 3. Apply the deny/ask/allow gate
  const canConfirm = deps.canConfirm();

  // Construct messages from the centralized formatter.
  const messages = {
    denyReason: formatDenyReason(descriptor.denialContext),
    unavailableReason: formatUnavailableReason(descriptor.denialContext),
    userDeniedReason: (decision: PermissionPromptDecision) =>
      formatUserDeniedReason(descriptor.denialContext, decision.denialReason),
  };

  let autoApproved = false;
  const gateResult = await applyPermissionGate({
    state: check.state,
    canConfirm,
    sessionApproval: descriptor.sessionApproval?.toGateApproval(),
    promptForApproval: async () => {
      const decision = await deps.promptPermission({
        requestId: toolCallId,
        ...descriptor.promptDetails,
      });
      autoApproved = decision.autoApproved === true;
      return decision;
    },
    // eslint-disable-next-line @typescript-eslint/unbound-method -- logger methods are plain functions; no this-binding issue
    writeLog: deps.writeReviewLog,
    logContext: { ...descriptor.logContext, agentName },
    messages,
  });

  // 4. Determine whether session approval was granted
  const hasSessionApproval =
    gateResult.action === "allow" && gateResult.sessionApproval !== undefined;

  // 5. Emit decision event
  deps.emitDecision(
    buildDecisionEvent(
      descriptor.decision,
      check,
      agentName,
      gateResult.action === "allow" ? "allow" : "deny",
      deriveResolution(
        check.state,
        gateResult.action,
        hasSessionApproval,
        canConfirm,
        autoApproved,
      ),
    ),
  );

  // 6. Record session approval — tell the store; it owns the per-pattern loop
  // hasSessionApproval already implies gateResult.action === "allow"
  if (hasSessionApproval && descriptor.sessionApproval) {
    deps.recordSessionApproval(descriptor.sessionApproval);
  }

  if (gateResult.action === "block") {
    return { action: "block", reason: gateResult.reason };
  }

  return { action: "allow" };
}
