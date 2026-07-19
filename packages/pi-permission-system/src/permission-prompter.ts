import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigReader } from "./config-store";
import type { ApprovalRequester } from "./forwarded-permissions/permission-forwarder";
import type { PermissionPromptDecision } from "./permission-dialog";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "./permission-events";
import { buildDirectUiPrompt } from "./permission-ui-prompt";
import { requiresBachPrompt } from "./bach-gate";
import type { ReviewLogger } from "./session-logger";
import { isBachMode, shouldAutoApprovePermissionState } from "./yolo-mode";

/**
 * Resolve the full bash program string the BACH destructiveness gate must see.
 *
 * `details.command` carries the single most-restrictive *unit* a chained bash
 * program decomposed into (e.g. just `cd /repo` when every unit resolved to
 * `allow` under a permissive default config). The BACH gate is a whole-command
 * destructiveness check — it must inspect the entire program so a
 * `wrangler deploy` on any line is caught — so prefer {@link PromptPermissionDetails.fullCommand}
 * (the original `input.command` string) and fall back to `details.command` only
 * when the full string is unavailable (e.g. MCP/path tools, forwarded prompts).
 */
function bachGateCommand(details: PromptPermissionDetails): string | undefined {
  return details.fullCommand ?? details.command;
}

export type PermissionReviewSource = "tool_call" | "skill_input" | "skill_read";

/** Details passed when prompting the user for a permission decision. */
export interface PromptPermissionDetails {
  requestId: string;
  source: PermissionReviewSource;
  agentName: string | null;
  message: string;
  toolCallId?: string;
  toolName?: string;
  skillName?: string;
  path?: string;
  command?: string;
  target?: string;
  toolInputPreview?: string;
  /**
   * The full, original tool input string the BACH gate must inspect as a whole.
   *
   * For `bash` this is the entire (possibly multi-line, chained) program from
   * `input.command` — distinct from `command`, which is the single
   * most-restrictive unit a chained program decomposed into and which can hide
   * a destructive op on a later line (e.g. a `wrangler deploy` after a leading
   * `cd`). The BACH destructiveness check reads this; everything else reads
   * `command` for display/logging that scopes to the policy-matched unit.
   */
  fullCommand?: string;
  /** Override label for the "for this session" dialog option. */
  sessionLabel?: string;
}

/** Mockable contract for permission prompting. */
export interface PermissionPrompterApi {
  prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
}

/**
 * Dependencies required by PermissionPrompter.
 *
 * Keeps the prompter's external surface narrow: callers provide config
 * access, a review logger, the UI-prompt event bus, and the forwarder
 * that owns the UI/subagent-forwarding branching logic.
 */
export interface PermissionPrompterDeps {
  /** Read current config for yolo-mode check (called at prompt time). */
  config: ConfigReader;
  /** Write structured entries to the permission review log. */
  logger: ReviewLogger;
  /** Event bus used for UI prompt broadcasts. */
  events: PermissionEventBus;
  /** Resolves the permission decision: direct UI dialog or forwarded to parent. */
  forwarder: ApprovalRequester;
}

/**
 * Encapsulates the full permission-prompt flow:
 *   1. Yolo-mode auto-approval check.
 *   2. Review-log "waiting" entry.
 *   3. UI-present vs. subagent-forwarding branching (via confirmPermission).
 *   4. Review-log "approved" / "denied" entry.
 *
 * Injecting a single PermissionPrompter instance means adding a new prompt
 * parameter (e.g. a future sessionLabel variant) only requires changing
 * PromptPermissionDetails and this class — not the full threading chain.
 */
export class PermissionPrompter implements PermissionPrompterApi {
  constructor(private readonly deps: PermissionPrompterDeps) {}

  async prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    // BACH gate: auto-approve most operations, but force-prompt for
    // destructive commands and external network access. Inspect the *full*
    // bash program (`fullCommand`), not the single per-unit `command`, so a
    // destructive op on any line (e.g. `wrangler deploy` after a leading
    // `cd`) still trips the gate (#<issue>).
    if (
      shouldAutoApprovePermissionState("ask", this.deps.config.current()) &&
      !(
        isBachMode() &&
        requiresBachPrompt(details.toolName ?? "", bachGateCommand(details))
      )
    ) {
      this.writeReviewEntry("permission_request.auto_approved", details);
      return { approved: true, state: "approved", autoApproved: true };
    }

    this.writeReviewEntry("permission_request.waiting", details);

    // Build the event once. When this session has UI it broadcasts directly;
    // when it does not (a forwarding subagent), the display fields ride along
    // to the parent so the parent emits a non-degraded event from the
    // forwarded path instead of here.
    const uiPrompt = buildDirectUiPrompt(details);
    if (ctx.hasUI) {
      emitUiPromptEvent(this.deps.events, uiPrompt);
    }

    const decision = await this.deps.forwarder.requestApproval(
      ctx,
      details.message,
      details.sessionLabel ? { sessionLabel: details.sessionLabel } : undefined,
      {
        source: uiPrompt.source,
        surface: uiPrompt.surface,
        value: uiPrompt.value,
      },
    );

    this.writeReviewEntry(
      decision.approved
        ? "permission_request.approved"
        : "permission_request.denied",
      {
        ...details,
        resolution: decision.state,
        denialReason: decision.denialReason,
      },
    );

    return decision;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private writeReviewEntry(
    event: string,
    details: PromptPermissionDetails & {
      resolution?: string;
      denialReason?: string;
    },
  ): void {
    this.deps.logger.review(event, {
      requestId: details.requestId,
      source: details.source,
      agentName: details.agentName,
      message: details.message,
      toolCallId: details.toolCallId ?? null,
      toolName: details.toolName ?? null,
      skillName: details.skillName ?? null,
      path: details.path ?? null,
      command: details.command ?? null,
      target: details.target ?? null,
      toolInputPreview: details.toolInputPreview ?? null,
      resolution: details.resolution ?? null,
      denialReason: details.denialReason ?? null,
    });
  }
}
