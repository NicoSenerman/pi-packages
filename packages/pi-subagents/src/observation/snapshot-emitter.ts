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
 * Durable-entry bloat control (a real session had 21,517 snapshot entries vs
 * 731 real messages): every appendEntry is a durable session-file line that pi
 * re-parses on every resume, so the write cadence is rate-limited, not just
 * debounced:
 *   - lifecycle transitions emit immediately (material changes);
 *   - event-driven progress emits are floored to one per MIN_INTERVAL_MS,
 *     with a trailing emit so the last progress is not lost;
 *   - byte-identical payloads are never written twice (kills the attach-retry
 *     200ms re-emit loop and idle no-op snapshots);
 *   - responseText/result are truncated (the panel only ever shows a 60-char
 *     first line / 200-char result preview).
 * Live view fidelity: the agent transcript stream (PITUI_AGENT_SOCKET) is
 * unaffected; only panel stat staleness is bounded by MIN_INTERVAL_MS.
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

/** Minimum spacing between event-driven (non-material) durable writes (ms). */
const MIN_INTERVAL_MS = 5_000;

/** Cap responseText/result in snapshots; consumers render ≤60/200 chars. */
const TEXT_CAP = 512;

function capped(text: string | null | undefined): string | null {
  if (text == null) return null;
  if (text.length <= TEXT_CAP) return text;
  const cut = text.slice(0, TEXT_CAP);
  // Never split a UTF-16 surrogate pair: a lone surrogate serializes as
  // "\ud83d" and serde_json (the Rust daemon) rejects the whole line.
  const last = text.charCodeAt(TEXT_CAP - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export class SnapshotEmitter {
  private readonly manager: SubagentManager;
  private readonly appendEntry: SnapshotEmitterDeps["appendEntry"];
  private readonly enabled: boolean;
  /** Per-agent unsubscribe handles, keyed by agent id. */
  private readonly subscriptions = new Map<string, () => void>();
  /** Per-agent attach-retry timer handles (in-flight only). */
  private readonly attachRetries = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Pending debounced emit timer. */
  private pending: ReturnType<typeof setTimeout> | undefined;
  /** Trailing rate-limit timer for event-driven emits. */
  private floored: ReturnType<typeof setTimeout> | undefined;
  /** Last durable write time (ms); material emits reset the floor. */
  private lastEmitAt = 0;
  /** Last emitted payload (serialized); identical payloads are skipped. */
  private lastPayload: string | undefined;

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
    if (this.enabled) this.emit(true);
  }

  onSubagentStarted(record: Subagent): void {
    if (!this.enabled) return;
    this.attach(record);
    this.emit(true);
  }

  /**
   * A resumed run re-arms the per-record subscription — the previous run's
   * terminal released it (completeRun/failRun → listeners.release()), so
   * without this hook resume runs emit zero snapshots until the terminal one
   * (observed: 143s and 429s resume runs with no interim snapshots).
   */
  onSubagentResumeStarted(record: Subagent): void {
    if (!this.enabled) return;
    this.attach(record);
    this.emit(true);
  }

  onSubagentCompleted(_record: Subagent): void {
    if (!this.enabled) return;
    this.emit(true);
  }

  onSubagentFinished(record: Subagent): void {
    if (!this.enabled) return;
    this.detach(record.id);
    this.clearAttachRetry(record.id);
    this.emit(true);
  }

  onSubagentResumed(_record: Subagent): void {
    if (this.enabled) this.emit(true);
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
    if (unsub) {
      this.subscriptions.set(agent.id, unsub);
      this.clearAttachRetry(agent.id);
    } else if (agent.status === "running") {
      this.scheduleAttachRetry(agent);
    }
  }

  private scheduleAttachRetry(agent: Subagent): void {
    if (this.attachRetries.has(agent.id)) return;
    const t = setTimeout(() => {
      this.attachRetries.delete(agent.id);
      if (this.subscriptions.has(agent.id)) return;
      const cur = this.manager.listAgents().find((a) => a.id === agent.id);
      if (!cur?.subagentSession && cur) {
        if (cur.status === "running") this.attach(cur);
        this.emit();
        return;
      }
      if (cur && cur.status === "running") {
        this.attach(cur);
        this.emit();
      }
    }, 200);
    this.attachRetries.set(agent.id, t);
  }

  private clearAttachRetry(id: string): void {
    const t = this.attachRetries.get(id);
    if (t) {
      clearTimeout(t);
      this.attachRetries.delete(id);
    }
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

  /** Material (lifecycle) changes write immediately and clear the floor;
   *  progress writes are floored to one per MIN_INTERVAL_MS with a trailing
   *  emit so the final state always lands. (Material writes that dedupe
   *  skip clear the floor but don't reset the clock — harmless: the
   *  payload is byte-identical to what's already durable.) */
  private emit(material = false): void {
    if (!this.enabled) return;
    if (!material) {
      const since = Date.now() - this.lastEmitAt;
      if (since < MIN_INTERVAL_MS) {
        if (!this.floored) {
          this.floored = setTimeout(() => {
            this.floored = undefined;
            this.emit();
          }, MIN_INTERVAL_MS - since);
        }
        return;
      }
    }
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    if (this.floored) {
      clearTimeout(this.floored);
      this.floored = undefined;
    }
    this.ensureSubscriptions();
    const agents = this.manager.listAgents();
    const snapshot = agents.map(snapshotAgent);
    const payload = JSON.stringify(snapshot);
    if (payload === this.lastPayload) return;
    this.lastPayload = payload;
    this.lastEmitAt = Date.now();
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
    if (this.floored) {
      clearTimeout(this.floored);
      this.floored = undefined;
    }
    for (const id of [...this.subscriptions.keys()]) this.detach(id);
    for (const id of [...this.attachRetries.keys()]) this.clearAttachRetry(id);
  }
}

function snapshotAgent(a: Subagent) {
  const usage = a.lifetimeUsage;
  return {
    id: a.id,
    type: a.type,
    description: a.description,
    prompt: a.prompt,
    status: a.status,
    // "provider/modelId"; null when the agent inherits the parent's model
    // at run time (Subagent.execution.model unset).
    model: a.modelLabel ?? null,
    result: capped(a.result),
    error: capped(a.error),
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    toolUses: a.toolUses,
    turnCount: a.turnCount,
    maxTurns: a.maxTurns,
    activeTools: [...a.activeTools.values()],
    responseText: capped(a.responseText) ?? "",
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
