/**
 * agent-creation-wizard.ts — AI-generation and manual-form agent creation flows.
 *
 * Extracted from agent-menu.ts to give each concern a single responsibility.
 * Receives dependencies via injection — no direct `node:fs` imports.
 */

import { join } from "node:path";

import { BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { Subagent } from "#src/types";
import type { AgentFileOps } from "#src/ui/agent-file-ops";
import { writeAgentFile } from "#src/ui/agent-file-writer";
import type { MenuUI } from "#src/ui/agent-menu";

// ---- Deps interface ----

/** Narrow manager interface for agent spawning (generate wizard). */
export interface WizardManager {
  spawnAndWait: (
    parentSnapshot: ParentSnapshot,
    type: string,
    prompt: string,
    opts: { description: string; maxTurns: number },
  ) => Promise<Subagent>;
}

/** Narrow registry interface for reloading after creation. */
export interface WizardRegistry {
  reload(): void;
}

// ---- Class ----

export class AgentCreationWizard {
  constructor(
    private readonly fileOps: AgentFileOps,
    private readonly manager: WizardManager,
    private readonly registry: WizardRegistry,
    private readonly personalAgentsDir: string,
    private readonly projectAgentsDir: string,
  ) {}

  async showCreateWizard(ui: MenuUI, parentSnapshot: ParentSnapshot): Promise<void> {
    const location = await ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${this.personalAgentsDir})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? this.projectAgentsDir
      : this.personalAgentsDir;

    const method = await ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await this.showGenerateWizard(ui, parentSnapshot, targetDir);
    } else {
      await this.showManualWizard(ui, targetDir);
    }
  }

  private async showGenerateWizard(
    ui: MenuUI,
    parentSnapshot: ParentSnapshot,
    targetDir: string,
  ): Promise<void> {
    const description = await ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    this.fileOps.ensureDir(targetDir);

    const targetPath = join(targetDir, `${name}.md`);
    if (this.fileOps.exists(targetPath)) {
      const overwrite = await ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5-20251001". Omit to inherit parent model>
thinking: <optional thinking level: off, minimal, low, medium, high, xhigh. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: append>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <true to run in background by default. Default: false>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    const record = await this.manager.spawnAndWait(
      parentSnapshot,
      "general-purpose",
      generatePrompt,
      {
        description: `Generate ${name} agent`,
        maxTurns: 5,
      },
    );

    if (record.status === "error") {
      ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    this.registry.reload();

    if (this.fileOps.exists(targetPath)) {
      ui.notify(`Created ${targetPath}`, "info");
    } else {
      ui.notify(
        "Agent generation completed but file was not created. Check the agent output.",
        "warning",
      );
    }
  }

  private async showManualWizard(ui: MenuUI, targetDir: string): Promise<void> {
    const name = await ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    const description = await ui.input("Description (one line)");
    if (!description) return;

    const toolChoice = await ui.select("Tools", [
      "all",
      "none",
      "read-only (read, bash, grep, find, ls)",
      "custom...",
    ]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, grep, find, ls";
    } else {
      const customTools = await ui.input(
        "Tools (comma-separated)",
        BUILTIN_TOOL_NAMES.join(", "),
      );
      if (!customTools) return;
      tools = customTools;
    }

    const modelChoice = await ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let modelLine = "";
    if (modelChoice === "haiku")
      modelLine = "\nmodel: anthropic/claude-haiku-4-5-20251001";
    else if (modelChoice === "sonnet")
      modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus")
      modelLine = "\nmodel: anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      const customModel = await ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }

    const thinkingChoice = await ui.select("Thinking level", [
      "inherit",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    if (!thinkingChoice) return;

    let thinkingLine = "";
    if (thinkingChoice !== "inherit") thinkingLine = `\nthinking: ${thinkingChoice}`;

    const systemPrompt = await ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = `---
description: ${description}
tools: ${tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;

    const targetPath = join(targetDir, `${name}.md`);

    await writeAgentFile(this.fileOps, ui, this.registry, targetPath, content, "Created");
  }
}
