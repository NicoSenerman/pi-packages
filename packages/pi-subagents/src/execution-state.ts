/**
 * execution-state.ts — ExecutionState: execution-phase state for a running agent.
 *
 * Constructed and attached to AgentRecord when onSessionCreated fires inside startAgent().
 * Contains the session and output file — the two fields that become known once the
 * runner creates the session. promise stays as a separate AgentRecord field because
 * it is set at a different moment (after runner.run() returns).
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface ExecutionState {
	/** The active agent session — available from the moment the session is created. */
	readonly session: AgentSession;
	/** Path to the agent's session JSONL file, or undefined if not yet available. */
	readonly outputFile: string | undefined;
}
