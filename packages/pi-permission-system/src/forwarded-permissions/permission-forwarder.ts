import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  getActiveAgentName,
  getActiveAgentNameFromSystemPrompt,
} from "#src/active-agent";
import { toRecord } from "#src/common";
import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
} from "#src/permission-dialog";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "#src/permission-events";
import {
  type ForwardedPermissionRequest,
  type ForwardedPermissionResponse,
  type ForwardedPromptDisplay,
  isForwardedPermissionRequestForSession,
  PERMISSION_FORWARDING_POLL_INTERVAL_MS,
  PERMISSION_FORWARDING_TIMEOUT_MS,
  type PermissionForwardingLocation,
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_PARENT_SESSION_ENV_CANDIDATES,
} from "#src/permission-forwarding";
import { buildForwardedUiPrompt } from "#src/permission-ui-prompt";
import { isSubagentExecutionContext } from "#src/subagent-context";
import type { SubagentSessionRegistry } from "#src/subagent-registry";

import {
  cleanupPermissionForwardingLocationIfEmpty,
  ensurePermissionForwardingLocation,
  type ForwardedPermissionLogger,
  getExistingPermissionForwardingLocation,
  listRequestFiles,
  logPermissionForwardingError,
  logPermissionForwardingWarning,
  readForwardedPermissionRequest,
  readForwardedPermissionResponse,
  safeDeleteFile,
  sleep,
  writeJsonFileAtomic,
} from "./io";

/**
 * Constructor config for `PermissionForwarder`.
 *
 * Replaces the `PermissionForwardingDeps` interface that was previously
 * threaded into free functions in `polling.ts`.  The forwarder consumes it
 * once at construction and stores each member as a private readonly field.
 */
export interface PermissionForwarderDeps {
  forwardingDir: string;
  subagentSessionsDir: string;
  /** In-process subagent session registry for detection and forwarding target resolution. */
  registry?: SubagentSessionRegistry;
  /** Event bus used for UI prompt broadcasts. */
  events?: PermissionEventBus;
  logger: ForwardedPermissionLogger;
  writeReviewLog: (event: string, details: Record<string, unknown>) => void;
  requestPermissionDecisionFromUi: (
    ui: ExtensionContext["ui"],
    title: string,
    message: string,
    options?: RequestPermissionOptions,
  ) => Promise<PermissionPromptDecision>;
  shouldAutoApprove: (request?: { surface?: string; value?: string }) => boolean;
}

// ── Module-private helpers ────────────────────────────────────────────────

function getSessionId(ctx: ExtensionContext): string {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
  } catch {}

  return "unknown";
}

function getContextSystemPrompt(ctx: ExtensionContext): string | undefined {
  const getSystemPrompt = toRecord(ctx).getSystemPrompt;
  if (typeof getSystemPrompt !== "function") {
    return undefined;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- getSystemPrompt is a Pi SDK accessor returning any
    const systemPrompt = getSystemPrompt.call(ctx);
    return typeof systemPrompt === "string" ? systemPrompt : undefined;
  } catch (error) {
    // No deps available in this helper — warning silently dropped.
    logPermissionForwardingWarning(
      null,
      "Failed to read context system prompt for forwarded permission metadata",
      error,
    );
    return undefined;
  }
}

function formatForwardedPermissionPrompt(
  request: ForwardedPermissionRequest,
): string {
  const agentName = request.requesterAgentName || "unknown";
  const sessionId = request.requesterSessionId || "unknown";
  return [
    `Subagent '${agentName}' requested permission.`,
    `Session ID: ${sessionId}`,
    "",
    request.message,
  ].join("\n");
}

// ── Public seam interfaces ────────────────────────────────────────────────

/**
 * Narrow seam describing what `PermissionPrompter` needs from the forwarder:
 * a single method that resolves a permission decision for the current context
 * (prompt directly when the session has UI, otherwise forward to the parent).
 *
 * Depending on the interface (not the concrete `PermissionForwarder`) keeps
 * the prompter's unit tests free of casts — they inject a plain
 * `{ requestApproval: vi.fn() }` mock.
 */
