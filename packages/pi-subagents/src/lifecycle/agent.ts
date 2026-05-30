/**
 * agent.ts — Agent class with encapsulated status-transition logic and per-agent behavior.
 *
 * Status transitions (status, result, error, startedAt, completedAt) are owned
 * by the class and exposed via transition methods. External code reads these
 * fields through public properties but cannot write them directly.
 *
 * Stats (toolUses, lifetimeUsage, compactionCount) are owned by the class and
 * accumulated via mutation methods (incrementToolUses, addUsage, incrementCompactions).
 *
 * Behavior (abort, steer buffering) lives on the agent rather than on
 * AgentManager — each agent manages its own lifecycle concerns.
 *
 * The child's working directory is supplied by a registered WorkspaceProvider
 * (the workspace seam); with no provider the child runs in the parent cwd.
 *
 * Phase-specific collaborators (subagentSession, notification) are attached
 * after construction as lifecycle information becomes available.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { debugLog } from "#src/debug";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import { addUsage } from "#src/lifecycle/usage";
import type { Workspace, WorkspaceProvider } from "#src/lifecycle/workspace";
import { NotificationState } from "#src/observation/notification-state";
import { subscribeAgentObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import type { AgentInvocation, CompactionInfo, ParentSessionInfo, SubagentType, ThinkingLevel } from "#src/types";

/** Per-agent lifecycle observer — created by AgentManager for each spawn. */
export interface AgentLifecycleObserver {
	/** Fires when the agent transitions to running (inside run(), after markRunning). */
	onStarted?(agent: Agent): void;
	/** Fires once the session is created — delivers the session to external consumers. */
	onSessionCreated?(agent: Agent, session: AgentSession): void;
	/** Fires once when the run completes or fails (for concurrency drain). */
	onRunFinished?(agent: Agent): void;
	/** Fires on compaction events during the run. */
	onCompacted?(agent: Agent, info: CompactionInfo): void;
}

export type AgentStatus =
	| "queued"
	| "running"
	| "completed"
	| "steered"
	| "aborted"
	| "stopped"
	| "error";

export interface AgentInit {
	// Identity
	id: string;
	type: SubagentType;
	description: string;
	invocation?: AgentInvocation;

	// Status (for tests and restore scenarios)
	status?: AgentStatus;
	startedAt?: number;
	completedAt?: number;
	result?: string;
	error?: string;

	// Shared deps (required for run(), optional for tests)
	/** Assembly factory that produces a born-complete SubagentSession. */
	createSubagentSession?: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
	observer?: AgentLifecycleObserver;
	getRunConfig?: () => RunConfig;
	/** Resolves the registered workspace provider (if any) at run-start. */
	getWorkspaceProvider?: () => WorkspaceProvider | undefined;
	/** Parent working directory handed to a workspace provider's prepare(). */
	baseCwd?: string;

	// Run config (required for run(), optional for tests)
	snapshot?: ParentSnapshot;
	prompt?: string;
	model?: Model<any>;
	maxTurns?: number;
	thinkingLevel?: ThinkingLevel;
	parentSession?: ParentSessionInfo;
	isBackground?: boolean;
	signal?: AbortSignal;
}

export class Agent {
	// Identity — set once at construction
	readonly id: string;
	readonly type: SubagentType;
	readonly description: string;
	readonly invocation?: AgentInvocation;

	// Transition state — encapsulated behind getters, mutated only via transition methods
	private _status: AgentStatus;
	get status(): AgentStatus { return this._status; }

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

	/** AbortController for cancelling this agent. Created at construction. */
	readonly abortController: AbortController;
	/** Promise for the full agent run (including post-processing). Set by run(). */
	promise?: Promise<void>;

	// Shared deps — optional (required for run())
	private readonly _createSubagentSession?: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
	readonly observer?: AgentLifecycleObserver;
	private readonly _getRunConfig?: () => RunConfig;
	private readonly _getWorkspaceProvider?: () => WorkspaceProvider | undefined;
	private readonly _baseCwd: string;
	/** Workspace prepared at run-start by a provider — undefined when none is registered. */
	private _workspace?: Workspace;

	// Run config — optional (required for run())
	private readonly _snapshot?: ParentSnapshot;
	private readonly _prompt?: string;
	private readonly _model?: Model<any>;
	private readonly _maxTurns?: number;
	private readonly _thinkingLevel?: ThinkingLevel;
	private readonly _parentSession?: ParentSessionInfo;
	private readonly _signal?: AbortSignal;

	// Phase-specific collaborators — each born complete when their info becomes available
	/** The born-complete child session — set when the factory returns inside run(). */
	subagentSession?: SubagentSession;
	notification?: NotificationState;

