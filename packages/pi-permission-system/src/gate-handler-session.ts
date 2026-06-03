import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PermissionCheckResult } from "./types";

/**
 * The session surface `PermissionGateHandler` invokes directly: bind the
 * per-event context, identify the agent, and (for the skill-input gate) run a
 * raw permission check and mint a request id.
 *
 * Transitional: [#329] (`SkillInputGatePipeline`) absorbs the skill-input
 * assembly, after which `checkPermission` + `createPermissionRequestId` leave
 * this role and it collapses to a two-method context role.
 */
export interface GateHandlerSession {
  activate(ctx: ExtensionContext): void;
  resolveAgentName(ctx: ExtensionContext): string | null;
  checkPermission(
    surface: string,
    input: unknown,
    agentName?: string,
  ): PermissionCheckResult;
  createPermissionRequestId(prefix: string): string;
}
