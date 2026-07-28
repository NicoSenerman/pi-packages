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
 * The snapshot is a full list (all agents, foreground + background) emitted on
 * a timer while any agent is active, plus immediate emits on lifecycle changes.
 * Unknown-customType appendEntry calls are a no-op in pi's interactive renderer
 * (addCustomEntryToChat returns when no renderer is registered), so even if the
 * gate is off in a host that doesn't set the env var, nothing breaks.
 */
export interface SnapshotEmitterDeps {
  manager: SubagentManager;
  appendEntry: (customType: string, data: unknown) => void;
}

const TICK_MS = 250;
const ACTIVE_STATUSES = new Set(["queued", "running", "steered"]);

export class SnapshotEmitter {
  private readonly manager: SubagentManager;
  private readonly appendEntry: SnapshotEmitterDeps["appendEntry"];
  private readonly enabled: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;

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

  onSubagentStarted(_record: Subagent): void {
    if (this.enabled) {
      this.ensureTimer();
      this.emit();
    }
  }

  onSubagentCompleted(_record: Subagent): void {
    if (this.enabled) this.emit();
  }

  onSubagentCompacted(_record: Subagent, _info: unknown): void {
    if (this.enabled) this.emit();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.emit(), TICK_MS);
  }

  private emit(): void {
    if (!this.enabled) return;
    const agents = this.manager.listAgents();
    const snapshot = agents.map(snapshotAgent);
    try {
      this.appendEntry("pitui:subagents:snapshot", { agents: snapshot });
    } catch (err) {
      debugLog("SnapshotEmitter.emit", err);
    }
    const anyActive = agents.some((a) => ACTIVE_STATUSES.has(a.status));
    if (!anyActive && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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
