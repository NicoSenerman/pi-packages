import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/parent-snapshot";
import type { AgentConfig } from "#src/types";
import { type AgentMenuDeps, createAgentsMenuHandler } from "#src/ui/agent-menu";
import { createTestRecord } from "#test/helpers/make-record";

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

/** Minimal stub satisfying the ParentSnapshot interface. */
const stubParentSnapshot: ParentSnapshot = {
  cwd: "/test",
  systemPrompt: "",
  model: {},
  modelRegistry: { find: () => undefined },
};

function makeFileOps() {
  return {
    exists: vi.fn((): boolean => false),
    read: vi.fn((): string | undefined => undefined),
    write: vi.fn(),
    remove: vi.fn(),
    ensureDir: vi.fn(),
    findAgentFile: vi.fn((): string | undefined => undefined),
  };
}

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
    fileOps: makeFileOps(),
    personalAgentsDir: "/home/.pi/agents",
    projectAgentsDir: "/test-project/.pi/agents",
    ...overrides,
  };
}

function makeUI(selectResults: (string | undefined)[] = []) {
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
    modelRegistry: { find: () => undefined, getAll: () => [] },
    parentSnapshot: stubParentSnapshot,
  };
}

beforeEach(() => {
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
    const params = makeUI([undefined]); // user cancels immediately
    const handler = createAgentsMenuHandler(deps);
    await handler(params);
    expect(reloadSpy).toHaveBeenCalled();
  });

  it("shows Create new agent option", async () => {
    const deps = makeDeps();
    const params = makeUI([undefined]);
    const handler = createAgentsMenuHandler(deps);
    await handler(params);
    const selectCall = params.ui.select.mock.calls[0];
    expect(selectCall[1]).toContain("Create new agent");
  });

  it("shows Settings option", async () => {
    const deps = makeDeps();
    const params = makeUI([undefined]);
    const handler = createAgentsMenuHandler(deps);
    await handler(params);
    const selectCall = params.ui.select.mock.calls[0];
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
    const params = makeUI([undefined]);
    const handler = createAgentsMenuHandler(deps);
    await handler(params);
    const options = params.ui.select.mock.calls[0][1] as string[];
    expect(options.some((o: string) => o.startsWith("Running agents ("))).toBe(true);
  });
});

describe("agent menu — delegates to config editor", () => {
  it("passes fileOps with correct dirs to the config editor", async () => {
    vi.spyOn(testRegistry, "getAllTypes").mockReturnValue(["test-agent"]);
    const fileOps = makeFileOps();
    const deps = makeDeps({ fileOps, projectAgentsDir: "/test-project/.pi/agents" });
    let selectCall = 0;
    const params = makeUI([]);
    params.ui.select = vi.fn().mockImplementation((_title: string, options: string[]) => {
      selectCall++;
      if (selectCall === 1) return "Agent types (1)"; // main menu
      if (selectCall === 2) return options[0]; // pick first agent type
      return undefined; // cancel everything else
    });

    const handler = createAgentsMenuHandler(deps);
    await handler(params);

    expect(fileOps.findAgentFile).toHaveBeenCalledWith(
      "test-agent",
      ["/test-project/.pi/agents", "/home/.pi/agents"],
    );
  });
});

describe("agent menu — settings", () => {
  it("navigates to settings and delegates maxConcurrent change to applyMaxConcurrent", async () => {
    const deps = makeDeps();
    const params = makeUI([
      "Settings", // from main menu
      "Max concurrency (current: 4)", // from settings
      undefined, // cancel settings re-show
    ]);
    params.ui.input = vi.fn().mockResolvedValue("8");
    const handler = createAgentsMenuHandler(deps);
    await handler(params);
    expect(deps.settings.applyMaxConcurrent).toHaveBeenCalledWith(8);
  });

  it("delegates defaultMaxTurns change to applyDefaultMaxTurns when 0 is entered", async () => {
    const deps = makeDeps();
    const params = makeUI([
      "Settings",
      "Default max turns (current: unlimited)",
      undefined,
    ]);
    params.ui.input = vi.fn().mockResolvedValue("0");
    const handler = createAgentsMenuHandler(deps);
    await handler(params);
    expect(deps.settings.applyDefaultMaxTurns).toHaveBeenCalledWith(0);
  });

  it("delegates graceTurns change to applyGraceTurns when a positive value is entered", async () => {
    const deps = makeDeps();
    const params = makeUI([
      "Settings",
      "Grace turns (current: 5)",
      undefined,
    ]);
    params.ui.input = vi.fn().mockResolvedValue("3");
    const handler = createAgentsMenuHandler(deps);
    await handler(params);
    expect(deps.settings.applyGraceTurns).toHaveBeenCalledWith(3);
  });
});
