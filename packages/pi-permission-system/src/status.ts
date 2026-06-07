import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  EXTENSION_ID,
  type PermissionSystemExtensionConfig,
} from "./extension-config";
import { getCurrentMode, isYoloModeEnabled } from "./yolo-mode";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;

type PermissionStatusContext =
  | Pick<ExtensionContext, "hasUI" | "ui">
  | Pick<ExtensionCommandContext, "ui">;

export function getPermissionSystemStatus(
  config: PermissionSystemExtensionConfig,
  ctx?: PermissionStatusContext,
): string | undefined {
  const mode = getCurrentMode();
  if (mode === "yolo" || isYoloModeEnabled(config)) {
    return "YOLO";
  }
  // Use theme accent color for GATED when UI context is available
  if (ctx?.ui?.theme) {
    return ctx.ui.theme.fg("accent", "GATED");
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
