/**
 * record-observer.ts — Subscribes to session events and updates AgentRecord stats.
 *
 * Replaces the scattered callback-wrapping logic in AgentManager's startAgent()
 * and resume() with a single direct subscription.
 */

import type { CompactionInfo } from "#src/lifecycle/agent-manager";
import type { AgentRecord } from "#src/lifecycle/agent-record";

/** Narrow session interface — only the subscribe method needed by the observer. */
interface SubscribableSession {
  subscribe(fn: (event: any) => void): () => void;
}

export interface RecordObserverOptions {
  onCompact?: (record: AgentRecord, info: CompactionInfo) => void;
}

/**
 * Subscribe to session events and accumulate stats on the agent record.
 *
 * Handles:
 * - `tool_execution_end` → `record.incrementToolUses()`
 * - `message_end` (assistant, with usage) → `record.addUsage(…)`
 * - `compaction_end` (not aborted) → `record.incrementCompactions()`, call `onCompact`
 *
 * @returns An unsubscribe function.
 */
export function subscribeRecordObserver(
  session: SubscribableSession,
  record: AgentRecord,
  options?: RecordObserverOptions,
): () => void {
  return session.subscribe((event: any) => {
    if (event.type === "tool_execution_end") {
      record.incrementToolUses();
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const u = event.message.usage;
      if (u) {
        record.addUsage({
          input: u.input ?? 0,
          output: u.output ?? 0,
          cacheWrite: u.cacheWrite ?? 0,
        });
      }
    }

    if (event.type === "compaction_end" && !event.aborted && event.result) {
      record.incrementCompactions();
      options?.onCompact?.(record, {
        reason: event.reason,
        tokensBefore: event.result.tokensBefore,
      });
    }
  });
}
