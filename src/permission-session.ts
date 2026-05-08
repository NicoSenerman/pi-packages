import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  getActiveAgentName,
  getActiveAgentNameFromSystemPrompt,
} from "./active-agent";
import type { ExtensionPaths } from "./extension-paths";
import type { ForwardingController } from "./forwarding-manager";
import type { PermissionManager } from "./permission-manager";
import type { PermissionPrompterApi } from "./permission-prompter";
import type { Rule } from "./rule";
import { createPermissionManagerForCwd } from "./runtime";
import type { SessionLogger } from "./session-logger";
import { SessionRules } from "./session-rules";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer";
import type { PermissionCheckResult, PermissionState } from "./types";

/**
 * Encapsulates all mutable session state and exposes operations instead of
 * fields.
 *
 * Replaces the `SessionState` interface + scattered handler field mutations
 * with a single class that owns the `PermissionManager`, `SessionRules`,
 * cache keys, skill entries, and runtime context.
 *
 * Constructor takes 4 high-level deps:
 * - `ExtensionPaths` (immutable path constants)
 * - `SessionLogger` (debug + review + warn)
 * - `PermissionPrompterApi` (interactive permission prompting)
 * - `ForwardingController` (polling lifecycle)
 */
export class PermissionSession {
  private context: ExtensionContext | null = null;
  private permissionManager: PermissionManager;
  private readonly sessionRules = new SessionRules();
  private activeSkillEntries: SkillPromptEntry[] = [];
  private knownAgentName: string | null = null;
  private activeToolsCacheKey: string | null = null;
  private promptStateCacheKey: string | null = null;

  constructor(
    private readonly paths: ExtensionPaths,
    readonly logger: SessionLogger,
    private readonly prompter: PermissionPrompterApi,
    private readonly forwarding: ForwardingController,
  ) {
    this.permissionManager = createPermissionManagerForCwd(
      paths.agentDir,
      undefined,
    );
  }

  // ── Context lifecycle ──────────────────────────────────────────────────

  /** Store the current extension context and start forwarding. */
  activate(ctx: ExtensionContext): void {
    this.context = ctx;
    this.forwarding.start(ctx);
  }

  /** Clear the context and stop forwarding. */
  deactivate(): void {
    this.context = null;
    this.forwarding.stop();
  }

  // ── Permission checking (delegates to PermissionManager) ───────────────

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

  getPolicyCacheStamp(agentName?: string): string {
    return this.permissionManager.getPolicyCacheStamp(agentName);
  }

  // ── Session rules (delegates to SessionRules) ──────────────────────────

  getSessionRuleset(): Rule[] {
    return this.sessionRules.getRuleset();
  }

  approveSessionRule(surface: string, pattern: string): void {
    this.sessionRules.approve(surface, pattern);
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  /**
   * Reset all mutable state for a new session.
   *
   * Creates a fresh PermissionManager scoped to `ctx.cwd`, clears caches,
   * skill entries, and activates the new context. Replaces the 4-field
   * copy-paste reset previously scattered across lifecycle handlers.
   */
  resetForNewSession(ctx: ExtensionContext): void {
    this.permissionManager = createPermissionManagerForCwd(
      this.paths.agentDir,
      ctx.cwd,
    );
    this.activeSkillEntries = [];
    this.activeToolsCacheKey = null;
    this.promptStateCacheKey = null;
    this.activate(ctx);
  }

  /**
   * Shut down the session: clear rules, caches, skill entries, and
   * deactivate context + forwarding.
   */
  shutdown(): void {
    this.sessionRules.clear();
    this.activeSkillEntries = [];
    this.activeToolsCacheKey = null;
    this.promptStateCacheKey = null;
    this.deactivate();
  }

  // ── Agent-start caching ────────────────────────────────────────────────

  shouldUpdateActiveTools(cacheKey: string): boolean {
    return this.activeToolsCacheKey !== cacheKey;
  }

  commitActiveToolsCacheKey(cacheKey: string): void {
    this.activeToolsCacheKey = cacheKey;
  }

  shouldUpdatePromptState(cacheKey: string): boolean {
    return this.promptStateCacheKey !== cacheKey;
  }

  commitPromptStateCacheKey(cacheKey: string): void {
    this.promptStateCacheKey = cacheKey;
  }

  // ── Skill entries ──────────────────────────────────────────────────────

  getActiveSkillEntries(): SkillPromptEntry[] {
    return this.activeSkillEntries;
  }

  setActiveSkillEntries(entries: SkillPromptEntry[]): void {
    this.activeSkillEntries = entries;
  }

  // ── Agent name ─────────────────────────────────────────────────────────

  /**
   * Resolve the active agent name from the session context, system prompt,
   * or last known name. Updates lastKnownActiveAgentName as a side effect.
   */
  resolveAgentName(
    ctx: ExtensionContext,
    systemPrompt?: string,
  ): string | null {
    const fromSession = getActiveAgentName(ctx);
    if (fromSession) {
      this.knownAgentName = fromSession;
      return fromSession;
    }
    const fromSystemPrompt = getActiveAgentNameFromSystemPrompt(systemPrompt);
    if (fromSystemPrompt) {
      this.knownAgentName = fromSystemPrompt;
      return fromSystemPrompt;
    }
    return this.knownAgentName;
  }

  get lastKnownActiveAgentName(): string | null {
    return this.knownAgentName;
  }

  // ── Infrastructure paths ───────────────────────────────────────────────

  getInfrastructureDirs(): readonly string[] {
    return this.paths.piInfrastructureDirs;
  }
}
