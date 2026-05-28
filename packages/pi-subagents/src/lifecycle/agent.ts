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
 * Behavior (abort, steer buffering, worktree setup) lives on the agent
 * rather than on AgentManager — each agent manages its own lifecycle concerns.
 *
 * Phase-specific collaborators (execution, worktreeState, notification) are attached
 * after construction as lifecycle information becomes available.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { debugLog } from "#src/debug";
import type { AgentRunner, RunResult } from "#src/lifecycle/agent-runner";
import type { ExecutionState } from "#src/lifecycle/execution-state";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import { addUsage } from "#src/lifecycle/usage";
import type { WorktreeManager } from "#src/lifecycle/worktree";
import { WorktreeState } from "#src/lifecycle/worktree-state";
import { NotificationState } from "#src/observation/notification-state";
import { subscribeAgentObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import type { AgentInvocation, CompactionInfo, IsolationMode, ParentSessionInfo, SubagentType, ThinkingLevel } from "#src/types";

/** Per-agent lifecycle observer — created by AgentManager for each spawn. */
export interface AgentLifecycleObserver {
	/** Fires when the agent transitions to running (inside run(), after markRunning). */
	onStarted?(agent: Agent): void;
	/** Fires when the runner creates the session — delivers the session to external consumers. */
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
	runner?: AgentRunner;
	worktrees?: WorktreeManager;
	observer?: AgentLifecycleObserver;
	getRunConfig?: () => RunConfig;

	// Run config (required for run(), optional for tests)
	snapshot?: ParentSnapshot;
	prompt?: string;
	model?: Model<any>;
	maxTurns?: number;
	isolated?: boolean;
	thinkingLevel?: ThinkingLevel;
	isolation?: IsolationMode;
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
	private readonly _runner?: AgentRunner;
	private readonly _worktrees?: WorktreeManager;
	readonly observer?: AgentLifecycleObserver;
	private readonly _getRunConfig?: () => RunConfig;

	// Run config — optional (required for run())
	private readonly _snapshot?: ParentSnapshot;
	private readonly _prompt?: string;
	private readonly _model?: Model<any>;
	private readonly _maxTurns?: number;
	private readonly _isolated?: boolean;
	private readonly _thinkingLevel?: ThinkingLevel;
	private readonly _isolation?: IsolationMode;
	private readonly _parentSession?: ParentSessionInfo;
	private readonly _signal?: AbortSignal;

	// Phase-specific collaborators — each born complete when their info becomes available
	execution?: ExecutionState;
	worktreeState?: WorktreeState;
	notification?: NotificationState;

	/**
	 * Create a git worktree for isolated execution, set worktreeState, and return the worktree path.
	 * Returns undefined if isolation is not "worktree".
	 * Throws if worktree creation fails (strict isolation).
	 * Uses this._worktrees and this._isolation (set at construction).
	 */
	setupWorktree(): string | undefined {
		if (this._isolation !== "worktree") return undefined;
		if (!this._worktrees) {
			throw new Error("Agent not configured for worktree isolation — missing worktrees dependency");
		}
		const wt = this._worktrees.create(this.id);
		if (!wt) {
			throw new Error(
				'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
				'Initialize git and commit at least once, or omit `isolation`.',
			);
		}
		this.worktreeState = new WorktreeState(wt);
		return wt.path;
	}

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
		this._runner = init.runner;
		this._worktrees = init.worktrees;
		this.observer = init.observer;
		this._getRunConfig = init.getRunConfig;

		// Run config
		this._snapshot = init.snapshot;
		this._prompt = init.prompt;
		this._model = init.model;
		this._maxTurns = init.maxTurns;
		this._isolated = init.isolated;
		this._thinkingLevel = init.thinkingLevel;
		this._isolation = init.isolation;
		this._parentSession = init.parentSession;
		this._signal = init.signal;

		// Notification state — created from parentSession.toolCallId if present
		if (init.parentSession?.toolCallId) {
			this.notification = new NotificationState(init.parentSession.toolCallId);
		}
	}

	/**
	 * Execute the full agent lifecycle: worktree setup, runner invocation,
	 * session-creation handling, observer wiring, worktree cleanup, and
	 * status transitions.
	 *
	 * Requires runner and snapshot to be set at construction.
	 * The returned promise always resolves (errors are captured internally).
	 */
	async run(): Promise<void> {
		if (!this._runner) {
			throw new Error("Agent not configured for execution — missing runner");
		}
		if (!this._snapshot || !this._prompt) {
			throw new Error("Agent not configured for execution — missing snapshot or prompt");
		}

		this.markRunning(Date.now());
		this.observer?.onStarted?.(this);
		this.wireSignal(this._signal, () => this.abort());

		try {
			this.setupWorktree();
		} catch (err) {
			this.markError(err);
			this.observer?.onRunFinished?.(this);
			return;
		}

		const runConfig = this._getRunConfig?.();
		try {
			const result = await this._runner.run(this._snapshot, this.type, this._prompt, {
				context: {
					cwd: this.worktreeState?.path,
					parentSession: this._parentSession,
				},
				model: this._model,
				maxTurns: this._maxTurns,
				defaultMaxTurns: runConfig?.defaultMaxTurns,
				graceTurns: runConfig?.graceTurns,
				isolated: this._isolated,
				thinkingLevel: this._thinkingLevel,
				signal: this.abortController.signal,
				onSessionCreated: (session) => {
					// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- sessionManager is typed as always present but Pi SDK may not provide it
					const outputFile = session.sessionManager?.getSessionFile?.() ?? undefined;
					this.execution = { session, outputFile };
					this.flushPendingSteers(session);
					this.attachObserver(subscribeAgentObserver(session, this, {
						onCompact: (r, info) => this.observer?.onCompacted?.(r, info),
					}));
					this.observer?.onSessionCreated?.(this, session);
				},
			});
			this.completeRun(result);
		} catch (err) {
			this.failRun(err);
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
	 * Queue removal stays on AgentManager until #230 extracts ConcurrencyQueue.
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
	 * Called from onSessionCreated once the session is available.
	 */
	flushPendingSteers(session: AgentSession): void {
		for (const msg of this._pendingSteers) {
			session.steer(msg).catch(() => {});
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

	/** Complete a run: release listeners, worktree cleanup, status transition, execution update, notify observer. */
	completeRun(result: RunResult): void {
		this.releaseListeners();

		let finalResult = result.responseText;
		if (this.worktreeState && this._worktrees) {
			const wtResult = this.worktreeState.performCleanup(this._worktrees, this.description);
			if (wtResult.hasChanges && wtResult.branch) {
				finalResult += `\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
			}
		}

		if (result.aborted) this.markAborted(finalResult);
		else if (result.steered) this.markSteered(finalResult);
		else this.markCompleted(finalResult);

		this.execution = {
			session: result.session,
			outputFile: result.sessionFile ?? this.execution?.outputFile,
		};

		this.observer?.onRunFinished?.(this);
	}

	/** Fail a run: mark error, release listeners, best-effort worktree cleanup, notify observer. */
	failRun(err: unknown): void {
		this.markError(err);
		this.releaseListeners();

		if (this.worktreeState && this._worktrees) {
			try {
				this.worktreeState.performCleanup(this._worktrees, this.description);
			} catch (cleanupErr) { debugLog("cleanupWorktree on agent error", cleanupErr); }
		}

		this.observer?.onRunFinished?.(this);
	}
}
