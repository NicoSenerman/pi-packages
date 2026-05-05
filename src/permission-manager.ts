import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import {
  extractFrontmatter,
  isPermissionState,
  parseSimpleYamlMap,
  toRecord,
} from "./common";
import {
  loadUnifiedConfig,
  normalizeUnifiedConfig,
  stripJsonComments,
} from "./config-loader";
import { getGlobalConfigPath } from "./config-paths";
import { normalizeInput } from "./input-normalizer";
import { normalizeFlatConfig } from "./normalize";
import type { Rule, RuleOrigin, Ruleset } from "./rule";
import { evaluate, evaluateFirst } from "./rule";
import {
  composeRuleset,
  synthesizeBaseline,
  synthesizeDefaults,
} from "./synthesize";
import type {
  FlatPermissionConfig,
  PermissionCheckResult,
  PermissionState,
  ScopeConfig,
} from "./types";

function defaultGlobalConfigPath(): string {
  return getGlobalConfigPath(getAgentDir());
}
function defaultAgentsDir(): string {
  return join(getAgentDir(), "agents");
}
function defaultGlobalMcpConfigPath(): string {
  return join(getAgentDir(), "mcp.json");
}

const BUILT_IN_TOOL_PERMISSION_NAMES = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
]);
const SPECIAL_PERMISSION_KEYS = new Set(["external_directory"]);

/** Universal fallback when permission["*"] is absent from all scopes. */
const DEFAULT_UNIVERSAL_FALLBACK: PermissionState = "ask";

/**
 * Deep-shallow merge two flat permission configs.
 * Both objects → shallow-merge the pattern maps.
 * Otherwise → override replaces base.
 */
