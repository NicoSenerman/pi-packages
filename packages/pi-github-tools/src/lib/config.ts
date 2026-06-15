/**
 * Extension configuration loading.
 *
 * Config files live at:
 *  - Global:  <agentDir>/extensions/pi-github-tools/config.json
 *  - Project: <cwd>/.pi/extensions/pi-github-tools/config.json
 *
 * Project config takes precedence over global.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_ID = "pi-github-tools";

const MERGE_METHODS = ["rebase", "squash", "merge"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface GithubToolsConfig {
  defaultMergeMethod?: MergeMethod;
}

export function getGlobalConfigPath(agentDir: string): string {
  return join(agentDir, "extensions", EXTENSION_ID, "config.json");
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", EXTENSION_ID, "config.json");
}

export function normalizeConfig(raw: unknown): GithubToolsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const config: GithubToolsConfig = {};
  if (
    (MERGE_METHODS as readonly unknown[]).includes(record.defaultMergeMethod)
  ) {
    config.defaultMergeMethod = record.defaultMergeMethod as MergeMethod;
  }
  return config;
}

export function loadSingleConfig(path: string): GithubToolsConfig {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return normalizeConfig(raw);
  } catch {
    return {};
  }
}

export function loadConfig(options: {
  globalConfigPath: string;
  projectConfigPath: string;
}): GithubToolsConfig {
  const global = loadSingleConfig(options.globalConfigPath);
  const project = loadSingleConfig(options.projectConfigPath);
  // Project takes precedence over global
  return { ...global, ...project };
}
