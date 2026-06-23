import type { ScopedPermissionManager } from "./permission-manager";
import type { Rule } from "./rule";
import type { SessionRules } from "./session-rules";
import type { PermissionCheckResult, PermissionState } from "./types";

/**
 * Resolves the effective permission for a surface/input, applying the current
 * session rules internally.
 *
 * Collapses the `checkPermission` + `getSessionRuleset` relay that every gate
 * previously threaded by hand: the ruleset was only ever fetched to be passed
 * straight back into `checkPermission`, so the two are one operation.
 */
export interface ScopedPermissionResolver {
  resolve(
    surface: string,
    input: unknown,
    agentName?: string,
  ): PermissionCheckResult;
  /**
   * Resolve a path-shaped surface against a caller-supplied set of equivalent
   * policy values, applying the current session rules. Used by the bash path
   * gate (`path`) and the external-directory gates (`external_directory`),
   * which compute equivalent path aliases per token. `surface` defaults to
   * `path`.
   */
  resolvePathPolicy(
    values: readonly string[],
    agentName?: string,
    surface?: string,
  ): PermissionCheckResult;
}

/**
 * Concrete collaborator that owns the resolution surface.
 *
 * Holds a `ScopedPermissionManager` and a `SessionRules` store, composing
 * them so callers never thread the session ruleset by hand.
 *
 * Constructor deps:
 * - `permissionManager` — the narrow session-scoped permission-checking interface
 * - `sessionRules` — narrowed to `getRuleset` (ISP: the resolver only reads, never records)
 */
export class PermissionResolver implements ScopedPermissionResolver {
  constructor(
    private readonly permissionManager: ScopedPermissionManager,
    private readonly sessionRules: Pick<SessionRules, "getRuleset">,
  ) {}

  /**
   * Resolve the effective permission for a surface/input, applying the current
   * session rules. Composes `checkPermission` with `getRuleset()` so callers
   * never thread the ruleset by hand.
   */
  resolve(
    surface: string,
    input: unknown,
    agentName?: string,
  ): PermissionCheckResult {
    return this.checkPermission(
      surface,
      input,
      agentName,
      this.sessionRules.getRuleset(),
    );
  }

  /**
   * Resolve a path-shaped surface (`path` or `external_directory`) for
   * precomputed policy values, composing the current session ruleset so callers
   * never thread it by hand. `surface` defaults to `path`; the external-directory
   * gates pass `external_directory` so a path's typed and symlink-resolved
   * aliases match against the `external_directory` rules.
   */
  resolvePathPolicy(
    values: readonly string[],
    agentName?: string,
    surface = "path",
  ): PermissionCheckResult {
    return this.permissionManager.checkPathPolicy(
      values,
      agentName,
      this.sessionRules.getRuleset(),
      surface,
    );
  }

  checkPermission(
    surface: string,
    input: unknown,
    agentName?: string,
    sessionRules?: Rule[],
  ): PermissionCheckResult {
    return this.permissionManager.checkPermission(
      surface,
      input,
      agentName,
      sessionRules,
    );
  }

  getToolPermission(toolName: string, agentName?: string): PermissionState {
    return this.permissionManager.getToolPermission(toolName, agentName);
  }

  getConfigIssues(agentName?: string): string[] {
    return this.permissionManager.getConfigIssues(agentName);
  }
}
