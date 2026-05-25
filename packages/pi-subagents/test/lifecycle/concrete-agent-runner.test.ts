import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ConcreteAgentRunner } from "#src/lifecycle/agent-runner";

// ── Minimal RunnerIO stub ─────────────────────────────────────────────────────

function makeIO() {
  return {
    detectEnv: vi.fn().mockResolvedValue({ isGitRepo: false, branch: "", platform: "linux" }),
    getAgentDir: vi.fn().mockReturnValue("/mock/agent-dir"),
    createResourceLoader: vi.fn().mockReturnValue({ reload: vi.fn().mockResolvedValue(undefined) }),
    deriveSessionDir: vi.fn().mockReturnValue("/mock/session-dir"),
    createSessionManager: vi.fn().mockReturnValue({
      newSession: vi.fn(),
      getSessionFile: vi.fn().mockReturnValue(undefined),
    }),
    createSettingsManager: vi.fn().mockReturnValue({}),
    createSession: vi.fn(),
    assemblerIO: {
      preloadSkills: vi.fn().mockReturnValue([]),
      buildAgentPrompt: vi.fn().mockReturnValue("sys"),
    },
  };
}

// ── Minimal session stub ──────────────────────────────────────────────────────

function makeSession(text: string) {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }] as unknown[],
    subscribe: vi.fn((fn: (event: unknown) => void) => {
      listeners.push(fn);
      return () => {};
    }),
    getActiveToolNames: vi.fn().mockReturnValue([]),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    steer: vi.fn(),
  };
  return { session: session as unknown as AgentSession };
}

/** Minimal AgentConfigLookup stub. */
const registry = {
  resolveAgentConfig: vi.fn((): import("#src/types").AgentConfig => ({
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

/** Minimal ParentSnapshot stub. */
const snapshot = {
  cwd: "/workspace",
  systemPrompt: "",
  model: {},
  modelRegistry: { find: vi.fn(), getAll: vi.fn().mockReturnValue([]) },
};

describe("ConcreteAgentRunner", () => {
  it("delegates run() to runAgent and returns a RunResult", async () => {
    const io = makeIO();
    const { session } = makeSession("result text");
    io.createSession.mockResolvedValue({ session });

    const runner = new ConcreteAgentRunner(io);
    const result = await runner.run(snapshot, "Explore", "do the thing", {
      context: { exec: vi.fn(), registry },
    });

    expect(result.responseText).toBe("result text");
    expect(result.session).toBe(session);
    expect(io.detectEnv).toHaveBeenCalled();
  });

  it("delegates resume() to resumeAgent and returns response text", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "resumed" }] }] as unknown[],
      subscribe: vi.fn((fn: (event: unknown) => void) => {
        listeners.push(fn);
        return () => {};
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    const runner = new ConcreteAgentRunner(makeIO());
    const text = await runner.resume(session, "continue");

    expect(text).toBe("resumed");
    expect((session.prompt as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("continue");
  });
});
