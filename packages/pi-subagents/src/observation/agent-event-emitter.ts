/**
 * agent-event-emitter.ts — Bridges per-event AgentSessionEvent streaming from
 * pi-subagents to pitui-daemon over a Unix socket.
 *
 * Each running agent's `subagentSession.subscribe(fn)` emits raw
 * AgentSessionEvent objects (message_start, message_update with partial text,
 * tool_start, tool_end, etc.). This class serializes them as JSONL lines and
 * writes them to the daemon's agents.sock.
 *
 * Handles reconnect with a FIFO buffer (max ~200 entries). Replaces the
 * snapshot_emitter for per-event streaming but does NOT replace
 * snapshot_emitter for lifecycle-state snapshots — those remain for the
 * monitor panel header.
 *
 * Connect/attach lifecycle is managed by SubagentManagerObserver hooks (see
 * AgentEventObserver class below).
 */

import { connect } from "node:net";
import type { SubagentManager } from "#src/lifecycle/subagent-manager";
import type { Subagent } from "#src/lifecycle/subagent";
import type { AgentSessionEvent } from "#src/types";
import { debugLog } from "#src/debug";

/** Max buffered events before dropping oldest. */
const MAX_BUFFER = 200;

/** Path to the daemon's per-event agent streaming socket. */
function agentSocketPath(): string {
	const home = process.env.HOME ?? "/tmp";
	const runtime = process.env.XDG_RUNTIME_DIR ?? "/tmp";
	return `${runtime}/pitui/agents-${process.env.USER ?? "unknown"}.sock`;
}

/**
 * Manages one connection to the daemon's agents.sock. Serializes
 * AgentSessionEvent objects as JSONL and writes them.
 */
export class AgentEventConnection {
	private readonly path: string;
	private sock: import("node:net").Socket | null = null;
	private buffer: string[] = [];
	private connecting = false;
	private closed = false;

	constructor(path?: string) {
		this.path = path ?? agentSocketPath();
	}

	/** Connect (or reconnect) to the daemon socket. */
	async connect(): Promise<void> {
		if (this.sock && !this.sock.destroyed) return;
		if (this.connecting) return;
		this.connecting = true;

		return new Promise((resolve) => {
			const sock = connect(this.path, () => {
				this.sock = sock;
				this.connecting = false;
				// Flush buffered events.
				for (const line of this.buffer) {
					this.writeLine(line);
				}
				this.buffer = [];
				resolve();
			});
			sock.on("error", (err: Error) => {
				debugLog("AgentEventConnection.error", err.message);
				this.connecting = false;
				// Don't resolve/reject — the connection will retry on next send.
				sock.destroy();
				this.sock = null;
				resolve();
			});
			sock.on("close", () => {
				this.sock = null;
				if (!this.closed) {
					debugLog("AgentEventConnection", "connection closed; will reconnect on next send");
				}
			});
		});
	}

	/** Send an AgentSessionEvent to the daemon. */
	send(agentId: string, seq: number, event: AgentSessionEvent): void {
		if (this.closed) return;
		const line = JSON.stringify({ agentId, seq, event });
		if (!this.sock || this.connecting) {
			// Buffer until connected.
			if (this.buffer.length >= MAX_BUFFER) {
				this.buffer.shift();
			}
			this.buffer.push(line);
			if (!this.connecting) {
				void this.connect();
			}
			return;
		}
		this.writeLine(line);
	}

	private writeLine(line: string): void {
		if (!this.sock) return;
		try {
			this.sock.write(line + "\n");
		} catch (err) {
			debugLog("AgentEventConnection.writeLine", err);
		}
	}

	/** Flush any remaining buffered events. */
	flush(): void {
		if (!this.sock || this.sock.destroyed) return;
		for (const line of this.buffer) {
			this.writeLine(line);
		}
		this.buffer = [];
	}

	close(): void {
		this.closed = true;
		this.flush();
		if (this.sock) {
			this.sock.end();
			this.sock.destroy();
			this.sock = null;
		}
	}
}

/**
 * SubagentManagerObserver that subscribes each running agent's session events
 * and forwards them to the daemon via AgentEventConnection.
 *
 * Attached to the CompositeSubagentObserver so lifecycle hooks trigger attach/detach.
 */
export class AgentEventObserver {
	private readonly connection: AgentEventConnection;
	private readonly enabled: boolean;
	/** Per-agent unsubscribes, keyed by agent id. */
	private readonly subscriptions = new Map<string, () => void>();
	/** Per-agent seq counters for ordering. */
	private readonly seqCounters = new Map<string, number>();
	/** Per-agent AbortController to cap stale sessions. No more than 8 active. */
	private readonly observers = new Map<string, AbortController>();

	constructor(connection?: AgentEventConnection) {
		this.connection = connection ?? new AgentEventConnection();
		this.enabled =
			process.env.PITUI_BRIDGE === "1" || process.env.PITUI_BRIDGE === "true";
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	// ── SubagentManagerObserver hooks ──────────────────────────────────────

	onSubagentStarted(record: Subagent): void {
		if (!this.enabled) return;
		this.cancelObserver(record.id);
		record.subscribeToUpdates((event: AgentSessionEvent) => {
			this.onAgentEvent(record.id, event);
		});
	}

	onSubagentCompleted(_record: Subagent): void {
		// Event subscriptions auto-die with the session.
	}

	onSubagentFinished(record: Subagent): void {
		if (!this.enabled) return;
		this.cancelObserver(record.id);
	}

	onSubagentCompacted(_record: Subagent, _info: unknown): void {
		// No action needed for compaction on the per-event stream.
	}

	onSubagentCreated(record: Subagent): void {
		// Subscribe immediately for background agents (before run starts).
		if (!this.enabled) return;
		this.attach(record);
	}

	/** High-level: subscribe to an agent's session and pipe events to the daemon. */
	private attach(agent: Subagent): void {
		this.cancelObserver(agent.id);
		const ac = new AbortController();
		this.observers.set(agent.id, ac);

		const unsub = agent.subscribeToUpdates((event: AgentSessionEvent) => {
			if (ac.signal.aborted) return;
			this.onAgentEvent(agent.id, event);
		});
		if (unsub) {
			this.subscriptions.set(agent.id, unsub);
		}
	}

	private onAgentEvent(agentId: string, event: AgentSessionEvent): void {
		const seq = this.seqCounters.get(agentId) ?? 0;
		this.seqCounters.set(agentId, seq + 1);

		// Try connecting if not already connected (best-effort).
		this.connection.send(agentId, seq, event);
	}

	private cancelObserver(id: string): void {
		const ac = this.observers.get(id);
		if (ac) {
			ac.abort();
			this.observers.delete(id);
		}
		const unsub = this.subscriptions.get(id);
		if (unsub) {
			try {
				unsub();
			} catch (err) {
				debugLog("AgentEventObserver.unsubscribe", err);
			}
			this.subscriptions.delete(id);
		}
		this.seqCounters.delete(id);
	}

	async flush(): Promise<void> {
		this.connection.flush();
	}

	close(): void {
		for (const id of [...this.subscriptions.keys()]) {
			this.cancelObserver(id);
		}
		this.connection.close();
	}
}
