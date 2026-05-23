/**
 * runtime.ts — SubagentRuntime: composition root for all mutable extension state.
 *
 * Eliminates module-scope state in agent-runner.ts and closure-scoped state
 * in index.ts by consolidating them into a single, testable object.
 * Follows the same pattern as pi-permission-system's ExtensionRuntime.
 */

import type { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import type { UICtx } from "#src/ui/agent-widget";

/**
 * Narrow widget interface consumed by SubagentRuntime delegation methods.
 * AgentWidget satisfies this structurally; tests use plain stubs.
 */
export interface WidgetLike {
  setUICtx(ctx: UICtx): void;
  onTurnStart(): void;
  markFinished(id: string): void;
  update(): void;
  ensureTimer(): void;
}

/**
 * Narrow config subset read by AgentManager when constructing RunOptions.
 * Kept separate so callers can satisfy it without depending on the full runtime.
 */
export interface RunConfig {
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
}

/**
 * All mutable state owned by the pi-subagents extension.
 *
 * Created once inside `piSubagentsExtension()` via `createSubagentRuntime()`.
 * Tests construct a fresh runtime per test for full isolation.
 */
export class SubagentRuntime {
  // ── Session state (was closure-scoped in index.ts) ───────────────────────
  /** Active Pi session context — set on session_start, cleared on session_shutdown. */
  currentCtx: { pi: unknown; ctx: unknown } | undefined = undefined;
  /**
   * Per-agent live activity state shared across the notification system,
   * widget, and tool handlers. The Map itself is never replaced.
   */
  readonly agentActivity: Map<string, AgentActivityTracker> = new Map();
  /**
   * Persistent widget reference. Null until constructed after AgentManager.
   * Delegation methods use optional chaining so callers never need `widget!`.
   */
  widget: WidgetLike | null = null;

  // ── Session-context methods ──────────────────────────────────────────────

  /** Store the active Pi session context (called from session_start). */
  setSessionContext(pi: unknown, ctx: unknown): void {
    this.currentCtx = { pi, ctx };
  }

  /** Clear the session context (called from session_shutdown). */
  clearSessionContext(): void {
    this.currentCtx = undefined;
  }

  // ── Widget delegation methods ─────────────────────────────────────────────

  /** Delegate to widget.setUICtx — no-op when widget is null. */
  setUICtx(ctx: UICtx): void {
    this.widget?.setUICtx(ctx);
  }

  /** Delegate to widget.onTurnStart — no-op when widget is null. */
  onTurnStart(): void {
    this.widget?.onTurnStart();
  }

  /** Delegate to widget.markFinished — no-op when widget is null. */
  markFinished(id: string): void {
    this.widget?.markFinished(id);
  }

  /** Delegate to widget.update — no-op when widget is null. */
  updateWidget(): void {
    this.widget?.update();
  }

  /** Delegate to widget.ensureTimer — no-op when widget is null. */
  ensureTimer(): void {
    this.widget?.ensureTimer();
  }
}

/**
 * Create a fully-initialized SubagentRuntime with default values.
 *
 * Call once at extension startup; pass the result to factories and handlers.
 */
export function createSubagentRuntime(): SubagentRuntime {
  return new SubagentRuntime();
}
