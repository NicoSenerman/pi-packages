import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { PermissionPromptDecision } from "../permission-dialog";
import type { PermissionEventBus } from "../permission-events";
import type { PermissionManager } from "../permission-manager";
import type { SessionState } from "../runtime";

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
  /** Override label for the "for this session" dialog option. */
  sessionLabel?: string;
}

/**
 * Explicit dependency bag passed to each extracted event handler.
 *
 * Mutable session state lives in `session`; handlers read and write
 * `deps.session.*` directly. Logging, infrastructure paths, and the
 * event bus are promoted to top-level fields so handlers and gate
 * adapters never reach through nested objects for leaf operations.
 */
export interface HandlerDeps {
  // ── Session state ─────────────────────────────────────────────────────
  /** Mutable session state: permissionManager, sessionRules, cache keys. */
  readonly session: SessionState;

  // ── Logging (promoted from runtime) ───────────────────────────────────
  writeDebugLog(event: string, details?: Record<string, unknown>): void;
  writeReviewLog(event: string, details?: Record<string, unknown>): void;

  // ── Immutable infrastructure paths ───────────────────────────────────
  readonly piInfrastructureDirs: readonly string[];
  /** Returns config-derived infrastructure read paths (current at call time). */
  getPiInfrastructureReadPaths(): string[];

  // ── Event bus ────────────────────────────────────────────────────────
  /** Event bus for emitting permissions:decision broadcast events. */
  readonly events: PermissionEventBus;

  // ── Factories ──────────────────────────────────────────────────────────
  /** Create a new PermissionManager scoped to cwd's config hierarchy. */
  createPermissionManagerForCwd(
    cwd: string | undefined | null,
  ): PermissionManager;

  // ── Config & lifecycle helpers ─────────────────────────────────────────
  /** Reload merged config from disk; optionally update the stored runtime context. */
  refreshExtensionConfig(ctx?: ExtensionContext): void;
  /** Show a warning notification to the user (no-op when no UI is available). */
  notifyWarning(message: string): void;
  /** Write the resolved config path set to the review and debug logs. */
  logResolvedConfigPaths(): void;

  // ── Permission helpers ─────────────────────────────────────────────────
  /**
   * Resolve the active agent name from the session context or system prompt.
   * Updates session.lastKnownActiveAgentName as a side effect.
   */
  resolveAgentName(ctx: ExtensionContext, systemPrompt?: string): string | null;
  /** Whether the current context can show an interactive permission prompt. */
  canRequestPermissionConfirmation(ctx: ExtensionContext): boolean;
  /** Prompt the user for a permission decision, log the outcome, and return it. */
  promptPermission(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
  /** Generate a unique ID for a permission request. */
  createPermissionRequestId(prefix: string): string;

  // ── Forwarding ─────────────────────────────────────────────────────────
  startForwardedPermissionPolling(ctx: ExtensionContext): void;
  stopForwardedPermissionPolling(): void;
  /** Unsubscribe the permissions:rpc:check and permissions:rpc:prompt handlers. */
  stopPermissionRpcHandlers(): void;

  // ── Pi API subset ──────────────────────────────────────────────────────
  getAllTools(): unknown[];
  setActiveTools(names: string[]): void;
}
