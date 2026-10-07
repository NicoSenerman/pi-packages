/**
 * tool_execution_start event handler.
 *
 * Extracted from index.ts so the handler can be tested in isolation
 * with a mocked narrow runtime interface.
 */

/** Narrow widget interface — only the methods the handler calls. */
export interface ToolStartWidget {
  setUICtx(ctx: unknown, mode: ExtensionMode): void;
  onTurnStart(): void;
}

/**
 * Narrows pi's full ExtensionMode union ("tui" | "rpc" | "json" | "print").
 * Only "tui" drives the interactive factory path; every other mode must
 * receive the pre-rendered string[] form so it crosses pi's RPC bridge.
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

/** Minimal context shape for tool_execution_start — only the fields the handler reads. */
interface ToolStartCtx {
  ui: unknown;
  mode?: ExtensionMode;
}

/**
 * Handles tool_execution_start events.
 *
 * Grabs UI context from the first tool execution of each turn
 * and signals the widget to clear lingering state.
 */
export class ToolStartHandler {
  constructor(private readonly widget: ToolStartWidget) {}

  handleToolExecutionStart(_event: unknown, ctx: ToolStartCtx): void {
    // Missing mode used to default to "tui", which registers a factory widget
    // that RPC (piru) drops. Under the bridge, treat omitted mode as rpc.
    const mode = ctx.mode ?? (process.env.PITUI_BRIDGE === "1" ? "rpc" : "tui");
    this.widget.setUICtx(ctx.ui, mode);
    this.widget.onTurnStart();
  }
}
