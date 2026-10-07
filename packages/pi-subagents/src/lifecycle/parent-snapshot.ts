/**
 * parent-snapshot.ts — Capture parent session state as a plain data snapshot.
 */

import type { Model } from "@earendil-works/pi-ai";
import { buildParentContext } from "#src/session/context";
import type { ModelRegistry } from "#src/session/model-resolver";
import type { SessionContext } from "#src/types";

/**
 * Plain data snapshot of the parent session state captured at spawn time.
 * Replaces live `ExtensionContext` references so queued agents don't read stale state.
 */
export interface ParentSnapshot {
  /** Parent working directory. */
  cwd: string;
  /** Parent's effective system prompt (for append-mode agents). */
  systemPrompt: string;
  /** Parent's current model instance (fallback when agent config has no model). */
  model: Model<any> | undefined;
  /** Model registry for resolving config.model strings and creating sessions. */
  modelRegistry: ModelRegistry;
  /** Pre-built parent conversation text (when inheritContext was requested). */
  parentContext?: string;
}

/**
 * Per-parent-session stash of the system prompt as rendered at pi-subagents'
 * own `before_agent_start` handler position.
 *
 * Why not `ctx.getSystemPrompt()`: pi 1.0 extensions that return
 * `{ systemPrompt }` from `before_agent_start` (pi-permission-system's
 * BACH/GATED mode prompts, rpiv-todo's open-TODOs block, …) set
 * `forceSystemPrompt`, and a pi-side projection then serves that literal
 * string on every model call. `getSystemPrompt()` therefore includes those
 * per-turn appends. A child session would inherit them verbatim through the
 * embedded parent prompt — including BACH's "delegate via the subagent tool"
 * marching orders pointed at a tool the recursion guard stripped from the
 * child. pi-subagents loads before those extensions (extensions-dir entries
 * first, then packages[] in order; pi-subagents heads packages[]), so a
 * handler here sees the render after the piru bridge's skills gating but
 * before any `{ systemPrompt }` forcer or the built-in MCP section mutation.
 * That render is also byte-stable across turns (no per-turn appends), which
 * preserves the KV-cache prefix the embed was designed for. Tool and context
 * freshness is unaffected: pi rebuilds the base options on every
 * `setActiveTools`, and the bridge's skills filter already ran.
 */
let stashedTurnPrompt: string | undefined;

/** Record the current turn's pre-forcer system prompt (parent sessions only). */
export function stashTurnSystemPrompt(prompt: string): void {
  if (prompt) stashedTurnPrompt = prompt;
}

/** Test hook: reset the stash. */
export function resetStashedTurnPrompt(): void {
  stashedTurnPrompt = undefined;
}

/**
 * Build an immutable snapshot of the parent session state.
 *
 * Called once at spawn time so queued agents capture state as it existed
 * when the user requested the agent, not when a queue slot opens.
 */
export function buildParentSnapshot(
  ctx: SessionContext,
  inheritContext?: boolean,
): ParentSnapshot {
  const parentContext = inheritContext ? buildParentContext(ctx) : undefined;
  return {
    cwd: ctx.cwd,
    systemPrompt: stashedTurnPrompt ?? ctx.getSystemPrompt(),
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- || intentional: converts empty string to undefined as well as null/undefined
    parentContext: parentContext || undefined,
  };
}
