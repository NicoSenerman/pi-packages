import type {
  ExtensionContext,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { getNonEmptyString, toRecord } from "#src/common";
import {
  emitDecisionEvent,
  type PermissionEventBus,
} from "#src/permission-events";
import { applyPermissionGate } from "#src/permission-gate";
import type { PromptPermissionDetails } from "#src/permission-prompter";
import {
  formatMissingToolNameReason,
  formatSkillAskPrompt,
  formatUnknownToolReason,
} from "#src/permission-prompts";
import type { PermissionSession } from "#src/permission-session";
import type { ToolInputFormatterLookup } from "#src/tool-input-formatter-registry";
import {
  resolveToolPreviewLimits,
  ToolPreviewFormatter,
} from "#src/tool-preview-formatter";
import {
  checkRequestedToolRegistration,
  getToolNameFromValue,
  type ToolRegistry,
} from "#src/tool-registry";
import { resolveBashCommandCheck } from "./gates/bash-command";
import { describeBashExternalDirectoryGate } from "./gates/bash-external-directory";
import { describeBashPathGate } from "./gates/bash-path";
import type { GateResult, GateRunnerDeps } from "./gates/descriptor";
import { isGateBypass } from "./gates/descriptor";
import { describeExternalDirectoryGate } from "./gates/external-directory";
import { describePathGate } from "./gates/path";
import { runGateCheck } from "./gates/runner";
import { describeSkillReadGate } from "./gates/skill-read";
import { describeToolGate } from "./gates/tool";
import type { ToolCallContext } from "./gates/types";

/** Minimal subset of InputEvent used by handleInput. */
interface InputPayload {
  text: string;
}

/**
 * Handles permission gate events: tool_call and input.
 *
 * Constructor deps:
 * - `session` — encapsulates all mutable session state and permission operations
 * - `events` — event bus for emitting permissions:decision broadcasts
 * - `toolRegistry` — Pi tool API subset (getAll + setActive)
 */
export class PermissionGateHandler {
  constructor(
    private readonly session: PermissionSession,
    private readonly events: PermissionEventBus,
    private readonly toolRegistry: ToolRegistry,
    private readonly customFormatters?: ToolInputFormatterLookup,
  ) {}

  async handleToolCall(
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<{ block?: true; reason?: string }> {
    this.session.activate(ctx);

    const validation = validateRequestedTool(event, this.toolRegistry.getAll());
    if (validation.status === "block") {
      return { block: true, reason: validation.reason };
    }
    const toolName = validation.toolName;

    const agentName = this.session.resolveAgentName(ctx);

    const input = getEventInput(event);
    const toolCallId =
      typeof (event as Record<string, unknown>).toolCallId === "string"
        ? ((event as Record<string, unknown>).toolCallId as string)
        : "";

    const tcc: ToolCallContext = {
      toolName,
      agentName,
      input,
      toolCallId,
      cwd: ctx.cwd,
    };

    // ── Shared gate adapter closures ─────────────────────────────────────
    const canConfirm = () => this.session.canPrompt(ctx);
    const promptPermission = (details: PromptPermissionDetails) =>
      this.session.prompt(ctx, details);
    const emitDecision: GateRunnerDeps["emitDecision"] = (e) =>
      emitDecisionEvent(this.events, e);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- logger.review is a plain function closure; no this-binding issue
    const writeReviewLog = this.session.logger.review;
    const checkPermission: GateRunnerDeps["checkPermission"] = (
      surface,
      input,
      agent,
      sessionRules,
    ) => this.session.checkPermission(surface, input, agent, sessionRules);
    const getSessionRuleset = () => this.session.getSessionRuleset();
    const recordSessionApproval: GateRunnerDeps["recordSessionApproval"] = (
      approval,
    ) => this.session.recordSessionApproval(approval);

    // ── Shared runner deps (built once, reused for all gates) ────────────
    const runnerDeps: GateRunnerDeps = {
      checkPermission,
      getSessionRuleset,
      recordSessionApproval,
      writeReviewLog,
      emitDecision,
      canConfirm,
      promptPermission,
    };

    // ── Unified gate executor ─────────────────────────────────────────────
    // Handles the bypass log/emit branch, calls runGateCheck for descriptors,
    // and returns a block result or undefined (allow / no-op).
    const runGate = async (
      gate: GateResult,
    ): Promise<{ block: true; reason: string } | undefined> => {
      if (!gate) {
        return undefined;
      }
      if (isGateBypass(gate)) {
        if (gate.log) {
          writeReviewLog(gate.log.event, gate.log.details);
        }
        if (gate.decision) {
          emitDecision(gate.decision);
        }
        return undefined;
      }
      const result = await runGateCheck(
        gate,
        tcc.agentName,
        tcc.toolCallId,
        runnerDeps,
      );
      return result.action === "block"
        ? { block: true, reason: result.reason }
        : undefined;
    };

    const formatter = new ToolPreviewFormatter(
      resolveToolPreviewLimits(this.session.config),
      this.customFormatters,
    );

    // ── Ordered gate pipeline ─────────────────────────────────────────────
    // infraDirs is computed once, outside the pipeline, exactly as before.
    const infraDirs = [
      ...this.session.getInfrastructureDirs(),
      ...this.session.getInfrastructureReadPaths(),
    ];

    const gateProducers: Array<() => GateResult | Promise<GateResult>> = [
      () =>
        describeSkillReadGate(tcc, () => this.session.getActiveSkillEntries()),
      () => describePathGate(tcc, checkPermission, getSessionRuleset),
      () => describeExternalDirectoryGate(tcc, infraDirs),
      () =>
        describeBashExternalDirectoryGate(
          tcc,
          checkPermission,
          getSessionRuleset,
        ),
      () => describeBashPathGate(tcc, checkPermission, getSessionRuleset),
      async () => {
        // Bash commands may chain several sub-commands (`a && b`, `a | b`, …);
        // evaluate each on the bash surface and select the most restrictive,
        // rather than matching the whole program string (#301). Other tools
        // evaluate their single input directly.
        const toolCheck =
          tcc.toolName === "bash"
            ? await resolveBashCommandCheck(
                getNonEmptyString(toRecord(tcc.input).command) ?? "",
                tcc.agentName ?? undefined,
                getSessionRuleset(),
                checkPermission,
              )
            : checkPermission(
                tcc.toolName,
                tcc.input,
                tcc.agentName ?? undefined,
                getSessionRuleset(),
              );
        const toolDescriptor = describeToolGate(tcc, toolCheck, formatter);
        toolDescriptor.preCheck = toolCheck;
        return toolDescriptor;
      },
    ];

    for (const produce of gateProducers) {
      const blocked = await runGate(await produce());
      if (blocked) {
        return blocked;
      }
    }

    return {};
  }

  async handleInput(
    event: InputPayload,
    ctx: ExtensionContext,
  ): Promise<InputEventResult> {
    this.session.activate(ctx);

    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    const agentName = this.session.resolveAgentName(ctx);
    const check = this.session.checkPermission(
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
    const skillInputCanConfirm = this.session.canPrompt(ctx);
    let skillInputAutoApproved = false;
    const skillInputGate = await applyPermissionGate({
      state: check.state,
      canConfirm: skillInputCanConfirm,
      promptForApproval: async () => {
        const decision = await this.session.prompt(ctx, {
          requestId: this.session.createPermissionRequestId("skill-input"),
          source: "skill_input",
          agentName,
          message: skillInputMessage,
          skillName,
        });
        skillInputAutoApproved = decision.autoApproved === true;
        return decision;
      },
      // eslint-disable-next-line @typescript-eslint/unbound-method -- logger.review is a plain function closure; no this-binding issue
      writeLog: this.session.logger.review,
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

    emitDecisionEvent(this.events, {
      surface: "skill",
      value: skillName,
      result: skillInputGate.action === "allow" ? "allow" : "deny",
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive fallback; TypeScript narrows check.state before the ternary's else branch */
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
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ?? null normalises undefined to null for the log record
      origin: check.origin ?? null,
      agentName: agentName ?? null,
      matchedPattern: check.matchedPattern ?? null,
    });

    if (skillInputGate.action === "block") {
      return { action: "handled" };
    }

    return { action: "continue" };
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** Discriminated result of validating a tool-call event's name and registration. */
export type RequestedToolValidation =
  | { status: "ok"; toolName: string }
  | { status: "block"; reason: string };

/**
 * Validate the tool name from a raw event against the registered tool list.
 *
 * Composes `getToolNameFromValue` + `checkRequestedToolRegistration` + the
 * two reason formatters and returns a discriminated result so `handleToolCall`
 * reads as a straight validate → proceed path without nested early-returns.
 *
 * Returns the **raw** tool name (not the normalised form) so that
 * `ToolCallContext.toolName` stays identical to the pre-extraction behaviour.
 */
export function validateRequestedTool(
  event: unknown,
  availableTools: readonly unknown[],
): RequestedToolValidation {
  const toolName = getToolNameFromValue(event);
  if (!toolName) {
    return { status: "block", reason: formatMissingToolNameReason() };
  }
  const check = checkRequestedToolRegistration(toolName, availableTools);
  if (check.status === "missing-tool-name") {
    return { status: "block", reason: formatMissingToolNameReason() };
  }
  if (check.status === "unregistered") {
    return {
      status: "block",
      reason: formatUnknownToolReason(
        check.requestedToolName,
        check.availableToolNames,
      ),
    };
  }
  return { status: "ok", toolName };
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
