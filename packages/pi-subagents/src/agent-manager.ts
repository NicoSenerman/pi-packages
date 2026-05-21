/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentRecord } from "./agent-record.js";
import type { AgentRunner } from "./agent-runner.js";
import { AgentTypeRegistry } from "./agent-types.js";
import { debugLog } from "./debug.js";
import type { ExecutionState } from "./execution-state.js";
import { buildParentSnapshot } from "./parent-snapshot.js";
import { subscribeRecordObserver } from "./record-observer.js";
import type { RunConfig } from "./runtime.js";
import type { AgentInvocation, IsolationMode, ParentSnapshot, ShellExec, SubagentType, ThinkingLevel } from "./types.js";
import type { WorktreeManager } from "./worktree.js";
import { WorktreeState } from "./worktree-state.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

export interface AgentManagerOptions {
  runner: AgentRunner;
  worktrees: WorktreeManager;
  exec: ShellExec;
  registry: AgentTypeRegistry;
  /** Injected getter for the concurrency limit — owned by SettingsManager. */
  getMaxConcurrent?: () => number;
  getRunConfig?: () => RunConfig;
  onStart?: OnAgentStart;
  onComplete?: OnAgentComplete;
  onCompact?: OnAgentCompact;
}

interface SpawnArgs {
  snapshot: ParentSnapshot;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Useful for
   * callers (e.g. cross-extension RPC) that must not be deferred by the queue.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called when the agent session is created — the one remaining callback. */
  onSessionCreated?: (session: AgentSession) => void;
  /** Path to the parent session's JSONL file (for deriving the subagent session directory). */
  parentSessionFile?: string;
  /** Session ID of the parent agent (stored in the child session's parentSession header). */
  parentSessionId?: string;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
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
  /** Steers buffered for agents whose session hasn’t been created yet. */
  private pendingSteers = new Map<string, string[]>();

  constructor(options: AgentManagerOptions) {
    this.runner = options.runner;
    this.worktrees = options.worktrees;
    this.exec = options.exec;
    this.registry = options.registry;
    this.onComplete = options.onComplete;
    this.onStart = options.onStart;
    this.onCompact = options.onCompact;
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
   * Buffer a steer message for an agent whose session isn’t ready yet.
   * Returns false if the agent id is not tracked (already cleaned up or unknown).
   * Called by steer-tool and service-adapter when record.execution is undefined.
   */
  queueSteer(id: string, message: string): boolean {
    if (!this.agents.has(id)) return false;
    const steers = this.pendingSteers.get(id) ?? [];
    steers.push(message);
    this.pendingSteers.set(id, steers);
    return true;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
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

    const snapshot = buildParentSnapshot(ctx, options.inheritContext);
    const args: SpawnArgs = { snapshot, type, prompt, options };

    if (options.isBackground && !options.bypassQueue && this.runningBackground >= this._getMaxConcurrent()) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
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
    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = this.worktrees.create(id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktreeState = new WorktreeState(wt);
      // Keep legacy field in sync during migration
      record.worktree = wt;
      worktreeCwd = wt.path;
    }

    record.markRunning(Date.now());
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    let unsubRecordObserver: (() => void) | undefined;

    const runConfig = this.getRunConfig?.();
    const promise = this.runner.run(snapshot, type, prompt, {
      exec: this.exec,
      model: options.model,
      maxTurns: options.maxTurns,
      defaultMaxTurns: runConfig?.defaultMaxTurns,
      graceTurns: runConfig?.graceTurns,
      isolated: options.isolated,
      thinkingLevel: options.thinkingLevel,
      cwd: worktreeCwd,
      parentSessionFile: options.parentSessionFile,
      parentSessionId: options.parentSessionId,
      signal: record.abortController!.signal,
      registry: this.registry,
      onSessionCreated: (session) => {
        // Capture the session file path early so it's available for display
        // before the run completes (e.g. in background agent status messages).
        const outputFile = session.sessionManager?.getSessionFile?.() ?? undefined;
        // Set the execution-state collaborator — born complete at session creation.
        const execution: ExecutionState = { session, outputFile };
        record.execution = execution;
        // Keep legacy fields in sync during migration
        record.session = session;
        if (outputFile) record.outputFile = outputFile;
        // Flush any steers that arrived before the session was ready
        const buffered = this.pendingSteers.get(id);
        if (buffered?.length) {
          for (const msg of buffered) {
            session.steer(msg).catch(() => {});
          }
          this.pendingSteers.delete(id);
        }
        // Subscribe record observer for stats accumulation
        unsubRecordObserver = subscribeRecordObserver(session, record, {
          onCompact: (r, info) => this.onCompact?.(r, info),
        });
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered, sessionFile }) => {
        unsubRecordObserver?.();
        detach();

        // Clean up worktree before transition so the final result includes branch text
        let finalResult = responseText;
        if (record.worktreeState) {
          const wtResult = this.worktrees.cleanup(record.worktreeState, options.description);
          record.worktreeState.recordCleanup(wtResult);
          // Keep legacy field in sync during migration
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            finalResult += `\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
          }
        }

        // Transition — guards against overwriting externally-stopped status
        if (aborted) record.markAborted(finalResult);
        else if (steered) record.markSteered(finalResult);
        else record.markCompleted(finalResult);

        record.session = session;
        if (sessionFile) record.outputFile = sessionFile;

        if (options.isBackground) {
          this.runningBackground--;
          try { this.onComplete?.(record); } catch (err) { debugLog("onComplete callback", err); }
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        record.markError(err);

        unsubRecordObserver?.();
        detach();

        // Best-effort worktree cleanup on error
        if (record.worktreeState) {
          try {
            const wtResult = this.worktrees.cleanup(record.worktreeState, options.description);
            record.worktreeState.recordCleanup(wtResult);
            // Keep legacy field in sync during migration
            record.worktreeResult = wtResult;
          } catch (err) { debugLog("cleanupWorktree on agent error", err); }
        }

        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this._getMaxConcurrent()) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.markError(err);
        this.onComplete?.(record);
      }
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(ctx, type, prompt, { ...options, isBackground: false });
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
    if (!record?.session) return undefined;

    record.resetForResume(Date.now());

    const unsubResume = subscribeRecordObserver(record.session, record, {
      onCompact: (r, info) => this.onCompact?.(r, info),
    });

    try {
      const responseText = await this.runner.resume(record.session, prompt, {
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

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.markStopped();
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
    this.pendingSteers.delete(id);
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
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
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
      if (record.status === "running") {
        record.abortController?.abort();
        record.markStopped();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
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
