import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  EXTENSION_ID,
  type PermissionSystemExtensionConfig,
} from "./extension-config";
import { getCurrentMode, isExplicitMode, isYoloModeEnabled } from "./yolo-mode";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;
export const PERMISSION_SYSTEM_YOLO_STATUS_VALUE = "yolo";

type PermissionStatusContext =
  | Pick<ExtensionContext, "hasUI" | "ui">
  | Pick<ExtensionCommandContext, "ui">;

export function getPermissionSystemStatus(
  config: PermissionSystemExtensionConfig,
  ctx?: PermissionStatusContext,
): string | undefined {
  // Effective mode to display. When the user has explicitly picked a mode via
  // /mode or the shortcut, show that. Otherwise: if config.yoloMode is on
  // (upstream's enable flag) show "yolo"; else default to BACH so a fresh
  // session shows the BACH label + prompt + gate out of the box.
  const effectiveMode = isExplicitMode()
    ? getCurrentMode()
    : isYoloModeEnabled(config)
      ? "yolo"
      : "bach";
  if (effectiveMode === "bach") {
    if (ctx?.ui?.theme) {
      return ctx.ui.theme.fg("syntaxType", "BACH");
    }
    return "BACH";
  }
  if (effectiveMode === "yolo") {
    if (ctx?.ui?.theme) {
      return ctx.ui.theme.fg("success", "YOLO");
    }
    return "YOLO";
  }
  // GATED
  if (ctx?.ui?.theme) {
    return ctx.ui.theme.fg("mdCode", "GATED");
  }
  return "GATED";
}

export function syncPermissionSystemStatus(
  ctx: PermissionStatusContext,
  config: PermissionSystemExtensionConfig,
): void {
  ctx.ui.setStatus(
    PERMISSION_SYSTEM_STATUS_KEY,
    getPermissionSystemStatus(config, ctx),
  );
}
