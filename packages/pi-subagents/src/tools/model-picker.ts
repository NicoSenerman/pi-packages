/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- Pi SDK types are not fully exported; tool ctx is `any` */
/**
 * model-picker.ts — Interactive model picker for subagent spawns.
 *
 * Gate: (settings.agentModelPicker || params.pick_model) AND no explicit model
 * (params.model absent, agent config has no hardcoded model) AND not a resume.
 * Headless (no ctx.ui.select) silently skips.
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
  },
  ui: { select?: unknown } | undefined,
): boolean {
  if (settings.agentModelDefault) return false;
  if (settings.agentModelPicker !== true && params.pick_model !== true)
    return false;
  if (params.resume) return false;
  if (params.model != null) return false;
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
  const select = deps.ui?.select as (
    title: string,
    options: ModelPickerOption[],
    opts?: { timeout: number },
  ) => Promise<string | undefined>;

  const parent = deps.parentModel;
  const parentLabel = parent?.provider
    ? `${parent.provider}/${parent.id}`
    : (parent?.id ?? "unknown");
  const lastUsed = readModelMru(deps.agentDir);
  const entries = (deps.modelRegistry.getAvailable?.() ??
    []) as ModelEntryLike[];
  const options: ModelPickerOption[] = [
    {
      title: `inherit parent (${parentLabel})`,
      description: "use the current session model",
      value: "",
    },
    ...sortByMru(entries, lastUsed).map((m) => ({
      title: m.id,
      description: m.provider,
      value: `${m.provider}/${m.id}`,
    })),
  ];

  const picked = await select(
    `${MODEL_PICKER_TITLE_PREFIX}${deps.subagentType}: ${deps.description}`,
    options,
    { timeout: 120000 },
  );
  if (picked === undefined) return { kind: "cancelled" };
  if (picked === "") return { kind: "inherit" };

  // First pick of the session: ask once whether to reuse this model for
  // every subagent this session. Mark asked BEFORE awaiting so concurrent
  // parallel spawns skip this — only the first spawn shows it.
  if (deps.settings.modelScopeAsked) {
    return { kind: "picked", value: picked };
  }
  deps.settings.markModelScopeAsked(false);

  const scope = await select(
    `Use ${picked} for every subagent this session?`,
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
