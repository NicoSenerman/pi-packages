/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- Pi SDK types are not fully exported; tool ctx is `any` */
/**
 * model-picker.ts — Interactive model picker for subagent spawns.
 *
 * Gate: (settings.agentModelPicker || params.pick_model) AND no agent-config
 * hardcoded model AND not a resume AND no session default. An LLM-supplied
 * params.model does NOT disarm the picker — it is surfaced as a highlighted
 * "(suggested)" option so the user can confirm or change it. Headless
 * (no ctx.ui.select) silently skips.
 *
 * Options are MRU-sorted via pi-model-sort's state file; the leading option
 * inherits the parent session model. "" = inherit, undefined = cancelled.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTypeRegistry } from "#src/config/agent-types";

/** Object-shaped option for ctx.ui.select; piru renders title+description and returns value. */
export interface ModelPickerOption {
  title: string;
  description: string;
  value: string;
}

export type ModelPickOutcome =
  | { kind: "inherit" }
  | { kind: "picked" | "pickedRememberSession"; value: string }
  | { kind: "cancelled" };

interface ModelEntryLike {
  id: string;
  name?: string;
  provider: string;
}

export interface ModelPickerDeps {
  params: Record<string, unknown>;
  modelRegistry: { getAvailable?(): unknown[] };
  parentModel: { id: string; provider?: string; name?: string } | undefined;
  subagentType: string;
  description: string;
  agentConfigModel: string | undefined;
  settings: {
    readonly agentModelPicker: boolean;
    readonly agentModelDefault?: string | undefined;
    readonly modelScopeAsked: boolean;
    markModelScopeAsked(declinedSession: boolean): void;
    acquirePickerLock(): Promise<() => void>;
  };
  agentDir: string;
  ui: { select?: unknown } | undefined;
}

/** Title prefix — piru pattern-matches this exact string (em dash + space) to route the dialog. */
export const MODEL_PICKER_TITLE_PREFIX = "Subagent model — ";

export function shouldOfferModelPicker(
  params: Record<string, unknown>,
  agentConfigModel: string | undefined,
  settings: {
    readonly agentModelPicker: boolean;
    readonly agentModelDefault?: string | undefined;
    readonly modelScopeAsked: boolean;
    markModelScopeAsked(declinedSession: boolean): void;
    acquirePickerLock(): Promise<() => void>;
  },
  ui: { select?: unknown } | undefined,
): boolean {
  if (settings.agentModelDefault !== undefined) return false;
  if (settings.agentModelPicker !== true && params.pick_model !== true)
    return false;
  if (params.resume) return false;
  if (agentConfigModel != null) return false;
  return typeof ui?.select === "function";
}

export async function maybePickAgentModel(
  deps: ModelPickerDeps,
): Promise<ModelPickOutcome> {
  if (
    !shouldOfferModelPicker(
      deps.params,
      deps.agentConfigModel,
      deps.settings,
      deps.ui,
    )
  ) {
    return { kind: "inherit" };
  }
  // Serialize across concurrent spawns: hold the lock for the whole picker
  // (model pick + optional scope ask) so siblings don't interleave in piru's
  // single overlay slot. Re-check the default once held — a prior spawn may
  // have set it while we waited.
  const release = await deps.settings.acquirePickerLock();
  try {
    if (deps.settings.agentModelDefault !== undefined) {
      return { kind: "inherit" };
    }
    const select = deps.ui?.select as (
      title: string,
      options: ModelPickerOption[],
      opts?: { timeout: number },
    ) => Promise<string | undefined>;
    if (typeof select !== "function") {
      return { kind: "inherit" };
    }
    const parent = deps.parentModel;
    const parentLabel = parent?.provider
      ? `${parent.provider}/${parent.id}`
      : (parent?.id ?? "unknown");
    const lastUsed = readModelMru(deps.agentDir);
    const entries = (deps.modelRegistry.getAvailable?.() ??
      []) as ModelEntryLike[];
    const suggested = normalizeSuggestedModel(
      deps.params.model as string | undefined,
      entries,
    );
    const sorted = sortByMru(entries, lastUsed);
    const options: ModelPickerOption[] = [
      {
        title: `inherit parent (${parentLabel})`,
        description: "use the current session model",
        value: "",
      },
      ...buildModelOptions(sorted, suggested),
    ];

    const picked = await select(
      `${MODEL_PICKER_TITLE_PREFIX}${deps.subagentType}: ${deps.description}`,
      options,
      { timeout: 120000 },
    );
    if (picked === undefined) return { kind: "cancelled" };

    // First pick of the session: ask once whether to reuse this choice for
    // every subagent this session. Mark asked BEFORE awaiting so concurrent
    // parallel spawns skip this — only the first spawn shows it. Fires for
    // both a concrete model pick AND the "inherit parent" pick.
    if (deps.settings.modelScopeAsked) {
      return picked === ""
        ? { kind: "inherit" }
        : { kind: "picked", value: picked };
    }
    deps.settings.markModelScopeAsked(false);

    const scopePicked = picked === "" ? "inherit parent" : picked;
    const scope = await select(
      `Use ${scopePicked} for every subagent this session?`,
      [
        {
          title: "Yes, this session",
          description: "skip the picker for the rest of this session",
          value: "session",
        },
        {
          title: "No, ask each time",
          description: "pick a model on every spawn",
          value: "once",
        },
      ],
      { timeout: 120000 },
    );
    if (scope === undefined) return { kind: "cancelled" };
    if (scope === "session") {
      return { kind: "pickedRememberSession", value: picked };
    }
    return { kind: "picked", value: picked };
  } finally {
    release();
  }
}

