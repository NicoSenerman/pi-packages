import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { AgentsMenuHandler } from "#src/ui/agent-menu";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createTestSubagentConfig, makeFileOps, makeMenuManager, makeMenuUI } from "#test/helpers/ui-stubs";

const testDefaultAgentConfig = createTestSubagentConfig();

/** Real registry for all tests. Methods are spied on per-test as needed. */
const testRegistry = new AgentTypeRegistry(() => new Map());

function makeSettings() {
  return {
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
  };
}

/**
 * Create an AgentsMenuHandler with all defaults, returning both the handler
 * and the individual collaborator stubs so tests can assert on them.
 */
function makeHandler(opts: {
  manager?: ReturnType<typeof makeMenuManager>;
  fileOps?: ReturnType<typeof makeFileOps>;
  settings?: ReturnType<typeof makeSettings>;
  personalAgentsDir?: string;
  projectAgentsDir?: string;
} = {}) {
  const manager = opts.manager ?? makeMenuManager();
  const fileOps = opts.fileOps ?? makeFileOps();
  const settings = opts.settings ?? makeSettings();
  const personalAgentsDir = opts.personalAgentsDir ?? "/home/.pi/agents";
  const projectAgentsDir = opts.projectAgentsDir ?? "/test-project/.pi/agents";
  const handler = new AgentsMenuHandler(
    manager,
    testRegistry,
    new Map(),
    settings,
    fileOps,
    personalAgentsDir,
    projectAgentsDir,
  );
  return { handler, manager, settings, fileOps };
}

function makeUI(selectResults: (string | undefined)[] = []) {
  return {
    ui: makeMenuUI(selectResults),
    modelRegistry: { find: () => undefined, getAll: () => [] },
    parentSnapshot: STUB_SNAPSHOT,
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

describe("AgentsMenuHandler", () => {
  it("is constructable", () => {
    const { handler } = makeHandler();
    expect(handler).toBeInstanceOf(AgentsMenuHandler);
  });

  it("calls registry.reload() on menu open", async () => {
    const reloadSpy = vi.spyOn(testRegistry, "reload");
    const { handler } = makeHandler();
    const params = makeUI([undefined]); // user cancels immediately
    await handler.handle(params);
    expect(reloadSpy).toHaveBeenCalled();
  });

  it("shows Create new agent option", async () => {
    const { handler } = makeHandler();
    const params = makeUI([undefined]);
    await handler.handle(params);
    const selectCall = params.ui.select.mock.calls[0];
    expect(selectCall[1]).toContain("Create new agent");
  });

  it("shows Settings option", async () => {
    const { handler } = makeHandler();
    const params = makeUI([undefined]);
    await handler.handle(params);
    const selectCall = params.ui.select.mock.calls[0];
    expect(selectCall[1]).toContain("Settings");
  });

  it("shows running agents when agents are active", async () => {
    const { handler } = makeHandler({
      manager: {
        listAgents: vi.fn().mockReturnValue([
          createTestSubagent({ status: "running" }),
          createTestSubagent({ status: "completed", id: "agent-2" }),
        ]),
        getRecord: vi.fn(),
        spawnAndWait: vi.fn(),
      },
    });
    const params = makeUI([undefined]);
    await handler.handle(params);
    const options = params.ui.select.mock.calls[0][1] as string[];
    expect(options.some((o: string) => o.startsWith("Running agents ("))).toBe(true);
  });
});

describe("agent menu — delegates to config editor", () => {
  it("passes fileOps with correct dirs to the config editor", async () => {
    vi.spyOn(testRegistry, "getAllTypes").mockReturnValue(["test-agent"]);
    const fileOps = makeFileOps();
    const { handler } = makeHandler({ fileOps, projectAgentsDir: "/test-project/.pi/agents" });
    let selectCall = 0;
    const params = makeUI([]);
    params.ui.select = vi.fn().mockImplementation((_title: string, options: string[]) => {
      selectCall++;
      if (selectCall === 1) return "Agent types (1)"; // main menu
      if (selectCall === 2) return options[0]; // pick first agent type
      return undefined; // cancel everything else
    });

    await handler.handle(params);

    expect(fileOps.findAgentFile).toHaveBeenCalledWith(
      "test-agent",
      ["/test-project/.pi/agents", "/home/.pi/agents"],
    );
  });
});

describe("agent menu — settings", () => {
  it("navigates to settings and delegates maxConcurrent change to applyMaxConcurrent", async () => {
    const { handler, settings } = makeHandler();
    const params = makeUI([
      "Settings", // from main menu
      "Max concurrency (current: 4)", // from settings
      undefined, // cancel settings re-show
    ]);
    params.ui.input = vi.fn().mockResolvedValue("8");
    await handler.handle(params);
    expect(settings.applyMaxConcurrent).toHaveBeenCalledWith(8);
  });

  it("delegates defaultMaxTurns change to applyDefaultMaxTurns when 0 is entered", async () => {
    const { handler, settings } = makeHandler();
    const params = makeUI([
      "Settings",
      "Default max turns (current: unlimited)",
      undefined,
    ]);
    params.ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle(params);
    expect(settings.applyDefaultMaxTurns).toHaveBeenCalledWith(0);
  });

  it("delegates graceTurns change to applyGraceTurns when a positive value is entered", async () => {
    const { handler, settings } = makeHandler();
    const params = makeUI([
      "Settings",
      "Grace turns (current: 5)",
      undefined,
    ]);
    params.ui.input = vi.fn().mockResolvedValue("3");
    await handler.handle(params);
    expect(settings.applyGraceTurns).toHaveBeenCalledWith(3);
  });
});
