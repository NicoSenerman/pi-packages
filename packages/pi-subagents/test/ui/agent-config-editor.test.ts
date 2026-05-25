import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";
import { buildMenuOptions, createAgentConfigEditor } from "#src/ui/agent-config-editor";

const testDefaultConfig: AgentConfig = {
  name: "test-agent",
  description: "A test agent",
  systemPrompt: "You are a test agent.",
  promptMode: "replace" as const,
  extensions: true,
  skills: true,
  isDefault: true,
  source: "default" as const,
};

const testCustomConfig: AgentConfig = {
  ...testDefaultConfig,
  isDefault: false,
  source: "project" as const,
};

const testRegistry = new AgentTypeRegistry(() => new Map());

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

function makeEditor(overrides: {
  fileOps?: ReturnType<typeof makeFileOps>;
  personalAgentsDir?: string;
  projectAgentsDir?: string;
} = {}) {
  const fileOps = overrides.fileOps ?? makeFileOps();
  const personalAgentsDir = overrides.personalAgentsDir ?? "/home/.pi/agents";
  const projectAgentsDir = overrides.projectAgentsDir ?? "/project/.pi/agents";
  return {
    fileOps,
    editor: createAgentConfigEditor(fileOps, testRegistry, personalAgentsDir, projectAgentsDir),
  };
}

function makeUI(selectResults: (string | undefined)[] = []) {
  let selectIdx = 0;
  return {
    select: vi.fn().mockImplementation(() => selectResults[selectIdx++]),
    input: vi.fn(),
    confirm: vi.fn(),
    editor: vi.fn(),
    notify: vi.fn(),
    custom: vi.fn(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testDefaultConfig);
  vi.spyOn(testRegistry, "resolveType").mockReturnValue("test-agent");
  vi.spyOn(testRegistry, "reload").mockImplementation(() => {});
  vi.spyOn(testRegistry, "getAllTypes").mockReturnValue([]);
});

