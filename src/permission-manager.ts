import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import {
  extractFrontmatter,
  getNonEmptyString,
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
import { normalizeFlatConfig } from "./normalize";
import type { Rule, Ruleset } from "./rule";
import { evaluate } from "./rule";
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
    let mergedPermission: FlatPermissionConfig = {};
    for (const scope of [
      globalConfig,
      projectConfig,
      agentConfig,
      projectAgentConfig,
    ]) {
      if (scope.permission) {
        mergedPermission = mergeFlatPermissions(
          mergedPermission,
          scope.permission,
        );
      }
    }

    // Extract the universal fallback from permission["*"].
    // The "*" key feeds synthesizeDefaults() only — it is NOT included as a
    // config rule so that extension tools fall through to source:"default".
    const universalFallback = isPermissionState(mergedPermission["*"])
      ? (mergedPermission["*"] as PermissionState)
      : DEFAULT_UNIVERSAL_FALLBACK;

    // Build config rules from everything except the universal "*" key.
    const permissionWithoutUniversal: FlatPermissionConfig = Object.fromEntries(
      Object.entries(mergedPermission).filter(([k]) => k !== "*"),
    );

    // Normalize to config rules, tagged with "config" layer.
    const configRules: Ruleset = normalizeFlatConfig(
      permissionWithoutUniversal,
    ).map((r): Rule => ({ ...r, layer: "config" }));

    const composedRules = composeRuleset(
      synthesizeDefaults(universalFallback),
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

    // --- Special surfaces (external_directory) ---
    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      const record = toRecord(input);
      const pathValue = typeof record.path === "string" ? record.path : null;

      // Session check: match by specific normalized path.
      if (pathValue && sessionRules && sessionRules.length > 0) {
        const sessionRule = evaluate(
          "external_directory",
          pathValue,
          sessionRules,
        );
        if (sessionRules.includes(sessionRule)) {
          return {
            toolName,
            state: "allow",
            matchedPattern: sessionRule.pattern,
            source: "session",
          };
        }
      }

      // Config/default check.
      const rule = evaluate(
        normalizedToolName,
        pathValue ?? "*",
        composedRules,
      );
      return {
        toolName,
        state: rule.action,
        matchedPattern: rule.layer === "config" ? rule.pattern : undefined,
        source: "special",
      };
    }

    // --- Skills ---
    if (normalizedToolName === "skill") {
      const skillName = toRecord(input).name;
      const lookupValue = typeof skillName === "string" ? skillName : "*";

      // Session check.
      if (sessionRules && sessionRules.length > 0) {
        const sessionRule = evaluate("skill", lookupValue, sessionRules);
        if (sessionRules.includes(sessionRule)) {
          return {
            toolName,
            state: "allow",
            matchedPattern: sessionRule.pattern,
            source: "session",
          };
        }
      }

      const rule = evaluate("skill", lookupValue, composedRules);
      return {
        toolName,
        state: rule.action,
        matchedPattern: rule.layer === "config" ? rule.pattern : undefined,
        source: "skill",
      };
    }

    // --- Bash ---
    if (normalizedToolName === "bash") {
      const record = toRecord(input);
      const command = typeof record.command === "string" ? record.command : "";

      // Session check.
      if (sessionRules && sessionRules.length > 0) {
        const sessionRule = evaluate("bash", command, sessionRules);
        if (sessionRules.includes(sessionRule)) {
          return {
            toolName,
            state: "allow",
            command,
            matchedPattern: sessionRule.pattern,
            source: "session",
          };
        }
      }

      const rule = evaluate("bash", command, composedRules);
      return {
        toolName,
        state: rule.action,
        command,
        matchedPattern: rule.layer === "config" ? rule.pattern : undefined,
        source: "bash",
      };
    }

    // --- MCP ---
    if (normalizedToolName === "mcp") {
      const mcpTargets = [
        ...createMcpPermissionTargets(
          input,
          this.getConfiguredMcpServerNames(),
        ),
        "mcp",
      ];
      const fallbackTarget = mcpTargets[0] || "mcp";

      // Session check: try each candidate target against session rules.
      if (sessionRules && sessionRules.length > 0) {
        for (const target of mcpTargets) {
          const sessionRule = evaluate("mcp", target, sessionRules);
          if (sessionRules.includes(sessionRule)) {
            return {
              toolName,
              state: "allow",
              matchedPattern: sessionRule.pattern,
              target,
              source: "session",
            };
          }
        }
      }

      // Try each candidate target. Stop on the first non-default match.
      for (const target of mcpTargets) {
        const rule = evaluate("mcp", target, composedRules);
        if (rule.layer !== "default") {
          return {
            toolName,
            state: rule.action,
            matchedPattern: rule.layer === "config" ? rule.pattern : undefined,
            target,
            source: rule.layer === "override" ? "tool" : "mcp",
          };
        }
      }

      // All targets matched only the synthesized default.
      const defaultRule = evaluate("mcp", fallbackTarget, composedRules);
      return {
        toolName,
        state: defaultRule.action,
        target: fallbackTarget,
        source: "default",
      };
    }

    // --- Tools (read, write, edit, grep, find, ls, extension tools) ---

    // Session check.
    if (sessionRules && sessionRules.length > 0) {
      const sessionRule = evaluate(normalizedToolName, "*", sessionRules);
      if (sessionRules.includes(sessionRule)) {
        return {
          toolName,
          state: "allow",
          matchedPattern: sessionRule.pattern,
          source: "session",
        };
      }
    }

    const rule = evaluate(normalizedToolName, "*", composedRules);

    if (BUILT_IN_TOOL_PERMISSION_NAMES.has(normalizedToolName)) {
      return {
        toolName,
        state: rule.action,
        source: "tool",
      };
    }

    return {
      toolName,
      state: rule.action,
      source: rule.layer === "default" ? "default" : "tool",
    };
  }
}

