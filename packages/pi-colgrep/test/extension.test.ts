/**
 * Extension wiring tests.
 *
 * Exercises the event handlers registered in `extension.ts` by driving a
 * lightweight TestPi stub and asserting on `pi.exec` calls and `ctx.ui`
 * interactions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piColGrepExtension from "#src/extension";

// Mock config loading so tests control `indexOnStartup` without touching the
// real filesystem. Path builders stay real.
const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn<() => { indexOnStartup: boolean }>(() => ({
    indexOnStartup: true,
  })),
}));

vi.mock("#src/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/lib/config")>();
  return { ...actual, loadConfig };
});

beforeEach(() => {
  loadConfig.mockReturnValue({ indexOnStartup: true });
});

// ---- TestPi stub ----

type HandlerFn = (event: unknown, ctx: TestCtx) => Promise<void> | void;
type CommandHandlerFn = (args: string, ctx: TestCtx) => Promise<void> | void;

interface TestCtx {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: Mock<(message: string, type?: string) => void>;
    setStatus: Mock<(key: string, text: string | undefined) => void>;
  };
}

class TestPi {
  readonly exec: Mock<
    (
      cmd: string,
      args: string[],
      opts?: { cwd?: string; timeout?: number },
    ) => Promise<{ stdout: string; stderr: string; code: number }>
  >;

  private readonly handlers = new Map<string, HandlerFn[]>();
  private readonly commands = new Map<string, { handler: CommandHandlerFn }>();

  constructor() {
    this.exec =
      vi.fn<
        (
          cmd: string,
          args: string[],
          opts?: { cwd?: string; timeout?: number },
        ) => Promise<{ stdout: string; stderr: string; code: number }>
      >();
  }

  readonly on = ((name: string, handler: HandlerFn) => {
    const existing = this.handlers.get(name) ?? [];
    existing.push(handler);
    this.handlers.set(name, existing);
  }) as unknown as ExtensionAPI["on"];

  readonly registerTool = (() => {}) as unknown as ExtensionAPI["registerTool"];

  readonly registerCommand = ((
    name: string,
    options: { handler: CommandHandlerFn },
  ) => {
    this.commands.set(name, { handler: options.handler });
  }) as unknown as ExtensionAPI["registerCommand"];

  asExtensionAPI(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }

  async trigger(event: string, payload: unknown, ctx: TestCtx): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  async invokeCommand(name: string, args: string, ctx: TestCtx): Promise<void> {
    const cmd = this.commands.get(name);
    if (!cmd) throw new Error(`Command "${name}" not registered`);
    await cmd.handler(args, ctx);
  }
}

// ---- shared factory ----

function makeCtx(cwd = "/project"): TestCtx {
  return {
    cwd,
    hasUI: true,
    ui: {
      notify: vi.fn<(message: string, type?: string) => void>(),
      setStatus: vi.fn<(key: string, text: string | undefined) => void>(),
    },
  };
}

function makeSessionStartEvent() {
  return {};
}

const NO_INDEX_STATUS =
  "No index found for /project [model]\nRun `colgrep <query>` to create one.\n";
const INDEXED_STATUS = "Project: /project\nModel:   model\nIndex:   /tmp/idx\n";

// ---- Cycle 6: session_start reindex ----

describe("extension — session_start reindex", () => {
  let pi: TestPi;
  let ctx: TestCtx;

  beforeEach(() => {
    pi = new TestPi();
    ctx = makeCtx();
    // Default: colgrep --version succeeds, colgrep init succeeds
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    piColGrepExtension(pi.asExtensionAPI());
  });

  it("runs colgrep init -y . when colgrep is available", async () => {
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.objectContaining({ cwd: "/project" }),
    );
  });

  it("does not run colgrep init when colgrep is unavailable", async () => {
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 127 });
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    // Only the --version check should have been called
    expect(pi.exec).toHaveBeenCalledTimes(1);
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["--version"],
      expect.anything(),
    );
  });

  it("sets indexing status before running and clears it after", async () => {
    const statusCalls: Array<[string, string | undefined]> = [];
    ctx.ui.setStatus.mockImplementation(
      (key: string, text: string | undefined) => {
        statusCalls.push([key, text]);
      },
    );
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    // Startup indexing is now fire-and-forget; drain it via shutdown so the
    // status-clear has run before asserting.
    await pi.trigger("session_shutdown", {}, ctx);
    expect(statusCalls.some(([, t]) => t?.startsWith("colgrep:"))).toBe(true);
    expect(statusCalls.at(-1)).toEqual(["colgrep", undefined]);
  });

  it("uses the session cwd as the reindex working directory", async () => {
    ctx = makeCtx("/workspace/myproject");
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.objectContaining({ cwd: "/workspace/myproject" }),
    );
  });
});

// ---- Issue #389: background, config-gated startup index ----

describe("extension — session_start background indexing (#389)", () => {
  let pi: TestPi;
  let ctx: TestCtx;

  beforeEach(() => {
    pi = new TestPi();
    ctx = makeCtx();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    piColGrepExtension(pi.asExtensionAPI());
  });

  it("kicks off the startup index without blocking on it", async () => {
    // Hold the `init` exec so it never resolves during the handler.
    let resolveInit: (() => void) | undefined;
    pi.exec.mockImplementation((_cmd, args) => {
      if (args[0] === "init") {
        return new Promise((resolve) => {
          resolveInit = () => resolve({ stdout: "", stderr: "", code: 0 });
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });
    const statusCalls: Array<[string, string | undefined]> = [];
    ctx.ui.setStatus.mockImplementation((key, text) => {
      statusCalls.push([key, text]);
    });

    await pi.trigger("session_start", makeSessionStartEvent(), ctx);

    // The init was launched...
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.objectContaining({ cwd: "/project" }),
    );
    // ...but the handler returned before it completed: the indexing status is
    // still set (not cleared), proving startup is non-blocking.
    expect(statusCalls.at(-1)).toEqual(["colgrep", "colgrep: indexing\u2026"]);

    resolveInit?.();
  });

  it("does not run the startup index when indexOnStartup is false", async () => {
    loadConfig.mockReturnValue({ indexOnStartup: false });
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    expect(pi.exec).not.toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.anything(),
    );
    // Availability is still checked.
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["--version"],
      expect.anything(),
    );
  });
});

// ---- Cycle 7: tool_result trigger ----

describe("extension — tool_result scheduling", () => {
  let pi: TestPi;
  let ctx: TestCtx;

  // Helper: warm up a session (availability check + initial reindex) so the
  // reindexer exists before tool_result events fire.
  async function warmSession(): Promise<void> {
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    // After session_start, exec has been called for --version and init.
    // Reset the mock so subsequent assertions are clean.
    pi.exec.mockClear();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
  }

  beforeEach(() => {
    pi = new TestPi();
    ctx = makeCtx();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    piColGrepExtension(pi.asExtensionAPI());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a reindex after a successful write tool_result", async () => {
    await warmSession();
    await pi.trigger("tool_result", { toolName: "write", isError: false }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.anything(),
    );
  });

  it("schedules a reindex after a successful edit tool_result", async () => {
    await warmSession();
    await pi.trigger("tool_result", { toolName: "edit", isError: false }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.anything(),
    );
  });

  it("does not schedule a reindex for an error tool_result", async () => {
    await warmSession();
    await pi.trigger("tool_result", { toolName: "write", isError: true }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("does not schedule a reindex for other tool names", async () => {
    await warmSession();
    await pi.trigger("tool_result", { toolName: "grep", isError: false }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("does not schedule a reindex when colgrep is unavailable", async () => {
    // Make colgrep unavailable so session_start skips reindexer creation
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 127 });
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    pi.exec.mockClear();
    await pi.trigger("tool_result", { toolName: "write", isError: false }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("does not schedule a reindex before session_start fires", async () => {
    // No session_start — reindexer is undefined
    await pi.trigger("tool_result", { toolName: "write", isError: false }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pi.exec).not.toHaveBeenCalled();
  });
});

// ---- Cycle 8: manual /colgrep-reindex command ----

describe("extension — /colgrep-reindex command", () => {
  let pi: TestPi;
  let ctx: TestCtx;

  async function warmSession(): Promise<void> {
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    pi.exec.mockClear();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
  }

  beforeEach(() => {
    pi = new TestPi();
    ctx = makeCtx();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    piColGrepExtension(pi.asExtensionAPI());
  });

  it("registers a colgrep-reindex command", async () => {
    await warmSession();
    await expect(
      pi.invokeCommand("colgrep-reindex", "", ctx),
    ).resolves.toBeUndefined();
  });

  it("runs colgrep init immediately when invoked", async () => {
    await warmSession();
    await pi.invokeCommand("colgrep-reindex", "", ctx);
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.anything(),
    );
  });

  it("shows a success notification after reindex completes", async () => {
    await warmSession();
    await pi.invokeCommand("colgrep-reindex", "", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("ColGrep"),
      "info",
    );
  });

  it("shows a warning notification when colgrep is unavailable", async () => {
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 127 });
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    ctx.ui.notify.mockClear();
    await pi.invokeCommand("colgrep-reindex", "", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("colgrep"),
      "warning",
    );
    expect(pi.exec).toHaveBeenCalledTimes(1); // only --version
  });

  it("resolves without throwing even when reindex exec fails", async () => {
    await warmSession();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "disk error", code: 1 });
    await expect(
      pi.invokeCommand("colgrep-reindex", "", ctx),
    ).resolves.toBeUndefined();
  });
});

// ---- Issue #389: write/edit reindex gating ----

describe("extension — write/edit reindex gating (#389)", () => {
  let pi: TestPi;
  let ctx: TestCtx;

  function mockExec(statusStdout: string) {
    pi.exec.mockImplementation((_cmd, args) => {
      if (args[0] === "status") {
        return Promise.resolve({ stdout: statusStdout, stderr: "", code: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    });
  }

  beforeEach(() => {
    pi = new TestPi();
    ctx = makeCtx();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    piColGrepExtension(pi.asExtensionAPI());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("probes index existence once on session_start", async () => {
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["status", "/project", "--color", "never"],
      expect.objectContaining({ cwd: "/project" }),
    );
  });

  it("schedules a reindex on write when an index already exists", async () => {
    loadConfig.mockReturnValue({ indexOnStartup: false });
    mockExec(INDEXED_STATUS);
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    pi.exec.mockClear();
    mockExec(INDEXED_STATUS);

    await pi.trigger("tool_result", { toolName: "write", isError: false }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.anything(),
    );
  });

  it("skips the reindex and warns once when no index exists", async () => {
    loadConfig.mockReturnValue({ indexOnStartup: false });
    mockExec(NO_INDEX_STATUS);
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    pi.exec.mockClear();
    ctx.ui.notify.mockClear();
    mockExec(NO_INDEX_STATUS);

    await pi.trigger("tool_result", { toolName: "write", isError: false }, ctx);
    await pi.trigger("tool_result", { toolName: "edit", isError: false }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(pi.exec).not.toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.anything(),
    );
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("skipping"),
      "info",
    );
  });

  it("resumes reindexing after a manual /colgrep-reindex builds the index", async () => {
    loadConfig.mockReturnValue({ indexOnStartup: false });
    mockExec(NO_INDEX_STATUS);
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);

    // Manual reindex builds an index and flips the gate.
    await pi.invokeCommand("colgrep-reindex", "", ctx);

    pi.exec.mockClear();
    mockExec(NO_INDEX_STATUS);
    await pi.trigger("tool_result", { toolName: "write", isError: false }, ctx);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(pi.exec).toHaveBeenCalledWith(
      "colgrep",
      ["init", "-y", "."],
      expect.anything(),
    );
  });
});

// ---- Cycle 9: session_shutdown cleanup ----

describe("extension — session_shutdown cleanup", () => {
  let pi: TestPi;
  let ctx: TestCtx;

  beforeEach(() => {
    pi = new TestPi();
    ctx = makeCtx();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    piColGrepExtension(pi.asExtensionAPI());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels a pending debounce timer on session_shutdown", async () => {
    // Warm up the session so the reindexer exists
    await pi.trigger("session_start", makeSessionStartEvent(), ctx);
    pi.exec.mockClear();
    pi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    // Schedule a reindex (starts a 4 s debounce timer)
    await pi.trigger("tool_result", { toolName: "write", isError: false }, ctx);

    // Shut down before the debounce fires
    await pi.trigger("session_shutdown", {}, ctx);

    // Timer passes — no reindex should fire
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pi.exec).not.toHaveBeenCalled();
  });
});
