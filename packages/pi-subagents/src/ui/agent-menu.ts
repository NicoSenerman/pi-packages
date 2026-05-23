import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSpawnConfig } from "../agent-manager.js";
import { AgentTypeRegistry } from "../agent-types.js";
import type { ModelRegistry } from "../model-resolver.js";
import type { AgentConfig, AgentRecord } from "../types.js";
import type { AgentActivityTracker } from "./agent-activity-tracker.js";
import { createAgentConfigEditor } from "./agent-config-editor.js";
import { createAgentCreationWizard } from "./agent-creation-wizard.js";
import type { AgentFileOps } from "./agent-file-ops.js";
import { formatDuration, getDisplayName } from "./display.js";

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

/**
 * Read-only interface for the agent-menu's agentActivity access.
 * Only the conversation viewer needs to read a tracker by agent ID.
 */
export interface AgentActivityReader {
  get(id: string): AgentActivityTracker | undefined;
}

export interface AgentMenuDeps {
  manager: AgentMenuManager;
  registry: AgentTypeRegistry;
  agentActivity: AgentActivityReader;
  /** Resolve model label for a given agent type + registry. */
  getModelLabel: (type: string, registry?: ModelRegistry) => string;
  /** Settings manager — owns in-memory values and persistence. */
  settings: AgentMenuSettings;
  fileOps: AgentFileOps;
  personalAgentsDir: string;
  projectAgentsDir: string;
}

// ---- Narrow UI context types ----

/** Narrow UI interface — only the ctx.ui methods menu handlers actually call. */
export interface MenuUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  editor(title: string, content: string): Promise<string | undefined>;
  custom<R>(component: any, options?: any): Promise<R>;
}

// ---- Factory ----

/**
 * Create the `/agents` command handler.
 * Returns a function suitable for `pi.registerCommand("agents", { handler })`.
 */
export function createAgentsMenuHandler(deps: AgentMenuDeps) {
  const editor = createAgentConfigEditor(
    deps.fileOps,
    deps.registry,
    deps.personalAgentsDir,
    deps.projectAgentsDir,
  );

  const wizard = createAgentCreationWizard({
    fileOps: deps.fileOps,
    manager: deps.manager,
    registry: deps.registry,
    personalAgentsDir: deps.personalAgentsDir,
    projectAgentsDir: deps.projectAgentsDir,
  });

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
      await wizard.showCreateWizard(ctx);
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
      await editor.showAgentDetail(ctx.ui, agentName);
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
    const session = record.session;
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
        return new ConversationViewer({ tui, session, record, activity, theme, done, registry: deps.registry });
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
