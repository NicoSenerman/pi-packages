import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The session surface `PermissionGateHandler` invokes directly: bind the
 * per-event context and identify the agent.
 *
 * This is the two-method context role both entry points share after [#329]
 * extracted `SkillInputGatePipeline` to own the skill-input gate assembly.
 */
export interface GateHandlerSession {
  activate(ctx: ExtensionContext): void;
  resolveAgentName(ctx: ExtensionContext): string | null;
}
