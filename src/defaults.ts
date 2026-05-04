import type { PermissionDefaultPolicy, PermissionState } from "./types";

/** Hardcoded fallback — every surface defaults to "ask" (least privilege). */
export const DEFAULT_POLICY: PermissionDefaultPolicy = {
  tools: "ask",
  bash: "ask",
  mcp: "ask",
  skills: "ask",
  special: "ask",
};

/**
 * Map a surface name used in evaluate() to the corresponding
 * defaultPolicy key. Surfaces not listed here fall through to
 * either "tools" or "special" via getSurfaceDefault().
 */
const SURFACE_TO_DEFAULT_KEY: Record<string, keyof PermissionDefaultPolicy> = {
  bash: "bash",
  mcp: "mcp",
  skill: "skills",
};

/**
 * Resolve the default action for a surface, consulting merged defaults.
 *
 * - "bash", "mcp", "skill" → dedicated defaultPolicy key
 * - special-key surfaces (e.g. "external_directory") → defaults.special
 * - everything else (tool-name surfaces) → defaults.tools
 *
 * @deprecated Default policy is now synthesized into the composed ruleset via
 * `synthesizeDefaults()` in `src/synthesize.ts`. Call-sites that previously
 * consulted this function can evaluate against the composed ruleset instead.
 * This function is kept for backward compatibility and will be removed in a
 * future cleanup.
 */
export function getSurfaceDefault(
  surface: string,
  defaults: PermissionDefaultPolicy,
  specialKeys: ReadonlySet<string>,
): PermissionState {
  const key = SURFACE_TO_DEFAULT_KEY[surface];
  if (key) return defaults[key];
  if (specialKeys.has(surface)) return defaults.special;
  return defaults.tools;
}

/**
 * Merge zero or more partial default policies on top of DEFAULT_POLICY.
 * Later partials override earlier ones (shallow spread per key).
 */
export function mergeDefaults(
  ...partials: ReadonlyArray<Partial<PermissionDefaultPolicy> | undefined>
): PermissionDefaultPolicy {
  const merged: PermissionDefaultPolicy = { ...DEFAULT_POLICY };

  for (const partial of partials) {
    if (!partial) continue;
    if (partial.tools) merged.tools = partial.tools;
    if (partial.bash) merged.bash = partial.bash;
    if (partial.mcp) merged.mcp = partial.mcp;
    if (partial.skills) merged.skills = partial.skills;
    if (partial.special) merged.special = partial.special;
  }

  return merged;
}
