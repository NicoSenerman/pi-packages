/**
 * ui-observer.ts — Subscribes to session events and updates AgentActivityTracker state.
 *
 * Replaces the callback-based createActivityTracker pattern with a direct
 * session subscription for streaming UI state (active tools, response text,
 * turn count, lifetime usage).
 */

import type { AgentActivityTracker } from "#src/ui/agent-activity-tracker";

/** Narrow session interface — only the subscribe method needed by the observer. */
interface SubscribableSession {
	subscribe(fn: (event: any) => void): () => void;
}

/**
 * Subscribe to session events and stream UI state into an AgentActivityTracker.
 *
 * Handles:
 * - `tool_execution_start` → `tracker.onToolStart(name)`
 * - `tool_execution_end` → `tracker.onToolEnd(name)`
 * - `message_start` → `tracker.onMessageStart()`
 * - `message_update` (text_delta) → `tracker.onMessageUpdate(delta)`
 * - `turn_end` → `tracker.onTurnEnd()`
 * - `message_end` (assistant, with usage) → `tracker.onUsageUpdate(usage)`
 *
 * Calls `onUpdate?.()` after each state mutation to trigger re-renders.
 *
 * @returns An unsubscribe function.
 */
export function subscribeUIObserver(
	session: SubscribableSession,
	tracker: AgentActivityTracker,
	onUpdate?: () => void,
): () => void {
	return session.subscribe((event: any) => {
		if (event.type === "tool_execution_start") {
			tracker.onToolStart(event.toolName);
			onUpdate?.();
		}

		if (event.type === "tool_execution_end") {
			tracker.onToolDone(event.toolName);
			onUpdate?.();
		}

		if (event.type === "message_start") {
			tracker.onMessageStart();
		}

		if (
			event.type === "message_update" &&
			event.assistantMessageEvent?.type === "text_delta"
		) {
			tracker.onMessageUpdate(event.assistantMessageEvent.delta);
			onUpdate?.();
		}

		if (event.type === "turn_end") {
			tracker.onTurnEnd();
			onUpdate?.();
		}

	});
}