export interface ApprovalRequester {
  requestApproval(
    ctx: ExtensionContext,
    message: string,
    options?: RequestPermissionOptions,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision>;
}

/**
 * Narrow seam describing what `ForwardingManager` needs from the forwarder:
 * a single method that drains this session's forwarded-permission inbox.
 *
 * Depending on the interface (not the concrete `PermissionForwarder`) keeps
 * the manager's unit tests free of casts — they inject a plain
 * `{ processInbox: vi.fn() }` mock.
 */
export interface InboxProcessor {
  processInbox(ctx: ExtensionContext): Promise<void>;
}

// ── PermissionForwarder ───────────────────────────────────────────────────

/**
 * Owner of the forwarded-permission behavior.
 *
 * Holds all forwarding state as private readonly fields and provides two
 * public methods (`requestApproval`, `processInbox`) that together encapsulate
 * the full forwarding lifecycle: deciding whether to prompt directly or
 * forward to the parent, building and persisting request files, polling for
 * responses, and processing the parent-session inbox.
 */
export class PermissionForwarder implements ApprovalRequester, InboxProcessor {
  private readonly forwardingDir: string;
  private readonly subagentSessionsDir: string;
  private readonly registry: SubagentSessionRegistry | undefined;
  private readonly events: PermissionEventBus | undefined;
  private readonly logger: ForwardedPermissionLogger;
  private readonly writeReviewLog: (
    event: string,
    details: Record<string, unknown>,
  ) => void;
  private readonly requestPermissionDecisionFromUi: (
    ui: ExtensionContext["ui"],
    title: string,
    message: string,
    options?: RequestPermissionOptions,
  ) => Promise<PermissionPromptDecision>;
  private readonly shouldAutoApprove: (request?: { surface?: string; value?: string }) => boolean;

  constructor(deps: PermissionForwarderDeps) {
    this.forwardingDir = deps.forwardingDir;
    this.subagentSessionsDir = deps.subagentSessionsDir;
    this.registry = deps.registry;
    this.events = deps.events;
    this.logger = deps.logger;
    this.writeReviewLog = deps.writeReviewLog;
    this.requestPermissionDecisionFromUi = deps.requestPermissionDecisionFromUi;
    this.shouldAutoApprove = deps.shouldAutoApprove;
  }

  // ── Public seam methods ────────────────────────────────────────────────

  /**
   * Resolve a permission decision for the current context: prompt directly
   * when this session has UI, otherwise forward to the parent session.
   */
  requestApproval(
    ctx: ExtensionContext,
    message: string,
    options?: RequestPermissionOptions,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision> {
    if (ctx.hasUI) {
      return this.requestPermissionDecisionFromUi(
        ctx.ui,
        "Permission Required",
        message,
        options,
      );
    }

    if (
      !isSubagentExecutionContext(ctx, this.subagentSessionsDir, this.registry)
    ) {
      return Promise.resolve({ approved: false, state: "denied" });
    }

    return this.waitForForwardedApproval(ctx, message, forwarded);
  }

  /** Drain and respond to this session's forwarded-permission inbox. */
  async processInbox(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }

    const currentSessionId = getSessionId(ctx);
    const location = getExistingPermissionForwardingLocation(
      this.forwardingDir,
      currentSessionId,
    );
    if (!location) {
      return;
    }

    const requestFiles = listRequestFiles(this.logger, location.requestsDir);
    if (requestFiles.length === 0) {
      return;
    }

    for (const fileName of requestFiles) {
      const requestPath = join(location.requestsDir, fileName);
      const request = readForwardedPermissionRequest(this.logger, requestPath);
      if (!request) {
        safeDeleteFile(
          this.logger,
          requestPath,
          `${location.label} forwarded permission request`,
        );
        continue;
      }

      await this.processSingleForwardedRequest(
        ctx,
        request,
        location,
        requestPath,
        currentSessionId,
      );
    }

    cleanupPermissionForwardingLocationIfEmpty(this.logger, location);
  }

  // ── Private methods ────────────────────────────────────────────────────