	// Steer buffer — messages queued before the session is ready
	private _pendingSteers: string[] = [];
	/** Number of steer messages waiting to be delivered. */
	get pendingSteerCount(): number { return this._pendingSteers.length; }

	/** The active agent session, or undefined before the session is created. */
	get session(): AgentSession | undefined {
		return this.subagentSession?.session;
	}

	/** Path to the agent's session JSONL file, or undefined if not yet available. */
	get outputFile(): string | undefined {
		return this.subagentSession?.outputFile;
	}

	/** Returns true when a SubagentSession is available (session is ready). */
	isSessionReady(): boolean {
		return this.subagentSession != null;
	}

	/**
	 * Deliver or buffer a steer message.
	 * Returns true when delivered immediately; false when buffered for later delivery.
	 */
	async steer(message: string): Promise<boolean> {
		if (!this.subagentSession) {
			this.queueSteer(message);
			return false;
		}
		await this.subagentSession.steer(message);
		return true;
	}

	/** Return the session conversation as formatted text, or undefined if no session. */
	getConversation(): string | undefined {
		return this.subagentSession?.getConversation();
	}

	/** Return the session context window utilization (0-100), or null if unavailable. */
	getContextPercent(): number | null {
		return this.subagentSession?.getContextPercent() ?? null;
	}

	/**
	 * Subscribe to session events for live updates (e.g., conversation viewer).
	 * Returns an unsubscribe function, or undefined if no session is available.
	 */
	subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined {
		return this.subagentSession?.subscribe(fn);
	}

	/** The session's message history, or an empty array if no session. */
	get messages(): readonly unknown[] {
		return this.subagentSession?.messages ?? [];
	}

	constructor(init: AgentInit) {
		// Identity
		this.id = init.id;
		this.type = init.type;
		this.description = init.description;
		this.invocation = init.invocation;

		// Status
		this._status = init.status ?? "queued";
		this._result = init.result;
		this._error = init.error;
		this._startedAt = init.startedAt ?? Date.now();
		this._completedAt = init.completedAt;

		// Stats
		this._toolUses = 0;
		this._lifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
		this._compactionCount = 0;

		// Abort controller — always created, never injected
		this.abortController = new AbortController();

		// Shared deps
		this._createSubagentSession = init.createSubagentSession;
		this.observer = init.observer;
		this._getRunConfig = init.getRunConfig;
		this._getWorkspaceProvider = init.getWorkspaceProvider;
		this._baseCwd = init.baseCwd ?? "";

		// Run config
		this._snapshot = init.snapshot;
		this._prompt = init.prompt;
		this._model = init.model;
		this._maxTurns = init.maxTurns;
		this._thinkingLevel = init.thinkingLevel;
		this._parentSession = init.parentSession;
		this._signal = init.signal;

		// Notification state — created from parentSession.toolCallId if present
		if (init.parentSession?.toolCallId) {
			this.notification = new NotificationState(init.parentSession.toolCallId);
		}
	}

	/**
	 * Execute the full agent lifecycle: workspace preparation, session creation
	 * via the factory, observer wiring, the turn loop, workspace disposal, and
	 * status transitions.
	 *
	 * Requires the session factory and snapshot to be set at construction.
	 * The returned promise always resolves (errors are captured internally).
	 */
	async run(): Promise<void> {
		if (!this._createSubagentSession) {
			throw new Error("Agent not configured for execution — missing session factory");
		}
		if (!this._snapshot || !this._prompt) {
			throw new Error("Agent not configured for execution — missing snapshot or prompt");
		}

		this.markRunning(Date.now());
		this.observer?.onStarted?.(this);
		this.wireSignal(this._signal, () => this.abort());

		let cwd: string | undefined;
		try {
			// A registered workspace provider supplies the child's cwd and owns its
			// teardown; with no provider the child runs in the parent cwd.
			const provider = this._getWorkspaceProvider?.();
			if (provider) {
				this._workspace = await provider.prepare({
					agentId: this.id,
					agentType: this.type,
					baseCwd: this._baseCwd,
					invocation: this.invocation,
				});
				cwd = this._workspace?.cwd;
			}
		} catch (err) {
			this.markError(err);
			this.releaseListeners();
			this.observer?.onRunFinished?.(this);
			return;
		}

		try {
			this.subagentSession = await this._createSubagentSession({
				snapshot: this._snapshot,
				type: this.type,
				cwd,
				parentSession: this._parentSession,
				model: this._model,
				thinkingLevel: this._thinkingLevel,
			});
		} catch (err) {
			// The factory disposed its own session on a post-creation failure.
			this.failRun(err);
			return;
		}

		const session = this.subagentSession.session;
		this.flushPendingSteers();
		this.attachObserver(subscribeAgentObserver(session, this, {
			onCompact: (r, info) => this.observer?.onCompacted?.(r, info),
		}));
		this.observer?.onSessionCreated?.(this, session);

		const runConfig = this._getRunConfig?.();
		try {
			const result = await this.subagentSession.runTurnLoop(this._prompt, {
				maxTurns: this._maxTurns,
				defaultMaxTurns: runConfig?.defaultMaxTurns,
				graceTurns: runConfig?.graceTurns,
				signal: this.abortController.signal,
			});
			this.completeRun(result);
		} catch (err) {
			this.failRun(err);
		}
	}

