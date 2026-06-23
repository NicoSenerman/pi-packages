import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { AgentCreationWizard } from "#src/ui/agent-creation-wizard";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { makeFileOps, makeMenuManager, makeMenuUI } from "#test/helpers/ui-stubs";

const testRegistry = new AgentTypeRegistry(() => new Map());

function makeDeps() {
  return {
    fileOps: makeFileOps(),
    manager: makeMenuManager(),
    registry: testRegistry,
    personalAgentsDir: "/home/.pi/agents",
    projectAgentsDir: "/project/.pi/agents",
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(testRegistry, "reload").mockImplementation(() => {});
});

function makeWizard(deps: ReturnType<typeof makeDeps>) {
  return new AgentCreationWizard(
    deps.fileOps,
    deps.manager,
    deps.registry,
    deps.personalAgentsDir,
    deps.projectAgentsDir,
  );
}

/** Queue sequential `input` responses on a menu UI. */
function withInputs(ui: ReturnType<typeof makeMenuUI>, ...values: (string | undefined)[]) {
  for (const v of values) ui.input.mockResolvedValueOnce(v);
  return ui;
}

/** Menu UI for the "Generate with Claude" path, with queued description/name inputs. */
function generateUI(inputs: (string | undefined)[]) {
  return withInputs(
    makeMenuUI(["Project (.pi/agents/)", "Generate with Claude (recommended)"]),
    ...inputs,
  );
}

/** Menu UI for the "Manual configuration" path, with queued name/description inputs. */
function manualUI(
  selections: { location?: string; tools?: string; model?: string; thinking?: string },
  inputs: (string | undefined)[],
) {
  return withInputs(
    makeMenuUI([
      selections.location ?? "Project (.pi/agents/)",
      "Manual configuration",
      selections.tools ?? "all",
      selections.model ?? "inherit (parent model)",
      selections.thinking ?? "inherit",
    ]),
    ...inputs,
  );
}

