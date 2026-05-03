import type {
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@mariozechner/pi-coding-agent";

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
  event: InputEvent,
  ctx: ExtensionContext,
): Promise<InputEventResult> {
  deps.setRuntimeContext(ctx);
  deps.startForwardedPermissionPolling(ctx);

  const skillName = extractSkillNameFromInput(event.text);
  if (!skillName) {
    return { action: "continue" };
  }

  const agentName = deps.resolveAgentName(ctx);
  const check = deps
    .getPermissionManager()
    .checkPermission("skill", { name: skillName }, agentName ?? undefined);

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
  const skillInputGate = await applyPermissionGate({
    state: check.state,
    canConfirm: deps.canRequestPermissionConfirmation(ctx),
    promptForApproval: () =>
      deps.promptPermission(ctx, {
        requestId: deps.createPermissionRequestId("skill-input"),
        source: "skill_input",
        agentName,
        message: skillInputMessage,
        skillName,
      }),
    writeLog: deps.writeReviewLog,
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

  if (skillInputGate.action === "block") {
    return { action: "handled" };
  }

  return { action: "continue" };
}
