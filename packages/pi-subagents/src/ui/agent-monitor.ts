/**
 * agent-monitor.ts — Live-updating overlay panel showing ALL running agents at a glance.
 *
 * Triggered by `ctrl+shift+a`. Like htop for agents — shows every agent's
 * task/prompt, current activity, and stats in a single flat view without
 * requiring menu drill-down.
 *
 * Self-contained: if this file has a bug, the `/agents` command is unaffected.
 */

import {
  type Component,
  type TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import { getLifetimeTotal } from "#src/lifecycle/usage";
import type { SubagentManager } from "#src/lifecycle/subagent-manager";
import type { Subagent } from "#src/lifecycle/subagent";
import type { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { ConversationContainer, type MapperDeps } from "#src/ui/conversation-container";
import { mlog, mlogClose } from "#src/ui/monitor-debug";
import {
  SPINNER,
  type Theme,
  buildInvocationTags,
  describeActivity,
  formatDuration,
  formatMs,
  formatSessionTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
} from "#src/ui/display";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Narrow interface for agent-activity map access. */
interface AgentActivityMap {
  get(id: string): AgentActivityTracker | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Spinner animation interval in ms. */
const SPINNER_INTERVAL_MS = 80;

/** Overlay height as % of terminal rows. */
const MONITOR_HEIGHT_PCT = 95;

/** Maximum task description lines before truncating. */
const MAX_TASK_LINES = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Status helpers
// ─────────────────────────────────────────────────────────────────────────────

function statusIcon(status: Subagent["status"], spinnerFrame: number, theme: Theme): string {
  switch (status) {
    case "running":
      return theme.fg("accent", SPINNER[spinnerFrame % SPINNER.length]);
    case "completed":
    case "steered":
      return theme.fg("success", "✓");
    case "error":
    case "stopped":
    case "aborted":
      return theme.fg("error", "✗");
    case "queued":
      return theme.fg("dim", "◦");
  }
}

function isTerminalStatus(status: Subagent["status"]): boolean {
  return status === "completed" || status === "steered" || status === "error"
    || status === "stopped" || status === "aborted";
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentMonitor Component
// ─────────────────────────────────────────────────────────────────────────────

class AgentMonitor implements Component {
  private selectedIndex = 0;
  private scrollOffset = 0;
  private closed = false;

  // Navigation state: list view vs embedded conversation view
  private view: "list" | "conversation" = "list";
  private selectionChanged = true; // auto-scroll only when user navigates
  private autoScroll = true; // for conversation view: auto-scroll to bottom on new content
  private lastInnerW = 0; // cached overlay inner width (set during render)
  private selectedAgentForViewer: Subagent | undefined;

  // Component-based conversation container
  private conversationContainer: ConversationContainer | undefined;

  // Live update subscriptions
  private unsubscribes: (() => void)[] = [];
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;

  private tui: TUI;
  private manager: SubagentManager;
  private activityMap: AgentActivityMap;
  private registry: AgentTypeRegistry;
  private theme: PiTheme;
  private done: (result: undefined) => void;
  constructor(deps: {
    tui: TUI;
    manager: SubagentManager;
    activityMap: AgentActivityMap;
    registry: AgentTypeRegistry;
    theme: PiTheme;
    done: (result: undefined) => void;
  }) {
    this.tui = deps.tui;
    this.manager = deps.manager;
    this.activityMap = deps.activityMap;
    this.registry = deps.registry;
    this.theme = deps.theme;
    this.done = deps.done;

    // Subscribe to live updates from all agents
    this.subscribeToAgents();

    // Spinner animation timer — only animates the list view.
    // When in conversation view the timer is paused; updates are driven
    // by the subscribe-callback instead of polling.
    this.spinnerTimer = setInterval(() => {
      if (this.closed) return;

      // In conversation view, pause spinner and let event-driven updates handle rendering
      if (this.view === "conversation") {
        if (this.conversationDirty && this.selectedAgentForViewer && this.conversationContainer) {
          mlog("spinner", "rebuilding dirty conversation");
          this.conversationContainer.rebuildFromSnapshot(this.selectedAgentForViewer.messages);
          this.conversationDirty = false;
          this.tui.requestRender();
        }
        return; // Don't animate spinner or poll subscriptions while in conversation
      }

      this.spinnerFrame++;
      this.subscribeToAgents(); // pick up newly spawned agents
      this.tui.requestRender();
    }, SPINNER_INTERVAL_MS);

  }

  // ── Component interface ─────────────────────────────────────────────────

  handleInput(data: string): void {
    // ── Conversation view input ─────────────────────────────────────────

    if (this.view === "conversation") {
      if (matchesKey(data, "escape") || matchesKey(data, "backspace") || matchesKey(data, "q")) {
        mlog("handleInput", "conversation → list (Esc/Backspace/Q)");
        this.view = "list";
        this.scrollOffset = 0;
        this.selectionChanged = true;
        this.disposeConversationView();
        this.tui.requestRender();
        return;
      }

      // E to expand/collapse focused component
      if (matchesKey(data, "e")) {
        if (this.conversationContainer && this.lastInnerW > 0) {
          const focusedChildIdx = this.conversationContainer.getFocusedChildIndex(this.scrollOffset, this.lastInnerW);
          if (focusedChildIdx >= 0) {
            this.conversationContainer.toggleExpanded(focusedChildIdx);
            this.tui.requestRender();
            return;
          }
        }
      }

      // Handle scroll keys directly for conversation view
      const agent = this.selectedAgentForViewer;
      if (agent && this.conversationContainer && this.lastInnerW > 0) {
        const innerW = this.lastInnerW;
        let contentLines = this.conversationContainer.render(innerW);

        // Add streaming indicator
        if (agent.status === "running") {
          const activity = this.getActivity(agent);
          if (activity) {
            const act = describeActivity(activity.activeTools, activity.responseText);
            contentLines = [...contentLines, "", truncateToWidth(this.theme.fg("accent", "● ") + this.theme.fg("dim", act), innerW)];
          }
        }

        const viewportH = this.viewportHeight();
        const maxScroll = Math.max(0, contentLines.length - viewportH);

        if (matchesKey(data, "up") || matchesKey(data, "k")) {
          this.scrollOffset = Math.max(0, this.scrollOffset - 1);
          this.autoScroll = this.scrollOffset >= maxScroll;
          this.tui.requestRender();
          return;
        } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
          this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
          this.autoScroll = this.scrollOffset >= maxScroll;
          this.tui.requestRender();
          return;
        } else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
          this.scrollOffset = Math.max(0, this.scrollOffset - viewportH);
          this.autoScroll = false;
          this.tui.requestRender();
          return;
        } else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
          this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportH);
          this.autoScroll = this.scrollOffset >= maxScroll;
          this.tui.requestRender();
          return;
        } else if (matchesKey(data, "home")) {
          this.scrollOffset = 0;
          this.autoScroll = false;
          this.tui.requestRender();
          return;
        } else if (matchesKey(data, "end")) {
          this.scrollOffset = maxScroll;
          this.autoScroll = true;
          this.tui.requestRender();
          return;
        }
      }
      return;
    }

    // ── List view input ────────────────────────────────────────────────

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.dispose();
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      const agents = this.getAgents();
      if (agents.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.selectionChanged = true;
      this.clampScroll();
      this.tui.requestRender();
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      const agents = this.getAgents();
      if (agents.length === 0) return;
      this.selectedIndex = Math.min(agents.length - 1, this.selectedIndex + 1);
      this.selectionChanged = true;
      this.clampScroll();
      this.tui.requestRender();
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      const agents = this.getAgents();
      if (agents.length === 0) return;
      this.selectedIndex = Math.max(0, this.selectedIndex - 5);
      this.selectionChanged = true;
      this.clampScroll();
      this.tui.requestRender();
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      const agents = this.getAgents();
      if (agents.length === 0) return;
      this.selectedIndex = Math.min(agents.length - 1, this.selectedIndex + 5);
      this.selectionChanged = true;
      this.clampScroll();
      this.tui.requestRender();
    } else if (matchesKey(data, "home")) {
      this.selectedIndex = 0;
      this.selectionChanged = true;
      this.clampScroll();
      this.tui.requestRender();
    } else if (matchesKey(data, "end")) {
      const agents = this.getAgents();
      this.selectedIndex = Math.max(0, agents.length - 1);
      this.selectionChanged = true;
      this.clampScroll();
      this.tui.requestRender();
    } else if (matchesKey(data, "enter") || matchesKey(data, "l")) {
      this.openConversationView();
    } else if (matchesKey(data, "i")) {
      // Interrupt selected agent
      const agents = this.getAgents();
      if (this.selectedIndex < agents.length) {
        const agent = agents[this.selectedIndex];
        if (agent.status === "running" || agent.status === "queued") {
          agent.abort();
          this.tui.requestRender();
        }
      }
    } else if (matchesKey(data, "a")) {
      // Abort selected agent
      const agents = this.getAgents();
      if (this.selectedIndex < agents.length) {
        const agent = agents[this.selectedIndex];
        if (agent.status === "running" || agent.status === "queued") {
          agent.abort();
          this.tui.requestRender();
        }
      }
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];

    if (this.view === "conversation") {
      // Skip re-render if nothing changed — the AgentWidget's requestRender()
      // fires every 80ms but there's no point re-rendering identical content.
      // We also need to re-render when scrollOffset or content changes.
      if (!this.needsRender && this.lastConversationLines.length > 0 && this._lastScrollOffset === this.scrollOffset) {
        return this.lastConversationLines;
      }
      this.needsRender = false;
      this._lastScrollOffset = this.scrollOffset;
      this.lastConversationLines = this.renderConversationView(width);
      return this.lastConversationLines;
    }
    return this.renderListView(width);
  }

  invalidate(): void {
    // No cached state to clear — everything is recomputed on render
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    mlog("dispose", "AgentMonitor dispose called");

    // Clear spinner timer
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }

    // Dispose conversation container if active
    this.disposeConversationView();

    // Unsubscribe from all agent updates
    for (const unsub of this.unsubscribes) {
      try { unsub(); } catch { /* best effort */ }
    }
    this.unsubscribes = [];
    mlog("dispose", "spinner cleared, closing log");
    mlogClose();
  }

  // ── Private: data access

  private getAgents(): Subagent[] {
    const agents = this.manager.listAgents();
    const priority: Record<Subagent["status"], number> = {
      error: 0, stopped: 0, aborted: 0,
      running: 1,
      queued: 2,
      completed: 3, steered: 3,
    };
    return agents.sort((a, b) => {
      const pa = priority[a.status] ?? 9;
      const pb = priority[b.status] ?? 9;
      if (pa !== pb) return pa - pb;
      return b.startedAt - a.startedAt; // newest first within group
    });
  }

  private getActivity(agent: Subagent): AgentActivityTracker | undefined {
    return this.activityMap.get(agent.id);
  }

  // ── Private: subscriptions ──────────────────────────────────────────────

  /** Track which agent IDs we've already subscribed to. */
  private subscribedIds = new Set<string>();

  private subscribeToAgents(): void {
    const agents = this.getAgents();
    for (const agent of agents) {
      if (!this.subscribedIds.has(agent.id)) {
        this.subscribeToAgent(agent);
      }
    }
  }

  /** Set to true when a subscribed agent sends an update; cleared after render. */
  private conversationDirty = false;
  /** Cached output from last conversation render — returned verbatim when nothing changed. */
  private lastConversationLines: string[] = [];
  /** True when a re-render is actually needed (dirty data or first render). */
  private needsRender = true;
  /** One-shot flag for content dump debugging. */
  private _dumpedContent = false;
  /** Last scroll offset when conversation was cached — used to detect scroll changes. */
  private _lastScrollOffset = -1;

  private subscribeToAgent(agent: Subagent): void {
    // Always mark as subscribed to prevent retrying on agents without sessions yet.
    // If subscribeToUpdates returns undefined (no session yet), we'll miss early
    // events but won't accumulate duplicate subscriptions from spinner retries.
    this.subscribedIds.add(agent.id);
    mlog("subscribe", "subscribing to agent", { id: agent.id, type: agent.type });
    const unsub = agent.subscribeToUpdates(() => {
      if (this.closed) return;
      mlog("subscribe-cb", "agent update", { id: agent.id, view: this.view });
      if (this.view === "conversation" && this.selectedAgentForViewer?.id === agent.id) {
        this.conversationDirty = true;
        this.needsRender = true;
      }
    });
    if (unsub) {
      this.unsubscribes.push(unsub);
    } else {
      // No session yet — remove from subscribedIds so we retry on the next spinner tick
      this.subscribedIds.delete(agent.id);
    }
  }

  // ── Private: rendering — list view ──────────────────────────────────────

  private renderListView(width: number): string[] {
    const th = this.theme;
    const innerW = width - 4; // │ + space + content + space + │
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("border", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    lines.push(row(`${th.bold("Agents")}`));
    lines.push(hrMid);

    // Agent list — render all agents, then truncate to viewport
    const agents = this.getAgents();
    if (agents.length === 0) {
      lines.push(row(th.fg("dim", "No agents running.")));
    } else {
      const contentLines: string[] = [];
      let selectedStart = 0;
      let selectedEnd = 0;
      let lineIdx = 0;

      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        const isSelected = i === this.selectedIndex;
        const rendered = this.renderAgent(agent, innerW, isSelected);

        if (isSelected) selectedStart = lineIdx;
        for (const line of rendered) {
          contentLines.push(line);
          lineIdx++;
        }
        if (isSelected) selectedEnd = lineIdx;

        // Blank line between agents (except after last)
        if (i < agents.length - 1) {
          contentLines.push("");
          lineIdx++;
        }
      }

      // Scroll content within the viewport, keeping selected agent visible
      const viewportH = this.viewportHeight();
      const maxScroll = Math.max(0, contentLines.length - viewportH);
      // Only auto-scroll when the user explicitly navigated; otherwise preserve current scrollOffset
      // (the spinner rerenders every 80ms — without this guard it would reset scrollOffset every tick)
      if (this.selectionChanged) {
        if (selectedStart < this.scrollOffset) {
          this.scrollOffset = selectedStart;
        } else if (selectedEnd > this.scrollOffset + viewportH) {
          this.scrollOffset = Math.max(0, selectedEnd - viewportH);
        }
        this.selectionChanged = false;
      }
      this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

      const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + viewportH);
      for (const line of visible) {
        lines.push(row(line));
      }
      // Pad remaining viewport lines
      const remaining = viewportH - visible.length;
      for (let i = 0; i < remaining; i++) {
        lines.push(row(""));
      }
    }

    // Footer separator + keybinding bar
    lines.push(hrMid);
    const footerLeft = th.fg("dim", " ↑↓/PgUp/Dn navigate  Enter open  i interrupt  a abort  Esc close");
    lines.push(row(footerLeft));
    lines.push(hrBot);

    return lines;
  }

  // ── Private: rendering — conversation view ─────────────────────────────

  private renderConversationView(width: number): string[] {
    const th = this.theme;
    const innerW = width - 4; // │ + space + content + space + │
    this.lastInnerW = innerW; // cache for handleInput scroll calculations
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    const agent = this.selectedAgentForViewer;
    if (!agent) {
      return this.renderListView(width);
    }

    // Header — agent info with animated spinner
    lines.push(hrTop);
    const name = getDisplayName(agent.type, this.registry);
    const modeLabel = getPromptModeLabel(agent.type, this.registry);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const icon = agent.status === "running"
      ? th.fg("accent", SPINNER[this.spinnerFrame % SPINNER.length])
      : agent.status === "completed"
        ? th.fg("success", "✓")
        : agent.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const headerParts: string[] = [formatDuration(agent.startedAt, agent.completedAt)];
    const toolUses = agent.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(agent.lifetimeUsage);
    if (tokens > 0) {
      const percent = agent.getContextPercent();
      headerParts.push(formatSessionTokens(tokens, percent, th, agent.compactionCount));
    }

    lines.push(row(
      `${icon} ${th.bold(name)}${modeTag}  ${th.fg("muted", agent.description)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`,
    ));
    const { modelName, tags } = buildInvocationTags(agent.invocation);
    const invParts = modelName ? [th.fg("accent", modelName), ...tags] : tags;
    if (invParts.length > 0) {
      lines.push(row(th.fg("dim", `  ↳ ${invParts.join(" · ")}`)));
    }
    lines.push(hrMid);

    // Content — render from component tree
    let contentLines: string[] = [];
    if (this.conversationContainer) {
      contentLines = this.conversationContainer.render(innerW);
      // Strip OSC sequences (e.g. \x1b]133;A\x07 shell integration markers)
      // that break the overlay layout. These are fine in Pi's main chat but
      // corrupt terminal state inside our custom overlay.
      const oscRe = /\x1b\][^\x07\x1b]*[\x07\x1b]/g;
      contentLines = contentLines.map(l => l.replace(oscRe, ""));
    }

    // One-shot comprehensive dump for debugging UI breakage
    if (!this._dumpedContent && contentLines.length > 0) {
      this._dumpedContent = true;
      for (let i = 0; i < contentLines.length; i++) {
        const c = contentLines[i];
        const vw = visibleWidth(c);
        const hasNL = c.includes("\n") || c.includes("\r");
        // Strip ANSI for preview
        const stripped = c.replace(/\x1b\[[0-9;]*m/g, "");
        mlog("content-dump", `line ${i}/${contentLines.length}`, {
          vw, rawLen: c.length, hasNewline: hasNL,
          stripped: stripped.slice(0, 80),
          // Check if after row() wrapping the line would be too wide
          rowVW: visibleWidth(row(c)),
          width,
        });
        // Flag lines with embedded newlines (they split the row)
        if (hasNL) {
          mlog("BUG-EMBEDDED-NEWLINE", `line ${i}`, { raw: c.length, sample: JSON.stringify(c.slice(0, 100)) });
        }
      }
      // Also dump a few row-wrapped lines to check final width
      for (let i = 0; i < Math.min(5, contentLines.length); i++) {
        const rowLine = row(contentLines[i]);
        const rvw = visibleWidth(rowLine);
        mlog("row-dump", `line ${i}`, { rowVW: rvw, expectedWidth: width, overflow: rvw > width });
      }
    }

    if (contentLines.length === 0) {
      contentLines = [th.fg("dim", "(waiting for first message...)")];
    }

    // Streaming indicator for running agents
    if (agent.status === "running") {
      const activity = this.getActivity(agent);
      if (activity) {
        const act = describeActivity(activity.activeTools, activity.responseText);
        contentLines.push("");
        contentLines.push(truncateToWidth(th.fg("accent", "● ") + th.fg("dim", act), innerW));
      }
    }

    const viewportH = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportH);
    // Auto-scroll: if enabled, snap to bottom on new content
    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

    const visible = contentLines.slice(this.scrollOffset, this.scrollOffset + viewportH);
    for (let i = 0; i < visible.length; i++) {
      const raw = visible[i];
      const vw = visibleWidth(raw);
      const rl = raw.length;
      // Log any line where visible width is way off from expected innerW
      if (vw > innerW + 5 || (vw < innerW - 5 && rl > 20)) {
        mlog("width-mismatch", `line ${i}`, { vis: vw, raw: rl, innerW, sample: raw.slice(0, 80) });
      }
      lines.push(row(raw));
    }
    // Pad remaining viewport lines
    const remaining = viewportH - visible.length;
    for (let i = 0; i < remaining; i++) {
      lines.push(row(""));
    }

    // Footer with keybinding bar and scroll position
    lines.push(hrMid);
    const focusedChildIdx = this.conversationContainer?.getFocusedChildIndex(this.scrollOffset, innerW) ?? -1;
    const scrollPct = contentLines.length <= viewportH
      ? "100%"
      : `${Math.round(((this.scrollOffset + viewportH) / contentLines.length) * 100)}%`;
    const footerLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
    const expandHint = focusedChildIdx >= 0 ? th.fg("accent", "E expand") + th.fg("dim", " · ") : "";
    const footerRight = th.fg("dim", "Esc/Backspace back  PgUp/PgDn page  Home/End jump");
    const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(expandHint) - visibleWidth(footerRight));
    lines.push(row(footerLeft + " ".repeat(footerGap) + expandHint + footerRight));
    lines.push(hrBot);

    mlog("render", "conversation view", { totalLines: lines.length, scrollOffset: this.scrollOffset, contentLines: contentLines.length, viewportH, closed: this.closed });

    // Final sanity: check every output line for embedded newlines or width overflow
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("\n") || lines[i].includes("\r")) {
        mlog("BUG-OUTPUT-NEWLINE", `output line ${i}`, { sample: JSON.stringify(lines[i].slice(0, 120)) });
      }
      const lvw = visibleWidth(lines[i]);
      if (lvw > width) {
        mlog("BUG-OUTPUT-OVERFLOW", `output line ${i}`, { vw: lvw, maxWidth: width, sample: lines[i].replace(/\x1b\[[0-9;]*m/g, "").slice(0, 80) });
      }
    }

    return lines;
  }

  // ── Private: agent rendering (list view only) ─────────────────────────────

  private renderAgent(agent: Subagent, width: number, isSelected: boolean): string[] {
    const th = this.theme;
    const lines: string[] = [];

    // Line 1: status icon + agent name + model
    const icon = statusIcon(agent.status, this.spinnerFrame, th);
    const name = getDisplayName(agent.type, this.registry);
    const selector = isSelected ? th.fg("accent", "▸ ") : "   ";
    const { modelName: model } = buildInvocationTags(agent.invocation);
    const modelTag = model ? th.fg("dim", ` (${model})`) : "";
    lines.push(`${selector}${icon} ${th.bold(name)}${modelTag}`);

    // Line 2: task/prompt description (word-wrapped, max 2 lines, dimmed)
    const indent = "    "; // 4 spaces indent
    const taskWidth = Math.max(10, width - indent.length);
    const wrappedTask = wrapTextWithAnsi(agent.description, taskWidth);
    const taskLines = wrappedTask.slice(0, MAX_TASK_LINES);
    for (const tl of taskLines) {
      lines.push(`  ${indent}${th.fg("dim", truncateToWidth(tl, taskWidth))}`);
    }
    if (wrappedTask.length > MAX_TASK_LINES) {
      lines.push(`  ${indent}${th.fg("dim", "…")}`);
    }

    // Line 3: activity / stats
    const activityLine = this.renderActivityLine(agent, width);
    if (activityLine) {
      lines.push(`  ${indent}${th.fg("dim", "└─")} ${activityLine}`);
    }

    return lines;
  }

  private renderActivityLine(agent: Subagent, _width: number): string {
    const th = this.theme;
    const activity = this.getActivity(agent);

    // Terminal statuses: show final stats
    if (isTerminalStatus(agent.status)) {
      const parts: string[] = [];

      if (agent.error) {
        parts.push(th.fg("error", agent.error.length > 50 ? agent.error.slice(0, 50) + "…" : agent.error));
        return parts.join(" · ");
      }

      // Tool count + duration for completed
      const toolCount = agent.toolUses;
      if (toolCount > 0) parts.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);

      const duration = this.formatDurationCompact(agent.startedAt, agent.completedAt);
      if (duration) parts.push(duration);

      // Tokens
      const tokens = getLifetimeTotal(agent.lifetimeUsage);
      if (tokens > 0) {
        const percent = agent.getContextPercent();
        parts.push(formatSessionTokens(tokens, percent, th, agent.compactionCount));
      }

      return parts.length > 0 ? parts.join(" · ") : "";
    }

    // Running/queued: show live activity
    const parts: string[] = [];

    if (agent.status === "running" && activity) {
      // Current tool activity
      if (activity.activeTools.size > 0) {
        const act = describeActivity(activity.activeTools, activity.responseText);
        parts.push(act);
      } else if (activity.responseText && activity.responseText.trim()) {
        // Streaming text — show truncated first line
        const firstLine = activity.responseText.split("\n").find(l => l.trim())?.trim() ?? "";
        const truncated = firstLine.length > 40 ? firstLine.slice(0, 40) + "…" : firstLine;
        parts.push(truncated);
      } else {
        parts.push("thinking…");
      }

      // Duration (live ticking)
      const elapsed = Date.now() - agent.startedAt;
      parts.push(formatMs(elapsed));

      // Turns
      parts.push(formatTurns(activity.turnCount, activity.maxTurns));

      // Tokens
      const tokens = getLifetimeTotal(agent.lifetimeUsage);
      if (tokens > 0) {
        const percent = agent.getContextPercent();
        parts.push(formatSessionTokens(tokens, percent, th, agent.compactionCount));
      }
    } else if (agent.status === "queued") {
      parts.push("queued");
    }

    return parts.join("  ");
  }

  /** Format duration compactly (no "running" suffix — caller adds context). */
  private formatDurationCompact(startedAt: number, completedAt?: number): string {
    if (completedAt) {
      const ms = completedAt - startedAt;
      if (ms >= 60_000) {
        const m = Math.floor(ms / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        return `${m}m${s}s`;
      }
      return formatMs(ms);
    }
    return formatMs(Date.now() - startedAt);
  }

  // ── Private: scroll/viewport ───────────────────────────────────────────

  private viewportHeight(): number {
    // Chrome lines: top border + header + header sep + footer sep + footer + bottom border = 6
    const chromeLines = 6;
    const maxRows = Math.floor((this.tui.terminal.rows * MONITOR_HEIGHT_PCT) / 100);
    return Math.max(3, maxRows - chromeLines);
  }

  private clampScroll(): void {
    const agents = this.getAgents();
    if (agents.length === 0) {
      this.scrollOffset = 0;
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, agents.length - 1);
    this.selectedIndex = Math.max(0, this.selectedIndex);

    // Clamp scrollOffset so the selected agent is visible.
    const viewportH = this.viewportHeight();
    const width = this.tui.terminal.columns;
    const innerW = Math.max(10, width - 4);
    let lineIdx = 0;
    let selectedStart = 0;
    let selectedEnd = 0;
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const isSelected = i === this.selectedIndex;
      if (isSelected) selectedStart = lineIdx;
      // Compute actual rendered line count for this agent
      const rendered = this.renderAgent(agent, innerW, isSelected);
      lineIdx += rendered.length;
      if (i < agents.length - 1) lineIdx++; // blank separator
      if (isSelected) selectedEnd = lineIdx;
    }
    const maxScroll = Math.max(0, lineIdx - viewportH);
    if (selectedStart < this.scrollOffset) {
      this.scrollOffset = selectedStart;
    } else if (selectedEnd > this.scrollOffset + viewportH) {
      this.scrollOffset = Math.max(0, selectedEnd - viewportH);
    }
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
  }

  // ── Private: conversation view management ───────────────────────────────

  private openConversationView(): void {
    const agents = this.getAgents();
    if (this.selectedIndex >= agents.length) return;
    const agent = agents[this.selectedIndex];

    if (!agent.isSessionReady()) {
      mlog("open-view", "skipped — session not ready", { id: agent.id });
      return;
    }

    mlog("open-view", "opening conversation view", { id: agent.id, type: agent.type });

    // Switch to embedded conversation view
    this.selectedAgentForViewer = agent;
    this.view = "conversation";
    this.scrollOffset = 0;
    this._lastScrollOffset = -1; // force re-render on first frame
    this.autoScroll = true; // start at bottom, follow new content

    // Subscribe to the selected agent's updates for live streaming
    // (only if not already subscribed — subscribeToAgents may have done it)
    if (!this.subscribedIds.has(agent.id)) {
      this.subscribeToAgent(agent);
    }

    // Create a ConversationContainer for the selected agent
    const deps: MapperDeps = {
      theme: this.theme,
      ui: this.tui,
      cwd: process.cwd(),
      toolOutputExpanded: false,
      hideThinkingBlock: false,
    };
    this.conversationContainer = new ConversationContainer(deps);
    this.conversationContainer.rebuildFromSnapshot(agent.messages);
    this.needsRender = true;

    this.tui.requestRender();
  }

  /** Dispose the conversation container and its subscription. */
  private disposeConversationView(): void {
    mlog("dispose-view", "disposing conversation view", { hadContainer: !!this.conversationContainer });
    if (this.conversationContainer) {
      this.conversationContainer.dispose();
    }
    this.conversationContainer = undefined;
    this.selectedAgentForViewer = undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the agent monitor overlay panel.
 *
 * This is the function registered as the `ctrl+shift+a` shortcut handler.
 * It creates the overlay via `ctx.ui.custom()`, which manages the component
 * lifecycle. If the monitor errors, the existing `/agents` command is unaffected.
 */
export async function openAgentMonitor(
  ctx: {
    ui: {
      custom<R>(component: any, options?: any): Promise<R>;
    };
  },
  manager: SubagentManager,
  registry: AgentTypeRegistry,
  agentActivity: Map<string, AgentActivityTracker>,
  _settings: unknown,
  _fileOps: unknown,
  _personalAgentsDir: string,
  _projectAgentsDir: string,
): Promise<void> {

  mlog("open", "openAgentMonitor called — creating overlay");
  await ctx.ui.custom<undefined>(
    (tui: TUI, theme: PiTheme, _keybindings: unknown, done: (result: undefined) => void) => {
      const monitor = new AgentMonitor({
        tui,
        manager,
        activityMap: agentActivity,
        registry,
        theme,
        done,
      });
      return monitor;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "95%",
        maxHeight: `${MONITOR_HEIGHT_PCT}%`,
      },
    },
  );
}
