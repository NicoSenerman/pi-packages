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

let currentMode: Mode = "bach";

export function getCurrentMode(): Mode {
  return currentMode;
}

export function isBachMode(): boolean {
  return currentMode === "bach";
}

/** Whether the current mode auto-approves permission requests. */
export function isAutoApproveMode(): boolean {
  // YOLO and BACH auto-approve; GATED does not.
  // currentMode is the single source of truth — config.yoloMode is ignored
  // when the user has explicitly chosen a mode via /mode or the shortcut.
  return currentMode !== "gated";
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
  _config: PermissionSystemExtensionConfig,
): boolean {
  return state === "ask" && isAutoApproveMode();
}

export function canResolveAskPermissionRequest(
  options: AskPermissionResolutionOptions,
): boolean {
  return options.hasUI || options.isSubagent || isAutoApproveMode();
}
