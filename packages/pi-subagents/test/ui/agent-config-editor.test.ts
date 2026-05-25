import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";
import {
  buildEjectContent,
  buildMenuOptions,
  createAgentConfigEditor,
} from "#src/ui/agent-config-editor";
import { createTestAgentConfig, makeFileOps, makeMenuUI } from "#test/helpers/ui-stubs";

const testDefaultConfig = createTestAgentConfig();
const testCustomConfig = createTestAgentConfig({ isDefault: false, source: "project" });

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
    editor: createAgentConfigEditor(fileOps, testRegistry, personalAgentsDir, projectAgentsDir),
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
      const ui = makeMenuUI();

      await editor.showAgentDetail(ui, "missing-agent");

      expect(ui.notify).toHaveBeenCalledWith(
        'Agent config not found for "missing-agent".',
        "warning",
      );
    });

    it("returns without action when user selects Back", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      const ui = makeMenuUI(["Back"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(ui.notify).not.toHaveBeenCalled();
    });

    it("returns without action when user cancels", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      const ui = makeMenuUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(ui.notify).not.toHaveBeenCalled();
    });

    // ---- Menu option structure ----

    it("shows Eject and Disable for a default agent with no file", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      const ui = makeMenuUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Eject (export as .md)", "Disable", "Back"]);
    });

    it("shows Edit, Disable, Reset, Delete for a default agent with override file", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      const ui = makeMenuUI([undefined]);

      await editor.showAgentDetail(ui, "test-agent");

      const options = ui.select.mock.calls[0][1] as string[];
      expect(options).toEqual(["Edit", "Disable", "Reset to default", "Delete", "Back"]);
    });

    it("shows Edit, Disable, Delete for a custom agent with file", async () => {
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testCustomConfig);
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      const ui = makeMenuUI([undefined]);

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
      const ui = makeMenuUI([undefined]);

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
      const ui = makeMenuUI([undefined]);

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
      const ui = makeMenuUI(["Edit"]);
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
      const ui = makeMenuUI(["Edit"]);
      ui.editor.mockResolvedValue("same content");

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
    });

    it("does not write when user cancels editor", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      fileOps.read.mockReturnValue("content");
      const ui = makeMenuUI(["Edit"]);
      ui.editor.mockResolvedValue(undefined);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
    });

    // ---- Delete ----

    it("removes file when user confirms delete", async () => {
      const { fileOps, editor } = makeEditor();
      const filePath = "/project/.pi/agents/test-agent.md";
      fileOps.findAgentFile.mockReturnValue(filePath);
      const ui = makeMenuUI(["Delete"]);
      ui.confirm.mockResolvedValue(true);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.remove).toHaveBeenCalledWith(filePath);
      expect(testRegistry.reload).toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(`Deleted ${filePath}`, "info");
    });

    it("does not remove file when user cancels delete", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue("/project/.pi/agents/test-agent.md");
      const ui = makeMenuUI(["Delete"]);
      ui.confirm.mockResolvedValue(false);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.remove).not.toHaveBeenCalled();
    });

    // ---- Reset to default ----

    it("removes override file when user confirms reset", async () => {
      const { fileOps, editor } = makeEditor();
      const filePath = "/project/.pi/agents/test-agent.md";
      fileOps.findAgentFile.mockReturnValue(filePath);
      const ui = makeMenuUI(["Reset to default"]);
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
      const ui = makeMenuUI(["Eject (export as .md)", "Project (.pi/agents/)"]);

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
      const ui = makeMenuUI(["Eject (export as .md)", "Project (.pi/agents/)"]);
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
      const ui = makeMenuUI(["Disable"]);

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
      const ui = makeMenuUI(["Disable"]);

      await editor.showAgentDetail(ui, "test-agent");

      expect(fileOps.write).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith("test-agent is already disabled.", "info");
    });

    it("creates a disable-only file when no agent file exists", async () => {
      const { fileOps, editor } = makeEditor();
      fileOps.findAgentFile.mockReturnValue(undefined);
      vi.spyOn(testRegistry, "resolveAgentConfig").mockReturnValue(testDefaultConfig);
      const ui = makeMenuUI(["Disable", "Project (.pi/agents/)"]);

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
      const ui = makeMenuUI(["Enable"]);

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
      const ui = makeMenuUI(["Enable"]);

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
    extensions: true,
    skills: true,
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
      isolated: true,
      isolation: "worktree",
      disallowedTools: ["web_search"],
    };
    const content = buildEjectContent(cfg);
    expect(content).toContain("display_name: My Agent");
    expect(content).toContain("tools: read, bash");
    expect(content).toContain("model: claude-sonnet");
    expect(content).toContain("thinking: low");
    expect(content).toContain("max_turns: 10");
    expect(content).toContain("disallowed_tools: web_search");
    expect(content).toContain("inherit_context: true");
    expect(content).toContain("run_in_background: true");
    expect(content).toContain("isolated: true");
    expect(content).toContain("isolation: worktree");
  });

  it("emits 'extensions: false' when extensions is false", () => {
    const cfg: AgentConfig = { ...minimalConfig, extensions: false };
    expect(buildEjectContent(cfg)).toContain("extensions: false");
  });

  it("emits 'extensions: <list>' when extensions is an array", () => {
    const cfg: AgentConfig = {
      ...minimalConfig,
      extensions: ["pi-github-tools", "pi-colgrep"],
    };
    expect(buildEjectContent(cfg)).toContain(
      "extensions: pi-github-tools, pi-colgrep",
    );
  });

  it("emits 'skills: false' when skills is false", () => {
    const cfg: AgentConfig = { ...minimalConfig, skills: false };
    expect(buildEjectContent(cfg)).toContain("skills: false");
  });

  it("emits 'skills: <list>' when skills is an array", () => {
    const cfg: AgentConfig = { ...minimalConfig, skills: ["code-design"] };
    expect(buildEjectContent(cfg)).toContain("skills: code-design");
  });

  it("does not emit extension/skills fields when they are true", () => {
    const content = buildEjectContent(minimalConfig);
    expect(content).not.toContain("extensions:");
    expect(content).not.toContain("skills:");
  });
});
