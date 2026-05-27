/**
 * agent-manager.ts - Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { debugLog } from "#src/debug";
import { AgentRecord } from "#src/lifecycle/agent-record";
import type { AgentRunner, RunResult } from "#src/lifecycle/agent-runner";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { WorktreeManager } from "#src/lifecycle/worktree";

import { NotificationState } from "#src/observation/notification-state";
import { subscribeRecordObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import type { AgentInvocation, IsolationMode, ShellExec, SubagentType, ThinkingLevel } from "#src/types";

/**
 * RunHandle - per-run lifecycle object that owns cleanup state.
 *
 * Owns the observer unsubscribe and parent-signal detach handles acquired during
 * a run. Exposes `complete()` and `fail()` as the only way to finish a run,
 * eliminating mutable closure variables from `startAgent`.
 * `fireOnFinished` is idempotent - safe to call from both success and error paths.
 */
class RunHandle {
  private unsub?: () => void;
  private detachFn?: () => void;
  private onFinished?: () => void;

  constructor(
    private readonly record: AgentRecord,
    private readonly worktrees: WorktreeManager,
    onFinished?: () => void,
  ) {
    this.onFinished = onFinished;
  }

  /** Wire a parent AbortSignal so it stops this agent when fired. */
  wireSignal(signal: AbortSignal | undefined, onAbort: () => void): void {
    if (!signal) return;
    const listener = () => onAbort();
    signal.addEventListener("abort", listener, { once: true });
    this.detachFn = () => signal.removeEventListener("abort", listener);
  }

  /** Store the record-observer unsubscribe handle (called from onSessionCreated). */
  attachObserver(unsub: () => void): void {
    this.unsub = unsub;
  }

