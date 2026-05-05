import { toRecord } from "./common";
import { createMcpPermissionTargets } from "./mcp-targets";

/**
 * Surface-normalized representation of a tool invocation used by
 * `checkPermission()` to feed a single `evaluateFirst()` call.
 */
export interface NormalizedInput {
  /** The permission surface for `evaluate()` (e.g. "bash", "mcp", "skill"). */
  surface: string;
  /**
   * Candidate lookup values in priority order (most-specific first).
   * Most surfaces produce a single-element array; MCP produces a
   * multi-candidate list derived from the invocation input.
   */
  values: string[];
  /**
   * Surface-specific fields forwarded verbatim into `PermissionCheckResult`
   * (e.g. `{ command }` for bash, `{ target }` for mcp).
   */
  resultExtras: Record<string, unknown>;
}

const SPECIAL_PERMISSION_KEYS = new Set(["external_directory"]);

/**
 * Map a raw tool invocation to the surface/values/extras triple needed by
 * `checkPermission()`.
 *
 * @param toolName - Normalized (trimmed) tool name from the tool-call event.
 * @param input    - Raw input payload from the tool-call event.
 * @param configuredMcpServerNames - Ordered list of MCP server names from the
 *   global MCP config, used to derive server-qualified MCP targets.
 */
export function normalizeInput(
  toolName: string,
  input: unknown,
  configuredMcpServerNames: readonly string[],
): NormalizedInput {
  // --- Special surfaces (external_directory) ---
  if (SPECIAL_PERMISSION_KEYS.has(toolName)) {
    const record = toRecord(input);
    const pathValue = typeof record.path === "string" ? record.path : null;
    return {
      surface: toolName,
      values: [pathValue ?? "*"],
      resultExtras: {},
    };
  }

  // --- Skill ---
  if (toolName === "skill") {
    const record = toRecord(input);
    const skillName = record.name;
    const lookupValue = typeof skillName === "string" ? skillName : "*";
    return {
      surface: "skill",
      values: [lookupValue],
      resultExtras: {},
    };
  }

  // --- Bash ---
  if (toolName === "bash") {
    const record = toRecord(input);
    const command = typeof record.command === "string" ? record.command : "";
    return {
      surface: "bash",
      values: [command],
      resultExtras: { command },
    };
  }

  // --- MCP ---
  if (toolName === "mcp") {
    const mcpTargets = [
      ...createMcpPermissionTargets(input, configuredMcpServerNames),
      "mcp",
    ];
    const fallbackTarget = mcpTargets[0] ?? "mcp";
    return {
      surface: "mcp",
      values: mcpTargets,
      resultExtras: { target: fallbackTarget },
    };
  }

  // --- Tool surfaces (read, write, edit, grep, find, ls, extension tools) ---
  return {
    surface: toolName,
    values: ["*"],
    resultExtras: {},
  };
}
