import { beforeEach, describe, expect, it, vi } from "vitest";

/** Mock AgentConfigLookup injected via RunOptions.registry. */
const mockAgentLookup = {
  resolveAgentConfig: vi.fn((): import("../src/types.js").AgentConfig => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false as const,
    skills: false as const,
    systemPrompt: "You are Explore.",
    promptMode: "replace" as const,
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getToolNamesForType: vi.fn((): string[] => ["read"]),
};

import { resumeAgent, runAgent } from "../src/agent-runner.js";

// ── RunnerIO stub factory ──────────────────────────────────────────────────────

// Return type deliberately unannotated so vi.fn() stubs keep their Mock<...> methods
// (mockResolvedValue, mockReturnValue, mock.calls, etc.). The inferred type is
// still structurally compatible with RunnerIO for the runAgent() call site.
function createRunnerIO() {
  return {
    detectEnv: vi.fn().mockResolvedValue({ isGitRepo: false, branch: "", platform: "linux" }),
    getAgentDir: vi.fn().mockReturnValue("/mock/agent-dir"),
    createResourceLoader: vi.fn().mockReturnValue({ reload: vi.fn().mockResolvedValue(undefined) }),
    deriveSessionDir: vi.fn().mockReturnValue("/mock/session-dir/tasks"),
    createSessionManager: vi.fn().mockReturnValue({
      newSession: vi.fn(),
      getSessionFile: vi.fn().mockReturnValue("/sessions/child.jsonl"),
    }),
    createSettingsManager: vi.fn().mockReturnValue({}),
    createSession: vi.fn(),
    assemblerIO: {
      preloadSkills: vi.fn().mockReturnValue([]),
      buildMemoryBlock: vi.fn().mockReturnValue(""),
      buildReadOnlyMemoryBlock: vi.fn().mockReturnValue(""),
      buildAgentPrompt: vi.fn().mockReturnValue("system prompt"),
    },
  };
}

let io: ReturnType<typeof createRunnerIO>;

// ── Session mock factory ───────────────────────────────────────────────────────

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
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

import type { ParentSnapshot } from "../src/parent-snapshot.js";

const snapshot: ParentSnapshot = {
  cwd: "/tmp",
  model: undefined as unknown,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  systemPrompt: "parent prompt",
};

const exec = vi.fn();

beforeEach(() => {
  io = createRunnerIO();
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    io.createSession.mockResolvedValue({ session });

    const result = await runAgent(snapshot, "Explore", "Say LOCKED", { exec, registry: mockAgentLookup }, io);

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "Explore", "Say BOUND", { exec, registry: mockAgentLookup }, io);

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith({});

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "Explore", "Say CONFIGURED", { exec, cwd: "/tmp/worktree", registry: mockAgentLookup }, io);

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

    await runAgent(snapshot, "Explore", "Say ISOLATED", { exec, registry: mockAgentLookup }, io);

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

    const result = await runAgent(snapshot, "Explore", "go", { exec, registry: mockAgentLookup }, io);

    expect(result.sessionFile).toBe("/sessions/child.jsonl");
  });

  it("calls newSession with parentSession when parentSessionId is provided", async () => {
    const { session } = createSession("LINKED");
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "Explore", "go", {
      exec,
      parentSessionFile: "/sessions/parent.jsonl",
      parentSessionId: "parent-id-123",
      registry: mockAgentLookup,
    }, io);

    const sm = io.createSessionManager.mock.results[0].value;
    expect(sm.newSession).toHaveBeenCalledWith({ parentSession: "parent-id-123" });
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result).toBe("RESUMED");
  });
});

// ─── Callback forwarding removed (issue #100) ───────────────────────────────────
// Usage, compaction, tool-activity, and text-delta callbacks have been removed
// from RunOptions and ResumeOptions. Record stats are now accumulated by
// subscribeRecordObserver and UI state by subscribeUIObserver — both subscribe
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

    const result = await runAgent(snapshot, "Explore", "go", {
      exec,
      defaultMaxTurns: 2,
      graceTurns: 1,
      registry: mockAgentLookup,
    } as any, io);

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

    const result = await runAgent(snapshot, "Explore", "go", {
      exec,
      defaultMaxTurns: 1,
      graceTurns: 3,
      registry: mockAgentLookup,
    } as any, io);

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

    await runAgent(snapshot, "Explore", "go", {
      exec,
      maxTurns: 3, // explicit per-call limit
      defaultMaxTurns: 1, // should be overridden
      graceTurns: 1,
      registry: mockAgentLookup,
    } as any, io);

    // Only 2 turns fired, maxTurns=3, so steer should NOT be called
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });
});
