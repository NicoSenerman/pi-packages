import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSpawnConfig } from "../agent-manager.js";
import {
  AgentTypeRegistry,
  BUILTIN_TOOL_NAMES,
} from "../agent-types.js";
import type { ModelRegistry } from "../model-resolver.js";
import type { AgentConfig, AgentRecord } from "../types.js";
import type { AgentActivityTracker } from "./agent-activity-tracker.js";
import { formatDuration, getDisplayName } from "./agent-widget.js";

// ---- Deps interface ----

/** Narrow manager interface for menu operations. */
export interface AgentMenuManager {
  listAgents: () => AgentRecord[];
  getRecord: (id: string) => AgentRecord | undefined;
  /** Used by generate wizard to spawn an agent that writes the .md file. */
  spawnAndWait: (ctx: ExtensionContext, type: string, prompt: string, opts: Omit<AgentSpawnConfig, "isBackground">) => Promise<AgentRecord>;
}

/** Narrow settings interface required by the agent menu. */
export interface AgentMenuSettings {
  readonly maxConcurrent: number;
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" };
  applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" };
  applyGraceTurns(n: number): { message: string; level: "info" | "warning" };
}

export interface AgentMenuDeps {
  manager: AgentMenuManager;
  registry: AgentTypeRegistry;
  agentActivity: Map<string, AgentActivityTracker>;
  /** Resolve model label for a given agent type + registry. */
  getModelLabel: (type: string, registry?: ModelRegistry) => string;
  /** Settings manager — owns in-memory values and persistence. */
  settings: AgentMenuSettings;
  personalAgentsDir: string;
  projectAgentsDir: string;
}

// ---- Narrow UI context types ----

// ---- Factory ----

/**
 * Create the `/agents` command handler.
 * Returns a function suitable for `pi.registerCommand("agents", { handler })`.
 */
