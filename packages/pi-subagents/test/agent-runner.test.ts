import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentDir,
  sessionManagerCreate,
  sessionManagerInMemory,
  settingsManagerCreate,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerCreate: vi.fn(() => ({
    kind: "persisted-session-manager",
    newSession: vi.fn(),
    getSessionFile: vi.fn(() => "/sessions/child.jsonl"),
  })),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      defaultResourceLoaderCtor(options);
    }

    async reload() {}
  },
  getAgentDir,
  SessionManager: { create: sessionManagerCreate, inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  resolveAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

vi.mock("../src/session-dir.js", () => ({
  deriveSubagentSessionDir: vi.fn(() => "/mock/session-dir/tasks"),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

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

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const exec = vi.fn();

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerCreate.mockClear();
  sessionManagerCreate.mockReturnValue({
    kind: "persisted-session-manager",
    newSession: vi.fn(),
    getSessionFile: vi.fn(() => "/sessions/child.jsonl"),
  });
  sessionManagerInMemory.mockClear();
  settingsManagerCreate.mockClear();
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { exec });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { exec });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say CONFIGURED", { exec, cwd: "/tmp/worktree" });

    expect(getAgentDir).toHaveBeenCalledTimes(1);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/mock/session-dir/tasks");
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { exec });

    // noContextFiles skips AGENTS.md/CLAUDE.md at the loader source;
    // appendSystemPromptOverride suppresses APPEND_SYSTEM.md (no flag equivalent).
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    // The override returns an empty list so any loaded sources are discarded.
    const ctorArgs = defaultResourceLoaderCtor.mock.calls[0][0];
    expect(ctorArgs.appendSystemPromptOverride(["would-be-loaded"])).toEqual([]);
  });

  it("returns sessionFile from the persisted SessionManager in RunResult", async () => {
    const { session } = createSession("WITH_FILE");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { exec });

    expect(result.sessionFile).toBe("/sessions/child.jsonl");
  });

  it("calls newSession with parentSession when parentSessionId is provided", async () => {
    const { session } = createSession("LINKED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      exec,
      parentSessionFile: "/sessions/parent.jsonl",
      parentSessionId: "parent-id-123",
    });

    const sm = sessionManagerCreate.mock.results[0].value;
    expect(sm.newSession).toHaveBeenCalledWith({ parentSession: "parent-id-123" });
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result).toBe("RESUMED");
  });
});

// ─── message_end → onAssistantUsage wiring (issue #38) ─────────────────
// Both runAgent and resumeAgent dispatch usage to the caller via this
// callback. The callback feeds the AgentRecord lifetime accumulator, which
// is the source of truth for total tokens (survives compaction).
describe("agent-runner usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: any) => void>, usage: any) {
    const event = { type: "message_end", message: { role: "assistant", usage } };
    for (const l of listeners) l(event);
  }

  it("runAgent forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ input: number; output: number; cacheWrite: number }> = [];
    session.prompt = vi.fn(async () => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10 });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      exec,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10 },
      { input: 200, output: 80, cacheWrite: 20 },
    ]);
  });

  it("runAgent normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 50 }); // output, cacheWrite missing
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      exec,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0 }]);
  });

  it("runAgent skips the callback when message_end has no usage field", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const cb = vi.fn();
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, undefined);
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", { exec, onAssistantUsage: cb });

    expect(cb).not.toHaveBeenCalled();
  });

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: any[] = [];

    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5 }]);
  });

  it("forwards compaction_end events to onCompaction (only when not aborted)", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      // Successful compaction — should fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        reason: "threshold",
        result: { tokensBefore: 12345 },
      });
      // Aborted compaction — should NOT fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: true,
        reason: "manual",
        result: { tokensBefore: 99999 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      exec,
      onCompaction: (info) => seen.push(info),
    });

    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 12345 }]);
  });
});

// ─── defaultMaxTurns / graceTurns via RunOptions (issue #69) ─────────────────
describe("agent-runner RunOptions — defaultMaxTurns and graceTurns", () => {
  function emitTurnEnd(listeners: Array<(e: any) => void>) {
    for (const l of listeners) l({ type: "turn_end" });
  }

  it("uses options.defaultMaxTurns as the fallback turn limit when no per-call maxTurns is set", async () => {
    const { session, listeners } = createSession("done");
    createAgentSession.mockResolvedValue({ session });

    // 2 turns → soft limit; 3rd turn → abort (graceTurns=1)
    session.prompt = vi.fn(async () => {
      emitTurnEnd(listeners); // turn 1
      emitTurnEnd(listeners); // turn 2 → steer (maxTurns=2)
      emitTurnEnd(listeners); // turn 3 → abort (maxTurns+graceTurns=3)
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    });

    const result = await runAgent(ctx, "Explore", "go", {
      exec,
      defaultMaxTurns: 2,
      graceTurns: 1,
    } as any);

    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("turn limit"));
    expect(session.abort).toHaveBeenCalled();
    expect(result.aborted).toBe(true);
  });

  it("options.graceTurns extends the grace window after the soft-limit steer", async () => {
    const { session, listeners } = createSession("done");
    createAgentSession.mockResolvedValue({ session });

    // maxTurns=1, graceTurns=3 → need 4 turns total to abort
    session.prompt = vi.fn(async () => {
      emitTurnEnd(listeners); // turn 1 → steer
      emitTurnEnd(listeners); // turn 2 → grace
      emitTurnEnd(listeners); // turn 3 → grace (still < 1+3=4)
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    });

    const result = await runAgent(ctx, "Explore", "go", {
      exec,
      defaultMaxTurns: 1,
      graceTurns: 3,
    } as any);

    // Steered at turn 1, but not aborted (turn 3 < 1+3=4)
    expect(result.steered).toBe(true);
    expect(result.aborted).toBe(false);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("options.maxTurns takes precedence over options.defaultMaxTurns", async () => {
    const { session, listeners } = createSession("done");
    createAgentSession.mockResolvedValue({ session });

    // maxTurns=3 (explicit) should win over defaultMaxTurns=1
    session.prompt = vi.fn(async () => {
      emitTurnEnd(listeners); // turn 1 — under maxTurns=3, no steer
      emitTurnEnd(listeners); // turn 2
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      exec,
      maxTurns: 3,       // explicit per-call limit
      defaultMaxTurns: 1, // should be overridden
      graceTurns: 1,
    } as any);

    // Only 2 turns fired, maxTurns=3, so steer should NOT be called
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });
});