  /** Complete a run successfully - clean up, transition record, fire onFinished. */
  complete(result: RunResult): string {
    this.releaseListeners();

    let finalResult = result.responseText;
    if (this.record.worktreeState) {
      const wtResult = this.record.worktreeState.performCleanup(this.worktrees, this.record.description);
      if (wtResult.hasChanges && wtResult.branch) {
        finalResult += `\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
      }
    }

    if (result.aborted) this.record.markAborted(finalResult);
    else if (result.steered) this.record.markSteered(finalResult);
    else this.record.markCompleted(finalResult);

    // Update execution with the final session/outputFile from the runner
    this.record.execution = {
      session: result.session,
      outputFile: result.sessionFile ?? this.record.execution?.outputFile,
    };

    this.fireOnFinished();
    return result.responseText;
  }

  /** Fail a run - mark error, best-effort worktree cleanup, fire onFinished. */
  fail(err: unknown): void {
    this.record.markError(err);
    this.releaseListeners();

    if (this.record.worktreeState) {
      try {
        this.record.worktreeState.performCleanup(this.worktrees, this.record.description);
      } catch (cleanupErr) { debugLog("cleanupWorktree on agent error", cleanupErr); }
    }

    this.fireOnFinished();
  }

  private releaseListeners(): void {
    this.unsub?.();
    this.unsub = undefined;
    this.detachFn?.();
    this.detachFn = undefined;
  }

  /** Fire the onFinished callback at most once. */
  private fireOnFinished(): void {
    const fn = this.onFinished;
    this.onFinished = undefined;
    fn?.();
  }
}

export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Observer interface for agent lifecycle notifications. */
export interface AgentManagerObserver {
  onAgentStarted(record: AgentRecord): void;
  onAgentCompleted(record: AgentRecord): void;
  onAgentCompacted(record: AgentRecord, info: CompactionInfo): void;
  /** Fires synchronously after a background agent record is created (before startAgent). */
  onAgentCreated(record: AgentRecord): void;
}

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

export interface AgentManagerOptions {
  runner: AgentRunner;
  worktrees: WorktreeManager;
  exec: ShellExec;
  registry: AgentTypeRegistry;
  /** Injected getter for the concurrency limit - owned by SettingsManager. */
  getMaxConcurrent?: () => number;
  getRunConfig?: () => RunConfig;
  observer?: AgentManagerObserver;
}

interface SpawnArgs {
  snapshot: ParentSnapshot;
  type: SubagentType;
  prompt: string;
  options: AgentSpawnConfig;
}

export interface ParentSessionInfo {
  /** Path to the parent session's JSONL file (for deriving the subagent session directory). */
  parentSessionFile?: string;
  /** Session ID of the parent agent (stored in the child session's parentSession header). */
  parentSessionId?: string;
  /** Tool call ID for background notification wiring. When set, spawn attaches NotificationState. */
  toolCallId?: string;
}

export interface AgentSpawnConfig {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn - start immediately even
   * if the configured concurrency limit would otherwise queue it. Useful for
   * callers (e.g. cross-extension RPC) that must not be deferred by the queue.
   */
  bypassQueue?: boolean;
  /** Isolation mode - "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal - when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called when the agent session is created - receives the session and the agent's record. */
  onSessionCreated?: (session: AgentSession, record: AgentRecord) => void;
  /** Parent session identity - grouped fields that travel together from the tool boundary. */
  parentSession?: ParentSessionInfo;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private readonly observer?: AgentManagerObserver;
  private readonly runner: AgentRunner;
  private readonly worktrees: WorktreeManager;
  private readonly exec: ShellExec;
  private readonly registry: AgentTypeRegistry;
  private readonly _getMaxConcurrent: () => number;
  private getRunConfig?: () => RunConfig;

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  constructor(options: AgentManagerOptions) {
    this.runner = options.runner;
    this.worktrees = options.worktrees;
    this.exec = options.exec;
    this.registry = options.registry;
    this.observer = options.observer;
    this.getRunConfig = options.getRunConfig;
    this._getMaxConcurrent = options.getMaxConcurrent ?? (() => DEFAULT_MAX_CONCURRENT);
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /**
   * Drain the concurrency queue after SettingsManager has updated maxConcurrent.
   * Call this whenever the concurrency limit increases so queued agents can start.
   */
  notifyConcurrencyChanged(): void {
    this.drainQueue();
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    snapshot: ParentSnapshot,
    type: SubagentType,
    prompt: string,
    options: AgentSpawnConfig,
  ): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record = new AgentRecord({
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      startedAt: Date.now(),
      abortController,
      invocation: options.invocation,
    });
    this.agents.set(id, record);

    if (options.parentSession?.toolCallId) {
      record.notification = new NotificationState(options.parentSession.toolCallId);
    }

    if (options.isBackground) {
      this.observer?.onAgentCreated(record);
    }

    const args: SpawnArgs = { snapshot, type, prompt, options };

    if (options.isBackground && !options.bypassQueue && this.runningBackground >= this._getMaxConcurrent()) {
      // Queue it - will be started when a running agent completes
      this.queue.push({ id, args });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) - clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { snapshot, type, prompt, options }: SpawnArgs) {
    const worktreeCwd = record.setupWorktree(this.worktrees, options.isolation);

    record.markRunning(Date.now());
    if (options.isBackground) this.runningBackground++;
    this.observer?.onAgentStarted(record);

    const handle = new RunHandle(
      record, this.worktrees,
      options.isBackground ? () => this.finalizeBackgroundRun(record) : undefined,
    );
    handle.wireSignal(options.signal, () => this.abort(id));

    const runConfig = this.getRunConfig?.();
    record.promise = this.runner.run(snapshot, type, prompt, {
      context: {
        exec: this.exec,
        registry: this.registry,
        cwd: worktreeCwd,
        parentSession: options.parentSession,
      },
      model: options.model,
      maxTurns: options.maxTurns,
      defaultMaxTurns: runConfig?.defaultMaxTurns,
      graceTurns: runConfig?.graceTurns,
      isolated: options.isolated,
      thinkingLevel: options.thinkingLevel,
      signal: record.abortController!.signal,
      onSessionCreated: (session) => {
        // Capture the session file path early so it's available for display
        // before the run completes (e.g. in background agent status messages).
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- sessionManager is typed as always present but Pi SDK may not provide it
        const outputFile = session.sessionManager?.getSessionFile?.() ?? undefined;
        record.execution = { session, outputFile };
        record.flushPendingSteers(session);
        handle.attachObserver(subscribeRecordObserver(session, record, {
          onCompact: (r, info) => this.observer?.onAgentCompacted(r, info),
        }));
        options.onSessionCreated?.(session, record);
      },
    })
      .then((result) => handle.complete(result))
      .catch((err: unknown) => { handle.fail(err); return ""; });
  }

  /** Decrement background counter, notify observer (crash-safe), and drain the queue. */
  private finalizeBackgroundRun(record: AgentRecord): void {
    this.runningBackground--;
    try { this.observer?.onAgentCompleted(record); } catch (err) { debugLog("onAgentCompleted observer", err); }
    this.drainQueue();
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this._getMaxConcurrent()) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (record?.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) - surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.markError(err);
        this.observer?.onAgentCompleted(record);
      }
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    snapshot: ParentSnapshot,
    type: SubagentType,
    prompt: string,
    options: Omit<AgentSpawnConfig, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(snapshot, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    const session = record?.session;
    if (!session) return undefined;

    record.resetForResume(Date.now());

    const unsubResume = subscribeRecordObserver(session, record, {
      onCompact: (r, info) => this.observer?.onAgentCompacted(r, info),
    });

    try {
      const responseText = await this.runner.resume(session, prompt, {
        signal,
      });
      record.markCompleted(responseText);
    } catch (err) {
      record.markError(err);
    } finally {
      unsubResume();
    }

    return record;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.markStopped();
      return true;
    }

    return record.abort();
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- dispose may not exist on all session implementations
    record.session?.dispose?.();
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  // fallow-ignore-next-line unused-class-member
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  // fallow-ignore-next-line unused-class-member
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.markStopped();
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.abort()) count++;
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  // fallow-ignore-next-line unused-class-member
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit - as running
    // agents finish they start queued ones, which need awaiting too.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop with explicit break
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter((p): p is Promise<string> => p != null);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { this.worktrees.prune(); } catch (err) { debugLog("pruneWorktrees on dispose", err); }
  }
}
