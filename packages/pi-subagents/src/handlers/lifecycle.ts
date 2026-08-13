import type { SessionContext } from "#src/types";

/**
 * Session lifecycle event handlers: session_start, session_before_switch, session_shutdown.
 *
 * Extracted from index.ts so each handler can be tested in isolation
 * with mocked narrow interfaces.
 */

/** Narrow manager interface — only the methods lifecycle handlers call. */
export interface LifecycleManager {
  clearCompleted(): Promise<void>;
  abortAll(): void;
  dispose(): Promise<void>;
}

/** Narrow runtime interface — only the methods lifecycle handlers call. */
export interface LifecycleRuntime {
  setSessionContext(ctx: SessionContext): void;
  clearSessionContext(): void;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

export interface LifecycleSettings {
  readonly agentModelDefault: string | undefined;
  loadSessionModelDefault(
    parentSessionFile: string | undefined,
  ): string | undefined;
}

interface LifecycleUi {
  setStatus?(key: string, text: string | undefined): void;
}

function emitSessionDefaultModelStatus(
  ui: LifecycleUi | undefined,
  value: string | undefined,
): void {
  if (typeof ui?.setStatus !== "function") return;
  if (value === undefined) {
    ui.setStatus("sub-model", undefined);
    return;
  }
  const label =
    value === ""
      ? "inherit"
      : value.includes("/")
        ? (() => {
            const slash = value.lastIndexOf("/");
            const provider = value.slice(0, slash);
            const id = value.slice(slash + 1);
            return `${id} (${provider})`;
          })()
        : value;
  ui.setStatus("sub-model", `sub: ${label}`);
}

/**
 * Handles session lifecycle events.
 *
 * Constructor deps:
 * - `runtime` — owns session context state
 * - `manager` — manages agent lifecycle (clear, abort, dispose)
 * - `disposeNotifications` — tears down the notification system on shutdown
 * - `unpublishService` — unpublishes the SubagentsService symbol on shutdown
 */
export class SessionLifecycleHandler {
  constructor(
    private readonly runtime: LifecycleRuntime,
    private readonly manager: LifecycleManager,
    private readonly disposeNotifications: () => void,
    private readonly unpublishService: () => void,
    private readonly settings?: LifecycleSettings,
  ) {}

  handleSessionStart(_event: unknown, ctx: unknown): Promise<void> {
    this.runtime.setSessionContext(ctx as SessionContext);
    const ui = (ctx as { ui?: LifecycleUi } | null)?.ui;
    if (this.settings && ui) {
      const { parentSessionFile } = this.runtime.getSessionInfo();
      const value = this.settings.loadSessionModelDefault(parentSessionFile);
      emitSessionDefaultModelStatus(ui, value);
    }
    return this.manager.clearCompleted();
  }

  handleSessionBeforeSwitch(): Promise<void> {
    return this.manager.clearCompleted();
  }

  // Cleanup order matters:
  // 1. Unpublish service — prevent new cross-extension calls
  // 2. Clear session context — no more session state
  // 3. Dispose notifications — silence nudges *before* the aborts that would
  //    raise them: no parent run is active at shutdown, so a terminal
  //    transition delivers its nudge synchronously and Pi cannot recall it
  // 4. Abort all agents — stop running and queued work
  // 5. Dispose manager — final cleanup, awaited so each child's extensions get
  //    their `session_shutdown` before Pi tears the parent down (#709)
  handleSessionShutdown(): Promise<void> {
    this.unpublishService();
    this.runtime.clearSessionContext();
    this.disposeNotifications();
    this.manager.abortAll();
    return this.manager.dispose();
  }
}