describe("AgentCreationWizard", () => {
  describe("showCreateWizard", () => {
    it("returns when user cancels location selection", async () => {
      const deps = makeDeps();
      const ui = makeMenuUI([undefined]);
      const wizard = makeWizard(deps);

      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(ui.select).toHaveBeenCalledTimes(1);
    });

    it("returns when user cancels method selection", async () => {
      const deps = makeDeps();
      const ui = makeMenuUI(["Project (.pi/agents/)", undefined]);
      const wizard = makeWizard(deps);

      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(ui.select).toHaveBeenCalledTimes(2);
    });
  });

  describe("generate wizard", () => {
    it("spawns agent and notifies on success when file is created", async () => {
      const deps = makeDeps();
      deps.fileOps.exists.mockReturnValue(false).mockReturnValueOnce(false);
      deps.manager.spawnAndWait.mockResolvedValue(
        createTestSubagent({ status: "completed" }),
      );
      // After spawn, check if file exists → true (file was created by spawned agent)
      deps.fileOps.exists
        .mockReset()
        .mockReturnValueOnce(false) // overwrite check before spawn
        .mockReturnValueOnce(true); // success check after spawn

      const ui = generateUI(["A code reviewer agent", "code-reviewer"]);

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(deps.manager.spawnAndWait).toHaveBeenCalledWith(
        STUB_SNAPSHOT,
        "general-purpose",
        expect.stringContaining("code-reviewer"),
        expect.objectContaining({ maxTurns: 5 }),
      );
      expect(deps.fileOps.ensureDir).toHaveBeenCalledWith("/project/.pi/agents");
      expect(ui.notify).toHaveBeenCalledWith(
        "Created /project/.pi/agents/code-reviewer.md",
        "info",
      );
    });

    it("notifies warning when spawn returns error status", async () => {
      const deps = makeDeps();
      deps.manager.spawnAndWait.mockResolvedValue(
        createTestSubagent({ status: "error", error: "spawn failed" }),
      );

      const ui = generateUI(["description", "test-agent"]);

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(ui.notify).toHaveBeenCalledWith(
        "Generation failed: spawn failed",
        "warning",
      );
    });

    it("notifies warning when file is not created after successful spawn", async () => {
      const deps = makeDeps();
      deps.manager.spawnAndWait.mockResolvedValue(
        createTestSubagent({ status: "completed" }),
      );
      // File does not exist after spawn
      deps.fileOps.exists.mockReturnValue(false);

      const ui = generateUI(["description", "test-agent"]);

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(ui.notify).toHaveBeenCalledWith(
        "Agent generation completed but file was not created. Check the agent output.",
        "warning",
      );
    });

    it("prompts for overwrite when target file already exists", async () => {
      const deps = makeDeps();
      deps.fileOps.exists.mockReturnValue(true);

      const ui = generateUI(["description", "existing-agent"]);
      ui.confirm.mockResolvedValue(false);

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(ui.confirm).toHaveBeenCalledWith(
        "Overwrite",
        expect.stringContaining("already exists"),
      );
      expect(deps.manager.spawnAndWait).not.toHaveBeenCalled();
    });

    it("returns when user cancels description input", async () => {
      const deps = makeDeps();
      const ui = generateUI([undefined]);

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(deps.manager.spawnAndWait).not.toHaveBeenCalled();
    });
  });

  describe("manual wizard", () => {
    it("writes agent file with all form inputs", async () => {
      const deps = makeDeps();
      const ui = manualUI({}, ["my-agent", "A test agent"]);
      ui.editor.mockResolvedValue("You are a test agent.");

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(deps.fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/my-agent.md",
        expect.stringContaining("description: A test agent"),
      );
      expect(deps.fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/my-agent.md",
        expect.stringContaining("You are a test agent."),
      );
      expect(testRegistry.reload).toHaveBeenCalled();
    });

    it("includes model line when a specific model is selected", async () => {
      const deps = makeDeps();
      const ui = manualUI({ model: "haiku" }, ["fast-agent", "Fast agent"]);
      ui.editor.mockResolvedValue("prompt");

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(deps.fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/fast-agent.md",
        expect.stringContaining("model: anthropic/claude-haiku-4-5-20251001"),
      );
    });

    it("includes thinking line when a non-inherit level is selected", async () => {
      const deps = makeDeps();
      const ui = manualUI({ thinking: "high" }, ["thinker", "Deep thinker"]);
      ui.editor.mockResolvedValue("prompt");

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(deps.fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/thinker.md",
        expect.stringContaining("thinking: high"),
      );
    });

    it("uses read-only tools when read-only is selected", async () => {
      const deps = makeDeps();
      const ui = manualUI(
        { tools: "read-only (read, bash, grep, find, ls)" },
        ["reader", "Read-only agent"],
      );
      ui.editor.mockResolvedValue("prompt");

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(deps.fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/reader.md",
        expect.stringContaining("tools: read, bash, grep, find, ls"),
      );
    });

    it("prompts for overwrite when target file already exists", async () => {
      const deps = makeDeps();
      deps.fileOps.exists.mockReturnValue(true);
      const ui = manualUI({}, ["existing", "desc"]);
      ui.editor.mockResolvedValue("prompt");
      ui.confirm.mockResolvedValue(false);

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(ui.confirm).toHaveBeenCalledWith(
        "Overwrite",
        expect.stringContaining("already exists"),
      );
      expect(deps.fileOps.write).not.toHaveBeenCalled();
    });

    it("returns when user cancels name input", async () => {
      const deps = makeDeps();
      const ui = withInputs(
        makeMenuUI(["Project (.pi/agents/)", "Manual configuration"]),
        undefined,
      );

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(deps.fileOps.write).not.toHaveBeenCalled();
    });

    it("writes to personal directory when personal is selected", async () => {
      const deps = makeDeps();
      const ui = manualUI(
        { location: "Personal (/home/.pi/agents)" },
        ["personal-agent", "Personal agent"],
      );
      ui.editor.mockResolvedValue("prompt");

      const wizard = makeWizard(deps);
      await wizard.showCreateWizard(ui, STUB_SNAPSHOT);

      expect(deps.fileOps.write).toHaveBeenCalledWith(
        "/home/.pi/agents/personal-agent.md",
        expect.stringContaining("description: Personal agent"),
      );
    });
  });
});