describe("createAgentConfigEditor", () => {
  describe("showAgentDetail", () => {
    it("notifies warning when agent type is not found", async () => {
      vi.spyOn(testRegistry, "resolveType").mockReturnValue(undefined);
      const { editor } = makeEditor();
      const ui = makeUI();

      await editor.showAgentDetail(ui, "missing-agent");

      expect(ui.notify).toHaveBeenCalledWith(
        'Agent config not found for "missing-agent".',
        "warning",
      );
    });

    it("returns without action when user selects Back", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      const ui = makeUI(["Back"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(ui.notify).not.toHaveBeenCalled();
    });

    it("returns without action when user cancels", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      const ui = makeUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(ui.notify).not.toHaveBeenCalled();
    });

    // ---- Menu option structure ----

    it("shows Eject and Disable for a default agent with no file", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      const ui = makeUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Eject (export as .md)", "Disable", "Back"]);
    });

    it("shows Edit, Disable, Reset, Delete for a default agent with override file", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      const ui = makeUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Edit", "Disable", "Reset to default", "Delete", "Back"]);
    });

    it("shows Edit, Disable, Delete for a custom agent with file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testCustomConfig);
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      const ui = makeUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Edit", "Disable", "Delete", "Back"]);
    });

    it("shows Enable, Edit, Reset, Delete for a disabled default agent with file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue({
        ...testDefaultConfig,
        enabled: false,
      });
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      const ui = makeUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Enable", "Edit", "Reset to default", "Delete", "Back"]);
    });

    it("shows Enable, Edit, Delete for a disabled custom agent with file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue({
        ...testCustomConfig,
        enabled: false,
      });
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      const ui = makeUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Enable", "Edit", "Delete", "Back"]);
    });

    // ---- Edit ----

    it("writes updated content when user edits and saves", async () => {
      const { fileOps, editor } = makeEditor();
      const filePath = "/project/.pi/agents/test-agent.md";
      fileOps.findAgentFile.mockReturnValue(filePath);
      fileOps.read.mockReturnValue("original content");
      const ui = makeUI(["Edit"]);
      ui.editor.mockResolvedValue("edited content");

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(filePath, "edited content");
      expect(testRegistry.reload).toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(`Updated ${filePath}`, "info");
    });

    it("does not write when editor returns unchanged content", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      fileOps.read.mockReturnValue("same content");
      const ui = makeUI(["Edit"]);
      ui.editor.mockResolvedValue("same content");

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
    });

    it("does not write when user cancels editor", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      fileOps.read.mockReturnValue("content");
      const ui = makeUI(["Edit"]);
      ui.editor.mockResolvedValue(undefined);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
    });

    // ---- Delete ----

    it("removes file when user confirms delete", async () => {
      const { fileOps, editor } = makeEditor();
      const filePath = "/project/.pi/agents/test-agent.md";
      fileOps.findAgentFile.mockReturnValue(filePath);
      const ui = makeUI(["Delete"]);
      ui.confirm.mockResolvedValue(true);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.remove).toHaveBeenCalledWith(filePath);
      expect(testRegistry.reload).toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(`Deleted ${filePath}`, "info");
    });

    it("does not remove file when user cancels delete", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      const ui = makeUI(["Delete"]);
      ui.confirm.mockResolvedValue(false);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.remove).not.toHaveBeenCalled();
    });

    // ---- Reset to default ----

    it("removes override file when user confirms reset", async () => {
      const { fileOps, editor } = makeEditor();
      const filePath = "/project/.pi/agents/test-agent.md";
      fileOps.findAgentFile.mockReturnValue(filePath);
      const ui = makeUI(["Reset to default"]);
      ui.confirm.mockResolvedValue(true);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.remove).toHaveBeenCalledWith(filePath);
      expect(testRegistry.reload).toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith("Restored default test-agent", "info");
    });

    // ---- Eject ----

    it("writes ejected config to project directory", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue({
        ...testDefaultConfig,
        builtinToolNames: ["read", "bash"],
      });
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      const ui = makeUI(["Eject (export as .md)", "Project (.pi/agents/)"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/test-agent.md",
        expect.stringContaining("description: A test agent"),
      );
      expect(testRegistry.reload).toHaveBeenCalled();
    });

    it("prompts for overwrite when ejected file already exists", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      fileOps.exists.mockReturnValue(true);
      const ui = makeUI(["Eject (export as .md)", "Project (.pi/agents/)"]);
      ui.confirm.mockResolvedValue(false);

      await editor.showAgentDetail(ui, "test-agent");

      expect(ui.confirm).toHaveBeenCalledWith(
        "Overwrite",
        expect.stringContaining("already exists"),
      );
      expect(fileOps.write).not.toHaveBeenCalled();
    });

    // ---- Disable ----

    it("disables agent by toggling enabled:false in existing file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testCustomConfig);
      const { fileOps, editor } = makeEditor();
      const filePath = "/project/.pi/agents/test-agent.md";
      fileOps.findAgentFile.mockReturnValue(filePath);
      fileOps.read.mockReturnValue("---\ndescription: test\n---\n\nprompt\n");
      const ui = makeUI(["Disable"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(
        filePath,
        "---\nenabled: false\ndescription: test\n---\n\nprompt\n",
      );
      expect(testRegistry.reload).toHaveBeenCalled();
    });

    it("notifies when agent is already disabled", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testCustomConfig);
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      fileOps.read.mockReturnValue("---\nenabled: false\ndescription: test\n---\n");
      const ui = makeUI(["Disable"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith("test-agent is already disabled.", "info");
    });

    it("creates a disable-only file when no agent file exists", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testDefaultConfig);
      const ui = makeUI(["Disable", "Project (.pi/agents/)"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/test-agent.md",
        "---\nenabled: false\n---\n",
      );
    });

    // ---- Enable ----

    it("enables agent by removing enabled:false from file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue({
        ...testCustomConfig,
        enabled: false,
      });
      const { fileOps, editor } = makeEditor();
      const filePath = "/project/.pi/agents/test-agent.md";
      fileOps.findAgentFile.mockReturnValue(filePath);
      fileOps.read.mockReturnValue("---\nenabled: false\ndescription: test\n---\n\nprompt\n");
      const ui = makeUI(["Enable"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(
        filePath,
        "---\ndescription: test\n---\n\nprompt\n",
      );
      expect(testRegistry.reload).toHaveBeenCalled();
    });

    it("removes empty override file when enabling", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue({
        ...testDefaultConfig,
        enabled: false,
      });
      const { fileOps, editor } = makeEditor();
      const filePath = "/project/.pi/agents/test-agent.md";
      fileOps.findAgentFile.mockReturnValue(filePath);
      fileOps.read.mockReturnValue("---\nenabled: false\n---\n");
      const ui = makeUI(["Enable"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.remove).toHaveBeenCalledWith(filePath);
      expect(ui.notify).toHaveBeenCalledWith(
        `Enabled test-agent (removed ${filePath})`,
        "info",
      );
    });
  });
});

describe("buildMenuOptions", () => {
  it("shows Eject and Disable for a default agent with no file", () => {
    expect(buildMenuOptions({ isDefault: true }, undefined)).toEqual([
      "Eject (export as .md)",
      "Disable",
      "Back",
    ]);
  });

  it("shows Edit, Disable, Reset, Delete for a default agent with override file", () => {
    expect(
      buildMenuOptions({ isDefault: true }, "/project/.pi/agents/test-agent.md"),
    ).toEqual(["Edit", "Disable", "Reset to default", "Delete", "Back"]);
  });

  it("shows Edit, Disable, Delete for a custom agent with file", () => {
    expect(
      buildMenuOptions({ isDefault: false }, "/project/.pi/agents/test-agent.md"),
    ).toEqual(["Edit", "Disable", "Delete", "Back"]);
  });

  it("shows Enable, Edit, Reset, Delete for a disabled default agent with file", () => {
    expect(
      buildMenuOptions(
        { isDefault: true, enabled: false },
        "/project/.pi/agents/test-agent.md",
      ),
    ).toEqual(["Enable", "Edit", "Reset to default", "Delete", "Back"]);
  });

  it("shows Enable, Edit, Delete for a disabled custom agent with file", () => {
    expect(
      buildMenuOptions(
        { isDefault: false, enabled: false },
        "/project/.pi/agents/test-agent.md",
      ),
    ).toEqual(["Enable", "Edit", "Delete", "Back"]);
  });
});
