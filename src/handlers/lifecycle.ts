import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { getActiveAgentName } from "../active-agent";
import { PERMISSION_SYSTEM_STATUS_KEY } from "../status";
import type { HandlerDeps } from "./types";

/** Minimal subset of SessionStartEvent used by this handler. */
interface SessionStartPayload {
  reason: string;
}

/** Minimal subset of ResourcesDiscoverEvent used by this handler. */
interface ResourcesDiscoverPayload {
  reason: string;
}

export async function handleSessionStart(
  deps: HandlerDeps,
  event: SessionStartPayload,
  ctx: ExtensionContext,
): Promise<void> {
  deps.session.runtimeContext = ctx;
  deps.refreshExtensionConfig(ctx);
  deps.session.permissionManager = deps.createPermissionManagerForCwd(ctx.cwd);
  deps.session.activeSkillEntries = [];
  deps.session.lastActiveToolsCacheKey = null;
  deps.session.lastPromptStateCacheKey = null;
  deps.session.lastKnownActiveAgentName = getActiveAgentName(ctx);
  deps.startForwardedPermissionPolling(ctx);
  deps.logResolvedConfigPaths();

  const agentName = deps.session.lastKnownActiveAgentName;
  const policyIssues =
    deps.session.permissionManager.getConfigIssues(agentName);
  for (const issue of policyIssues) {
    deps.logger.warn(issue);
  }

  if (event.reason === "reload") {
    deps.logger.debug("lifecycle.reload", {
      triggeredBy: "session_start",
      reason: event.reason,
      cwd: ctx.cwd,
    });
  }
}

export async function handleResourcesDiscover(
  deps: HandlerDeps,
  event: ResourcesDiscoverPayload,
): Promise<void> {
  if (event.reason !== "reload") {
    return;
  }

  const { runtimeContext } = deps.session;
  deps.session.permissionManager = deps.createPermissionManagerForCwd(
    runtimeContext?.cwd,
  );
  deps.session.activeSkillEntries = [];
  deps.session.lastActiveToolsCacheKey = null;
  deps.session.lastPromptStateCacheKey = null;
  deps.logger.debug("lifecycle.reload", {
    triggeredBy: "resources_discover",
    reason: event.reason,
    cwd: runtimeContext?.cwd ?? null,
  });
}

export async function handleSessionShutdown(deps: HandlerDeps): Promise<void> {
  const { runtimeContext } = deps.session;
  if (runtimeContext) {
    runtimeContext.ui.setStatus(PERMISSION_SYSTEM_STATUS_KEY, undefined);
  }
  deps.session.runtimeContext = null;
  deps.session.activeSkillEntries = [];
  deps.session.lastActiveToolsCacheKey = null;
  deps.session.lastPromptStateCacheKey = null;
  deps.session.sessionRules.clear();
  deps.stopForwardedPermissionPolling();
  deps.stopPermissionRpcHandlers();
}
