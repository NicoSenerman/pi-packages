/**
 * agent-config-editor.ts — Agent detail view with edit/delete/eject/disable/enable transitions.
 *
 * Extracted from agent-menu.ts to give each concern a single responsibility.
 * Receives dependencies via injection — no direct `node:fs` imports.
 */

import { join } from "node:path";

import type { AgentTypeRegistry } from "../agent-types.js";
import type { AgentConfig } from "../types.js";
import type { AgentFileOps } from "./agent-file-ops.js";
import type { MenuUI } from "./agent-menu.js";

// ---- Factory ----

export function createAgentConfigEditor(
  fileOps: AgentFileOps,
  registry: AgentTypeRegistry,
  personalAgentsDir: string,
  projectAgentsDir: string,
) {
  function agentDirs(): string[] {
    return [projectAgentsDir, personalAgentsDir];
  }

  async function showAgentDetail(ui: MenuUI, name: string) {
    if (registry.resolveType(name) == null) {
      ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }
    const cfg = registry.resolveAgentConfig(name);

    const file = fileOps.findAgentFile(name, agentDirs());
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = fileOps.read(file);
      if (content !== undefined) {
        const edited = await ui.editor(`Edit ${name}`, content);
        if (edited !== undefined && edited !== content) {
          fileOps.write(file, edited);
          registry.reload();
          ui.notify(`Updated ${file}`, "info");
        }
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ui.confirm(
          "Delete agent",
          `Delete ${name} (${file})?`,
        );
        if (confirmed) {
          fileOps.remove(file);
          registry.reload();
          ui.notify(`Deleted ${file}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ui.confirm(
        "Reset to default",
        `Delete override ${file} and restore embedded default?`,
      );
      if (confirmed) {
        fileOps.remove(file);
        registry.reload();
        ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ui, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ui, name);
    } else if (choice === "Enable") {
      await enableAgent(ui, name);
    }
  }

  async function ejectAgent(ui: MenuUI, name: string, cfg: AgentConfig) {
    const location = await ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? projectAgentsDir
      : personalAgentsDir;

    const targetPath = join(targetDir, `${name}.md`);
    if (fileOps.exists(targetPath)) {
      const overwrite = await ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    const fmFields: string[] = [];
    fmFields.push(`description: ${cfg.description}`);
    if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
    fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`);
    if (cfg.model) fmFields.push(`model: ${cfg.model}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    fmFields.push(`prompt_mode: ${cfg.promptMode}`);
    if (cfg.extensions === false) fmFields.push("extensions: false");
    else if (Array.isArray(cfg.extensions))
      fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
    if (cfg.skills === false) fmFields.push("skills: false");
    else if (Array.isArray(cfg.skills))
      fmFields.push(`skills: ${cfg.skills.join(", ")}`);
    if (cfg.disallowedTools?.length)
      fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
    if (cfg.inheritContext) fmFields.push("inherit_context: true");
    if (cfg.runInBackground) fmFields.push("run_in_background: true");
    if (cfg.isolated) fmFields.push("isolated: true");
    if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
    if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;

    fileOps.write(targetPath, content);
    registry.reload();
    ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ui: MenuUI, name: string) {
    const file = fileOps.findAgentFile(name, agentDirs());
    if (file) {
      const content = fileOps.read(file);
      if (content?.includes("\nenabled: false\n")) {
        ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      if (content) {
        const updated = content.replace(/^---\n/, "---\nenabled: false\n");
        fileOps.write(file, updated);
        registry.reload();
        ui.notify(`Disabled ${name} (${file})`, "info");
      }
      return;
    }

    const location = await ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? projectAgentsDir
      : personalAgentsDir;

    const targetPath = join(targetDir, `${name}.md`);
    fileOps.write(targetPath, "---\nenabled: false\n---\n");
    registry.reload();
    ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  async function enableAgent(ui: MenuUI, name: string) {
    const file = fileOps.findAgentFile(name, agentDirs());
    if (!file) return;

    const content = fileOps.read(file);
    if (!content) return;

    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");

    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      fileOps.remove(file);
      registry.reload();
      ui.notify(`Enabled ${name} (removed ${file})`, "info");
    } else {
      fileOps.write(file, updated);
      registry.reload();
      ui.notify(`Enabled ${name} (${file})`, "info");
    }
  }

  return { showAgentDetail };
}
