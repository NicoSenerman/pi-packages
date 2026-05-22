import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { type AgentMenuDeps, createAgentsMenuHandler } from "../../src/ui/agent-menu.js";
import { createTestRecord } from "../helpers/make-record.js";

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn((): boolean => false),
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

const testDefaultAgentConfig: AgentConfig = {
  name: "test-agent",
  description: "A test agent",
  systemPrompt: "You are a test agent.",
  promptMode: "replace" as const,
  extensions: true,
  skills: true,
  isDefault: true,
  source: "default" as const,
};

/** Real registry for all tests. Methods are spied on per-test as needed. */
const testRegistry = new AgentTypeRegistry(() => new Map());

function makeDeps(overrides: Partial<AgentMenuDeps> = {}): AgentMenuDeps {
  return {
    manager: {
      listAgents: vi.fn().mockReturnValue([]),
      getRecord: vi.fn(),
      spawnAndWait: vi.fn(),
    },
    registry: testRegistry,
    agentActivity: new Map(),
    getModelLabel: vi.fn().mockReturnValue("inherit"),
    settings: {
      maxConcurrent: 4,
      defaultMaxTurns: undefined as number | undefined,
      graceTurns: 5,
      applyMaxConcurrent: vi.fn((): { message: string; level: "info" | "warning" } => ({
        message: "Max concurrency set to 8",
        level: "info",
      })),
      applyDefaultMaxTurns: vi.fn((): { message: string; level: "info" | "warning" } => ({
        message: "Default max turns set to unlimited",
        level: "info",
      })),
      applyGraceTurns: vi.fn((): { message: string; level: "info" | "warning" } => ({
        message: "Grace turns set to 3",
        level: "info",
      })),
    },
    personalAgentsDir: "/home/.pi/agents",
    projectAgentsDir: "/test-project/.pi/agents",
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
  vi.restoreAllMocks();
  // Default spy: resolveAgentConfig returns testDefaultAgentConfig
  vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testDefaultAgentConfig);
  // Default spy: resolveType returns "test-agent"
  vi.spyOn(testRegistry, "resolveType").mockReturnValue("test-agent");
  // Default spy: getAllTypes returns empty (tests override as needed)
  vi.spyOn(testRegistry, "getAllTypes").mockReturnValue([]);
});

describe("createAgentsMenuHandler", () => {
  it("returns a handler function", () => {
    const handler = createAgentsMenuHandler(makeDeps());
    expect(typeof handler).toBe("function");
  });

  it("calls registry.reload() on menu open", async () => {
    const reloadSpy = vi.spyOn(testRegistry, "reload");
    const deps = makeDeps();
    const ctx = makeCtx([undefined]); // user cancels immediately
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    expect(reloadSpy).toHaveBeenCalled();
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
    vi.spyOn(testRegistry, "getAllTypes").mockReturnValue(["test-agent"]);
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
  it("navigates to settings and delegates maxConcurrent change to applyMaxConcurrent", async () => {
    const deps = makeDeps();
    const ctx = makeCtx([
      "Settings", // from main menu
      "Max concurrency (current: 4)", // from settings
      undefined, // cancel settings re-show
    ]);
    ctx.ui.input = vi.fn().mockResolvedValue("8");
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    expect(deps.settings.applyMaxConcurrent).toHaveBeenCalledWith(8);
  });

  it("delegates defaultMaxTurns change to applyDefaultMaxTurns when 0 is entered", async () => {
    const deps = makeDeps();
    const ctx = makeCtx([
      "Settings",
      "Default max turns (current: unlimited)",
      undefined,
    ]);
    ctx.ui.input = vi.fn().mockResolvedValue("0");
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    expect(deps.settings.applyDefaultMaxTurns).toHaveBeenCalledWith(0);
  });

  it("delegates graceTurns change to applyGraceTurns when a positive value is entered", async () => {
    const deps = makeDeps();
    const ctx = makeCtx([
      "Settings",
      "Grace turns (current: 5)",
      undefined,
    ]);
    ctx.ui.input = vi.fn().mockResolvedValue("3");
    const handler = createAgentsMenuHandler(deps);
    await handler(ctx as any);
    expect(deps.settings.applyGraceTurns).toHaveBeenCalledWith(3);
  });
});