	/**
	 * Resume an existing session with a new prompt, managing the observer
	 * subscription lifecycle internally (same wiring as run()).
	 *
	 * Requires an existing SubagentSession (set when the original run created it).
	 * The returned promise always resolves (errors are captured internally).
	 * The parent signal flows straight through to resumeTurnLoop — resume does not
	 * route through this.abortController.
	 */
	async resume(prompt: string, signal?: AbortSignal): Promise<void> {
		const subagentSession = this.subagentSession;
		if (!subagentSession) {
			throw new Error("Agent not configured for resume — missing session");
		}

		this.resetForResume(Date.now());
		this.attachObserver(subscribeAgentObserver(subagentSession.session, this, {
			onCompact: (r, info) => this.observer?.onCompacted?.(r, info),
		}));

		try {
			const responseText = await subagentSession.resumeTurnLoop(prompt, signal);
			this.markCompleted(responseText);
		} catch (err) {
			this.markError(err);
		} finally {
			this.releaseListeners();
		}
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
	 * Queue removal is handled by AgentManager via ConcurrencyQueue.dequeue().
	 */
	abort(): boolean {
		if (this._status !== "running") return false;
		this.abortController.abort();
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
	 * Called once the session is available, delegating to SubagentSession.steer.
	 */
	flushPendingSteers(): void {
		for (const msg of this._pendingSteers) {
			this.subagentSession?.steer(msg).catch(() => {});
		}
		this._pendingSteers = [];
	}

	/** Reset for resume: running status, new startedAt, clear completedAt/result/error/listeners. */
	resetForResume(startedAt: number): void {
		this._status = "running";
		this._startedAt = startedAt;
		this._completedAt = undefined;
		this._result = undefined;
		this._error = undefined;
		this.releaseListeners();
	}

	// --- Per-run listener state (released on completion or resume reset) ---
	private _unsub?: () => void;
	private _detachFn?: () => void;

	/** Wire a parent AbortSignal so it stops this agent when fired. */
	wireSignal(signal: AbortSignal | undefined, onAbort: () => void): void {
		if (!signal) return;
		const listener = () => onAbort();
		signal.addEventListener("abort", listener, { once: true });
		this._detachFn = () => signal.removeEventListener("abort", listener);
	}

	/** Store the record-observer unsubscribe handle. */
	attachObserver(unsub: () => void): void {
		this._unsub = unsub;
	}

	/** Release observer + signal listener handles. */
	releaseListeners(): void {
		this._unsub?.();
		this._unsub = undefined;
		this._detachFn?.();
		this._detachFn = undefined;
	}

	/** Complete a run: release listeners, dispose the workspace, status transition, notify observer. */
	completeRun(result: TurnLoopResult): void {
		this.releaseListeners();

		let finalResult = result.responseText;
		if (this._workspace) {
			const finalStatus: AgentStatus = result.aborted
				? "aborted"
				: result.steered
					? "steered"
					: "completed";
			const disposeResult = this._workspace.dispose({ status: finalStatus, description: this.description });
			if (disposeResult?.resultAddendum) finalResult += disposeResult.resultAddendum;
		}

		if (result.aborted) this.markAborted(finalResult);
		else if (result.steered) this.markSteered(finalResult);
		else this.markCompleted(finalResult);

		this.observer?.onRunFinished?.(this);
	}

	/** Dispose the wrapped session, firing the `disposed` lifecycle event. */
	disposeSession(): void {
		this.subagentSession?.dispose();
	}

	/** Fail a run: mark error, release listeners, best-effort workspace dispose, notify observer. */
	failRun(err: unknown): void {
		this.markError(err);
		this.releaseListeners();

		try {
			if (this._workspace) this._workspace.dispose({ status: "error", description: this.description });
		} catch (cleanupErr) { debugLog("workspace dispose on agent error", cleanupErr); }

		this.observer?.onRunFinished?.(this);
	}
}
