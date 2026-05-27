/**
 * agent-record.ts — AgentRecord class with encapsulated status-transition logic.
 *
 * Status transitions (status, result, error, startedAt, completedAt) are owned
 * by the class and exposed via transition methods. External code reads these
 * fields through public properties but cannot write them directly.
 *
 * Stats (toolUses, lifetimeUsage, compactionCount) are owned by the class and
 * accumulated via mutation methods (incrementToolUses, addUsage, incrementCompactions).
 *
 * Behavior (abort, steer buffering, worktree setup) lives on the record rather
 * than on AgentManager — each agent manages its own lifecycle concerns.
 *
 * Phase-specific collaborators (execution, worktreeState, notification) are attached
 * after construction as lifecycle information becomes available.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExecutionState } from "#src/lifecycle/execution-state";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import { addUsage } from "#src/lifecycle/usage";
import type { WorktreeState } from "#src/lifecycle/worktree-state";
import type { NotificationState } from "#src/observation/notification-state";
import type { AgentInvocation, SubagentType } from "#src/types";

export type AgentRecordStatus =
	| "queued"
	| "running"
	| "completed"
	| "steered"
	| "aborted"
	| "stopped"
	| "error";

export interface AgentRecordInit {
	id: string;
	type: SubagentType;
	description: string;
	status?: AgentRecordStatus;
	startedAt?: number;
	completedAt?: number;
	result?: string;
	error?: string;
	abortController?: AbortController;
	invocation?: AgentInvocation;
	promise?: Promise<string>;
}

export class AgentRecord {
	// Identity — set once at construction
	readonly id: string;
	readonly type: SubagentType;
	readonly description: string;
	readonly invocation?: AgentInvocation;

	// Transition state — encapsulated behind getters, mutated only via transition methods
	private _status: AgentRecordStatus;
	get status(): AgentRecordStatus { return this._status; }

	private _result?: string;
	get result(): string | undefined { return this._result; }

	private _error?: string;
	get error(): string | undefined { return this._error; }

	private _startedAt: number;
	get startedAt(): number { return this._startedAt; }

	private _completedAt?: number;
	get completedAt(): number | undefined { return this._completedAt; }

	// Stats — accumulated via mutation methods, readable via getters
	private _toolUses: number;
	get toolUses(): number { return this._toolUses; }

	private _lifetimeUsage: LifetimeUsage;
	get lifetimeUsage(): Readonly<LifetimeUsage> { return this._lifetimeUsage; }

	private _compactionCount: number;
	get compactionCount(): number { return this._compactionCount; }

	/** AbortController for cancelling this agent. Set at construction; used only by AgentManager. */
	readonly abortController?: AbortController;
	/** Promise for the full agent run (including post-processing). Set once by AgentManager. */
	promise?: Promise<string>;

	// Phase-specific collaborators — each born complete when their info becomes available
	execution?: ExecutionState;
	worktreeState?: WorktreeState;
	notification?: NotificationState;

	// Steer buffer — messages queued before the session is ready
	private _pendingSteers: string[] = [];
	/** Number of steer messages waiting to be delivered. */
	get pendingSteerCount(): number { return this._pendingSteers.length; }

	/** The active agent session, or undefined before the session is created. */
	get session(): AgentSession | undefined {
		return this.execution?.session;
	}

	/** Path to the agent's session JSONL file, or undefined if not yet available. */
	get outputFile(): string | undefined {
		return this.execution?.outputFile;
	}

	constructor(init: AgentRecordInit) {
		this.id = init.id;
		this.type = init.type;
		this.description = init.description;
		this.invocation = init.invocation;

		this._status = init.status ?? "queued";
		this._result = init.result;
		this._error = init.error;
		this._startedAt = init.startedAt ?? Date.now();
		this._completedAt = init.completedAt;

		this._toolUses = 0;
		this._lifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
		this._compactionCount = 0;
		this.abortController = init.abortController;
		this.promise = init.promise;
	}

	/** Increment tool use count. Called by record-observer on tool_execution_end. */
	incrementToolUses(): void {
		this._toolUses++;
	}

	/** Accumulate a usage delta into lifetimeUsage. Called by record-observer on message_end. */
	addUsage(delta: { input: number; output: number; cacheWrite: number }): void {
		addUsage(this._lifetimeUsage, delta);
	}

	/** Increment compaction count. Called by record-observer on compaction_end. */
	incrementCompactions(): void {
		this._compactionCount++;
	}

	/** Transition to running state. Sets status and startedAt. */
	markRunning(startedAt: number): void {
		this._status = "running";
		this._startedAt = startedAt;
	}

	/**
	 * Transition to completed state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markCompleted(result: string, completedAt?: number): void {
		this._result = result;
		this._completedAt ??= completedAt ?? Date.now();
		if (this._status !== "stopped") {
			this._status = "completed";
		}
	}

	/**
	 * Transition to aborted state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markAborted(result: string, completedAt?: number): void {
		this._result = result;
		this._completedAt ??= completedAt ?? Date.now();
		if (this._status !== "stopped") {
			this._status = "aborted";
		}
	}

	/**
	 * Transition to steered state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markSteered(result: string, completedAt?: number): void {
		this._result = result;
		this._completedAt ??= completedAt ?? Date.now();
		if (this._status !== "stopped") {
			this._status = "steered";
		}
	}

	/**
	 * Transition to error state.
	 * Always sets error (formatted) and completedAt (??=). Only changes status if not stopped.
	 */
	markError(error: unknown, completedAt?: number): void {
		this._error = error instanceof Error ? error.message : String(error);
		this._completedAt ??= completedAt ?? Date.now();
		if (this._status !== "stopped") {
			this._status = "error";
		}
	}

	/** Transition to stopped state. Always valid — no guard. */
	markStopped(completedAt?: number): void {
		this._status = "stopped";
		this._completedAt = completedAt ?? Date.now();
	}

	/**
	 * Abort a running agent: fire AbortController and transition to stopped.
	 * Returns false if the agent is not running.
	 * Queue removal stays on AgentManager until #230 extracts ConcurrencyQueue.
	 */
	abort(): boolean {
		if (this._status !== "running") return false;
		this.abortController?.abort();
		this.markStopped();
		return true;
	}

	/**
	 * Buffer a steer message for delivery once the session is ready.
	 * Called when steer is requested before onSessionCreated fires.
	 */
	queueSteer(message: string): void {
		this._pendingSteers.push(message);
	}

	/**
	 * Flush all buffered steer messages to the session and clear the buffer.
	 * Called from onSessionCreated once the session is available.
	 */
	flushPendingSteers(session: AgentSession): void {
		for (const msg of this._pendingSteers) {
			session.steer(msg).catch(() => {});
		}
		this._pendingSteers = [];
	}

	/** Reset for resume: running status, new startedAt, clear completedAt/result/error. */
	resetForResume(startedAt: number): void {
		this._status = "running";
		this._startedAt = startedAt;
		this._completedAt = undefined;
		this._result = undefined;
		this._error = undefined;
	}
}
