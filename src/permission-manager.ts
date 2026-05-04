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
import { loadUnifiedConfig, stripJsonComments } from "./config-loader";
import { getGlobalConfigPath } from "./config-paths";
import { mergeDefaults } from "./defaults";
import { normalizeConfig } from "./normalize";
import type { Ruleset } from "./rule";
import { evaluate } from "./rule";
import {
  composeRuleset,
  synthesizeBaseline,
  synthesizeDefaults,
  synthesizeOverrides,
} from "./synthesize";
import type {
  PermissionCheckResult,
  PermissionDefaultPolicy,
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
const DEFAULT_POLICY: PermissionDefaultPolicy = {
  tools: "ask",
  bash: "ask",
  mcp: "ask",
  skills: "ask",
  special: "ask",
};

function normalizePolicy(value: unknown): PermissionDefaultPolicy {
  const record = toRecord(value);
  return {
    tools: isPermissionState(record.tools)
      ? record.tools
      : DEFAULT_POLICY.tools,
    bash: isPermissionState(record.bash) ? record.bash : DEFAULT_POLICY.bash,
    mcp: isPermissionState(record.mcp) ? record.mcp : DEFAULT_POLICY.mcp,
    skills: isPermissionState(record.skills)
      ? record.skills
      : DEFAULT_POLICY.skills,
    special: isPermissionState(record.special)
      ? record.special
      : DEFAULT_POLICY.special,
  };
}

function normalizePartialPolicy(
  value: unknown,
): Partial<PermissionDefaultPolicy> {
  const record = toRecord(value);
  const normalized: Partial<PermissionDefaultPolicy> = {};

  if (isPermissionState(record.tools)) {
    normalized.tools = record.tools;
  }

  if (isPermissionState(record.bash)) {
    normalized.bash = record.bash;
  }

  if (isPermissionState(record.mcp)) {
    normalized.mcp = record.mcp;
  }

  if (isPermissionState(record.skills)) {
    normalized.skills = record.skills;
  }

  if (isPermissionState(record.special)) {
    normalized.special = record.special;
  }

  return normalized;
}

function normalizePermissionRecord(
  value: unknown,
): Record<string, PermissionState> {
  const record = toRecord(value);
  const normalized: Record<string, PermissionState> = {};
  for (const [key, state] of Object.entries(record)) {
    if (isPermissionState(state)) {
      normalized[key] = state;
    }
  }
  return normalized;
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

const DEPRECATED_SPECIAL_KEYS: ReadonlySet<string> = new Set([
  "doom_loop",
  "tool_call_limit",
]);

export interface NormalizeResult {
  permissions: ScopeConfig;
  configIssues: string[];
}

export function normalizeRawPermission(raw: unknown): NormalizeResult {
  const record = toRecord(raw);
  const configIssues: string[] = [];
  const normalizedTools = normalizePermissionRecord(record.tools);

  const normalized: ScopeConfig = {
    defaultPolicy: normalizePartialPolicy(record.defaultPolicy),
    tools: normalizedTools,
    bash: normalizePermissionRecord(record.bash),
    mcp: normalizePermissionRecord(record.mcp),
    skills: normalizePermissionRecord(record.skills),
    special: normalizePermissionRecord(record.special),
  };

  // Detect deprecated keys in the raw special sub-object before discarding.
  const rawSpecial = toRecord(record.special);
  for (const key of DEPRECATED_SPECIAL_KEYS) {
    if (key in rawSpecial) {
      configIssues.push(
        `special.${key} is deprecated and ignored — remove it from your policy file.`,
      );
      // Ensure the key is stripped even if its value was a valid PermissionState.
      if (normalized.special) {
        delete normalized.special[key];
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (!isPermissionState(value)) {
      continue;
    }

    if (BUILT_IN_TOOL_PERMISSION_NAMES.has(key)) {
      normalized.tools = { ...(normalized.tools || {}), [key]: value };
      continue;
    }

    if (SPECIAL_PERMISSION_KEYS.has(key)) {
      normalized.special = { ...(normalized.special || {}), [key]: value };
    }
  }

  return { permissions: normalized, configIssues };
}

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
   * Fully composed ruleset: synthesized defaults → baseline → overrides → config.
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
      defaultPolicy: normalizePolicy(config.defaultPolicy),
      tools: config.tools || {},
      bash: config.bash || {},
      mcp: config.mcp || {},
      skills: config.skills || {},
      special: config.special || {},
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
      defaultPolicy: config.defaultPolicy,
      tools: config.tools,
      bash: config.bash,
      mcp: config.mcp,
      skills: config.skills,
      special: config.special,
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
        const result = normalizeRawPermission(parsed.permission);
        value = result.permissions;
        this.accumulateConfigIssues(result.configIssues);
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

    // Tag config rules with layer "config" so checkPermission() can derive
    // the result source and matchedPattern without positional arithmetic.
    const tagConfig = (r: import("./rule").Rule) => ({
      ...r,
      layer: "config" as const,
    });
    const configRules: Ruleset = [
      ...normalizeConfig(globalConfig).map(tagConfig),
      ...normalizeConfig(projectConfig).map(tagConfig),
      ...normalizeConfig(agentConfig).map(tagConfig),
      ...normalizeConfig(projectAgentConfig).map(tagConfig),
    ];

    // Merge defaultPolicy across scopes (shallow spread, same precedence).
    const defaults = mergeDefaults(
      globalConfig.defaultPolicy,
      projectConfig.defaultPolicy,
      agentConfig.defaultPolicy,
      projectAgentConfig.defaultPolicy,
    );

    // tools.bash / tools.mcp overrides: per-scope, lowest-priority first so
    // that later scopes win via last-match-wins in synthesizeOverrides.
    const overrideScopes = [
      { bash: globalConfig.tools?.bash, mcp: globalConfig.tools?.mcp },
      { bash: projectConfig.tools?.bash, mcp: projectConfig.tools?.mcp },
      { bash: agentConfig.tools?.bash, mcp: agentConfig.tools?.mcp },
      {
        bash: projectAgentConfig.tools?.bash,
        mcp: projectAgentConfig.tools?.mcp,
      },
    ];

    const composedRules = composeRuleset(
      synthesizeDefaults(defaults),
      synthesizeBaseline(configRules),
      synthesizeOverrides(overrideScopes),
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
   * Get the tool-level permission state for a tool, without considering command-level rules.
   * This is used for tool injection decisions where we need to know if a tool is allowed/denied
   * at the tool level before checking specific command permissions.
   *
   * With tool-name-as-surface normalization, tools.bash becomes a bash catch-all
   * { surface: "bash", pattern: "*", action } so getToolPermission("bash")
   * naturally picks it up via evaluate("bash", "*", rules).
   *
   * @param toolName - The name of the tool (for example "bash", "read", or a third-party tool name)
   * @param agentName - Optional agent name to check agent-specific permissions
   * @returns The permission state for the tool at the tool level
   */
  getToolPermission(toolName: string, agentName?: string): PermissionState {
    const { composedRules } = this.resolvePermissions(agentName);
    const normalizedToolName = toolName.trim();

    // Special surfaces: evaluate via the "special" surface used by config rules
    // and the synthesized special default.
    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      return evaluate("special", normalizedToolName, composedRules).action;
    }

    // For bash, mcp, skill: evaluate with "*" value against composedRules.
    // The synthesized override/default rules are catch-alls (pattern "*") that
    // respond correctly to a "*" lookup without matching specific patterns.
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
    // Config/default rules use surface "special"; session rules use surface
    // "external_directory" with path patterns. Check each independently.
    if (SPECIAL_PERMISSION_KEYS.has(normalizedToolName)) {
      // Session check: match by specific normalized path.
      const record = toRecord(input);
      const pathValue = typeof record.path === "string" ? record.path : null;
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
      const rule = evaluate("special", normalizedToolName, composedRules);
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

      // Try each candidate target. Stop on the first non-default match
      // (config, override, or baseline rule). Default rules are catch-alls
      // that would fire on every target — skip them so more-specific targets
      // can be checked first.
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
    const rule = evaluate(normalizedToolName, "*", composedRules);

    // Built-in tools always report source "tool" regardless of which layer
    // supplied the decision (matches current behaviour).
    if (BUILT_IN_TOOL_PERMISSION_NAMES.has(normalizedToolName)) {
      return {
        toolName,
        state: rule.action,
        source: "tool",
      };
    }

    // Extension tools: "default" layer → source "default"; any explicit rule
    // (config or override) → source "tool".
    return {
      toolName,
      state: rule.action,
      source: rule.layer === "default" ? "default" : "tool",
    };
  }
}
