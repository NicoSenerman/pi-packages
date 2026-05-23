/**
 * Extension wiring tests.
 *
 * Exercises the event handlers registered in `extension.ts` by driving a
 * lightweight TestPi stub and asserting on `pi.exec` calls and `ctx.ui`
 * interactions.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import piColGrepExtension from "../src/extension.js";

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
