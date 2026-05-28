/**
 * agent-manager.ts - Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { debugLog } from "#src/debug";
import { Agent, type AgentLifecycleObserver } from "#src/lifecycle/agent";
import type { AgentRunner } from "#src/lifecycle/agent-runner";
import type { ConcurrencyQueue } from "#src/lifecycle/concurrency-queue";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { WorktreeManager } from "#src/lifecycle/worktree";

import { subscribeAgentObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import type { AgentInvocation, CompactionInfo, IsolationMode, ParentSessionInfo, SubagentType, ThinkingLevel } from "#src/types";

/** Observer interface for agent lifecycle notifications. */
export interface AgentManagerObserver {
  onAgentStarted(record: Agent): void;
  onAgentCompleted(record: Agent): void;
  onAgentCompacted(record: Agent, info: CompactionInfo): void;
  /** Fires synchronously after a background agent record is created (before run). */
  onAgentCreated(record: Agent): void;
}

export interface AgentManagerOptions {
  runner: AgentRunner;
  worktrees: WorktreeManager;
  /** Concurrency queue — owns scheduling, limit checks, and drain logic. */
  queue: ConcurrencyQueue;
  getRunConfig?: () => RunConfig;
  observer?: AgentManagerObserver;
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
  /** Per-agent lifecycle observer — replaces onSessionCreated callback. */
  observer?: AgentLifecycleObserver;
  /** Parent session identity - grouped fields that travel together from the tool boundary. */
  parentSession?: ParentSessionInfo;
}

export class AgentManager {
  private agents = new Map<string, Agent>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private readonly observer?: AgentManagerObserver;
  private readonly runner: AgentRunner;
  private readonly worktrees: WorktreeManager;
  private readonly queue: ConcurrencyQueue;
  private getRunConfig?: () => RunConfig;

  constructor(options: AgentManagerOptions) {
    this.runner = options.runner;
    this.worktrees = options.worktrees;
    this.queue = options.queue;
    this.observer = options.observer;
    this.getRunConfig = options.getRunConfig;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Compose a per-agent lifecycle observer from manager and spawn-config concerns. */
  private buildObserver(options: AgentSpawnConfig): AgentLifecycleObserver {
    return {
      onStarted: (agent) => {
        if (options.isBackground) this.queue.markStarted();
        this.observer?.onAgentStarted(agent);
      },
      onSessionCreated: options.observer?.onSessionCreated
        ? (agent, session) => options.observer!.onSessionCreated!(agent, session)
        : undefined,
      onRunFinished: (agent) => {
        if (options.isBackground) {
          this.queue.markFinished();
          try { this.observer?.onAgentCompleted(agent); } catch (err) { debugLog("onAgentCompleted observer", err); }
        }
      },
      onCompacted: (agent, info) => {
        this.observer?.onAgentCompacted(agent, info);
      },
    };
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
    const record = new Agent({
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      startedAt: Date.now(),
      invocation: options.invocation,
      // Run config
      snapshot,
      prompt,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      thinkingLevel: options.thinkingLevel,
      isolation: options.isolation,
      parentSession: options.parentSession,
      signal: options.signal,
      // Shared deps
      runner: this.runner,
      worktrees: this.worktrees,
      observer: this.buildObserver(options),
      getRunConfig: this.getRunConfig,
    });
    this.agents.set(id, record);

    if (options.isBackground) {
      this.observer?.onAgentCreated(record);
    }

    if (options.isBackground && !options.bypassQueue && this.queue.isFull()) {
      // Queue it - will be started when a running agent completes
      this.queue.enqueue(id);
      return id;
    }

    record.promise = record.run();
    return id;
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
  ): Promise<Agent> {
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
  ): Promise<Agent | undefined> {
    const record = this.agents.get(id);
    const session = record?.session;
    if (!session) return undefined;

    record.resetForResume(Date.now());

    const unsubResume = subscribeAgentObserver(session, record, {
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

  getRecord(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  listAgents(): Agent[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue.dequeue(id);
      record.markStopped();
      return true;
    }

    return record.abort();
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: Agent): void {
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
    for (const id of this.queue.queuedIds) {
      const record = this.agents.get(id);
      if (record) {
        record.markStopped();
        count++;
      }
    }
    this.queue.clear();
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.abort()) count++;
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  // fallow-ignore-next-line unused-class-member
  async waitForAll(): Promise<void> {
    // Loop because queue.drain() respects the concurrency limit - as running
    // agents finish they start queued ones, which need awaiting too.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop with explicit break
    while (true) {
      this.queue.drain();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter((p): p is Promise<void> => p != null);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue.clear();
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { this.worktrees.prune(); } catch (err) { debugLog("pruneWorktrees on dispose", err); }
  }
}
