import { debugLog } from "#src/debug";
import type { SubagentManager } from "#src/lifecycle/subagent-manager";
import type { Subagent } from "#src/lifecycle/subagent";

/**
 * pitui bridge: emits structured snapshots of all subagents via appendEntry so
 * a non-interactive host (pitui, an RPC TUI) can render a live agent panel with
 * the same fidelity as pi's built-in monitor overlay.
 *
 * Gated by the `PITUI_BRIDGE` env var: inactive by default, so native pi sessions
 * pay zero overhead and the snapshot entries are never written. Over RPC, pitui
 * sets PITUI_BRIDGE=1 when spawning the daemon.
 *
 * Event-driven, not timer-driven: each running subagent subscribes to its own
 * session event stream on start, and a debounced emit coalesces a burst of
 * session events (tool starts/ends, message deltas, turn ends, compactions) into
 * a single snapshot. This replaces the previous 250ms blind tick, which wrote
 * thousands of durable entries per session (one observed session had 3,799 /
 * 3.4MB). Lifecycle transitions (created/completed) emit immediately so the
 * panel reflects spawns and terminal states without waiting for the next event.
 *
 * Unknown-customType appendEntry calls are a no-op in pi's interactive renderer
 * (addCustomEntryToChat returns when no renderer is registered), so even if the
 * gate is off in a host that doesn't set the env var, nothing breaks.
 */
export interface SnapshotEmitterDeps {
  manager: SubagentManager;
  appendEntry: (customType: string, data: unknown) => void;
}

/** Coalesce session-event bursts into one snapshot within this window (ms). */
const DEBOUNCE_MS = 120;

export class SnapshotEmitter {
  private readonly manager: SubagentManager;
  private readonly appendEntry: SnapshotEmitterDeps["appendEntry"];
  private readonly enabled: boolean;
  /** Per-agent unsubscribe handles, keyed by agent id. */
  private readonly subscriptions = new Map<string, () => void>();
  /** Pending debounced emit timer. */
  private pending: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: SnapshotEmitterDeps) {
    this.manager = deps.manager;
    this.appendEntry = deps.appendEntry;
    this.enabled =
      process.env.PITUI_BRIDGE === "1" || process.env.PITUI_BRIDGE === "true";
    if (this.enabled) {
      debugLog("SnapshotEmitter", "enabled (PITUI_BRIDGE)");
    }
  }

  /** Lifecycle hook for SubagentManagerObserver fan-out. */
  onSubagentCreated(_record: Subagent): void {
    if (this.enabled) this.emit();
  }

  onSubagentStarted(record: Subagent): void {
    if (!this.enabled) return;
    this.attach(record);
    this.emit();
  }

  onSubagentCompleted(_record: Subagent): void {
    if (!this.enabled) return;
    this.emit();
  }

  onSubagentFinished(record: Subagent): void {
    if (!this.enabled) return;
    this.detach(record.id);
    this.emit();
  }

  onSubagentCompacted(_record: Subagent, _info: unknown): void {
    if (this.enabled) this.scheduleEmit();
  }

  /** Subscribe to the agent's live session events; debounced re-snapshot.
   *  subagentSession only exists after the async session factory resolves
   *  mid-run; lifecycle hooks fire earlier and subscribeToUpdates silently
   *  returns undefined there, so emit() keeps retrying while the agent runs. */
  private attach(agent: Subagent): void {
    this.detach(agent.id);
    const unsub = agent.subscribeToUpdates(() => this.onAgentEvent(agent));
    if (unsub) this.subscriptions.set(agent.id, unsub);
  }

  private ensureSubscriptions(): void {
    for (const agent of this.manager.listAgents()) {
      if (agent.status === "running" && !this.subscriptions.has(agent.id)) {
        this.attach(agent);
      }
    }
  }

  private detach(id: string): void {
    const unsub = this.subscriptions.get(id);
    if (unsub) {
      try {
        unsub();
      } catch (err) {
        debugLog("SnapshotEmitter.detach", err);
      }
      this.subscriptions.delete(id);
    }
  }

  /** Per-agent session event: coalesce into a debounced snapshot. */
  private onAgentEvent(_agent: Subagent): void {
    this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.emit();
    }, DEBOUNCE_MS);
  }

  private emit(): void {
    if (!this.enabled) return;
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    this.ensureSubscriptions();
    const agents = this.manager.listAgents();
    const snapshot = agents.map(snapshotAgent);
    try {
      this.appendEntry("pitui:subagents:snapshot", { agents: snapshot });
    } catch (err) {
      debugLog("SnapshotEmitter.emit", err);
    }
  }

  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    for (const id of [...this.subscriptions.keys()]) this.detach(id);
  }
}

function snapshotAgent(a: Subagent) {
  const usage = a.lifetimeUsage;
  return {
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
    result: a.result,
    error: a.error,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    toolUses: a.toolUses,
    turnCount: a.turnCount,
    maxTurns: a.maxTurns,
    activeTools: [...a.activeTools.values()],
    responseText: a.responseText,
    thinking: a.thinking,
    compactionCount: a.compactionCount,
    lifetimeUsage: {
      input: usage.input,
      output: usage.output,
      cacheWrite: usage.cacheWrite,
    },
    contextPercent: a.getContextPercent(),
    runInBackground: a.invocation?.runInBackground ?? false,
    // Absolute path to the agent's own JSONL session file; pitui tails this
    // when the user opens the conversation view.
    outputFile: a.outputFile ?? null,
  };
}
