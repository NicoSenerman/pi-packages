/**
 * Recursion guard: EXCLUDED_TOOL_NAMES are filtered out after bindExtensions.
 *
 * Extension-registered tools (added during `session.bindExtensions(...)`) join
 * the active tool set during bindExtensions.
 * A single post-bind filter pass applies the `EXCLUDED_TOOL_NAMES` recursion guard
 * to the full post-bind active set.
 *
 * This file simulates that flow by having `getActiveToolNames` return a larger set
 * after `bindExtensions` and asserts that `setActiveToolsByName` is called once
 * (post-bind) with the expected tool set.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createSubagentSessionDeps, createSubagentSessionIO } from "#test/helpers/subagent-session-io";

const agentConfigMock = {
  current: {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read"],
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
  },
};

/** Mock AgentConfigLookup. */
const mockAgentLookup = {
  resolveAgentConfig: vi.fn((): import("#src/types").AgentConfig => ({
    ...agentConfigMock.current,
    promptMode: agentConfigMock.current.promptMode as "replace" | "append",
  })),
  getToolNamesForType: vi.fn((): string[] => agentConfigMock.current.builtinToolNames ?? ["read"]), // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- builtinToolNames is always defined in type but may be absent at runtime
};

let io: ReturnType<typeof createSubagentSessionIO>;

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
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getActiveToolNames: vi.fn(() => (bound ? afterBind : beforeBind)),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {
      bound = true;
    }),
  };
  return session;
}

const exec = vi.fn();

beforeEach(() => {
  io = createSubagentSessionIO();
  agentConfigMock.current = {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read"],
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
  };
});

describe("post-bind recursion guard", () => {
  it("setActiveToolsByName is called once, after bindExtensions", async () => {
    const session = createSessionWithExtensionToolRegistration(["read"], ["read", "extension_tool"]);
    io.createSession.mockResolvedValue({ session });

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "test-agent" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const setOrder = session.setActiveToolsByName.mock.invocationCallOrder[0];
    expect(setOrder).toBeGreaterThan(bindOrder);
  });

  it("post-bind filter includes extension-registered tools", async () => {
    const session = createSessionWithExtensionToolRegistration(["read"], ["read", "extension_tool"]);
    io.createSession.mockResolvedValue({ session });

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "test-agent" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    const postBindArgs = session.setActiveToolsByName.mock.calls[0][0];
    expect(postBindArgs).toContain("read");
    expect(postBindArgs).toContain("extension_tool");
  });

  it("post-bind filter excludes EXCLUDED_TOOL_NAMES", async () => {
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "subagent", "get_subagent_result", "steer_subagent", "external"],
    );
    io.createSession.mockResolvedValue({ session });

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "test-agent" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    const postBindArgs = session.setActiveToolsByName.mock.calls[0][0];
    expect(postBindArgs).toContain("read");
    expect(postBindArgs).toContain("external");
    expect(postBindArgs).not.toContain("subagent");
    expect(postBindArgs).not.toContain("get_subagent_result");
    expect(postBindArgs).not.toContain("steer_subagent");
  });

  it("runs the guard unconditionally even when no extension tools are registered", async () => {
    const session = createSessionWithExtensionToolRegistration(["read"], ["read"]);
    io.createSession.mockResolvedValue({ session });

    await createSubagentSession(
      { snapshot: STUB_SNAPSHOT, type: "test-agent" },
      createSubagentSessionDeps({ io, exec, registry: mockAgentLookup }),
    );

    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    expect(session.setActiveToolsByName.mock.calls[0][0]).toEqual(["read"]);
  });
});
