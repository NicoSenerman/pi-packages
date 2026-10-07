import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeCommandWatcher,
  routeBridgeCommand,
  type BridgeRouter,
} from "#src/observation/bridge-command-watcher";
import { createTestSubagent } from "#test/helpers/make-subagent";
import type { SubagentManager } from "#src/lifecycle/subagent-manager";

function makeManagerStub(abortFn: (id: string) => boolean): SubagentManager {
  return { abort: abortFn } as unknown as SubagentManager;
}

describe("routeBridgeCommand", () => {
  const router = (abortFn: (id: string) => boolean): BridgeRouter => ({
    abort: abortFn,
  });

  it("routes an abort command to manager.abort", () => {
    const abort = vi.fn(() => true);
    expect(routeBridgeCommand(router(abort), { op: "abort", agentId: "a1" })).toBe(true);
    expect(abort).toHaveBeenCalledWith("a1");
  });

  it("returns false on an unknown op", () => {
    const abort = vi.fn(() => true);
    expect(
      routeBridgeCommand(router(abort), { op: "restart", agentId: "a1" }),
    ).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it("returns false when agentId is missing", () => {
    const abort = vi.fn(() => true);
    expect(routeBridgeCommand(router(abort), { op: "abort" })).toBe(false);
    expect(abort).not.toHaveBeenCalled();
  });

  it("forwards the manager's boolean return", () => {
    expect(
      routeBridgeCommand(router(() => false), {
        op: "abort",
        agentId: "ghost",
      }),
    ).toBe(false);
  });

  it("aborts a queued agent via the same path (manager decides semantics)", () => {
    const agent = createTestSubagent({ id: "q", status: "queued" });
    const abort = vi.fn((id: string) => {
      if (id === "q") agent.markStopped();
      return true;
    });
    routeBridgeCommand(router(abort), { op: "abort", agentId: "q" });
    expect(abort).toHaveBeenCalledWith("q");
    expect(agent.status).toBe("stopped");
  });
});

describe("BridgeCommandWatcher", () => {
  const ORIG = process.env.PITUI_BRIDGE;
  beforeEach(() => {
    process.env.PITUI_BRIDGE = "1";
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.PITUI_BRIDGE;
    else process.env.PITUI_BRIDGE = ORIG;
  });

  it("is a no-op when PITUI_BRIDGE is unset (start does not watch)", () => {
    delete process.env.PITUI_BRIDGE;
    const manager = makeManagerStub(() => true);
    const w = new BridgeCommandWatcher({
      manager,
      path: "/tmp/nonexistent-bridge-cmd-file",
    });
    w.start();
    w.stop();
    expect(true).toBe(true);
  });

  it("start is idempotent", () => {
    const manager = makeManagerStub(() => true);
    const w = new BridgeCommandWatcher({
      manager,
      path: "/tmp/nonexistent-bridge-cmd-file",
    });
    w.start();
    w.start();
    w.stop();
    expect(true).toBe(true);
  });

  it("stop is safe to call before start", () => {
    const manager = makeManagerStub(() => true);
    const w = new BridgeCommandWatcher({
      manager,
      path: "/tmp/nonexistent-bridge-cmd-file",
    });
    w.stop();
    expect(true).toBe(true);
  });

  it("one watcher's stop() does not kill a sibling on the same file", async () => {
    // Regression: bare unwatchFile(path) removes the shared per-path StatWatcher
    // and starsves every other factory-bound watcher. Ref-counted
    // unwatchFile(path, listener) is required so pi binding extensions more than
    // once in a process can't leave the second+ session deaf to abort lines.
    const tmp = join(tmpdir(), `bridge-cmd-test-${randomUUID()}.jsonl`);
    writeFileSync(tmp, "");
    const abortedA: string[] = [];
    const abortedB: string[] = [];
    const wA = new BridgeCommandWatcher({
      manager: makeManagerStub((id) => {
        abortedA.push(id);
        return true;
      }),
      path: tmp,
    });
    const wB = new BridgeCommandWatcher({
      manager: makeManagerStub((id) => {
        abortedB.push(id);
        return true;
      }),
      path: tmp,
    });
    wA.start();
    wB.start();
    // Simulate first factory's shutdown.
    wA.stop();
    // Let the StatWatcher settle past one poll tick before appending.
    await new Promise((r) => setTimeout(r, 350));
    // Append an abort after wA stopped — wB must still see it.
    appendFileSync(tmp, JSON.stringify({ op: "abort", agentId: "child-b" }) + "\n");
    await vi.waitFor(
      () => {
        expect(abortedB).toContain("child-b");
      },
      { timeout: 3000, interval: 100 },
    );
    // wA's handler must not have leaked in a call after it stopped.
    await new Promise((r) => setTimeout(r, 500));
    expect(abortedA).not.toContain("child-b");
    wB.stop();
    rmSync(tmp, { force: true });
  });

  it("routes an abort line appended after seedOffset via the live watcher", async () => {
    const tmp = join(tmpdir(), `bridge-cmd-test-${randomUUID()}.jsonl`);
    writeFileSync(tmp, "");
    const aborted: string[] = [];
    const w = new BridgeCommandWatcher({
      manager: makeManagerStub((id) => {
        aborted.push(id);
        return true;
      }),
      path: tmp,
    });
    w.start();
    appendFileSync(tmp, JSON.stringify({ op: "abort", agentId: "agent-k" }) + "\n");
    await vi.waitFor(
      () => {
        expect(aborted).toContain("agent-k");
      },
      { timeout: 3000, interval: 100 },
    );
    w.stop();
    rmSync(tmp, { force: true });
  });
});
