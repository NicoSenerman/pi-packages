import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionSystemExtensionConfig } from "./extension-config";
import { syncPermissionSystemStatus } from "./status";
import type { PermissionState } from "./types";

export interface AskPermissionResolutionOptions {
  config: PermissionSystemExtensionConfig;
  hasUI: boolean;
  isSubagent: boolean;
}

// ── Session-scoped runtime yolo state ──────────────────────────────────
// Config-file yoloMode is shared across all Pi sessions (same config.json).
// Runtime yolo is an in-memory flag that is per-session, allowing each Pi
// window to independently toggle yolo mode without affecting others.

let runtimeYoloMode = true;

export function setRuntimeYoloMode(value: boolean): void {
  runtimeYoloMode = value;
}

export function getRuntimeYoloMode(): boolean {
  return runtimeYoloMode;
}

export function isYoloModeEnabled(
  config: PermissionSystemExtensionConfig,
): boolean {
  // Runtime flag takes precedence; falls back to config-file setting.
  return runtimeYoloMode || Boolean(config.yoloMode);
}

export function shouldAutoApprovePermissionState(
  state: PermissionState,
  config: PermissionSystemExtensionConfig,
): boolean {
  return state === "ask" && isYoloModeEnabled(config);
}

export function canResolveAskPermissionRequest(
  options: AskPermissionResolutionOptions,
): boolean {
  return (
    options.hasUI || options.isSubagent || isYoloModeEnabled(options.config)
  );
}

// ── Toggle helper (used by /mode command and shortcut) ─────────────────

export type Mode = "yolo" | "plan";

let currentMode: Mode = "yolo";

export function getCurrentMode(): Mode {
  return currentMode;
}

export function setCurrentMode(
  mode: Mode,
  ctx: ExtensionContext,
  config: PermissionSystemExtensionConfig,
): void {
  currentMode = mode;
  runtimeYoloMode = mode === "yolo";
  syncPermissionSystemStatus(ctx, { ...config, yoloMode: runtimeYoloMode });
}