export function createAgentsMenuHandler(deps: AgentMenuDeps) {
  function findAgentFile(
    name: string,
  ): { path: string; location: "project" | "personal" } | undefined {
    const projectPath = join(deps.projectAgentsDir, `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const personalPath = join(deps.personalAgentsDir, `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  async function showAgentsMenu(ctx: ExtensionContext) {
    deps.registry.reload();
    const allNames = deps.registry.getAllTypes();

    const options: string[] = [];

    const agents = deps.manager.listAgents();
    if (agents.length > 0) {
      const running = agents.filter(
        (a) => a.status === "running" || a.status === "queued",
      ).length;
      const done = agents.filter(
        (a) => a.status === "completed" || a.status === "steered",
      ).length;
      options.push(
        `Running agents (${agents.length}) — ${running} running, ${done} done`,
      );
    }

    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg =
      allNames.length === 0 && agents.length === 0
        ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
          "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
          "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
        : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionContext) {
    const allNames = deps.registry.getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    const entries = allNames.map((name) => {
      const cfg = deps.registry.resolveAgentConfig(name);
      const disabled = cfg.enabled === false;
      const model = deps.getModelLabel(name, ctx.modelRegistry);
      const indicator = sourceIndicator(cfg);
      const prefix = `${indicator}${name} · ${model}`;
      const desc = disabled ? "(disabled)" : cfg.description;
      return { name, prefix, desc };
    });
    const maxPrefix = Math.max(...entries.map((e) => e.prefix.length));

    const hasCustom = allNames.some((n) => {
      const c = deps.registry.resolveAgentConfig(n);
      return !c.isDefault && c.enabled !== false;
    });
    const hasDisabled = allNames.some((n) => deps.registry.resolveAgentConfig(n).enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");
    const legend = legendParts.length ? "\n" + legendParts.join("  ") : "";

    const options = entries.map(
      ({ prefix, desc }) => `${prefix.padEnd(maxPrefix)} — ${desc}`,
    );
    if (legend) options.push(legend);

    const choice = await ctx.ui.select("Agent types", options);
    if (!choice) return;

    const agentName = choice
      .split(" · ")[0]
      .replace(/^[•◦✕\s]+/, "")
      .trim();
    if (deps.registry.resolveType(agentName) != null) {
      await showAgentDetail(ctx, agentName);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionContext) {
    const agents = deps.manager.listAgents();
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const options = agents.map((a) => {
      const dn = getDisplayName(a.type, deps.registry);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });

    const choice = await ctx.ui.select("Running agents", options);
    if (!choice) return;

    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const record = agents[idx];

    await viewAgentConversation(ctx, record);
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionContext, record: AgentRecord) {
    const session = record.execution?.session;
    if (!session) {
      ctx.ui.notify(
        `Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`,
        "info",
      );
      return;
    }

    const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import(
      "./conversation-viewer.js"
    );
    const activity = deps.agentActivity.get(record.id);

    await ctx.ui.custom<undefined>(
      (tui: any, theme: any, _keybindings: any, done: any) => {
        return new ConversationViewer(tui, session, record, activity, theme, done, deps.registry);
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
        },
      },
    );
  }

  async function showAgentDetail(ctx: ExtensionContext, name: string) {
    if (deps.registry.resolveType(name) == null) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }
    const cfg = deps.registry.resolveAgentConfig(name);

    const file = findAgentFile(name);
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

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        deps.registry.reload();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm(
          "Delete agent",
          `Delete ${name} from ${file.location} (${file.path})?`,
        );
        if (confirmed) {
          unlinkSync(file.path);
          deps.registry.reload();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm(
        "Reset to default",
        `Delete override ${file.path} and restore embedded default?`,
      );
      if (confirmed) {
        unlinkSync(file.path);
        deps.registry.reload();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  async function ejectAgent(ctx: ExtensionContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${deps.personalAgentsDir})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? deps.projectAgentsDir
      : deps.personalAgentsDir;
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm(
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

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    deps.registry.reload();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  async function disableAgent(ctx: ExtensionContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      const updated = content.replace(/^---\n/, "---\nenabled: false\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      deps.registry.reload();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${deps.personalAgentsDir})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? deps.projectAgentsDir
      : deps.personalAgentsDir;
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    deps.registry.reload();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  async function enableAgent(ctx: ExtensionContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");

    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      deps.registry.reload();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      deps.registry.reload();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${deps.personalAgentsDir})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project")
      ? deps.projectAgentsDir
      : deps.personalAgentsDir;

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

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
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <true to run in background by default. Default: false>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
isolation: <"worktree" to run in isolated git worktree. Omit for normal>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    const record = await deps.manager.spawnAndWait(
      ctx,
      "general-purpose",
      generatePrompt,
      {
        description: `Generate ${name} agent`,
        maxTurns: 5,
      },
    );

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    deps.registry.reload();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify(
        "Agent generation completed but file was not created. Check the agent output.",
        "warning",
      );
    }
  }

  async function showManualWizard(ctx: ExtensionContext, targetDir: string) {
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    const toolChoice = await ctx.ui.select("Tools", [
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
      const customTools = await ctx.ui.input(
        "Tools (comma-separated)",
        BUILTIN_TOOL_NAMES.join(", "),
      );
      if (!customTools) return;
      tools = customTools;
    }

    const modelChoice = await ctx.ui.select("Model", [
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
      const customModel = await ctx.ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }

    const thinkingChoice = await ctx.ui.select("Thinking level", [
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

    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = `---
description: ${description}
tools: ${tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm(
        "Overwrite",
        `${targetPath} already exists. Overwrite?`,
      );
      if (!overwrite) return;
    }

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    deps.registry.reload();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  async function showSettings(ctx: ExtensionContext) {
    const choice = await ctx.ui.select("Settings", [
      `Max concurrency (current: ${deps.settings.maxConcurrent})`,
      `Default max turns (current: ${deps.settings.defaultMaxTurns ?? "unlimited"})`,
      `Grace turns (current: ${deps.settings.graceTurns})`,
    ]);
    if (!choice) return;

    if (choice.startsWith("Max concurrency")) {
      const val = await ctx.ui.input(
        "Max concurrent background agents",
        String(deps.settings.maxConcurrent),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) {
          const toast = deps.settings.applyMaxConcurrent(n);
          ctx.ui.notify(toast.message, toast.level);
        } else {
          ctx.ui.notify("Must be a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Default max turns")) {
      const val = await ctx.ui.input(
        "Default max turns before wrap-up (0 = unlimited)",
        String(deps.settings.defaultMaxTurns ?? 0),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 0) {
          const toast = deps.settings.applyDefaultMaxTurns(n);
          ctx.ui.notify(toast.message, toast.level);
        } else {
          ctx.ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Grace turns")) {
      const val = await ctx.ui.input(
        "Grace turns after wrap-up steer",
        String(deps.settings.graceTurns),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) {
          const toast = deps.settings.applyGraceTurns(n);
          ctx.ui.notify(toast.message, toast.level);
        } else {
          ctx.ui.notify("Must be a positive integer.", "warning");
        }
      }
    }
  }

  // Return the handler function
  return async (ctx: ExtensionContext) => {
    await showAgentsMenu(ctx);
  };
}