  private async waitForForwardedApproval(
    ctx: ExtensionContext,
    message: string,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision> {
    const requesterSessionId = getSessionId(ctx);
    const targetSessionId = resolvePermissionForwardingTargetSessionId({
      hasUI: ctx.hasUI,
      isSubagent: isSubagentExecutionContext(
        ctx,
        this.subagentSessionsDir,
        this.registry,
      ),
      currentSessionId: requesterSessionId,
      env: process.env,
      sessionId: requesterSessionId,
      registry: this.registry,
    });

    if (!targetSessionId) {
      logPermissionForwardingError(
        this.logger,
        `Permission forwarding target session could not be resolved. ` +
          `Checked env vars: ${SUBAGENT_PARENT_SESSION_ENV_CANDIDATES.join(", ")}. ` +
          `If you are using a subagent extension (nicobailon/pi-subagents, HazAT/pi-interactive-subagents, etc.), ` +
          `ask its maintainer to set PI_SUBAGENT_PARENT_SESSION in the child process environment ` +
          `(see https://github.com/gotgenes/pi-permission-system/issues/143).`,
      );
      return { approved: false, state: "denied" };
    }

    const location = ensurePermissionForwardingLocation(
      this.logger,
      this.forwardingDir,
      targetSessionId,
    );
    if (!location) {
      logPermissionForwardingError(
        this.logger,
        `Permission forwarding is unavailable because session-scoped directories could not be prepared for '${targetSessionId}'`,
      );
      return { approved: false, state: "denied" };
    }

    const request = this.buildForwardedRequest(
      ctx,
      message,
      requesterSessionId,
      targetSessionId,
      forwarded,
    );
    const requestPath = join(location.requestsDir, `${request.id}.json`);
    const responsePath = join(location.responsesDir, `${request.id}.json`);

    this.writeReviewLog("forwarded_permission.request_created", {
      requestId: request.id,
      requesterAgentName: request.requesterAgentName,
      requesterSessionId: request.requesterSessionId,
      targetSessionId,
      requestPath,
      responsePath,
    });

    try {
      writeJsonFileAtomic(this.logger, requestPath, request);
    } catch (error) {
      logPermissionForwardingError(
        this.logger,
        `Failed to write forwarded permission request '${requestPath}'`,
        error,
      );
      return { approved: false, state: "denied" };
    }

    return this.pollForForwardedResponse(
      location,
      request,
      requestPath,
      responsePath,
    );
  }

  private buildForwardedRequest(
    ctx: ExtensionContext,
    message: string,
    requesterSessionId: string,
    targetSessionId: string,
    forwarded?: ForwardedPromptDisplay,
  ): ForwardedPermissionRequest {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
    const requesterAgentName =
      getActiveAgentName(ctx) ??
      getActiveAgentNameFromSystemPrompt(getContextSystemPrompt(ctx)) ??
      "unknown";
    return {
      id: requestId,
      createdAt: Date.now(),
      requesterSessionId,
      targetSessionId,
      requesterAgentName,
      message,
      ...(forwarded
        ? {
            source: forwarded.source,
            surface: forwarded.surface,
            value: forwarded.value,
          }
        : {}),
    };
  }

  private async pollForForwardedResponse(
    location: PermissionForwardingLocation,
    request: ForwardedPermissionRequest,
    requestPath: string,
    responsePath: string,
  ): Promise<PermissionPromptDecision> {
    const { id: requestId, requesterAgentName, targetSessionId } = request;
    const deadline = Date.now() + PERMISSION_FORWARDING_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (existsSync(responsePath)) {
        const response = readForwardedPermissionResponse(
          this.logger,
          responsePath,
        );
        this.writeReviewLog("forwarded_permission.response_received", {
          requestId,
          approved: response?.approved ?? null,
          state: response?.state ?? null,
          denialReason: response?.denialReason ?? null,
          responderSessionId: response?.responderSessionId ?? null,
          targetSessionId,
          responsePath,
        });
        safeDeleteFile(
          this.logger,
          responsePath,
          "forwarded permission response",
        );
        safeDeleteFile(
          this.logger,
          requestPath,
          "forwarded permission request",
        );
        cleanupPermissionForwardingLocationIfEmpty(this.logger, location);
        return response ?? { approved: false, state: "denied" };
      }

      await sleep(PERMISSION_FORWARDING_POLL_INTERVAL_MS);
    }

    logPermissionForwardingWarning(
      this.logger,
      `Timed out waiting for forwarded permission response '${responsePath}'`,
    );
    this.writeReviewLog("forwarded_permission.response_timed_out", {
      requestId,
      requesterAgentName,
      targetSessionId,
      responsePath,
    });
    safeDeleteFile(this.logger, requestPath, "forwarded permission request");
    cleanupPermissionForwardingLocationIfEmpty(this.logger, location);
    return { approved: false, state: "denied" };
  }

