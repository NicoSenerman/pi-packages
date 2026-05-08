import type {
  BeforeAgentStartEventResult,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

/** Minimal subset of BeforeAgentStartEvent used by this handler. */
interface BeforeAgentStartPayload {
  systemPrompt: string;
}

import {
  createActiveToolsCacheKey,
  createBeforeAgentStartPromptStateKey,
} from "../before-agent-start-cache";
import { resolveSkillPromptEntries } from "../skill-prompt-sanitizer";
import { sanitizeAvailableToolsSection } from "../system-prompt-sanitizer";
import { getToolNameFromValue } from "../tool-registry";
import type { PermissionState } from "../types";
import type { HandlerDeps } from "./types";

/**
 * Pure helper: returns true when the tool should be exposed to the agent.
 * Checks the tool-level permission (not command-level) so that a blanket
 * `bash: deny` hides the tool entirely before any invocation is attempted.
 */
export function shouldExposeTool(
  toolName: string,
  agentName: string | null,
  getToolPermission: (toolName: string, agentName?: string) => PermissionState,
): boolean {
  const toolPermission = getToolPermission(toolName, agentName ?? undefined);
  return toolPermission !== "deny";
}

export async function handleBeforeAgentStart(
  deps: HandlerDeps,
  event: BeforeAgentStartPayload,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult> {
  const { session } = deps;
  session.activate(ctx);
  session.refreshConfig(ctx);

  const agentName = session.resolveAgentName(ctx, event.systemPrompt);
  const allTools = deps.getAllTools();
  const allowedTools: string[] = [];

  for (const tool of allTools) {
    const toolName = getToolNameFromValue(tool);
    if (!toolName) {
      continue;
    }
    if (
      shouldExposeTool(toolName, agentName, (t, a) =>
        session.getToolPermission(t, a),
      )
    ) {
      allowedTools.push(toolName);
    }
  }

  const activeToolsCacheKey = createActiveToolsCacheKey(allowedTools);
  if (session.shouldUpdateActiveTools(activeToolsCacheKey)) {
    deps.setActiveTools(allowedTools);
    session.commitActiveToolsCacheKey(activeToolsCacheKey);
  }

  const promptStateCacheKey = createBeforeAgentStartPromptStateKey({
    agentName,
    cwd: ctx.cwd,
    permissionStamp: session.getPolicyCacheStamp(agentName ?? undefined),
    systemPrompt: event.systemPrompt,
    allowedToolNames: allowedTools,
  });

  if (!session.shouldUpdatePromptState(promptStateCacheKey)) {
    return {};
  }

  session.commitPromptStateCacheKey(promptStateCacheKey);

  const toolPromptResult = sanitizeAvailableToolsSection(
    event.systemPrompt,
    allowedTools,
  );
  const skillPromptResult = resolveSkillPromptEntries(
    toolPromptResult.prompt,
    session,
    agentName,
    ctx.cwd,
  );
  session.setActiveSkillEntries(skillPromptResult.entries);

  if (skillPromptResult.prompt !== event.systemPrompt) {
    return { systemPrompt: skillPromptResult.prompt };
  }

  return {};
}
