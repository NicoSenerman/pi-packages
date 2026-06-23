/**
 * session-navigation.ts — Pure selection and transcript-sourcing for native session navigation.
 *
 * Splits the unit-testable core of the `/subagent-sessions` command from its TUI
 * wiring (`session-navigator.ts`): which subagents are navigable and how a picked
 * agent's transcript is sourced (live, in this slice).
 *
 * The `TranscriptSource` seam decouples *how messages are sourced* (live record
 * here; a file snapshot in a follow-up) from *how they render* — the renderer
 * (`session-navigator.ts`, which mounts Pi's per-entry components) talks only to
 * this seam. Rendering lives in the SDK/TUI module because the per-entry
 * components require a `TUI`, `cwd`, and markdown theme.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { AgentSessionEvent, SessionMessage, SubagentType } from "#src/types";
import { formatDuration, getDisplayName } from "#src/ui/display";

// ─────────────────────────────────────────────────────────────────────────────

/** The record fields the navigator reads to label and live-source a transcript. */
export interface NavigableSubagent {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  readonly agentMessages: readonly SessionMessage[];
  isSessionReady(): boolean;
  subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

/** A navigable entry: a record plus the label shown in the picker. */
export interface NavigationEntry {
  readonly record: NavigableSubagent;
  readonly label: string;
}

/** Running-agent streaming state, surfaced by a live source. */
export interface StreamingState {
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
}

/** Liveness-agnostic transcript source consumed by the renderer. */
export interface TranscriptSource {
  /** Current message history. */
  getMessages(): readonly SessionMessage[];
  /** Subscribe to changes; returns an unsubscribe, or undefined for a static snapshot. */
  subscribe(onChange: () => void): (() => void) | undefined;
  /** Running-agent streaming state, or undefined when not streaming. */
  streaming(): StreamingState | undefined;
  /** Resolve a registered tool definition by name, for Pi's tool-execution components. */
  getToolDefinition(name: string): ToolDefinition | undefined;
}

/** Filter the agents to those with a viewable session and label each for the picker. */
export function listNavigableAgents(
  agents: readonly NavigableSubagent[],
  registry: AgentConfigLookup,
): NavigationEntry[] {
  return agents
    .filter((record) => record.isSessionReady())
    .map((record) => ({ record, label: buildLabel(record, registry) }));
}

/** Source a transcript live from an in-memory record (this slice's only source). */
export function liveSource(record: NavigableSubagent): TranscriptSource {
  return {
    getMessages: () => record.agentMessages,
    subscribe: (onChange) => record.subscribeToUpdates(() => onChange()),
    streaming: () =>
      record.status === "running"
        ? { activeTools: record.activeTools, responseText: record.responseText }
        : undefined,
    getToolDefinition: (name) => record.getToolDefinition(name),
  };
}

function buildLabel(record: NavigableSubagent, registry: AgentConfigLookup): string {
  const name = getDisplayName(record.type, registry);
  const duration = formatDuration(record.startedAt, record.completedAt);
  return `${name} (${record.description}) · ${record.toolUses} tools · ${record.status} · ${duration}`;
}
