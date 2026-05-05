import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { PermissionPromptDecision } from "../permission-dialog";
import type { PermissionEventBus } from "../permission-events";
import type { PermissionManager } from "../permission-manager";
import type { ExtensionRuntime } from "../runtime";

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
 * Mutable state lives in `runtime`; handlers read and write `deps.runtime.*`
 * directly instead of going through getter/setter pairs.
 */
export interface HandlerDeps {
  // ── Runtime context ────────────────────────────────────────────────────
  /** All mutable extension state and log-writing methods. */
  readonly runtime: ExtensionRuntime;
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
   * Updates runtime.lastKnownActiveAgentName as a side effect.
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
