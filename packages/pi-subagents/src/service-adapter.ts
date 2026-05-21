/**
 * service-adapter.ts — Adapter that wraps AgentManager to satisfy SubagentsService.
 *
 * Handles model resolution at the API boundary, record serialization
 * (stripping non-serializable fields), and session gating.
 */

import type { ModelRegistry } from "./model-resolver.js";
import type { SubagentRecord, SubagentsService } from "./service.js";
import type { AgentRecord } from "./types.js";

/** Narrow interface for the AgentManager — avoids coupling to the concrete class. */
export interface AgentManagerLike {
  spawn(ctx: unknown, type: string, prompt: string, options: unknown): string;
  getRecord(id: string): AgentRecord | undefined;
  listAgents(): AgentRecord[];
  abort(id: string): boolean;
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  queueSteer(id: string, message: string): boolean;
}

/** Dependencies injected into the adapter factory. */
export interface AdapterDeps {
  manager: AgentManagerLike;
  resolveModel: (input: string, registry: ModelRegistry) => unknown | string;
  getCtx: () => { pi: unknown; ctx: unknown } | undefined;
  getModelRegistry: () => ModelRegistry | undefined;
}

/** Create a SubagentsService backed by the given dependencies. */
export function createSubagentsService(deps: AdapterDeps): SubagentsService {
  const { manager } = deps;

  return {
    spawn(type: string, prompt: string, options?) {
      const session = deps.getCtx();
      if (!session) {
        throw new Error("No active session — cannot spawn agents outside a session.");
      }

      let model: unknown;
      if (options?.model) {
        const registry = deps.getModelRegistry();
        if (!registry) {
          throw new Error("No model registry available.");
        }
        const resolved = deps.resolveModel(options.model, registry);
        if (typeof resolved === "string") {
          throw new Error(resolved);
        }
        model = resolved;
      }

      const description = options?.description ?? prompt.slice(0, 80);
      const isBackground = !(options?.foreground ?? false);

      return manager.spawn(session.ctx, type, prompt, {
        description,
        model,
        maxTurns: options?.maxTurns,
        thinkingLevel: options?.thinkingLevel,
        isolated: options?.isolated,
        inheritContext: options?.inheritContext,
        bypassQueue: options?.bypassQueue,
        isolation: options?.isolation,
        isBackground,
      });
    },

    getRecord(id: string): SubagentRecord | undefined {
      const record = manager.getRecord(id);
      return record ? toSubagentRecord(record) : undefined;
    },

    listAgents(): SubagentRecord[] {
      return manager.listAgents().map(toSubagentRecord);
    },

    abort(id: string): boolean {
      return manager.abort(id);
    },

    async steer(id: string, message: string): Promise<boolean> {
      const record = manager.getRecord(id);
      if (!record || record.status !== "running") {
        return false;
      }
      if (!record.session) {
        // Session not ready yet — queue via manager for delivery once initialized
        return manager.queueSteer(id, message);
      }
      await record.session.steer(message);
      return true;
    },

    async waitForAll(): Promise<void> {
      return manager.waitForAll();
    },

    hasRunning(): boolean {
      return manager.hasRunning();
    },
  };
}

/**
 * Convert an internal AgentRecord to a serializable SubagentRecord.
 * Uses an explicit allowlist — new fields must be opted in.
 */
export function toSubagentRecord(record: AgentRecord): SubagentRecord {
  const out: SubagentRecord = {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    startedAt: record.startedAt,
    lifetimeUsage: record.lifetimeUsage,
    compactionCount: record.compactionCount,
  };

  if (record.result !== undefined) out.result = record.result;
  if (record.error !== undefined) out.error = record.error;
  if (record.completedAt !== undefined) out.completedAt = record.completedAt;
  if (record.worktreeResult !== undefined) out.worktreeResult = record.worktreeResult;

  return out;
}
