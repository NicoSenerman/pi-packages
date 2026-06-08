import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  EXTENSION_ID,
  type PermissionSystemExtensionConfig,
} from "./extension-config";
import { getCurrentMode } from "./yolo-mode";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;

type PermissionStatusContext =
  | Pick<ExtensionContext, "hasUI" | "ui">
  | Pick<ExtensionCommandContext, "ui">;

export function getPermissionSystemStatus(
  config: PermissionSystemExtensionConfig,
  ctx?: PermissionStatusContext,
): string | undefined {
  const mode = getCurrentMode();
  if (mode === "bach") {
    if (ctx?.ui?.theme) {
      return ctx.ui.theme.fg("syntaxType", "BACH");
    }
    return "BACH";
  }
  if (mode === "yolo") {
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