function mergeFlatPermissions(
  base: FlatPermissionConfig,
  override: FlatPermissionConfig,
): FlatPermissionConfig {
  const merged: FlatPermissionConfig = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseVal = merged[key];
    if (
      typeof baseVal === "object" &&
      baseVal !== null &&
      typeof value === "object" &&
      value !== null
    ) {
      merged[key] = {
        ...(baseVal as Record<string, PermissionState>),
        ...(value as Record<string, PermissionState>),
      };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function readConfiguredMcpServerNamesFromConfigPath(
  configPath: string,
): string[] {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    const root = toRecord(parsed);
    const serverRecord = toRecord(root.mcpServers ?? root["mcp-servers"]);

    return Object.keys(serverRecord)
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

function getConfiguredMcpServerNamesFromPaths(
  paths: readonly string[],
): string[] {
  const seen = new Set<string>();

  for (const path of paths) {
    for (const name of readConfiguredMcpServerNamesFromConfigPath(path)) {
      seen.add(name);
    }
  }

  return [...seen].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

export interface ResolvedPolicyPaths {
  globalConfigPath: string;
  globalConfigExists: boolean;
  projectConfigPath: string | null;
  projectConfigExists: boolean;
  agentsDir: string;
  agentsDirExists: boolean;
  projectAgentsDir: string | null;
  projectAgentsDirExists: boolean;
}

type ResolvedPermissions = {
  /**
   * Fully composed ruleset: synthesized defaults → baseline → config.
   * Session rules are appended at call-time inside checkPermission().
   */
  composedRules: Ruleset;
};

type FileCacheEntry<TValue> = {
  stamp: string;
  value: TValue;
};

function getFileStamp(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "missing";
  }
}

export class PermissionManager {
  private readonly globalConfigPath: string;
  private readonly agentsDir: string;
  private readonly projectGlobalConfigPath: string | null;
  private readonly projectAgentsDir: string | null;
  private readonly globalMcpConfigPath: string;
  private readonly configuredMcpServerNamesOverride: readonly string[] | null;
  private globalConfigCache: FileCacheEntry<ScopeConfig> | null = null;
  private projectGlobalConfigCache: FileCacheEntry<ScopeConfig> | null = null;
  private readonly agentConfigCache = new Map<
    string,
    FileCacheEntry<ScopeConfig>
  >();
  private readonly projectAgentConfigCache = new Map<
    string,
    FileCacheEntry<ScopeConfig>
  >();
  private readonly resolvedPermissionsCache = new Map<
    string,
    FileCacheEntry<ResolvedPermissions>
  >();
  private configuredMcpServerNamesCache: FileCacheEntry<
    readonly string[]
  > | null = null;
  private accumulatedConfigIssues: string[] = [];

  constructor(
    options: {
      globalConfigPath?: string;
      agentsDir?: string;
      projectGlobalConfigPath?: string;
      projectAgentsDir?: string;
      globalMcpConfigPath?: string;
      mcpServerNames?: readonly string[];
    } = {},
  ) {
    this.globalConfigPath =
      options.globalConfigPath || defaultGlobalConfigPath();
    this.agentsDir = options.agentsDir || defaultAgentsDir();
    this.projectGlobalConfigPath = options.projectGlobalConfigPath || null;
    this.projectAgentsDir = options.projectAgentsDir || null;
    this.globalMcpConfigPath =
      options.globalMcpConfigPath || defaultGlobalMcpConfigPath();
    this.configuredMcpServerNamesOverride = options.mcpServerNames
      ? [
          ...new Set(
            options.mcpServerNames
              .map((name) => name.trim())
              .filter((name) => name.length > 0),
          ),
        ]
      : null;
  }

  private accumulateConfigIssues(issues: string[]): void {
    for (const issue of issues) {
      if (!this.accumulatedConfigIssues.includes(issue)) {
        this.accumulatedConfigIssues.push(issue);
      }
    }
  }

  getConfigIssues(agentName?: string): string[] {
    // Trigger a load/resolve to ensure issues are collected.
    this.resolvePermissions(agentName);
    return [...this.accumulatedConfigIssues];
  }

  private loadGlobalConfig(): ScopeConfig {
    const stamp = getFileStamp(this.globalConfigPath);
    if (this.globalConfigCache?.stamp === stamp) {
      return this.globalConfigCache.value;
    }

    const { config, issues } = loadUnifiedConfig(this.globalConfigPath);
    this.accumulateConfigIssues(issues);

    const value: ScopeConfig = {
      permission: config.permission,
    };

    this.globalConfigCache = { stamp, value };
    return value;
  }

  private loadProjectGlobalConfig(): ScopeConfig {
    if (!this.projectGlobalConfigPath) {
      return {};
    }

    const stamp = getFileStamp(this.projectGlobalConfigPath);
    if (this.projectGlobalConfigCache?.stamp === stamp) {
      return this.projectGlobalConfigCache.value;
    }

    const { config, issues } = loadUnifiedConfig(this.projectGlobalConfigPath);
    this.accumulateConfigIssues(issues);

    const value: ScopeConfig = {
      permission: config.permission,
    };

    this.projectGlobalConfigCache = { stamp, value };
    return value;
  }

  private loadScopeConfigFrom(
    dir: string | null,
    cache: Map<string, FileCacheEntry<ScopeConfig>>,
    agentName?: string,
  ): ScopeConfig {
    if (!dir || !agentName) {
      return {};
    }

    const filePath = join(dir, `${agentName}.md`);
    const stamp = getFileStamp(filePath);
    const cached = cache.get(agentName);
    if (cached?.stamp === stamp) {
      return cached.value;
    }

    let value: ScopeConfig;
    try {
      const markdown = readFileSync(filePath, "utf-8");
      const frontmatter = extractFrontmatter(markdown);
      if (!frontmatter) {
        value = {};
      } else {
        const parsed = parseSimpleYamlMap(frontmatter);
        // Re-use the config-loader normalizer so the flat permission shape
        // is validated the same way as on-disk config files.
        const { config, issues } = normalizeUnifiedConfig(parsed);
        this.accumulateConfigIssues(issues);
        value = { permission: config.permission };
      }
    } catch {
      value = {};
    }

    cache.set(agentName, { stamp, value });
    return value;
  }

  private loadScopeConfig(agentName?: string): ScopeConfig {
    return this.loadScopeConfigFrom(
      this.agentsDir,
      this.agentConfigCache,
      agentName,
    );
  }

  private loadProjectScopeConfig(agentName?: string): ScopeConfig {
    return this.loadScopeConfigFrom(
      this.projectAgentsDir,
      this.projectAgentConfigCache,
      agentName,
    );
  }

  getResolvedPolicyPaths(): ResolvedPolicyPaths {
    return {
      globalConfigPath: this.globalConfigPath,
      globalConfigExists: existsSync(this.globalConfigPath),
      projectConfigPath: this.projectGlobalConfigPath,
      projectConfigExists: this.projectGlobalConfigPath
        ? existsSync(this.projectGlobalConfigPath)
        : false,
      agentsDir: this.agentsDir,
      agentsDirExists: existsSync(this.agentsDir),
      projectAgentsDir: this.projectAgentsDir,
      projectAgentsDirExists: this.projectAgentsDir
        ? existsSync(this.projectAgentsDir)
        : false,
    };
  }

  getPolicyCacheStamp(agentName?: string): string {
    const agentStamp = agentName
      ? getFileStamp(join(this.agentsDir, `${agentName}.md`))
      : "missing";
    const projectStamp = this.projectGlobalConfigPath
      ? getFileStamp(this.projectGlobalConfigPath)
      : "none";
    const projectAgentStamp =
      this.projectAgentsDir && agentName
        ? getFileStamp(join(this.projectAgentsDir, `${agentName}.md`))
        : "none";

    return `${getFileStamp(this.globalConfigPath)}|${projectStamp}|${agentStamp}|${projectAgentStamp}`;
  }

  private resolvePermissions(agentName?: string): ResolvedPermissions {
    const cacheKey = agentName || "__global__";
    const stamp = this.getPolicyCacheStamp(agentName);
    const cached = this.resolvedPermissionsCache.get(cacheKey);
    if (cached?.stamp === stamp) {
      return cached.value;
    }

    const globalConfig = this.loadGlobalConfig();
    const projectConfig = this.loadProjectGlobalConfig();
    const agentConfig = this.loadScopeConfig(agentName);
    const projectAgentConfig = this.loadProjectScopeConfig(agentName);

    // Merge permission objects across scopes (lowest → highest precedence).
    // Build a parallel origin map that tracks which scope contributed each
    // (surface, pattern) entry, mirroring mergeFlatPermissions() semantics.
    type OriginMap = Map<string, Map<string, RuleOrigin>>;
    const origins: OriginMap = new Map();
    let mergedPermission: FlatPermissionConfig = {};

    for (const [scopeName, scope] of [
      ["global", globalConfig],
      ["project", projectConfig],
      ["agent", agentConfig],
      ["project-agent", projectAgentConfig],
    ] as const) {
      if (!scope.permission) continue;

      for (const [surface, value] of Object.entries(scope.permission)) {
        const baseVal = mergedPermission[surface];
        const bothObjects =
          typeof baseVal === "object" &&
          baseVal !== null &&
          typeof value === "object" &&
          value !== null;

        if (bothObjects) {
          // Shallow-merge: each incoming pattern is attributed to this scope;
          // existing patterns from lower scopes keep their earlier origin.
          if (!origins.has(surface)) origins.set(surface, new Map());
          for (const pattern of Object.keys(value as Record<string, unknown>)) {
            origins.get(surface)!.set(pattern, scopeName);
          }
        } else {
          // Full replacement: this scope takes over the entire surface entry.
          const surfaceOrigins = new Map<string, RuleOrigin>();
          if (typeof value === "string") {
            surfaceOrigins.set("*", scopeName);
          } else if (typeof value === "object" && value !== null) {
            for (const pattern of Object.keys(
              value as Record<string, unknown>,
            )) {
              surfaceOrigins.set(pattern, scopeName);
            }
          }
          origins.set(surface, surfaceOrigins);
        }
      }

      mergedPermission = mergeFlatPermissions(
        mergedPermission,
        scope.permission,
      );
    }

    // Extract the universal fallback from permission["*"].
    // The "*" key feeds synthesizeDefaults() only — it is NOT included as a
    // config rule so that extension tools fall through to source:"default".
    const universalFallback = isPermissionState(mergedPermission["*"])
      ? (mergedPermission["*"] as PermissionState)
      : DEFAULT_UNIVERSAL_FALLBACK;
    // Track which scope contributed the universal fallback, if any.
    const universalFallbackOrigin: RuleOrigin | undefined = origins
      .get("*")
      ?.get("*");

    // Build config rules from everything except the universal "*" key.
    const permissionWithoutUniversal: FlatPermissionConfig = Object.fromEntries(
      Object.entries(mergedPermission).filter(([k]) => k !== "*"),
    );

    // Normalize to config rules, tagged with "config" layer and their origin.
    const configRules: Ruleset = normalizeFlatConfig(
      permissionWithoutUniversal,
    ).map(
      (r): Rule => ({
        ...r,
        layer: "config",
        origin: origins.get(r.surface)?.get(r.pattern),
      }),
    );

    const composedRules = composeRuleset(
      synthesizeDefaults(universalFallback, universalFallbackOrigin),
      synthesizeBaseline(configRules),
      configRules,
    );

    const value: ResolvedPermissions = { composedRules };
    this.resolvedPermissionsCache.set(cacheKey, { stamp, value });
    return value;
  }

  private getConfiguredMcpServerNames(): readonly string[] {
    if (this.configuredMcpServerNamesOverride) {
      return this.configuredMcpServerNamesOverride;
    }

    const paths = [this.globalMcpConfigPath];
    const stamp = paths
      .map((path) => `${path}:${getFileStamp(path)}`)
      .join("|");
    if (this.configuredMcpServerNamesCache?.stamp === stamp) {
      return this.configuredMcpServerNamesCache.value;
    }

    const value = getConfiguredMcpServerNamesFromPaths(paths);
    this.configuredMcpServerNamesCache = { stamp, value };
    return value;
  }

  /**
   * Get the tool-level permission state for a tool, without considering
   * command-level rules. Used for tool injection decisions.
   */
  getToolPermission(toolName: string, agentName?: string): PermissionState {
    const { composedRules } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();

    // Special surfaces (external_directory): evaluate directly by surface name.
    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      return evaluate(normalizedToolName, "*", composedRules).action;
    }

    // Bash, MCP, skill: evaluate with "*" value — the per-surface catch-all
    // (or universal default) handles this correctly.
    if (normalizedToolName === "bash") {
      return evaluate("bash", "*", composedRules).action;
    }
    if (normalizedToolName === "mcp") {
      return evaluate("mcp", "*", composedRules).action;
    }
    if (normalizedToolName === "skill") {
      return evaluate("skill", "*", composedRules).action;
    }

    // Tool-name surfaces (read, write, etc. and extension tools).
    return evaluate(normalizedToolName, "*", composedRules).action;
  }

  checkPermission(
    toolName: string,
    input: unknown,
    agentName?: string,
    sessionRules?: Ruleset,
  ): PermissionCheckResult {
    const { composedRules } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();

    // Append session rules at the end (highest priority) so evaluate() handles
    // them via last-match-wins — no separate per-branch pre-check needed.
    const fullRules: Ruleset = sessionRules?.length
      ? [...composedRules, ...sessionRules]
      : composedRules;

    const { surface, values, resultExtras } = normalizeInput(
      normalizedToolName,
      input,
      this.getConfiguredMcpServerNames(),
    );

    const { rule, value } = evaluateFirst(surface, values, fullRules);

    // For MCP, replace the normalizer's fallback target with the actual
    // matched candidate value so PermissionCheckResult.target is accurate.
    const extras =
      surface === "mcp" ? { ...resultExtras, target: value } : resultExtras;

    return {
      toolName,
      state: rule.action,
      matchedPattern:
        rule.layer === "config" || rule.layer === "session"
          ? rule.pattern
          : undefined,
      source: deriveSource(rule, normalizedToolName),
      origin: rule.origin,
      ...extras,
    };
  }
}

/**
 * Map a matched rule + tool name to the correct PermissionCheckResult.source.
 *
 * Mirrors the source-derivation logic from the former per-branch
 * checkPermission() implementation:
 *
 * - session          → "session" (always, all surfaces)
 * - mcp + default    → "default"
 * - mcp + other      → "mcp"
 * - special          → "special" (always)
 * - skill            → "skill" (always)
 * - bash             → "bash" (always)
 * - built-in tool    → "tool" (always)
 * - extension tool   → "default" when default layer, "tool" otherwise
 */
function deriveSource(
  rule: Rule,
  toolName: string,
): PermissionCheckResult["source"] {
  if (rule.layer === "session") return "session";

  if (toolName === "mcp") {
    if (rule.layer === "default") return "default";
    return "mcp";
  }

  if (SPECIAL_PERMISSION_KEYS.has(toolName)) return "special";
  if (toolName === "skill") return "skill";
  if (toolName === "bash") return "bash";

  // Built-in tools always report "tool"; extension tools distinguish default.
  if (BUILT_IN_TOOL_PERMISSION_NAMES.has(toolName)) return "tool";
  return rule.layer === "default" ? "default" : "tool";
}

// Keep isPermissionState and toRecord available for convenience — they are
// used directly in some handler files that import from permission-manager.
export { isPermissionState, toRecord };
