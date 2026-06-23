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

// `currentMode` defaults to "bach" so a fresh session shows the BACH prompt +
// status + gate out of the box. `modeExplicitlySet` tracks whether the user
// has actually picked a mode via /mode or the ctrl+alt+m shortcut. Permission
// auto-approval requires explicit yolo/bach OR config.yoloMode — the default
// (non-explicit) BACH state stays fail-closed (no auto-approve), matching
// upstream's contract and the factory wiring tests.
let currentMode: Mode = "bach";
let modeExplicitlySet = false;

export function getCurrentMode(): Mode {
  return currentMode;
}

export function isBachMode(): boolean {
  return currentMode === "bach";
}

/** Whether the user has explicitly picked a mode via /mode or shortcut. */
export function isExplicitMode(): boolean {
  return modeExplicitlySet;
}

/**
 * Mark the current mode as explicitly chosen (without changing the mode itself).
 * Called at session_start for non-child sessions so BACH — the default mode —
 * auto-approves permissions out of the box (the real runtime behavior), while
 * factory wiring tests that construct the extension without firing
 * session_start keep modeExplicitlySet=false and stay fail-closed.
 */
export function markModeExplicitlySet(): void {
  modeExplicitlySet = true;
}

/**
 * Reset mode state to the non-explicit default. Used by tests that need to
 * assert upstream's fail-closed contract (prompt UI surfacing during `ask`,
 * session-approval isolation) — they fire session_start (which marks the
 * default BACH mode explicit → auto-approve) then call this to opt back into
 * fail-closed behavior for the assertion.
 */
export function resetModeState(): void {
  currentMode = "bach";
  modeExplicitlySet = false;
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
 * Auto-approval happens when the user has explicitly chosen yolo or bach
 * (modeExplicitlySet), or when config.yoloMode is on. The default BACH state
 * (before any explicit pick) does NOT auto-approve — it stays fail-closed so
 * tests passing `yoloMode: undefined` see `ask` stay `ask`, and so a fresh
 * session doesn't silently auto-approve dangerous ops before the user has
 * opted into a mode.
 */
export function isAutoApproveMode(
  config?: PermissionSystemExtensionConfig,
): boolean {
  if (modeExplicitlySet) {
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
  modeExplicitlySet = true;
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
