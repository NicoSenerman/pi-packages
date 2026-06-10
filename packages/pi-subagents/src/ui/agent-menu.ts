/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Pi SDK types are not fully exported; see upstream Pi SDK for type improvements */
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { type ModelRegistry, resolveModel } from "#src/session/model-resolver";
import { getModelLabelFromConfig } from "#src/tools/helpers";
import type { AgentConfig, Subagent } from "#src/types";
import type { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { AgentConfigEditor } from "#src/ui/agent-config-editor";
import { AgentCreationWizard } from "#src/ui/agent-creation-wizard";
import type { AgentFileOps } from "#src/ui/agent-file-ops";
import { formatDuration, getDisplayName } from "#src/ui/display";

// ---- Narrow interfaces ----

/** Narrow manager interface for menu operations. */
export interface AgentMenuManager {
  listAgents: () => Subagent[];
  getRecord: (id: string) => Subagent | undefined;
  /** Used by generate wizard to spawn an agent that writes the .md file. */
  spawnAndWait: (
    parentSnapshot: ParentSnapshot,
    type: string,
    prompt: string,
    opts: { description: string; maxTurns: number },
  ) => Promise<Subagent>;
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

// ---- Class ----

/**
 * Handler for the `/agents` slash command.
 *
 * Call `handle(ctx)` from the Pi command registration to open the interactive menu.
 */
export class AgentsMenuHandler {
  private readonly editor: AgentConfigEditor;
  private readonly wizard: AgentCreationWizard;

  constructor(
    private readonly manager: AgentMenuManager,
    private readonly registry: AgentTypeRegistry,
    private readonly agentActivity: AgentActivityReader,
    private readonly settings: AgentMenuSettings,
    fileOps: AgentFileOps,
    personalAgentsDir: string,
    projectAgentsDir: string,
  ) {
    this.editor = new AgentConfigEditor(
      fileOps,
      registry,
      personalAgentsDir,
      projectAgentsDir,
    );
    this.wizard = new AgentCreationWizard(
      fileOps,
      manager,
      registry,
      personalAgentsDir,
      projectAgentsDir,
    );
  }

  async handle({
    ui,
    modelRegistry,
    parentSnapshot,
  }: {
    ui: MenuUI;
    modelRegistry: ModelRegistry;
    parentSnapshot: ParentSnapshot;
  }): Promise<void> {
    await this.showAgentsMenu(ui, modelRegistry, parentSnapshot);
  }

  private getModelLabel(type: string, modelRegistry?: ModelRegistry): string {
    const cfg = this.registry.resolveAgentConfig(type);
    if (!cfg.model) return "inherit";
    if (modelRegistry) {
      const resolved = resolveModel(cfg.model, modelRegistry);
      if (typeof resolved === "string") return "inherit";
    }
    return getModelLabelFromConfig(cfg.model);
  }

  private async showAgentsMenu(
    ui: MenuUI,
    modelRegistry: ModelRegistry,
    parentSnapshot: ParentSnapshot,
  ): Promise<void> {
    this.registry.reload();
    const allNames = this.registry.getAllTypes();

    const options: string[] = [];

    const agents = this.manager.listAgents();
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
      ui.notify(noAgentsMsg, "info");
    }

    const choice = await ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await this.showRunningAgents(ui);
      await this.showAgentsMenu(ui, modelRegistry, parentSnapshot);
    } else if (choice.startsWith("Agent types (")) {
      await this.showAllAgentsList(ui, modelRegistry);
      await this.showAgentsMenu(ui, modelRegistry, parentSnapshot);
    } else if (choice === "Create new agent") {
      await this.wizard.showCreateWizard(ui, parentSnapshot);
    } else if (choice === "Settings") {
      await this.showSettings(ui);
      await this.showAgentsMenu(ui, modelRegistry, parentSnapshot);
    }
  }

  private async showAllAgentsList(ui: MenuUI, modelRegistry: ModelRegistry): Promise<void> {
    const allNames = this.registry.getAllTypes();
    if (allNames.length === 0) {
      ui.notify("No agents.", "info");
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
      const cfg = this.registry.resolveAgentConfig(name);
      const disabled = cfg.enabled === false;
      const model = this.getModelLabel(name, modelRegistry);
      const indicator = sourceIndicator(cfg);
      const prefix = `${indicator}${name} · ${model}`;
      const desc = disabled ? "(disabled)" : cfg.description;
      return { name, prefix, desc };
    });
    const maxPrefix = Math.max(...entries.map((e) => e.prefix.length));

    const hasCustom = allNames.some((n) => {
      const c = this.registry.resolveAgentConfig(n);
      return !c.isDefault && c.enabled !== false;
    });
    const hasDisabled = allNames.some(
      (n) => this.registry.resolveAgentConfig(n).enabled === false,
    );
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");
    const legend = legendParts.length ? "\n" + legendParts.join("  ") : "";

    const options = entries.map(
      ({ prefix, desc }) => `${prefix.padEnd(maxPrefix)} — ${desc}`,
    );
    if (legend) options.push(legend);

    const choice = await ui.select("Agent types", options);
    if (!choice) return;

    const agentName = choice
      .split(" · ")[0]
      .replace(/^[•◦✕\s]+/, "")
      .trim();
    if (this.registry.resolveType(agentName) != null) {
      await this.editor.showAgentDetail(ui, agentName);
      await this.showAllAgentsList(ui, modelRegistry);
    }
  }

  private async showRunningAgents(ui: MenuUI): Promise<void> {
    const agents = this.manager.listAgents();
    if (agents.length === 0) {
      ui.notify("No agents.", "info");
      return;
    }

    const options = agents.map((a) => {
      const dn = getDisplayName(a.type, this.registry);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });

    const choice = await ui.select("Running agents", options);
    if (!choice) return;

    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const record = agents[idx];

    await this.viewAgentConversation(ui, record);
    await this.showRunningAgents(ui);
  }

  private async viewAgentConversation(ui: MenuUI, record: Subagent): Promise<void> {
    if (!record.isSessionReady()) {
      ui.notify(
        `Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`,
        "info",
      );
      return;
    }

    const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import(
      "./conversation-viewer"
    );
    const activity = this.agentActivity.get(record.id);

    await ui.custom<undefined>(
      (tui: any, theme: any, _keybindings: any, done: any) => {
        return new ConversationViewer({
          tui,
          record,
          activity,
          theme,
          done,
          registry: this.registry,
        });
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "95%",
          maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
        },
      },
    );
  }

  private async showSettings(ui: MenuUI): Promise<void> {
    const choice = await ui.select("Settings", [
      `Max concurrency (current: ${this.settings.maxConcurrent})`,
      `Default max turns (current: ${this.settings.defaultMaxTurns ?? "unlimited"})`,
      `Grace turns (current: ${this.settings.graceTurns})`,
    ]);
    if (!choice) return;

    if (choice.startsWith("Max concurrency")) {
      const val = await ui.input(
        "Max concurrent background agents",
        String(this.settings.maxConcurrent),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) {
          const toast = this.settings.applyMaxConcurrent(n);
          ui.notify(toast.message, toast.level);
        } else {
          ui.notify("Must be a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Default max turns")) {
      const val = await ui.input(
        "Default max turns before wrap-up (0 = unlimited)",
        String(this.settings.defaultMaxTurns ?? 0),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 0) {
          const toast = this.settings.applyDefaultMaxTurns(n);
          ui.notify(toast.message, toast.level);
        } else {
          ui.notify("Must be 0 (unlimited) or a positive integer.", "warning");
        }
      }
    } else if (choice.startsWith("Grace turns")) {
      const val = await ui.input(
        "Grace turns after wrap-up steer",
        String(this.settings.graceTurns),
      );
      if (val) {
        const n = parseInt(val, 10);
        if (n >= 1) {
          const toast = this.settings.applyGraceTurns(n);
          ui.notify(toast.message, toast.level);
        } else {
          ui.notify("Must be a positive integer.", "warning");
        }
      }
    }
  }
}
