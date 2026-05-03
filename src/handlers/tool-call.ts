import type {
  ExtensionContext,
  ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

import { getNonEmptyString, toRecord } from "../common";
import {
  extractExternalPathsFromBashCommand,
  formatBashExternalDirectoryAskPrompt,
  formatBashExternalDirectoryDenyReason,
  formatExternalDirectoryAskPrompt,
  formatExternalDirectoryDenyReason,
  formatExternalDirectoryHardStopHint,
  formatExternalDirectoryUserDeniedReason,
  getPathBearingToolPath,
  isPathOutsideWorkingDirectory,
  normalizePathForComparison,
  PATH_BEARING_TOOLS,
} from "../external-directory";
import type { PermissionPromptDecision } from "../permission-dialog";
import { applyPermissionGate } from "../permission-gate";
import {
  formatAskPrompt,
  formatDenyReason,
  formatMissingToolNameReason,
  formatSkillPathAskPrompt,
  formatSkillPathDenyReason,
  formatUnknownToolReason,
  formatUserDeniedReason,
} from "../permission-prompts";
import { deriveApprovalPrefix } from "../session-approval-cache";
import { findSkillPathMatch } from "../skill-prompt-sanitizer";
import { getPermissionLogContext } from "../tool-input-preview";
import {
  checkRequestedToolRegistration,
  getToolNameFromValue,
} from "../tool-registry";
import type { HandlerDeps } from "./types";

/**
 * Extract the tool input from an event, checking both `input` and `arguments`
 * fields (different Pi SDK versions use different names).
 */
export function getEventInput(event: unknown): unknown {
  const record = toRecord(event);

  if (record.input !== undefined) {
    return record.input;
  }

  if (record.arguments !== undefined) {
    return record.arguments;
  }

  return {};
}

export async function handleToolCall(
  deps: HandlerDeps,
  event: unknown,
  ctx: ExtensionContext,
): Promise<{ block?: true; reason?: string }> {
  deps.setRuntimeContext(ctx);
  deps.startForwardedPermissionPolling(ctx);

  const agentName = deps.resolveAgentName(ctx);
  const toolName = getToolNameFromValue(event);

  if (!toolName) {
    return { block: true, reason: formatMissingToolNameReason() };
  }

  const registrationCheck = checkRequestedToolRegistration(
    toolName,
    deps.getAllTools(),
  );
  if (registrationCheck.status === "missing-tool-name") {
    return { block: true, reason: formatMissingToolNameReason() };
  }

  if (registrationCheck.status === "unregistered") {
    return {
      block: true,
      reason: formatUnknownToolReason(
        registrationCheck.requestedToolName,
        registrationCheck.availableToolNames,
      ),
    };
  }

  // ── Skill-read gate ──────────────────────────────────────────────────────
  if (
    isToolCallEventType("read", event as ToolCallEvent) &&
    deps.getActiveSkillEntries().length > 0
  ) {
    const normalizedReadPath = normalizePathForComparison(
      (event as ToolCallEvent & { input: { path: string } }).input.path,
      ctx.cwd,
    );
    const matchedSkill = findSkillPathMatch(
      normalizedReadPath,
      deps.getActiveSkillEntries(),
    );

    if (matchedSkill) {
      const readEvent = event as ToolCallEvent & { input: { path: string } };
      const skillReadMessage = formatSkillPathAskPrompt(
        matchedSkill,
        readEvent.input.path,
        agentName ?? undefined,
      );
      const skillReadGate = await applyPermissionGate({
        state: matchedSkill.state,
        canConfirm: deps.canRequestPermissionConfirmation(ctx),
        promptForApproval: () =>
          deps.promptPermission(ctx, {
            requestId: (readEvent as { toolCallId: string }).toolCallId,
            source: "skill_read",
            agentName,
            message: skillReadMessage,
            toolCallId: (readEvent as { toolCallId: string }).toolCallId,
            toolName,
            skillName: matchedSkill.name,
            path: readEvent.input.path,
          }),
        writeLog: deps.writeReviewLog,
        logContext: {
          source: "skill_read",
          skillName: matchedSkill.name,
          agentName,
          path: readEvent.input.path,
          message: skillReadMessage,
        },
        messages: {
          denyReason: formatSkillPathDenyReason(
            matchedSkill,
            readEvent.input.path,
            agentName ?? undefined,
          ),
          unavailableReason: `Accessing skill '${matchedSkill.name}' requires approval, but no interactive UI is available.`,
          userDeniedReason: (decision) => {
            const denialReason = decision.denialReason
              ? ` Reason: ${decision.denialReason}.`
              : "";
            return `User denied access to skill '${matchedSkill.name}'.${denialReason}`;
          },
        },
      });
      if (skillReadGate.action === "block") {
        return { block: true, reason: skillReadGate.reason };
      }
    }
  }

  const input = getEventInput(event);

  // ── External-directory gate (file tools) ─────────────────────────────────
  const externalDirectoryPath = ctx.cwd
    ? getPathBearingToolPath(toolName, input)
    : null;

  if (
    ctx.cwd &&
    externalDirectoryPath &&
    isPathOutsideWorkingDirectory(externalDirectoryPath, ctx.cwd)
  ) {
    const normalizedExtPath = normalizePathForComparison(
      externalDirectoryPath,
      ctx.cwd,
    );
    const sessionPrefix = deps.sessionApprovalCache.findMatchingPrefix(
      "external_directory",
      normalizedExtPath,
    );

    if (sessionPrefix) {
      deps.writeReviewLog("permission_request.session_approved", {
        source: "tool_call",
        toolCallId: (event as { toolCallId: string }).toolCallId,
        toolName,
        agentName,
        path: externalDirectoryPath,
        resolution: "session_approved",
        sessionApprovalPrefix: sessionPrefix,
      });
      // Fall through to normal permission check
    } else {
      const extCheck = deps
        .getPermissionManager()
        .checkPermission("external_directory", {}, agentName ?? undefined);

      let extDirDecision: PermissionPromptDecision | null = null;
      const extDirMessage = formatExternalDirectoryAskPrompt(
        toolName,
        externalDirectoryPath,
        ctx.cwd,
        agentName ?? undefined,
      );
      const extDirGate = await applyPermissionGate({
        state: extCheck.state,
        canConfirm: deps.canRequestPermissionConfirmation(ctx),
        promptForApproval: async () => {
          const decision = await deps.promptPermission(ctx, {
            requestId: (event as { toolCallId: string }).toolCallId,
            source: "tool_call",
            agentName,
            message: extDirMessage,
            toolCallId: (event as { toolCallId: string }).toolCallId,
            toolName,
            path: externalDirectoryPath,
          });
          extDirDecision = decision;
          return decision;
        },
        writeLog: deps.writeReviewLog,
        logContext: {
          source: "tool_call",
          toolCallId: (event as { toolCallId: string }).toolCallId,
          toolName,
          agentName,
          path: externalDirectoryPath,
          message: extDirMessage,
        },
        messages: {
          denyReason: formatExternalDirectoryDenyReason(
            toolName,
            externalDirectoryPath,
            ctx.cwd,
            agentName ?? undefined,
          ),
          unavailableReason: `Accessing '${externalDirectoryPath}' outside the working directory requires approval, but no interactive UI is available.`,
          userDeniedReason: (decision) =>
            formatExternalDirectoryUserDeniedReason(
              toolName,
              externalDirectoryPath,
              decision.denialReason,
            ),
        },
      });
      if (extDirGate.action === "block") {
        return { block: true, reason: extDirGate.reason };
      }

      if (extDirDecision?.state === "approved_for_session") {
        const prefix = deriveApprovalPrefix(normalizedExtPath);
        deps.sessionApprovalCache.approve("external_directory", prefix);
      }
    }
    // Fall through to normal permission check
  }

  // ── Bash external-directory gate ─────────────────────────────────────────
  if (ctx.cwd && toolName === "bash") {
    const command = getNonEmptyString(toRecord(input).command);
    if (command) {
      const externalPaths = extractExternalPathsFromBashCommand(
        command,
        ctx.cwd,
      );
      if (externalPaths.length > 0) {
        const uncoveredPaths = externalPaths.filter(
          (p) => !deps.sessionApprovalCache.has("external_directory", p),
        );

        if (uncoveredPaths.length === 0) {
          deps.writeReviewLog("permission_request.session_approved", {
            source: "tool_call",
            toolCallId: (event as { toolCallId: string }).toolCallId,
            toolName,
            agentName,
            command,
            externalPaths,
            resolution: "session_approved",
          });
          // Fall through to normal bash permission check
        } else {
          const extCheck = deps
            .getPermissionManager()
            .checkPermission("external_directory", {}, agentName ?? undefined);

          let bashExtDecision: PermissionPromptDecision | null = null;
          const bashExtMessage = formatBashExternalDirectoryAskPrompt(
            command,
            uncoveredPaths,
            ctx.cwd,
            agentName ?? undefined,
          );
          const bashExtGate = await applyPermissionGate({
            state: extCheck.state,
            canConfirm: deps.canRequestPermissionConfirmation(ctx),
            promptForApproval: async () => {
              const decision = await deps.promptPermission(ctx, {
                requestId: (event as { toolCallId: string }).toolCallId,
                source: "tool_call",
                agentName,
                message: bashExtMessage,
                toolCallId: (event as { toolCallId: string }).toolCallId,
                toolName,
                command,
              });
              bashExtDecision = decision;
              return decision;
            },
            writeLog: deps.writeReviewLog,
            logContext: {
              source: "tool_call",
              toolCallId: (event as { toolCallId: string }).toolCallId,
              toolName,
              agentName,
              command,
              externalPaths: uncoveredPaths,
              message: bashExtMessage,
            },
            messages: {
              denyReason: formatBashExternalDirectoryDenyReason(
                command,
                uncoveredPaths,
                ctx.cwd,
                agentName ?? undefined,
              ),
              unavailableReason: `Bash command '${command}' references path(s) outside the working directory and requires approval, but no interactive UI is available.`,
              userDeniedReason: (decision) => {
                const reasonSuffix = decision.denialReason
                  ? ` Reason: ${decision.denialReason}.`
                  : "";
                return `User denied external directory access for bash command '${command}'.${reasonSuffix} ${formatExternalDirectoryHardStopHint()}`;
              },
            },
          });
          if (bashExtGate.action === "block") {
            return { block: true, reason: bashExtGate.reason };
          }

          if (bashExtDecision?.state === "approved_for_session") {
            for (const extPath of uncoveredPaths) {
              const prefix = deriveApprovalPrefix(extPath);
              deps.sessionApprovalCache.approve("external_directory", prefix);
            }
          }
        }
        // Fall through to normal bash permission check
      }
    }
  }

  // ── Normal tool permission gate ───────────────────────────────────────────
  const check = deps
    .getPermissionManager()
    .checkPermission(toolName, input, agentName ?? undefined);
  const permissionLogContext = getPermissionLogContext(
    check,
    input,
    PATH_BEARING_TOOLS,
  );

  const toolUnavailableReason =
    toolName === "bash" && isToolCallEventType("bash", event as ToolCallEvent)
      ? `Running bash command '${(event as ToolCallEvent & { input: { command: string } }).input.command}' requires approval, but no interactive UI is available.`
      : toolName === "mcp"
        ? "Using tool 'mcp' requires approval, but no interactive UI is available."
        : `Using tool '${toolName}' requires approval, but no interactive UI is available.`;

  const toolAskMessage = formatAskPrompt(check, agentName ?? undefined, input);
  const toolGate = await applyPermissionGate({
    state: check.state,
    canConfirm: deps.canRequestPermissionConfirmation(ctx),
    promptForApproval: () =>
      deps.promptPermission(ctx, {
        requestId: (event as { toolCallId: string }).toolCallId,
        source: "tool_call",
        agentName,
        message: toolAskMessage,
        toolCallId: (event as { toolCallId: string }).toolCallId,
        toolName,
        ...permissionLogContext,
      }),
    writeLog: deps.writeReviewLog,
    logContext: {
      source: "tool_call",
      toolCallId: (event as { toolCallId: string }).toolCallId,
      toolName,
      agentName,
      message: toolAskMessage,
      ...permissionLogContext,
    },
    messages: {
      denyReason: formatDenyReason(check, agentName ?? undefined),
      unavailableReason: toolUnavailableReason,
      userDeniedReason: (decision) =>
        formatUserDeniedReason(check, decision.denialReason),
    },
  });

  if (toolGate.action === "block") {
    return { block: true, reason: toolGate.reason };
  }

  return {};
}
