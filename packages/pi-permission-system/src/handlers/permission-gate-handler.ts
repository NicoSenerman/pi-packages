import type {
  ExtensionContext,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { getNonEmptyString, toRecord } from "#src/common";
import {
  type DecisionReporter,
  GateDecisionReporter,
} from "#src/decision-reporter";
import type { PermissionEventBus } from "#src/permission-events";
import {
  formatMissingToolNameReason,
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
import { BashProgram } from "./gates/bash-program";
import type { GateResult } from "./gates/descriptor";
import { describeExternalDirectoryGate } from "./gates/external-directory";
import { describePathGate } from "./gates/path";
import { GateRunner } from "./gates/runner";
import { describeSkillInputGate } from "./gates/skill-input";
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
  private readonly reporter: DecisionReporter;
  private readonly runner: GateRunner;

  constructor(
    private readonly session: PermissionSession,
    events: PermissionEventBus,
    private readonly toolRegistry: ToolRegistry,
    private readonly customFormatters?: ToolInputFormatterLookup,
  ) {
    this.reporter = new GateDecisionReporter(session.logger, events);
    this.runner = new GateRunner(session, session, session, this.reporter);
  }

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

    // Parse the bash command exactly once per tool_call; the three bash gates
    // share this single BashProgram instead of each re-parsing (#308).
    const command = getNonEmptyString(toRecord(tcc.input).command);
    const bashProgram =
      tcc.toolName === "bash" && command
        ? await BashProgram.parse(command)
        : null;

    // ── Shared resolver (for gate producers that need it directly) ──────
    const resolver = this.session;

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
      () => describePathGate(tcc, resolver),
      () => describeExternalDirectoryGate(tcc, infraDirs),
      () => describeBashExternalDirectoryGate(tcc, bashProgram, resolver),
      () => describeBashPathGate(tcc, bashProgram, resolver),
      () => {
        // Bash commands may chain several sub-commands (`a && b`, `a | b`, …);
        // evaluate each unit from the shared parse on the bash surface and
        // select the most restrictive, rather than matching the whole program
        // string (#301). Other tools evaluate their single input directly.
        const toolCheck =
          tcc.toolName === "bash" && bashProgram
            ? resolveBashCommandCheck(
                command ?? "",
                bashProgram.commands(),
                tcc.agentName ?? undefined,
                resolver,
              )
            : resolver.resolve(
                tcc.toolName,
                tcc.input,
                tcc.agentName ?? undefined,
              );
        const toolDescriptor = describeToolGate(tcc, toolCheck, formatter);
        toolDescriptor.preCheck = toolCheck;
        return toolDescriptor;
      },
    ];

    for (const produce of gateProducers) {
      const outcome = await this.runner.run(
        await produce(),
        tcc.agentName,
        tcc.toolCallId,
      );
      if (outcome.action === "block") {
        return { block: true, reason: outcome.reason };
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

    const outcome = await this.runner.run(
      describeSkillInputGate(skillName, agentName, check),
      agentName,
      this.session.createPermissionRequestId("skill-input"),
    );
    return outcome.action === "block"
      ? { action: "handled" }
      : { action: "continue" };
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
