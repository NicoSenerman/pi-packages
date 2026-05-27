import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAgent, runAgent } from "#src/lifecycle/agent-runner";

const mockRegisterChildSession = vi.hoisted(() =>
  vi.fn<(key: string, info: { parentSessionId?: string; agentName: string }) => void>(),
);
const mockUnregisterChildSession = vi.hoisted(() => vi.fn<(key: string) => void>());

vi.mock("#src/lifecycle/permission-bridge", () => ({
  registerChildSession: mockRegisterChildSession,
  unregisterChildSession: mockUnregisterChildSession,
}));

import { createAgentLookup, createRunnerIO } from "#test/helpers/runner-io";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

/** Mock AgentConfigLookup injected via RunOptions.registry. */
const mockAgentLookup = createAgentLookup();

let io: ReturnType<typeof createRunnerIO>;

// ── Session mock factory ───────────────────────────────────────────────────────

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as unknown[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
}

const exec = vi.fn();

beforeEach(() => {
  io = createRunnerIO();
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    io.createSession.mockResolvedValue({ session });

    const result = await runAgent(STUB_SNAPSHOT, "Explore", "Say LOCKED", { context: { exec, registry: mockAgentLookup } }, { io, exec, registry: mockAgentLookup });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    io.createSession.mockResolvedValue({ session });

    await runAgent(STUB_SNAPSHOT, "Explore", "Say BOUND", { context: { exec, registry: mockAgentLookup } }, { io, exec, registry: mockAgentLookup });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith({});

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    io.createSession.mockResolvedValue({ session });

    await runAgent(STUB_SNAPSHOT, "Explore", "Say CONFIGURED", { context: { exec, registry: mockAgentLookup, cwd: "/tmp/worktree" } }, { io, exec, registry: mockAgentLookup });

    expect(io.getAgentDir).toHaveBeenCalledTimes(1);
    expect(io.createResourceLoader).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
    expect(io.createSettingsManager).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(io.createSessionManager).toHaveBeenCalledWith("/tmp/worktree", "/mock/session-dir/tasks");
    expect(io.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    io.createSession.mockResolvedValue({ session });

    await runAgent(STUB_SNAPSHOT, "Explore", "Say ISOLATED", { context: { exec, registry: mockAgentLookup } }, { io, exec, registry: mockAgentLookup });

    // noContextFiles skips AGENTS.md/CLAUDE.md at the loader source;
    // appendSystemPromptOverride suppresses APPEND_SYSTEM.md (no flag equivalent).
    expect(io.createResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    // The override returns an empty list so any loaded sources are discarded.
    const loaderOpts = io.createResourceLoader.mock.calls[0][0];
    expect(loaderOpts.appendSystemPromptOverride()).toEqual([]);
  });

  it("returns sessionFile from the persisted SessionManager in RunResult", async () => {
    const { session } = createSession("WITH_FILE");
    io.createSession.mockResolvedValue({ session });

    const result = await runAgent(STUB_SNAPSHOT, "Explore", "go", { context: { exec, registry: mockAgentLookup } }, { io, exec, registry: mockAgentLookup });

    expect(result.sessionFile).toBe("/sessions/child.jsonl");
  });

  it("calls newSession with parentSession when parentSessionId is provided", async () => {
    const { session } = createSession("LINKED");
    io.createSession.mockResolvedValue({ session });

    await runAgent(STUB_SNAPSHOT, "Explore", "go", {
      context: {
        exec,
        registry: mockAgentLookup,
        parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "parent-id-123" },
      },
    }, { io, exec, registry: mockAgentLookup });

    const sm = io.createSessionManager.mock.results[0].value;
    expect(sm.newSession).toHaveBeenCalledWith({ parentSession: "parent-id-123" });
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as unknown as AgentSession, "Continue");

    expect(result).toBe("RESUMED");
  });
});

// ─── Callback forwarding removed (issue #100) ───────────────────────────────────
// Usage, compaction, tool-activity, and text-delta callbacks have been removed
// from RunOptions and ResumeOptions. Record stats are now accumulated by
// subscribeAgentObserver and UI state by subscribeUIObserver — both subscribe
// to the session directly. Tests for that wiring live in
// test/record-observer.test.ts and test/ui/ui-observer.test.ts.