  private async processSingleForwardedRequest(
    ctx: ExtensionContext,
    request: ForwardedPermissionRequest,
    location: PermissionForwardingLocation,
    requestPath: string,
    currentSessionId: string,
  ): Promise<void> {
    if (!isForwardedPermissionRequestForSession(request, currentSessionId)) {
      logPermissionForwardingWarning(
        this.logger,
        `Ignoring forwarded permission request '${request.id}' because it targets session '${request.targetSessionId}' instead of '${currentSessionId}'`,
      );
      safeDeleteFile(
        this.logger,
        requestPath,
        `${location.label} forwarded permission request`,
      );
      return;
    }

    const forwardedPermissionLogDetails = {
      requestId: request.id,
      source: location.label,
      requesterAgentName: request.requesterAgentName,
      requesterSessionId: request.requesterSessionId,
      targetSessionId: request.targetSessionId,
      requestPath,
    };

    let decision: PermissionPromptDecision = {
      approved: false,
      state: "denied",
    };
    if (this.shouldAutoApprove({ surface: request.surface ?? undefined, value: request.value ?? undefined })) {
      this.writeReviewLog(
        "forwarded_permission.auto_approved",
        forwardedPermissionLogDetails,
      );
      decision = { approved: true, state: "approved" };
    } else {
      this.writeReviewLog(
        "forwarded_permission.prompted",
        forwardedPermissionLogDetails,
      );
      try {
        const forwardedMessage = formatForwardedPermissionPrompt(request);
        if (this.events) {
          emitUiPromptEvent(
            this.events,
            buildForwardedUiPrompt({
              requestId: request.id,
              message: forwardedMessage,
              requesterAgentName: request.requesterAgentName || null,
              requesterSessionId: request.requesterSessionId || null,
              source: request.source ?? null,
              surface: request.surface ?? null,
              value: request.value ?? null,
            }),
          );
        }
        decision = await this.requestPermissionDecisionFromUi(
          ctx.ui,
          "Permission Required (Subagent)",
          forwardedMessage,
        );
      } catch (error) {
        logPermissionForwardingError(
          this.logger,
          "Failed to show forwarded permission confirmation dialog",
          error,
        );
        decision = { approved: false, state: "denied" };
      }
    }

    const responsePath = join(location.responsesDir, `${request.id}.json`);
    this.writeReviewLog(
      decision.approved
        ? "forwarded_permission.approved"
        : "forwarded_permission.denied",
      {
        requestId: request.id,
        source: location.label,
        requesterAgentName: request.requesterAgentName,
        requesterSessionId: request.requesterSessionId,
        targetSessionId: request.targetSessionId,
        responsePath,
        resolution: decision.state,
        denialReason: decision.denialReason ?? null,
      },
    );
    try {
      writeJsonFileAtomic(this.logger, responsePath, {
        approved: decision.approved,
        state: decision.state,
        denialReason: decision.denialReason,
        responderSessionId: currentSessionId,
        respondedAt: Date.now(),
      } satisfies ForwardedPermissionResponse);
    } catch (error) {
      logPermissionForwardingError(
        this.logger,
        `Failed to write ${location.label} forwarded permission response '${responsePath}'`,
        error,
      );
      return;
    }

    safeDeleteFile(
      this.logger,
      requestPath,
      `${location.label} forwarded permission request`,
    );
  }
}
