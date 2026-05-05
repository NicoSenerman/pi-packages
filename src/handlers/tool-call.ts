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
  isPiInfrastructureRead,
  normalizePathForComparison,
  PATH_BEARING_TOOLS,
} from "../external-directory";
import { suggestSessionPattern } from "../pattern-suggest";
import type { PermissionPromptDecision } from "../permission-dialog";
import {
  emitDecisionEvent,
  type PermissionDecisionResolution,
} from "../permission-events";
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
import { deriveApprovalPattern } from "../session-rules";
import { findSkillPathMatch } from "../skill-prompt-sanitizer";
import { getPermissionLogContext } from "../tool-input-preview";
import {
  checkRequestedToolRegistration,
  getToolNameFromValue,
} from "../tool-registry";
import type { PermissionCheckResult } from "../types";
import type { HandlerDeps } from "./types";

// ── Emission helper ────────────────────────────────────────────────────────

/**
 * Derive the human-readable value for a decision event from a check result.
 * Bash → extracted command; MCP → qualified target; others → tool name.
 */
function deriveDecisionValue(
  toolName: string,
  check: Pick<PermissionCheckResult, "command" | "target">,
): string {
  if (toolName === "bash") return check.command ?? toolName;
  if (toolName === "mcp") return check.target ?? toolName;
  return toolName;
}

/**
 * Map the gate outcome back to a PermissionDecisionResolution.
 *
 * @param state     - The permission state passed to the gate.
 * @param action    - The gate's resulting action ("allow" | "block").
 * @param hasSession - True when the gate result carries a sessionApproval
 *                    (indicates the user chose "for this session").
 * @param canConfirm - Whether an interactive prompt was available.
 */
