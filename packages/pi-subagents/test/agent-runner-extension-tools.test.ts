/**
 * Patch 2 (RepOne #443): re-filter active tools after bindExtensions.
 *
 * Extension-registered tools (added during `session.bindExtensions(...)`) are
 * not in the session's active tool set when the initial filter pass runs.
 * Without a post-bind re-filter, the `extensions: string[]` allowlist branch
 * never matches any extension tool, and `extensions: true` lets denylisted
 * extension tools slip through.
 *
 * This file simulates that flow by having `getActiveToolNames` return a small
 * built-in set before `bindExtensions` and a larger set including extension
 * tools after, then asserts that the final `setActiveToolsByName` call (the
 * post-bind re-filter) honors the agent's `extensions` and `disallowedTools`
 * config against the post-bind world.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const agentConfigMock = {
  current: {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read"],
    extensions: true as boolean | string[],
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    disallowedTools: undefined as string[] | undefined,
  },
};

/** Mock AgentConfigLookup injected via RunOptions.registry. */
const mockAgentLookup = {
  resolveAgentConfig: vi.fn((): import("../src/types.js").AgentConfig => ({
    ...agentConfigMock.current,
    promptMode: agentConfigMock.current.promptMode as "replace" | "append",
  })),
  getToolNamesForType: vi.fn((): string[] => agentConfigMock.current.builtinToolNames ?? ["read"]),
};

import { runAgent } from "../src/agent-runner.js";

// ── RunnerIO stub factory ──────────────────────────────────────────────────────

// Return type deliberately unannotated so vi.fn() stubs keep their Mock<...> methods.
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

/**
 * Build a mock session where `getActiveToolNames` returns one set before
 * `bindExtensions` is called and another set after.
 *
 * @param beforeBind  Tools active before bindExtensions (built-in only).
 * @param afterBind   Tools active after bindExtensions (built-in + extension).
 */
function createSessionWithExtensionToolRegistration(
  beforeBind: string[],
  afterBind: string[],
) {
  let bound = false;
  const session = {
    messages: [] as unknown[],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => (bound ? afterBind : beforeBind)),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {
      bound = true;
    }),
  };
  return session;
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
  // Reset agent config to defaults
  agentConfigMock.current = {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read"],
    extensions: true,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    disallowedTools: undefined,
  };
});

describe("Patch 2: post-bind active-tool re-filter", () => {
  it("setActiveToolsByName is called both before and after bindExtensions", async () => {
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "extension_tool"],
    );
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "test-agent", "go", { exec, registry: mockAgentLookup }, io);

    // Should be called twice: once before bind, once after.
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(2);

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const firstSetOrder =
      session.setActiveToolsByName.mock.invocationCallOrder[0];
    const secondSetOrder =
      session.setActiveToolsByName.mock.invocationCallOrder[1];

    // First set is before bind, second is after.
    expect(firstSetOrder).toBeLessThan(bindOrder);
    expect(secondSetOrder).toBeGreaterThan(bindOrder);
  });

  it("post-bind re-filter includes extension tool when extensions: true", async () => {
    agentConfigMock.current.extensions = true;
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "extension_tool"],
    );
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "test-agent", "go", { exec, registry: mockAgentLookup }, io);

    // Second (post-bind) call is the re-filter; it should include the
    // extension-registered tool since extensions: true allows everything.
    const secondCallArgs = session.setActiveToolsByName.mock.calls[1][0];
    expect(secondCallArgs).toContain("read");
    expect(secondCallArgs).toContain("extension_tool");
  });

  it("post-bind re-filter respects extensions: string[] allowlist", async () => {
    // Allowlist only "permission-system" prefix; "other_tool" must be excluded.
    agentConfigMock.current.extensions = ["permission-system"];
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "permission-system_check", "other_tool"],
    );
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "test-agent", "go", { exec, registry: mockAgentLookup }, io);

    const postBindArgs = session.setActiveToolsByName.mock.calls[1][0];
    // Built-in tools are always allowed.
    expect(postBindArgs).toContain("read");
    // Allowlisted extension tool included.
    expect(postBindArgs).toContain("permission-system_check");
    // Non-allowlisted extension tool excluded.
    expect(postBindArgs).not.toContain("other_tool");
  });

  it("post-bind re-filter respects disallowedTools denylist for extension tools", async () => {
    agentConfigMock.current.extensions = true;
    agentConfigMock.current.disallowedTools = ["bad_extension_tool"];
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "good_extension_tool", "bad_extension_tool"],
    );
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "test-agent", "go", { exec, registry: mockAgentLookup }, io);

    const postBindArgs = session.setActiveToolsByName.mock.calls[1][0];
    expect(postBindArgs).toContain("read");
    expect(postBindArgs).toContain("good_extension_tool");
    expect(postBindArgs).not.toContain("bad_extension_tool");
  });

  it("post-bind re-filter excludes our own tools (EXCLUDED_TOOL_NAMES) even when extensions: true", async () => {
    agentConfigMock.current.extensions = true;
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "Agent", "get_subagent_result", "steer_subagent", "external"],
    );
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "test-agent", "go", { exec, registry: mockAgentLookup }, io);

    const postBindArgs = session.setActiveToolsByName.mock.calls[1][0];
    expect(postBindArgs).toContain("read");
    expect(postBindArgs).toContain("external");
    // Our own subagent-dispatch tools must never reach children.
    expect(postBindArgs).not.toContain("Agent");
    expect(postBindArgs).not.toContain("get_subagent_result");
    expect(postBindArgs).not.toContain("steer_subagent");
  });

  it("extensions: false still applies disallowedTools to built-in tools (post-bind re-filter)", async () => {
    // When extensions: false, the loader is constructed with noExtensions: true,
    // so bindExtensions doesn't register any extension tools. The post-bind
    // re-filter still runs to apply denylisting against the (built-in-only)
    // active set.
    agentConfigMock.current.extensions = false;
    agentConfigMock.current.disallowedTools = ["read"];
    const session = createSessionWithExtensionToolRegistration(
      ["read", "write"],
      // With noExtensions: true on the loader, bindExtensions adds nothing.
      ["read", "write"],
    );
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "test-agent", "go", { exec, registry: mockAgentLookup }, io);

    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(2);
    const postBindArgs = session.setActiveToolsByName.mock.calls[1][0];
    // Denylisted built-in is removed.
    expect(postBindArgs).not.toContain("read");
    // Non-denylisted built-in survives.
    expect(postBindArgs).toContain("write");
  });

  it("extensions: false with no disallowedTools skips the filter (no setActiveToolsByName call)", async () => {
    // When extensions: false AND no disallowedTools, there's nothing to filter,
    // so neither the pre-bind nor post-bind setActiveToolsByName should fire.
    agentConfigMock.current.extensions = false;
    agentConfigMock.current.disallowedTools = undefined;
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read"],
    );
    io.createSession.mockResolvedValue({ session });

    await runAgent(snapshot, "test-agent", "go", { exec, registry: mockAgentLookup }, io);

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});
