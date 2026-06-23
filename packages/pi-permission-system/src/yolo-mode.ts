import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionSystemExtensionConfig } from "./extension-config";
import { syncPermissionSystemStatus } from "./status";
import type { PermissionState } from "./types";

export interface AskPermissionResolutionOptions {
  config: PermissionSystemExtensionConfig;
  hasUI: boolean;
  isSubagent: boolean;
}

// ── Toggle helper (used by /mode command and shortcut) ─────────────────

export type Mode = "yolo" | "bach" | "gated";

export const MODE_CYCLE: Mode[] = ["yolo", "bach", "gated"];

// `currentMode` is only set when the user explicitly picks a mode via /mode or
// the ctrl+alt+m shortcut. Until then it stays `null` and permission decisions
// fall back to `config.yoloMode` — the upstream fail-closed contract. This keeps
// factory tests (which pass `yoloMode: undefined` and expect `ask` to stay
// `ask`) green while still allowing the runtime mode toggle to override.
let currentMode: Mode | null = null;

export function getCurrentMode(): Mode {
  // Default to whatever the live config says when no explicit mode is set.
  // Callers that need "what did the user pick" should treat null as "no pick".
  return currentMode ?? "bach";
}

export function isBachMode(): boolean {
  return currentMode === "bach";
}

/** Whether the user has explicitly picked a mode via /mode or shortcut. */
export function isExplicitMode(): boolean {
  return currentMode !== null;
}

/** Whether yolo mode is enabled per the live config (upstream contract). */
export function isYoloModeEnabled(
  config: PermissionSystemExtensionConfig,
): boolean {
  return Boolean(config.yoloMode);
}

/**
 * Whether the current mode auto-approves permission requests.
 *
 * When the user has explicitly chosen a mode (currentMode != null), that
 * choice is authoritative. Otherwise we defer to `config.yoloMode` so the
 * fail-closed default (yoloMode undefined/false) is honored — matching
 * upstream's contract and the factory wiring tests.
 */
export function isAutoApproveMode(
  config?: PermissionSystemExtensionConfig,
): boolean {
  if (currentMode !== null) {
    return currentMode !== "gated";
  }
  return config ? isYoloModeEnabled(config) : false;
}

export function setCurrentMode(
  mode: Mode,
  ctx: ExtensionContext,
  config: PermissionSystemExtensionConfig,
): void {
  currentMode = mode;
  syncPermissionSystemStatus(ctx, { ...config, yoloMode: mode !== "gated" });
}

// ── Permission decision helpers ──────────────────────────────────────────
// These derive from currentMode (single source of truth), not from a
// separate runtimeYoloMode boolean or config.yoloMode flag.

export function shouldAutoApprovePermissionState(
  state: PermissionState,
  config: PermissionSystemExtensionConfig,
): boolean {
  return state === "ask" && isAutoApproveMode(config);
}

export function canResolveAskPermissionRequest(
  options: AskPermissionResolutionOptions,
): boolean {
  return (
    options.hasUI || options.isSubagent || isAutoApproveMode(options.config)
  );
}