// ---------------------------------------------------------------------------
// MCP target derivation helpers (unchanged)
// ---------------------------------------------------------------------------

function parseQualifiedMcpToolName(
  value: string,
): { server: string; tool: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex <= 0 || colonIndex >= trimmed.length - 1) {
    return null;
  }

  const server = trimmed.slice(0, colonIndex).trim();
  const tool = trimmed.slice(colonIndex + 1).trim();
  if (!server || !tool) {
    return null;
  }

  return { server, tool };
}

function addDerivedMcpServerTargets(
  toolName: string,
  configuredServerNames: readonly string[],
  pushTarget: (value: string | null) => void,
): void {
  const trimmedToolName = toolName.trim();
  if (!trimmedToolName) {
    return;
  }

  for (const serverName of configuredServerNames) {
    const trimmedServerName = serverName.trim();
    if (!trimmedServerName) {
      continue;
    }

    if (!trimmedToolName.endsWith(`_${trimmedServerName}`)) {
      continue;
    }

    if (trimmedToolName.startsWith(`${trimmedServerName}_`)) {
      continue;
    }

    pushTarget(`${trimmedServerName}_${trimmedToolName}`);
    pushTarget(`${trimmedServerName}:${trimmedToolName}`);
    pushTarget(trimmedServerName);
  }
}

function pushMcpToolPermissionTargets(
  rawReference: string,
  serverHint: string | null,
  configuredServerNames: readonly string[],
  pushTarget: (value: string | null) => void,
): void {
  const qualified = parseQualifiedMcpToolName(rawReference);
  const resolvedServer = serverHint ?? qualified?.server ?? null;
  const resolvedTool = qualified?.tool ?? rawReference;

  if (resolvedServer) {
    pushTarget(`${resolvedServer}_${resolvedTool}`);
    pushTarget(`${resolvedServer}:${resolvedTool}`);
    pushTarget(resolvedServer);
  } else {
    addDerivedMcpServerTargets(resolvedTool, configuredServerNames, pushTarget);
  }

  pushTarget(resolvedTool);
  pushTarget(rawReference);
}

function createMcpPermissionTargets(
  input: unknown,
  configuredServerNames: readonly string[] = [],
): string[] {
  const record = toRecord(input);
  const tool = getNonEmptyString(record.tool);
  const server = getNonEmptyString(record.server);
  const connect = getNonEmptyString(record.connect);
  const describe = getNonEmptyString(record.describe);
  const search = getNonEmptyString(record.search);

  const targets: string[] = [];
  const pushTarget = (value: string | null) => {
    if (!value) {
      return;
    }
    if (!targets.includes(value)) {
      targets.push(value);
    }
  };

  if (tool) {
    pushMcpToolPermissionTargets(
      tool,
      server,
      configuredServerNames,
      pushTarget,
    );
    pushTarget("mcp_call");
    return targets;
  }

  if (connect) {
    pushTarget(`mcp_connect_${connect}`);
    pushTarget(connect);
    pushTarget("mcp_connect");
    return targets;
  }

  if (describe) {
    pushMcpToolPermissionTargets(
      describe,
      server,
      configuredServerNames,
      pushTarget,
    );
    pushTarget("mcp_describe");
    return targets;
  }

  if (search) {
    if (server) {
      pushTarget(`mcp_server_${server}`);
      pushTarget(server);
    }

    pushTarget(search);
    pushTarget("mcp_search");
    return targets;
  }

  if (server) {
    pushTarget(`mcp_server_${server}`);
    pushTarget(server);
    pushTarget("mcp_list");
    return targets;
  }

  pushTarget("mcp_status");
  return targets;
}

// Keep isPermissionState and toRecord available for convenience — they are
// used directly in some handler files that import from permission-manager.
export { isPermissionState, toRecord };