export function getAgentConfigModel(
  params: Record<string, unknown>,
  registry: AgentTypeRegistry,
): string | undefined {
  const resolved = registry.resolveType(params.subagent_type as string);
  return registry.resolveAgentConfig(resolved ?? "general-purpose").model;
}

/** MRU map from pi-model-sort's state file. Read-only; anything wrong = empty ordering. */
function readModelMru(agentDir: string): Map<string, number> {
  try {
    const raw = JSON.parse(
      readFileSync(join(agentDir, "extensions", "pi-model-sort.json"), "utf-8"),
    );
    const lastUsed = raw?.lastUsed;
    if (!lastUsed || typeof lastUsed !== "object") return new Map();
    const out = new Map<string, number>();
    for (const [key, ts] of Object.entries(lastUsed)) {
      if (typeof ts === "number") out.set(key, ts);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** MRU-descending; never-used entries fall to the bottom, alphabetical by full key. */
function sortByMru(
  entries: ModelEntryLike[],
  lastUsed: Map<string, number>,
): ModelEntryLike[] {
  return [...entries].sort((a, b) => {
    const ka = `${a.provider}/${a.id}`;
    const kb = `${b.provider}/${b.id}`;
    const ta = lastUsed.get(ka) ?? -1;
    const tb = lastUsed.get(kb) ?? -1;
    if (ta !== tb) return tb - ta;
    return ka.localeCompare(kb);
  });
}

/**
 * Resolve an LLM-supplied params.model to a normalized "provider/id" key when
 * it matches an available model. Accepts "provider/id", a bare id, or a fuzzy
 * name (matched case-insensitively against id then name), mirroring the
 * resolver's fuzzy fallback so any model the resolver accepts is surfaced.
 * Returns undefined when the suggestion doesn't resolve to any available model,
 * so the picker just shows the plain MRU-sorted list.
 */
function normalizeSuggestedModel(
  suggested: string | undefined,
  entries: ModelEntryLike[],
): string | undefined {
  if (typeof suggested !== "string" || suggested.trim() === "")
    return undefined;
  const trimmed = suggested.trim();
  // Exact "provider/id" match wins outright.
  if (entries.some((m) => `${m.provider}/${m.id}` === trimmed)) {
    return trimmed;
  }
  // Bare id or fuzzy name: case-insensitive, preferring an exact id hit,
  // then exact name, then id-contains, then name-contains.
  const lower = trimmed.toLowerCase();
  const exactId = entries.find((m) => m.id.toLowerCase() === lower);
  if (exactId) return `${exactId.provider}/${exactId.id}`;
  const exactName = entries.find((m) => m.name?.toLowerCase() === lower);
  if (exactName) return `${exactName.provider}/${exactName.id}`;
  const idContains = entries.find((m) => m.id.toLowerCase().includes(lower));
  if (idContains) return `${idContains.provider}/${idContains.id}`;
  const nameContains = entries.find((m) =>
    m.name?.toLowerCase().includes(lower),
  );
  if (nameContains) return `${nameContains.provider}/${nameContains.id}`;
  return undefined;
}

/**
 * Build the per-model picker rows from MRU-sorted entries. If `suggested`
 * (a normalized "provider/id" key) resolves to one of the entries, that row
 * is annotated with " (suggested)" in its title and hoisted to the front so
 * the user sees the LLM's guess first. piru round-trips `value` unchanged, so
 * annotating only the title is safe.
 */
function buildModelOptions(
  sorted: ModelEntryLike[],
  suggested: string | undefined,
): ModelPickerOption[] {
  if (suggested === undefined) {
    return sorted.map((m) => ({
      title: m.id,
      description: m.provider,
      value: `${m.provider}/${m.id}`,
    }));
  }
  const options = sorted.map((m) => {
    const key = `${m.provider}/${m.id}`;
    return {
      title: key === suggested ? `${m.id} (suggested)` : m.id,
      description: m.provider,
      value: key,
    };
  });
  // Hoist the suggested row to the front (after the inherit option).
  const idx = options.findIndex((o) => o.value === suggested);
  if (idx > 0) {
    const [hoisted] = options.splice(idx, 1);
    options.unshift(hoisted);
  }
  return options;
}
