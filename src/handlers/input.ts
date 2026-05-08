import type {
  ExtensionContext,
  InputEventResult,
} from "@mariozechner/pi-coding-agent";

/** Minimal subset of InputEvent used by this handler. */
interface InputPayload {
  text: string;
}

import { emitDecisionEvent } from "../permission-events";
import { applyPermissionGate } from "../permission-gate";
import { formatSkillAskPrompt } from "../permission-prompts";
import type { HandlerDeps } from "./types";

/**
 * Parse a `/skill:<name>` prefix from user input.
 * Returns the skill name, or null if the text is not a skill invocation.
 */
export function extractSkillNameFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/skill:")) {
    return null;
  }

  const afterPrefix = trimmed.slice("/skill:".length);
  if (!afterPrefix) {
    return null;
  }

  const firstWhitespace = afterPrefix.search(/\s/);
  const skillName = (
    firstWhitespace === -1 ? afterPrefix : afterPrefix.slice(0, firstWhitespace)
  ).trim();
  return skillName || null;
}

export async function handleInput(
  deps: HandlerDeps,
  event: InputPayload,
  ctx: ExtensionContext,
): Promise<InputEventResult> {
  deps.session.runtimeContext = ctx;
  deps.startForwardedPermissionPolling(ctx);

  const skillName = extractSkillNameFromInput(event.text);
  if (!skillName) {
    return { action: "continue" };
  }

  const agentName = deps.resolveAgentName(ctx);
  const check = deps.session.permissionManager.checkPermission(
    "skill",
    { name: skillName },
    agentName ?? undefined,
  );

  if (check.state === "deny" && ctx.hasUI) {
    const notifyMessage = agentName
      ? `Skill '${skillName}' is not permitted for agent '${agentName}'.`
      : `Skill '${skillName}' is not permitted by the current skill policy.`;
    ctx.ui.notify(notifyMessage, "warning");
  }

  const skillInputMessage = formatSkillAskPrompt(
    skillName,
    agentName ?? undefined,
  );
  const skillInputCanConfirm = deps.canRequestPermissionConfirmation(ctx);
  let skillInputAutoApproved = false;
  const skillInputGate = await applyPermissionGate({
    state: check.state,
    canConfirm: skillInputCanConfirm,
    promptForApproval: async () => {
      const decision = await deps.promptPermission(ctx, {
        requestId: deps.createPermissionRequestId("skill-input"),
        source: "skill_input",
        agentName,
        message: skillInputMessage,
        skillName,
      });
      skillInputAutoApproved = decision.autoApproved === true;
      return decision;
    },
    writeLog: deps.logger.review,
    logContext: {
      source: "skill_input",
      skillName,
      agentName,
      message: skillInputMessage,
    },
    messages: {
      denyReason: skillInputMessage,
      unavailableReason:
        "Skill requires approval, but no interactive UI is available.",
      userDeniedReason: () => "User denied skill.",
    },
  });

  emitDecisionEvent(deps.events, {
    surface: "skill",
    value: skillName,
    result: skillInputGate.action === "allow" ? "allow" : "deny",
    resolution:
      check.state === "allow"
        ? "policy_allow"
        : check.state === "deny"
          ? "policy_deny"
          : skillInputGate.action === "allow"
            ? skillInputAutoApproved
              ? "auto_approved"
              : "user_approved"
            : skillInputCanConfirm
              ? "user_denied"
              : "confirmation_unavailable",
    origin: check.origin ?? null,
    agentName: agentName ?? null,
    matchedPattern: check.matchedPattern ?? null,
  });

  if (skillInputGate.action === "block") {
    return { action: "handled" };
  }

  return { action: "continue" };
}
