import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";
import {
  AgentConfigEditor,
  buildEjectContent,
  buildMenuOptions,
} from "#src/ui/agent-config-editor";
import { createTestSubagentConfig, makeFileOps, makeMenuUI } from "#test/helpers/ui-stubs";

const testDefaultConfig = createTestSubagentConfig();
const testCustomConfig = createTestSubagentConfig({ isDefault: false, source: "project" });

/** A config marked disabled (`enabled: false`), preserving the rest of `base`. */
function disabledConfig(base: typeof testDefaultConfig) {
  return { ...base, enabled: false };
}

const testRegistry = new AgentTypeRegistry(() => new Map());

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
    editor: new AgentConfigEditor(fileOps, testRegistry, personalAgentsDir, projectAgentsDir),
  };
}

/**
 * Setup helper for `showAgentDetail` tests.
 *
 * Creates an editor + file ops + menu UI in one call.
 * Pass `filePath` to configure `findAgentFile`; pass `fileContent` to configure `read`.
 */
function setupDetail(
  selectResults: (string | undefined)[],
  options: { filePath?: string; fileContent?: string } = {},
) {
  const { fileOps, editor } = makeEditor();
  const ui = makeMenuUI(selectResults);
  fileOps.findAgentFile.mockReturnValue(options.filePath);
  if (options.fileContent !== undefined) {
    fileOps.read.mockReturnValue(options.fileContent);
  }
  return { fileOps, editor, ui };
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
      const { editor, ui } = setupDetail([]);

      await editor.showAgentDetail(ui, "missing-agent");

      expect(ui.notify).toHaveBeenCalledWith(
        'Agent config not found for "missing-agent".',
        "warning",
      );
    });

    it("returns without action when user selects Back", async () => {
      const { editor, ui } = setupDetail(["Back"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(ui.notify).not.toHaveBeenCalled();
    });

    it("returns without action when user cancels", async () => {
      const { editor, ui } = setupDetail([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(ui.notify).not.toHaveBeenCalled();
    });

    // ---- Menu option structure ----

    it("shows Eject and Disable for a default agent with no file", async () => {
      const { editor, ui } = setupDetail([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Eject (export as .md)", "Disable", "Back"]);
    });

    it("shows Edit, Disable, Reset, Delete for a default agent with override file", async () => {
      const { editor, ui } = setupDetail([undefined], { filePath: "/project/.pi/agents/test-agent.md" });

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Edit", "Disable", "Reset to default", "Delete", "Back"]);
    });

    it("shows Edit, Disable, Delete for a custom agent with file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testCustomConfig);
      const { editor, ui } = setupDetail([undefined], { filePath: "/project/.pi/agents/test-agent.md" });

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Edit", "Disable", "Delete", "Back"]);
    });

    it("shows Enable, Edit, Reset, Delete for a disabled default agent with file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(disabledConfig(testDefaultConfig));
      const { editor, ui } = setupDetail([undefined], { filePath: "/project/.pi/agents/test-agent.md" });

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Enable", "Edit", "Reset to default", "Delete", "Back"]);
    });

    it("shows Enable, Edit, Delete for a disabled custom agent with file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(disabledConfig(testCustomConfig));
      const { editor, ui } = setupDetail([undefined], { filePath: "/project/.pi/agents/test-agent.md" });

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Enable", "Edit", "Delete", "Back"]);
    });

    // ---- Edit ----

    it("writes updated content when user edits and saves", async () => {
      const filePath = "/project/.pi/agents/test-agent.md";
      const { fileOps, editor, ui } = setupDetail(["Edit"], { filePath, fileContent: "original content" });
      ui.editor.mockResolvedValue("edited content");

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(filePath, "edited content");
      expect(testRegistry.reload).toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(`Updated ${filePath}`, "info");
    });

    it("does not write when editor returns unchanged content", async () => {
      const filePath = "/project/.pi/agents/test-agent.md";
      const { fileOps, editor, ui } = setupDetail(["Edit"], { filePath, fileContent: "same content" });
      ui.editor.mockResolvedValue("same content");

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
    });

    it("does not write when user cancels editor", async () => {
      const filePath = "/project/.pi/agents/test-agent.md";
      const { fileOps, editor, ui } = setupDetail(["Edit"], { filePath, fileContent: "content" });
      ui.editor.mockResolvedValue(undefined);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
    });

    // ---- Delete ----

    it("removes file when user confirms delete", async () => {
      const filePath = "/project/.pi/agents/test-agent.md";
      const { fileOps, editor, ui } = setupDetail(["Delete"], { filePath });
      ui.confirm.mockResolvedValue(true);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.remove).toHaveBeenCalledWith(filePath);
      expect(testRegistry.reload).toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(`Deleted ${filePath}`, "info");
    });

    it("does not remove file when user cancels delete", async () => {
      const { fileOps, editor, ui } = setupDetail(["Delete"], { filePath: "/project/.pi/agents/test-agent.md" });
      ui.confirm.mockResolvedValue(false);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.remove).not.toHaveBeenCalled();
    });

    // ---- Reset to default ----

    it("removes override file when user confirms reset", async () => {
      const filePath = "/project/.pi/agents/test-agent.md";
      const { fileOps, editor, ui } = setupDetail(["Reset to default"], { filePath });
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
      const { fileOps, editor, ui } = setupDetail(["Eject (export as .md)", "Project (.pi/agents/)"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/test-agent.md",
        expect.stringContaining("description: A test agent"),
      );
      expect(testRegistry.reload).toHaveBeenCalled();
    });

    it("prompts for overwrite when ejected file already exists", async () => {
      const { fileOps, editor, ui } = setupDetail(["Eject (export as .md)", "Project (.pi/agents/)"]);
      fileOps.exists.mockReturnValue(true);
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
      const filePath = "/project/.pi/agents/test-agent.md";
      const { fileOps, editor, ui } = setupDetail(["Disable"], {
        filePath,
        fileContent: "---\ndescription: test\n---\n\nprompt\n",
      });

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(
        filePath,
        "---\nenabled: false\ndescription: test\n---\n\nprompt\n",
      );
      expect(testRegistry.reload).toHaveBeenCalled();
    });

    it("notifies when agent is already disabled", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testCustomConfig);
      const { fileOps, editor, ui } = setupDetail(["Disable"], {
        filePath: "/project/.pi/agents/test-agent.md",
        fileContent: "---\nenabled: false\ndescription: test\n---\n",
      });

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith("test-agent is already disabled.", "info");
    });

    it("creates a disable-only file when no agent file exists", async () => {
      const { fileOps, editor, ui } = setupDetail(["Disable", "Project (.pi/agents/)"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(
        "/project/.pi/agents/test-agent.md",
        "---\nenabled: false\n---\n",
      );
    });

    // ---- Enable ----

    it("enables agent by removing enabled:false from file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(disabledConfig(testCustomConfig));
      const filePath = "/project/.pi/agents/test-agent.md";
      const { fileOps, editor, ui } = setupDetail(["Enable"], {
        filePath,
        fileContent: "---\nenabled: false\ndescription: test\n---\n\nprompt\n",
      });

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).toHaveBeenCalledWith(
        filePath,
        "---\ndescription: test\n---\n\nprompt\n",
      );
      expect(testRegistry.reload).toHaveBeenCalled();
    });

    it("removes empty override file when enabling", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(disabledConfig(testDefaultConfig));
      const filePath = "/project/.pi/agents/test-agent.md";
      const { fileOps, editor, ui } = setupDetail(["Enable"], {
        filePath,
        fileContent: "---\nenabled: false\n---\n",
      });

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

describe("buildEjectContent", () => {
  const minimalConfig: AgentConfig = {
    name: "my-agent",
    description: "Does something useful",
    systemPrompt: "You are a useful agent.",
    promptMode: "replace",
  };

  it("produces minimal frontmatter for a config with no optional fields", () => {
    expect(buildEjectContent(minimalConfig)).toBe(
      [
        "---",
        "description: Does something useful",
        "tools: all",
        "prompt_mode: replace",
        "---",
        "",
        "You are a useful agent.",
        "",
      ].join("\n"),
    );
  });

  it("includes all optional scalar fields when present", () => {
    const cfg: AgentConfig = {
      ...minimalConfig,
      displayName: "My Agent",
      builtinToolNames: ["read", "bash"],
      model: "claude-sonnet",
      thinking: "low",
      maxTurns: 10,
      inheritContext: true,
      runInBackground: true,
    };
    const content = buildEjectContent(cfg);
    expect(content).toContain("display_name: My Agent");
    expect(content).toContain("tools: read, bash");
    expect(content).toContain("model: claude-sonnet");
    expect(content).toContain("thinking: low");
    expect(content).toContain("max_turns: 10");
    expect(content).toContain("inherit_context: true");
    expect(content).toContain("run_in_background: true");
  });
});
