/**
 * agent-config-editor.ts — Agent detail view with edit/delete/eject/disable/enable transitions.
 *
 * Extracted from agent-menu.ts to give each concern a single responsibility.
 * Receives dependencies via injection — no direct `node:fs` imports.
 */

import { join } from "node:path";

import type { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";
import type { AgentFileOps } from "#src/ui/agent-file-ops";
import { writeAgentFile } from "#src/ui/agent-file-writer";
import type { MenuUI } from "#src/ui/menu-ui";

// ---- Pure helpers ----

/** Compute the menu option list for the agent detail view. */
export function buildMenuOptions(
  cfg: { isDefault?: boolean; enabled?: boolean },
  file: string | undefined,
): string[] {
  const isDefault = cfg.isDefault === true;
  const disabled = cfg.enabled === false;

  if (disabled && file) {
    return isDefault
      ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
      : ["Enable", "Edit", "Delete", "Back"];
  }
  if (isDefault && !file) {
    return ["Eject (export as .md)", "Disable", "Back"];
  }
  if (isDefault && file) {
    return ["Edit", "Disable", "Reset to default", "Delete", "Back"];
  }
  return ["Edit", "Disable", "Delete", "Back"];
}

/** Build the `.md` file content (frontmatter + system prompt) for an ejected agent. */
export function buildEjectContent(cfg: AgentConfig): string {
  const fmFields: string[] = [];
  fmFields.push(`description: ${cfg.description}`);
  if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
  fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") ?? "all"}`);
  if (cfg.model) fmFields.push(`model: ${cfg.model}`);
  if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
  if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
  fmFields.push(`prompt_mode: ${cfg.promptMode}`);
  if (cfg.inheritContext) fmFields.push("inherit_context: true");
  if (cfg.runInBackground) fmFields.push("run_in_background: true");
  return `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
}

// ---- Class ----

export class AgentConfigEditor {
  constructor(
    private readonly fileOps: AgentFileOps,
    private readonly registry: AgentTypeRegistry,
    private readonly personalAgentsDir: string,
    private readonly projectAgentsDir: string,
  ) {}

  private agentDirs(): string[] {
    return [this.projectAgentsDir, this.personalAgentsDir];
  }

  // Only caller was agent-menu.ts (deleted in #442); this file is removed in #441.
  // fallow-ignore-next-line unused-class-member
  async showAgentDetail(ui: MenuUI, name: string): Promise<void> {
    if (this.registry.resolveType(name) == null) {
      ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }
    const cfg = this.registry.resolveAgentConfig(name);
    const file = this.fileOps.findAgentFile(name, this.agentDirs());

    const choice = await ui.select(name, buildMenuOptions(cfg, file));
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) await this.handleEdit(ui, name, file);
    else if (choice === "Delete" && file) await this.handleDelete(ui, name, file);
    else if (choice === "Reset to default" && file)
      await this.handleReset(ui, name, file);
    else if (choice.startsWith("Eject")) await this.ejectAgent(ui, name, cfg);
    else if (choice === "Disable") await this.disableAgent(ui, name);
    else if (choice === "Enable") await this.enableAgent(ui, name);
  }

  private async handleEdit(ui: MenuUI, name: string, file: string): Promise<void> {
    const content = this.fileOps.read(file);
    if (content === undefined) return;
    const edited = await ui.editor(`Edit ${name}`, content);
    if (edited !== undefined && edited !== content) {
      this.fileOps.write(file, edited);
      this.registry.reload();
      ui.notify(`Updated ${file}`, "info");
    }
  }

  private async handleDelete(ui: MenuUI, name: string, file: string): Promise<void> {
    const confirmed = await ui.confirm(
      "Delete agent",
      `Delete ${name} (${file})?`,
    );
    if (confirmed) {
      this.fileOps.remove(file);
      this.registry.reload();
      ui.notify(`Deleted ${file}`, "info");
    }
  }

  private async handleReset(ui: MenuUI, name: string, file: string): Promise<void> {
    const confirmed = await ui.confirm(
      "Reset to default",
      `Delete override ${file} and restore embedded default?`,
    );
    if (confirmed) {
      this.fileOps.remove(file);
      this.registry.reload();
      ui.notify(`Restored default ${name}`, "info");
    }
  }

  private async ejectAgent(ui: MenuUI, name: string, cfg: AgentConfig): Promise<void> {
    const location = await ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${this.personalAgentsDir})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? this.projectAgentsDir
      : this.personalAgentsDir;

    const targetPath = join(targetDir, `${name}.md`);
    await writeAgentFile(
      this.fileOps,
      ui,
      this.registry,
      targetPath,
      buildEjectContent(cfg),
      `Ejected ${name} to`,
    );
  }

  private async disableAgent(ui: MenuUI, name: string): Promise<void> {
    const file = this.fileOps.findAgentFile(name, this.agentDirs());
    if (file) {
      const content = this.fileOps.read(file);
      if (content?.includes("\nenabled: false\n")) {
        ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      if (content) {
        const updated = content.replace(/^---\n/, "---\nenabled: false\n");
        this.fileOps.write(file, updated);
        this.registry.reload();
        ui.notify(`Disabled ${name} (${file})`, "info");
      }
      return;
    }

    const location = await ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${this.personalAgentsDir})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? this.projectAgentsDir
      : this.personalAgentsDir;

    const targetPath = join(targetDir, `${name}.md`);
    this.fileOps.write(targetPath, "---\nenabled: false\n---\n");
    this.registry.reload();
    ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async enableAgent(ui: MenuUI, name: string): Promise<void> {
    const file = this.fileOps.findAgentFile(name, this.agentDirs());
    if (!file) return;

    const content = this.fileOps.read(file);
    if (!content) return;

    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");

    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      this.fileOps.remove(file);
      this.registry.reload();
      ui.notify(`Enabled ${name} (removed ${file})`, "info");
    } else {
      this.fileOps.write(file, updated);
      this.registry.reload();
      ui.notify(`Enabled ${name} (${file})`, "info");
    }
  }
}
