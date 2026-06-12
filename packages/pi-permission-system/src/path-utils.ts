import {
  join,
  normalize,
  posix as posixPath,
  resolve,
  win32 as winPath,
} from "node:path";

import { canonicalizePath } from "./canonicalize-path";
import { getNonEmptyString, toRecord } from "./common";
import { expandHomePath } from "./expand-home";
import type { ToolAccessExtractorLookup } from "./tool-access-extractor-registry";
import { wildcardMatch } from "./wildcard-matcher";

export function normalizePathForComparison(
  pathValue: string,
  cwd: string,
): string {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return "";
  }

  let normalizedPath = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  normalizedPath = expandHomePath(normalizedPath);

  const absolutePath = resolve(cwd, normalizedPath);
  const normalizedAbsolutePath = normalize(absolutePath);
  return process.platform === "win32"
    ? normalizedAbsolutePath.toLowerCase()
    : normalizedAbsolutePath;
}

/**
 * Returns true when `pathValue` is `directory` itself or nested inside it.
 *
 * Containment is decided with Node's platform-native `path.relative` rather
 * than a hand-rolled prefix check: on `win32` the comparison folds case (and
 * tolerates either separator), matching the case-insensitive filesystem.
 * `platform` defaults to `process.platform` and is injectable so Windows
 * behavior is testable on a POSIX CI.
 */
export function isPathWithinDirectory(
  pathValue: string,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!pathValue || !directory) {
    return false;
  }

  if (pathValue === directory) {
    return true;
  }

  const impl = platform === "win32" ? winPath : posixPath;
  const rel = impl.relative(directory, pathValue);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${impl.sep}`) &&
    !impl.isAbsolute(rel)
  );
}

/**
 * Paths that are universally safe and should never trigger external-directory checks.
 * These are OS device files: read returns EOF or process streams, write discards or goes to process streams.
 */
export const SAFE_SYSTEM_PATHS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);

/**
 * Returns true if the given normalized path is a safe OS device file
 * that should never trigger external-directory checks.
 */
export function isSafeSystemPath(normalizedPath: string): boolean {
  return SAFE_SYSTEM_PATHS.has(normalizedPath);
}

/**
 * File tools that only read — never write — the filesystem.
 * Only these tools are eligible for the Pi infrastructure auto-allow.
 */
export const READ_ONLY_PATH_BEARING_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "find",
  "grep",
  "ls",
]);

export const PATH_BEARING_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "find",
  "grep",
  "ls",
]);

/**
 * Surfaces whose patterns are matched against filesystem paths and therefore
 * fold case (and separators) on Windows: the path-bearing tools plus the
 * cross-cutting `path` gate and the `external_directory` boundary gate.
 */
export const PATH_SURFACES: ReadonlySet<string> = new Set([
  ...PATH_BEARING_TOOLS,
  "external_directory",
  "path",
]);

export function getPathBearingToolPath(
  toolName: string,
  input: unknown,
): string | null {
  if (!PATH_BEARING_TOOLS.has(toolName)) {
    return null;
  }

  return getNonEmptyString(toRecord(input).path);
}

/**
 * Extract the filesystem path a tool will access, for the cross-cutting `path`
 * and `external_directory` gates.
 *
 * Unlike {@link getPathBearingToolPath} (built-in tools only), this recognizes
 * extension and MCP tools so they are no longer exempt from path gating:
 *
 * - `bash` → `null` (bash has its own token-based path gates).
 * - Built-in path-bearing tools → `input.path`.
 * - `mcp` → `input.arguments.path`.
 * - Any other tool → a registered {@link ToolAccessExtractor}'s path, else the
 *   default `input.path` convention.
 */
export function getToolInputPath(
  toolName: string,
  input: unknown,
  extractors?: ToolAccessExtractorLookup,
): string | null {
  if (toolName === "bash") {
    return null;
  }

  const record = toRecord(input);

  if (PATH_BEARING_TOOLS.has(toolName)) {
    return getNonEmptyString(record.path);
  }

  if (toolName === "mcp") {
    return getNonEmptyString(toRecord(record.arguments).path);
  }

  const custom = extractors?.get(toolName);
  if (custom) {
    return getNonEmptyString(custom(record));
  }

  return getNonEmptyString(record.path);
}

/**
 * Like {@link normalizePathForComparison} but also resolves symlinks via
 * `realpathSync` (best-effort). Use this for containment decisions where the
 * OS-followed path matters, not for pattern matching.
 */
export function canonicalNormalizePathForComparison(
  pathValue: string,
  cwd: string,
): string {
  const lexical = normalizePathForComparison(pathValue, cwd);
  if (!lexical) return "";
  const canonical = canonicalizePath(lexical);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function isPathOutsideWorkingDirectory(
  pathValue: string,
  cwd: string,
): boolean {
  const normalizedCwd = canonicalNormalizePathForComparison(cwd, cwd);
  const normalizedPath = canonicalNormalizePathForComparison(pathValue, cwd);
  if (!normalizedCwd || !normalizedPath) {
    return false;
  }
  if (isSafeSystemPath(normalizedPath)) {
    return false;
  }
  return !isPathWithinDirectory(normalizedPath, normalizedCwd);
}

function containsGlobChars(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

/**
 * Returns true if the given tool + normalized path combination qualifies for
 * automatic allow as a Pi infrastructure read.
 *
 * A path qualifies when:
 * 1. The tool is read-only (in READ_ONLY_PATH_BEARING_TOOLS).
 * 2. The normalized path is within one of the provided `infrastructureDirs`
 *    OR within the project-local Pi package directories
 *    (`<cwd>/.pi/npm/` or `<cwd>/.pi/git/`).
 *
 * `infrastructureDirs` entries may be absolute paths or patterns containing
 * `~`/`$HOME` (expanded at call time) or glob characters (`*`, `?`).
 * Project-local paths are computed fresh from `cwd` on each call so they
 * follow working-directory changes without a runtime rebuild.
 */
export function isPiInfrastructureRead(
  toolName: string,
  normalizedPath: string,
  infrastructureDirs: readonly string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!READ_ONLY_PATH_BEARING_TOOLS.has(toolName)) {
    return false;
  }

  // On Windows the path value is canonicalized + lowercased; fold case (and
  // separators) so mixed-case infra dirs and glob patterns still match.
  const matchOptions =
    platform === "win32"
      ? { caseInsensitive: true, windowsSeparators: true }
      : undefined;

  for (const dir of infrastructureDirs) {
    if (containsGlobChars(dir)) {
      if (wildcardMatch(dir, normalizedPath, matchOptions)) return true;
    } else {
      if (isPathWithinDirectory(normalizedPath, expandHomePath(dir), platform))
        return true;
    }
  }

  // Project-local Pi packages — checked fresh every call so CWD changes work.
  const projectNpmDir = join(cwd, ".pi", "npm");
  const projectGitDir = join(cwd, ".pi", "git");
  if (isPathWithinDirectory(normalizedPath, projectNpmDir, platform)) {
    return true;
  }
  if (isPathWithinDirectory(normalizedPath, projectGitDir, platform)) {
    return true;
  }

  return false;
}
