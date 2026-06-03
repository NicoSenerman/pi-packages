import { buildInputForSurface } from "./input-normalizer";
import type { PermissionManager } from "./permission-manager";
import type { PermissionsService } from "./service";
import type { SessionRules } from "./session-rules";
import type {
  ToolInputFormatter,
  ToolInputFormatterRegistry,
} from "./tool-input-formatter-registry";

/**
 * In-process implementation of the cross-extension {@link PermissionsService}.
 *
 * Constructed once in the composition root and backed by the runtime's
 * permission manager and session rules. Both injected instances are stable
 * for the lifetime of the factory — `runtime.permissionManager` is never
 * reassigned on the runtime object (only `PermissionSession` reassigns its
 * own internal copy), and `runtime.sessionRules` is `readonly`.
 */
export class LocalPermissionsService implements PermissionsService {
  constructor(
    private readonly permissionManager: PermissionManager,
    private readonly sessionRules: SessionRules,
    private readonly formatterRegistry: ToolInputFormatterRegistry,
  ) {}

  checkPermission(
    surface: string,
    value?: string,
    agentName?: string,
  ): ReturnType<PermissionsService["checkPermission"]> {
    const input = buildInputForSurface(surface, value);
    return this.permissionManager.checkPermission(
      surface,
      input,
      agentName,
      this.sessionRules.getRuleset(),
    );
  }

  getToolPermission(
    toolName: string,
    agentName?: string,
  ): ReturnType<PermissionsService["getToolPermission"]> {
    return this.permissionManager.getToolPermission(toolName, agentName);
  }

  registerToolInputFormatter(
    toolName: string,
    formatter: ToolInputFormatter,
  ): ReturnType<PermissionsService["registerToolInputFormatter"]> {
    return this.formatterRegistry.register(toolName, formatter);
  }
}
