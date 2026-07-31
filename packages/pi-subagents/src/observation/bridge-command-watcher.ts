import { watchFile, unwatchFile, readFileSync, statSync } from "node:fs";
import type { SubagentManager } from "#src/lifecycle/subagent-manager";
import { debugLog } from "#src/debug";

const DEFAULT_COMMAND_FILE = `${process.env.HOME ?? ""}/.pi/agent/pi-rust-tui-bridge.commands.jsonl`;

/** Per-invocation command file set by the pitui-daemon on its pi child so
 *  parallel `piru` windows don't mix abort commands. Falls back to the shared
 *  per-user path for older daemons. */
function defaultCommandFile(): string {
  return process.env.PITUI_BRIDGE_COMMAND_FILE ?? DEFAULT_COMMAND_FILE;
}
const POLL_INTERVAL_MS = 500;

export interface BridgeCommandDeps {
  manager: SubagentManager;
  path?: string;
}

/** Commands the bridge understands. Abort is the only op today. */
export interface BridgeCommand {
  op: string;
  agentId: string;
}

export interface BridgeRouter {
  abort(id: string): boolean;
}

/**
 * Apply a parsed bridge command to the manager. Pure (no I/O) so it can be
 * unit-tested without the real file watcher. Unknown ops or missing ids are
 * ignored; pi's `i`/`a` both surface as `{op:"abort", agentId}`,
 * `manager.abort` itself distinguishes queued vs running.
 */
export function routeBridgeCommand(
  router: BridgeRouter,
  cmd: { op?: string; agentId?: string },
): boolean {
  if (cmd.op !== "abort" || !cmd.agentId) return false;
  return router.abort(cmd.agentId);
}

/**
 * pitui bridge: lets the daemon ask pi-subagents to abort a specific agent
 * out-of-band. The daemon appends `{"op":"abort","agentId":"…"}` lines to a
 * JSONL command file; this watcher tails it.
 *
 * There is no RPC command on pi that aborts a single subagent, and the manager
 * lives inside the pi process — so the file is the cross-process transport.
 * `fs.watchFile` polls (the daemon may not flush inotify'd writes promptly
 * under load), and the watcher tracks its byte offset to process only new
 * lines and survive restarts without replaying stale commands.
 *
 * Gated by `PITUI_BRIDGE` so native pi sessions never start a watcher.
 */
export class BridgeCommandWatcher {
  private readonly manager: SubagentManager;
  private readonly path: string;
  private readonly enabled: boolean;
  private active = false;
  private offset = 0;

  constructor(deps: BridgeCommandDeps) {
    this.manager = deps.manager;
    this.path = deps.path ?? defaultCommandFile();
    this.enabled =
      process.env.PITUI_BRIDGE === "1" || process.env.PITUI_BRIDGE === "true";
  }

  start(): void {
    if (!this.enabled || this.active) return;
    this.active = true;
    this.seedOffset();
    debugLog(
      "BridgeCommandWatcher.start",
      `watching ${this.path} from offset ${this.offset}`,
    );
    watchFile(this.path, { interval: POLL_INTERVAL_MS }, () => {
      void this.drain().catch((err) =>
        debugLog("BridgeCommandWatcher.drain", err),
      );
    });
  }

  stop(): void {
    if (!this.enabled || !this.active) return;
    this.active = false;
    unwatchFile(this.path);
  }

  /** Seed the read offset to EOF so we never replay stale commands on start. */
  private seedOffset(): void {
    try {
      this.offset = statSync(this.path).size;
    } catch {
      this.offset = 0;
    }
  }

  private async drain(): Promise<void> {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size === this.offset) return;
    if (size < this.offset) {
      // Truncated/rotated — start fresh from the top.
      this.offset = 0;
    }
    let data: Buffer;
    try {
      data = readFileSync(this.path);
    } catch (err) {
      debugLog("BridgeCommandWatcher.read", err);
      return;
    }
    const tail = data.subarray(this.offset);
    this.offset = size;
    for (const raw of tail.toString("utf8").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const cmd = JSON.parse(line) as { op?: string; agentId?: string };
        routeBridgeCommand(this.manager, cmd);
      } catch (err) {
        debugLog("BridgeCommandWatcher.parse", err);
      }
    }
  }
}
