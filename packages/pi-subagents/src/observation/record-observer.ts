/**
 * record-observer.ts — Subscribes to session events and accumulates SubagentState stats.
 *
 * Replaces the scattered callback-wrapping logic in SubagentManager's startAgent()
 * and resume() with a single direct subscription. The observer targets the
 * SubagentState value object directly, so it carries no dependency on Subagent;
 * the caller forwards itself to its own lifecycle observer via onCompact.
 */

import type { SubagentState } from "#src/lifecycle/subagent-state";
import type { CompactionInfo, SubscribableSession } from "#src/types";

export interface SubagentObserverOptions {
  onCompact?: (info: CompactionInfo) => void;
}

/**
 * Subscribe to session events and accumulate stats on the subagent state.
 *
 * Handles:
 * - `tool_execution_end` → `state.incrementToolUses()`
 * - `message_end` (assistant, with usage) → `state.addUsage(…)`
 * - `compaction_end` (not aborted) → `state.incrementCompactions()`, call `onCompact`
 *
 * @returns An unsubscribe function.
 */
export function subscribeSubagentObserver(
  session: SubscribableSession,
  state: SubagentState,
  options?: SubagentObserverOptions,
): () => void {
  return session.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      state.incrementToolUses();
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = event.message.usage;
      state.addUsage({
        input: u.input,
        output: u.output,
        cacheWrite: u.cacheWrite,
      });
    }

    if (event.type === "compaction_end" && !event.aborted && event.result) {
      state.incrementCompactions();
      options?.onCompact?.({
        reason: event.reason,
        tokensBefore: event.result.tokensBefore,
      });
    }
  });
}