function deriveResolution(
  state: "allow" | "deny" | "ask",
  action: "allow" | "block",
  hasSession: boolean,
  canConfirm: boolean,
): PermissionDecisionResolution {
  if (state === "allow") return "policy_allow";
  if (state === "deny") return "policy_deny";
  // state === "ask"
  if (action === "allow") {
    return hasSession ? "user_approved_for_session" : "user_approved";
  }
  return canConfirm ? "user_denied" : "confirmation_unavailable";
}

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
  deps.runtime.runtimeContext = ctx;
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
    deps.runtime.activeSkillEntries.length > 0
  ) {
    const normalizedReadPath = normalizePathForComparison(
      (event as ToolCallEvent & { input: { path: string } }).input.path,
      ctx.cwd,
    );
    const matchedSkill = findSkillPathMatch(
      normalizedReadPath,
      deps.runtime.activeSkillEntries,
    );

    if (matchedSkill) {
      const readEvent = event as ToolCallEvent & { input: { path: string } };
      const skillReadMessage = formatSkillPathAskPrompt(
        matchedSkill,
        readEvent.input.path,
        agentName ?? undefined,
      );
      const skillReadCanConfirm = deps.canRequestPermissionConfirmation(ctx);
      const skillReadGate = await applyPermissionGate({
        state: matchedSkill.state,
        canConfirm: skillReadCanConfirm,
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
        writeLog: deps.runtime.writeReviewLog,
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
      emitDecisionEvent(deps.events, {
        surface: "skill",
        value: matchedSkill.name,
        result: skillReadGate.action === "allow" ? "allow" : "deny",
        resolution: deriveResolution(
          matchedSkill.state,
          skillReadGate.action,
          false,
          skillReadCanConfirm,
        ),
        origin: null,
        agentName: agentName ?? null,
        matchedPattern: null,
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

    // ── Pi infrastructure read bypass ──────────────────────────────────
    // Auto-allow read-only tools targeting Pi infrastructure directories
    // (agent dir, global node_modules, project-local .pi/npm|git, and
    // any user-configured extras).  Writes are never bypassed.
    const allInfraDirs = [
      ...deps.runtime.piInfrastructureDirs,
      ...(deps.runtime.config.piInfrastructureReadPaths ?? []),
    ];
    if (
      isPiInfrastructureRead(toolName, normalizedExtPath, allInfraDirs, ctx.cwd)
    ) {
      deps.runtime.writeReviewLog(
        "permission_request.infrastructure_auto_allowed",
        {
          source: "tool_call",
          toolCallId: (event as { toolCallId: string }).toolCallId,
          toolName,
          agentName,
          path: externalDirectoryPath,
        },
      );
      emitDecisionEvent(deps.events, {
        surface: toolName,
        value: externalDirectoryPath,
        result: "allow",
        resolution: "infrastructure_auto_allowed",
        origin: null,
        agentName: agentName ?? null,
        matchedPattern: null,
      });
      // Fall through to normal tool-permission check.
    } else {
      const extCheck = deps.runtime.permissionManager.checkPermission(
        "external_directory",
        { path: normalizedExtPath },
        agentName ?? undefined,
        deps.runtime.sessionRules.getRuleset(),
      );

      if (extCheck.source === "session") {
        deps.runtime.writeReviewLog("permission_request.session_approved", {
          source: "tool_call",
          toolCallId: (event as { toolCallId: string }).toolCallId,
          toolName,
          agentName,
          path: externalDirectoryPath,
          resolution: "session_approved",
          sessionApprovalPattern: extCheck.matchedPattern,
        });
        emitDecisionEvent(deps.events, {
          surface: "external_directory",
          value: externalDirectoryPath,
          result: "allow",
          resolution: "session_approved",
          origin: extCheck.origin ?? null,
          agentName: agentName ?? null,
          matchedPattern: extCheck.matchedPattern ?? null,
        });
        // Fall through to normal permission check
      } else {
        let extDirDecision: PermissionPromptDecision | null = null;
        const extDirMessage = formatExternalDirectoryAskPrompt(
          toolName,
          externalDirectoryPath,
          ctx.cwd,
          agentName ?? undefined,
        );
        const extDirCanConfirm = deps.canRequestPermissionConfirmation(ctx);
        const extDirGateResult = await applyPermissionGate({
          state: extCheck.state,
          canConfirm: extDirCanConfirm,
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
          writeLog: deps.runtime.writeReviewLog,
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
        emitDecisionEvent(deps.events, {
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
          agentName: agentName ?? null,
          matchedPattern: extCheck.matchedPattern ?? null,
        });
        if (extDirGateResult.action === "block") {
          return { block: true, reason: extDirGateResult.reason };
        }

        if (extDirDecision?.state === "approved_for_session") {
          const pattern = deriveApprovalPattern(normalizedExtPath);
          deps.runtime.sessionRules.approve("external_directory", pattern);
        }
      }
    } // end else (not Pi infrastructure read)
    // Fall through to normal permission check
  }

  // ── Bash external-directory gate ─────────────────────────────────────────
  if (ctx.cwd && toolName === "bash") {
    const command = getNonEmptyString(toRecord(input).command);
    if (command) {
      const externalPaths = await extractExternalPathsFromBashCommand(
        command,
        ctx.cwd,
      );
      if (externalPaths.length > 0) {
        const bashSessionRules = deps.runtime.sessionRules.getRuleset();
        const uncoveredPaths = externalPaths.filter(
          (p) =>
            deps.runtime.permissionManager.checkPermission(
              "external_directory",
              { path: p },
              agentName ?? undefined,
              bashSessionRules,
            ).source !== "session",
        );

        if (uncoveredPaths.length === 0) {
          deps.runtime.writeReviewLog("permission_request.session_approved", {
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
          // Get the config-level policy (no path → no session check).
          const extCheck = deps.runtime.permissionManager.checkPermission(
            "external_directory",
            {},
            agentName ?? undefined,
          );

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
            writeLog: deps.runtime.writeReviewLog,
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
              const pattern = deriveApprovalPattern(extPath);
              deps.runtime.sessionRules.approve("external_directory", pattern);
            }
          }
        }
        // Fall through to normal bash permission check
      }
    }
  }

  // ── Normal tool permission gate ───────────────────────────────────────────
  const check = deps.runtime.permissionManager.checkPermission(
    toolName,
    input,
    agentName ?? undefined,
    deps.runtime.sessionRules.getRuleset(),
  );

  // Session-hit: already approved by a session rule — skip the gate entirely.
  if (check.source === "session") {
    deps.runtime.writeReviewLog("permission_request.session_approved", {
      source: "tool_call",
      toolCallId: (event as { toolCallId: string }).toolCallId,
      toolName,
      agentName,
      resolution: "session_approved",
      sessionApprovalPattern: check.matchedPattern,
    });
    emitDecisionEvent(deps.events, {
      surface: toolName,
      value: deriveDecisionValue(toolName, check),
      result: "allow",
      resolution: "session_approved",
      origin: check.origin ?? null,
      agentName: agentName ?? null,
      matchedPattern: check.matchedPattern ?? null,
    });
    return {};
  }

  const permissionLogContext = getPermissionLogContext(
    check,
    input,
    PATH_BEARING_TOOLS,
  );

  // Compute session approval suggestion for the "for this session" option.
  const suggestionValue =
    toolName === "bash"
      ? (check.command ?? "")
      : toolName === "mcp"
        ? (check.target ?? "mcp")
        : "*";
  const suggestion = suggestSessionPattern(toolName, suggestionValue);

  const toolUnavailableReason =
    toolName === "bash" && isToolCallEventType("bash", event as ToolCallEvent)
      ? `Running bash command '${(event as ToolCallEvent & { input: { command: string } }).input.command}' requires approval, but no interactive UI is available.`
      : toolName === "mcp"
        ? "Using tool 'mcp' requires approval, but no interactive UI is available."
        : `Using tool '${toolName}' requires approval, but no interactive UI is available.`;

  const toolAskMessage = formatAskPrompt(check, agentName ?? undefined, input);
  const toolCanConfirm = deps.canRequestPermissionConfirmation(ctx);
  const toolGate = await applyPermissionGate({
    state: check.state,
    canConfirm: toolCanConfirm,
    sessionApproval: {
      surface: suggestion.surface,
      pattern: suggestion.pattern,
    },
    promptForApproval: () =>
      deps.promptPermission(ctx, {
        requestId: (event as { toolCallId: string }).toolCallId,
        source: "tool_call",
        agentName,
        message: toolAskMessage,
        toolCallId: (event as { toolCallId: string }).toolCallId,
        toolName,
        sessionLabel: suggestion.label,
        ...permissionLogContext,
      }),
    writeLog: deps.runtime.writeReviewLog,
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

  emitDecisionEvent(deps.events, {
    surface: toolName,
    value: deriveDecisionValue(toolName, check),
    result: toolGate.action === "allow" ? "allow" : "deny",
    resolution: deriveResolution(
      check.state,
      toolGate.action,
      toolGate.sessionApproval !== undefined,
      toolCanConfirm,
    ),
    origin: check.origin ?? null,
    agentName: agentName ?? null,
    matchedPattern: check.matchedPattern ?? null,
  });

  if (toolGate.action === "block") {
    return { block: true, reason: toolGate.reason };
  }

  if (toolGate.sessionApproval) {
    deps.runtime.sessionRules.approve(
      toolGate.sessionApproval.surface,
      toolGate.sessionApproval.pattern,
    );
  }

  return {};
}