// ─── defaultMaxTurns / graceTurns via RunOptions (issue #69) ─────────────────
describe("agent-runner RunOptions — defaultMaxTurns and graceTurns", () => {
  function emitTurnEnd(listeners: Array<(e: any) => void>) {
    for (const l of listeners) l({ type: "turn_end" });
  }

  it("uses options.defaultMaxTurns as the fallback turn limit when no per-call maxTurns is set", async () => {
    const { session, listeners } = createSession("done");
    io.createSession.mockResolvedValue({ session });

    // 2 turns → soft limit; 3rd turn → abort (graceTurns=1)
    session.prompt = vi.fn(async () => {
      emitTurnEnd(listeners); // turn 1
      emitTurnEnd(listeners); // turn 2 → steer (maxTurns=2)
      emitTurnEnd(listeners); // turn 3 → abort (maxTurns+graceTurns=3)
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    });

    const result = await runAgent(STUB_SNAPSHOT, "Explore", "go", {
      context: { exec, registry: mockAgentLookup },
      defaultMaxTurns: 2,
      graceTurns: 1,
    }, { io, exec, registry: mockAgentLookup });

    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("turn limit"));
    expect(session.abort).toHaveBeenCalled();
    expect(result.aborted).toBe(true);
  });

  it("options.graceTurns extends the grace window after the soft-limit steer", async () => {
    const { session, listeners } = createSession("done");
    io.createSession.mockResolvedValue({ session });

    // maxTurns=1, graceTurns=3 → need 4 turns total to abort
    session.prompt = vi.fn(async () => {
      emitTurnEnd(listeners); // turn 1 → steer
      emitTurnEnd(listeners); // turn 2 → grace
      emitTurnEnd(listeners); // turn 3 → grace (still < 1+3=4)
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    });

    const result = await runAgent(STUB_SNAPSHOT, "Explore", "go", {
      context: { exec, registry: mockAgentLookup },
      defaultMaxTurns: 1,
      graceTurns: 3,
    }, { io, exec, registry: mockAgentLookup });

    // Steered at turn 1, but not aborted (turn 3 < 1+3=4)
    expect(result.steered).toBe(true);
    expect(result.aborted).toBe(false);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("options.maxTurns takes precedence over options.defaultMaxTurns", async () => {
    const { session, listeners } = createSession("done");
    io.createSession.mockResolvedValue({ session });

    // maxTurns=3 (explicit) should win over defaultMaxTurns=1
    session.prompt = vi.fn(async () => {
      emitTurnEnd(listeners); // turn 1 — under maxTurns=3, no steer
      emitTurnEnd(listeners); // turn 2
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    });

    await runAgent(STUB_SNAPSHOT, "Explore", "go", {
      context: { exec, registry: mockAgentLookup },
      maxTurns: 3, // explicit per-call limit
      defaultMaxTurns: 1, // should be overridden
      graceTurns: 1,
    }, { io, exec, registry: mockAgentLookup });

    // Only 2 turns fired, maxTurns=3, so steer should NOT be called
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });
});

// ─── Permission bridge integration (issue #101) ───────────────────────────────
describe("agent-runner permission bridge", () => {
  beforeEach(() => {
    mockRegisterChildSession.mockReset();
    mockUnregisterChildSession.mockReset();
  });

  it("registers the child session before bindExtensions()", async () => {
    const { session } = createSession("PERM");
    io.createSession.mockResolvedValue({ session });

    await runAgent(STUB_SNAPSHOT, "Explore", "go", {
      context: { exec, registry: mockAgentLookup },
    }, { io, exec, registry: mockAgentLookup });

    expect(mockRegisterChildSession).toHaveBeenCalledOnce();
    const registerOrder = mockRegisterChildSession.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(registerOrder).toBeLessThan(bindOrder);
  });

  it("passes agentName (the subagent type) and parentSessionId to registerChildSession", async () => {
    const { session } = createSession("PERM");
    io.createSession.mockResolvedValue({ session });

    await runAgent(STUB_SNAPSHOT, "Explore", "go", {
      context: {
        exec,
        registry: mockAgentLookup,
        parentSession: {
          parentSessionFile: "/sessions/parent.jsonl",
          parentSessionId: "parent-session-42",
        },
      },
    }, { io, exec, registry: mockAgentLookup });

    expect(mockRegisterChildSession).toHaveBeenCalledWith(
      expect.any(String),
      { agentName: "Explore", parentSessionId: "parent-session-42" },
    );
  });

  it("unregisters the child session after a successful run", async () => {
    const { session } = createSession("PERM");
    io.createSession.mockResolvedValue({ session });

    await runAgent(STUB_SNAPSHOT, "Explore", "go", {
      context: { exec, registry: mockAgentLookup },
    }, { io, exec, registry: mockAgentLookup });

    expect(mockUnregisterChildSession).toHaveBeenCalledOnce();
    const sessionKey = mockRegisterChildSession.mock.calls[0][0];
    expect(mockUnregisterChildSession).toHaveBeenCalledWith(sessionKey);
  });

  it("unregisters the child session even when session.prompt() throws", async () => {
    const { session } = createSession("PERM");
    io.createSession.mockResolvedValue({ session });
    session.prompt = vi.fn().mockRejectedValue(new Error("prompt failed"));

    await expect(
      runAgent(STUB_SNAPSHOT, "Explore", "go", {
        context: { exec, registry: mockAgentLookup },
      }, { io, exec, registry: mockAgentLookup }),
    ).rejects.toThrow("prompt failed");

    expect(mockUnregisterChildSession).toHaveBeenCalledOnce();
  });

  it("registers using the session directory as the session key", async () => {
    const { session } = createSession("PERM");
    io.createSession.mockResolvedValue({ session });
    io.deriveSessionDir.mockReturnValue("/custom/session/dir");

    await runAgent(STUB_SNAPSHOT, "Explore", "go", {
      context: { exec, registry: mockAgentLookup },
    }, { io, exec, registry: mockAgentLookup });

    expect(mockRegisterChildSession).toHaveBeenCalledWith(
      "/custom/session/dir",
      expect.any(Object),
    );
  });
});
