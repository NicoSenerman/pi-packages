import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../../src/types.js";
import { type AgentMenuDeps, createAgentsMenuHandler } from "../../src/ui/agent-menu.js";
import { createTestRecord } from "../helpers/make-record.js";

const { mockExistsSync, mockGetAllTypes, mockResolveAgentConfig, mockResolveType } = vi.hoisted(() => ({
  mockExistsSync: vi.fn((): boolean => false),
  mockGetAllTypes: vi.fn((): string[] => []),
  mockResolveAgentConfig: vi.fn((): AgentConfig => ({
    name: "test-agent",
    description: "A test agent",
    systemPrompt: "You are a test agent.",
    promptMode: "replace" as const,
    extensions: true,
    skills: true,
    isDefault: true,
    source: "default" as const,
  })),
  mockResolveType: vi.fn((): string | undefined => "test-agent"),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    default: {
      ...actual,
      existsSync: mockExistsSync,
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

vi.mock("../../src/agent-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/agent-types.js")>();
  return {
    ...actual,
    getAllTypes: mockGetAllTypes,
    resolveAgentConfig: mockResolveAgentConfig,
    resolveType: mockResolveType,
  };
});

function makeDeps(overrides: Partial<AgentMenuDeps> = {}): AgentMenuDeps {
  return {
    manager: {
      listAgents: vi.fn().mockReturnValue([]),
      getRecord: vi.fn(),
      spawnAndWait: vi.fn(),
      getMaxConcurrent: vi.fn().mockReturnValue(4),
      setMaxConcurrent: vi.fn(),
    },
    reloadCustomAgents: vi.fn(),
    agentActivity: new Map(),
    getModelLabel: vi.fn().mockReturnValue("inherit"),
    snapshotSettings: vi.fn().mockReturnValue({
      maxConcurrent: 4,
      defaultMaxTurns: 0,
      graceTurns: 3,
    }),
    saveSettings: vi.fn().mockReturnValue({ message: "Saved", level: "info" }),
    emitEvent: vi.fn(),
    personalAgentsDir: "/home/.pi/agents",
    projectAgentsDir: "/test-project/.pi/agents",
    getDefaultMaxTurns: vi.fn().mockReturnValue(undefined),
    getGraceTurns: vi.fn().mockReturnValue(5),
    setDefaultMaxTurns: vi.fn(),
    setGraceTurns: vi.fn(),
    ...overrides,
  };
}

function makeCtx(selectResults: (string | undefined)[] = []) {
  let selectIdx = 0;
  return {
    ui: {
      select: vi.fn().mockImplementation(() => selectResults[selectIdx++]),
      input: vi.fn(),
      confirm: vi.fn(),
      editor: vi.fn(),
      notify: vi.fn(),
      custom: vi.fn(),
    },
    modelRegistry: {},
  };
}

beforeEach(() => {
  mockExistsSync.mockClear();
  mockGetAllTypes.mockClear();
  mockResolveAgentConfig.mockClear();
  mockResolveType.mockClear();
});

describe("createAgentsMenuHandler", () => {
  it("returns a handler function", () => {
    const handler = createAgentsMenuHandler(makeDeps());
    expect(typeof handler).toBe("function");
  });

  it("calls reloadCustomAgents on menu open", async () => {
    const deps = makeDeps();
    const ctx = makeCtx([undefined]); // user cancels immediately
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    expect(deps.reloadCustomAgents).toHaveBeenCalled();
  });

  it("shows Create new agent option", async () => {
    const deps = makeDeps();
    const ctx = makeCtx([undefined]);
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    const selectCall = ctx.ui.select.mock.calls[0];
    expect(selectCall[1]).toContain("Create new agent");
  });

  it("shows Settings option", async () => {
    const deps = makeDeps();
    const ctx = makeCtx([undefined]);
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    const selectCall = ctx.ui.select.mock.calls[0];
    expect(selectCall[1]).toContain("Settings");
  });

  it("shows running agents when agents are active", async () => {
    const deps = makeDeps({
      manager: {
        ...makeDeps().manager,
        listAgents: vi.fn().mockReturnValue([
          createTestRecord({ status: "running" }),
          createTestRecord({ status: "completed", id: "agent-2" }),
        ]),
      },
    });
    const ctx = makeCtx([undefined]);
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    const options = ctx.ui.select.mock.calls[0][1] as string[];
    expect(options.some((o: string) => o.startsWith("Running agents ("))).toBe(true);
  });
});

describe("agent menu — projectAgentsDir injection", () => {
  it("uses injected projectAgentsDir when resolving agent files", async () => {
    mockGetAllTypes.mockReturnValue(["test-agent"]);
    const deps = makeDeps({ projectAgentsDir: "/test-project/.pi/agents" });
    let selectCall = 0;
    const ctx = makeCtx([]);
    ctx.ui.select = vi.fn().mockImplementation((_title: string, options: string[]) => {
      selectCall++;
      if (selectCall === 1) return "Agent types (1)"; // main menu
      if (selectCall === 2) return options[0]; // pick first agent type
      return undefined; // cancel everything else
    });

    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);

    expect(mockExistsSync).toHaveBeenCalledWith("/test-project/.pi/agents/test-agent.md");
  });
});

describe("agent menu — settings", () => {
  it("navigates to settings and allows setting max concurrency", async () => {
    const deps = makeDeps();
    const ctx = makeCtx([
      "Settings", // from main menu
      "Max concurrency (current: 4)", // from settings
      undefined, // cancel settings re-show
    ]);
    ctx.ui.input = vi.fn().mockResolvedValue("8");
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    expect(deps.manager.setMaxConcurrent).toHaveBeenCalledWith(8);
  });
});
