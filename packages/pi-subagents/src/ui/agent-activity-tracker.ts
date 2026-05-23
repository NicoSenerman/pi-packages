/**
 * agent-activity-tracker.ts — Per-agent live activity state with explicit transition methods.
 *
 * Replaces the mutable `AgentActivity` interface that was written via output arguments
 * in `ui-observer.ts`. Callers use named transition methods; readers use read-only accessors.
 */

import type { SessionLike } from "#src/lifecycle/usage";

/** Per-agent live activity state with explicit transition methods and read-only accessors. */
export class AgentActivityTracker {
	private _activeTools = new Map<string, string>();
	private _toolKeySeq = 0;
	private _responseText = "";
	private _session: SessionLike | undefined = undefined;
	private _turnCount = 1;

	constructor(private readonly _maxTurns?: number) {}

	// ── Transition methods (write surface) ──────────────────────────────────

	/** Record that a tool has started executing. */
	onToolStart(toolName: string): void {
		this._activeTools.set(toolName + "_" + (++this._toolKeySeq), toolName);
	}

	/** Remove a tool from active tools (called when tool execution ends). No-op when no matching tool is active. */
	onToolDone(toolName: string): void {
		for (const [key, name] of this._activeTools) {
			if (name === toolName) {
				this._activeTools.delete(key);
				break;
			}
		}
	}

	/** Reset the current response text (called at the start of each assistant message). */
	onMessageStart(): void {
		this._responseText = "";
	}

	/** Append a text delta to the current response text. */
	onMessageUpdate(delta: string): void {
		this._responseText += delta;
	}

	/** Record that a turn has ended; increments turnCount. */
	onTurnEnd(): void {
		this._turnCount++;
	}

	/** Bind the session reference (called once when the agent session is created). */
	setSession(session: SessionLike): void {
		this._session = session;
	}

	// ── Read-only accessors ──────────────────────────────────────────────────

	/** Currently-active tools: key → tool name. Multiple entries for concurrent same-name tools. */
	get activeTools(): ReadonlyMap<string, string> {
		return this._activeTools;
	}

	/** The agent's latest partial response text (reset at each message start). */
	get responseText(): string {
		return this._responseText;
	}

	/** The active SDK session, or undefined before the first session is created. */
	get session(): SessionLike | undefined {
		return this._session;
	}

	/** Current turn count (starts at 1). */
	get turnCount(): number {
		return this._turnCount;
	}

	/** Effective max turns for this agent, or undefined for unlimited. */
	get maxTurns(): number | undefined {
		return this._maxTurns;
	}

}
