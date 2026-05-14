/**
 * GitHub CLI helpers and repository auto-detection.
 * Platform-independent — no Pi SDK imports.
 */
import { runCommand } from "./process";

export interface RepoInfo {
  owner: string;
  repo: string;
}

let cachedRepo: RepoInfo | undefined;

/**
 * Reset the cached repo detection result.
 * Exposed for tests — not needed at runtime.
 */
export function resetRepoCache(): void {
  cachedRepo = undefined;
}

/**
 * Run a `gh` CLI command and return stdout as a trimmed string.
 * Throws on non-zero exit.
 */
export async function gh(...args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await runCommand({
    cmd: "gh",
    args,
  });
  if (exitCode !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`,
    );
  }
  return stdout.trim();
}

/**
 * Run a `gh` CLI command and parse stdout as JSON.
 * Throws on non-zero exit or invalid JSON.
 */
export async function ghJson<T>(...args: string[]): Promise<T> {
  const text = await gh(...args);
  return JSON.parse(text) as T;
}

/**
 * Detect the current GitHub repository.
 *
 * Strategy:
 * 1. Try `gh repo view --json owner,name` (authoritative, requires gh auth).
 * 2. Fallback: parse `git remote get-url origin` (SSH and HTTPS formats).
 *
 * Result is cached for the extension lifetime.
 */
export async function detectRepo(): Promise<RepoInfo> {
  if (cachedRepo) return cachedRepo;

  // Try gh first
  try {
    const result = await ghJson<{ owner: { login: string }; name: string }>(
      "repo",
      "view",
      "--json",
      "owner,name",
    );
    cachedRepo = { owner: result.owner.login, repo: result.name };
    return cachedRepo;
  } catch {
    // Fall back to git remote
  }

  const { stdout } = await runCommand({
    cmd: "git",
    args: ["remote", "get-url", "origin"],
  });
  const match = stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) {
    throw new Error("Could not detect GitHub repository from git remote");
  }
  cachedRepo = { owner: match[1], repo: match[2] };
  return cachedRepo;
}
