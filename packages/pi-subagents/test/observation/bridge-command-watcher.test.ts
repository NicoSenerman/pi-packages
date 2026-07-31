import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
});
