/**
 * ui-observer.ts — Subscribes to session events and updates AgentActivity state.
 *
 * Replaces the callback-based createActivityTracker pattern with a direct
 * session subscription for streaming UI state (active tools, response text,
 * turn count, lifetime usage).
 */

import { addUsage } from "../usage.js";
import type { AgentActivity } from "./agent-widget.js";

/** Narrow session interface — only the subscribe method needed by the observer. */
interface SubscribableSession {
	subscribe(fn: (event: any) => void): () => void;
}

/**
 * Subscribe to session events and stream UI state into an AgentActivity object.
 *
 * Handles:
 * - `tool_execution_start` → add to `state.activeTools`
 * - `tool_execution_end` → remove from `state.activeTools`, `state.toolUses++`
 * - `message_start` → reset `state.responseText`
 * - `message_update` (text_delta) → append to `state.responseText`
 * - `turn_end` → `state.turnCount++`
 * - `message_end` (assistant, with usage) → `addUsage(state.lifetimeUsage, …)`
 *
 * Calls `onUpdate?.()` after each state mutation to trigger re-renders.
 *
 * @returns An unsubscribe function.
 */
export function subscribeUIObserver(
	session: SubscribableSession,
	state: AgentActivity,
	onUpdate?: () => void,
): () => void {
	return session.subscribe((event: any) => {
		if (event.type === "tool_execution_start") {
			state.activeTools.set(event.toolName + "_" + Date.now(), event.toolName);
			onUpdate?.();
		}

		if (event.type === "tool_execution_end") {
			for (const [key, name] of state.activeTools) {
				if (name === event.toolName) {
					state.activeTools.delete(key);
					break;
				}
			}
			state.toolUses++;
			onUpdate?.();
		}

		if (event.type === "message_start") {
			state.responseText = "";
		}

		if (
			event.type === "message_update" &&
			event.assistantMessageEvent?.type === "text_delta"
		) {
			state.responseText += event.assistantMessageEvent.delta;
			onUpdate?.();
		}

		if (event.type === "turn_end") {
			state.turnCount++;
			onUpdate?.();
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			const u = event.message.usage;
			if (u) {
				addUsage(state.lifetimeUsage, {
					input: u.input ?? 0,
					output: u.output ?? 0,
					cacheWrite: u.cacheWrite ?? 0,
				});
				onUpdate?.();
			}
		}
	});
}
