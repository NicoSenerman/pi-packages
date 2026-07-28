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
const ACTIVE_STATUSES = new Set(["queued", "running", "steered"]);

/**
 * Grace period before the panel fades out after the last agent finishes.
 * pi's native widget keeps completed agents for 1 turn; we approximate that
 * with a timed fade so the user sees the terminal state briefly, then the
 * panel clears to an empty snapshot (pitui renders {} by hiding the widget).
 */
const FADE_MS = 3_000;
const TERMINAL_STATUSES = new Set(["completed", "error", "stopped", "aborted"]);

export class SnapshotEmitter {
  private readonly manager: SubagentManager;
  private readonly appendEntry: SnapshotEmitterDeps["appendEntry"];
  private readonly enabled: boolean;
  /** Per-agent unsubscribe handles, keyed by agent id. */
  private readonly subscriptions = new Map<string, () => void>();
  /** Pending debounced emit timer. */
  private pending: ReturnType<typeof setTimeout> | undefined;
  /** Pending fade-out timer, cancelled if a new agent starts. */
  private fadeTimer: ReturnType<typeof setTimeout> | undefined;

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
    this.cancelFade();
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
    this.scheduleFadeIfIdle();
  }

  onSubagentCompacted(_record: Subagent, _info: unknown): void {
    if (this.enabled) this.scheduleEmit();
  }

  /** Subscribe to the agent's live session events; debounced re-snapshot. */
  private attach(agent: Subagent): void {
    this.detach(agent.id);
    const unsub = agent.subscribeToUpdates(() => this.onAgentEvent(agent));
    if (unsub) this.subscriptions.set(agent.id, unsub);
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

  /**
   * If no agents are active, schedule a fade-out: emit an empty snapshot after
   * FADE_MS so the panel clears. Cancelled if a new agent starts before then.
   */
  private scheduleFadeIfIdle(): void {
    const anyActive = this.manager
      .listAgents()
      .some((a) => ACTIVE_STATUSES.has(a.status));
    if (anyActive) return;
    if (this.fadeTimer) return;
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = undefined;
      if (this.manager.listAgents().some((a) => ACTIVE_STATUSES.has(a.status)))
        return;
      try {
        this.appendEntry("pitui:subagents:snapshot", { agents: [] });
      } catch (err) {
        debugLog("SnapshotEmitter.fade", err);
      }
    }, FADE_MS);
  }

  private cancelFade(): void {
    if (this.fadeTimer) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = undefined;
    }
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
    this.cancelFade();
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
    compactionCount: a.compactionCount,
    lifetimeUsage: {
      input: usage.input,
      output: usage.output,
      cacheWrite: usage.cacheWrite,
    },
    contextPercent: a.getContextPercent(),
    runInBackground: a.invocation?.runInBackground ?? false,
  };
}
