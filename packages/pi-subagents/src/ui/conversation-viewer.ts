/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation using
 * Pi's TUI component library for rich rendering (markdown, diff coloring,
 * themed backgrounds, expand/collapse).
 */

import { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { getLifetimeTotal } from "#src/lifecycle/usage";
import type { Subagent } from "#src/types";
import type { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { ConversationContainer } from "#src/ui/conversation-container";
import { type MapperDeps } from "#src/ui/message-mapper";
import { buildInvocationTags, describeActivity, formatDuration, formatSessionTokens, getDisplayName, getPromptModeLabel } from "#src/ui/display";

// ─────────────────────────────────────────────────────────────────────────────

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 95;

export interface ConversationViewerOptions {
  tui: TUI;
  record: Subagent;
  activity: AgentActivityTracker | undefined;
  theme: Theme;
  done: (result: undefined) => void;
  registry: AgentConfigLookup;
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;

  private tui: TUI;
  private record: Subagent;
  private activity: AgentActivityTracker | undefined;
  private theme: Theme;
  private done: (result: undefined) => void;
  private registry: AgentConfigLookup;

  private conversationContainer: ConversationContainer;

  constructor({
    tui,
    record,
    activity,
    theme,
    done,
    registry,
  }: ConversationViewerOptions) {
    this.tui = tui;
    this.record = record;
    this.activity = activity;
    this.theme = theme;
    this.done = done;
    this.registry = registry;

    const deps: MapperDeps = {
      theme,
      ui: tui,
      cwd: process.cwd(),
      toolOutputExpanded: false,
      hideThinkingBlock: false,
    };
    this.conversationContainer = new ConversationContainer(deps);
    this.conversationContainer.rebuildFromSnapshot(record.messages);

    this.unsubscribe = record.subscribeToUpdates(() => {
      if (this.closed) return;
      this.conversationContainer.rebuildFromSnapshot(this.record.messages);
      this.tui.requestRender();
    });
  }

  // fallow-ignore-next-line unused-class-member
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // E to expand/collapse focused component
    if (matchesKey(data, "e")) {
      const focusedChildIdx = this.conversationContainer.getFocusedChildIndex(this.scrollOffset, this.lastInnerW);
      if (focusedChildIdx >= 0) {
        this.conversationContainer.toggleExpanded(focusedChildIdx);
        this.tui.requestRender();
        return;
      }
    }

    const contentLines = this.conversationContainer.render(this.lastInnerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = width - 4;
    this.lastInnerW = innerW;
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

    // Header
    lines.push(hrTop);
    const name = getDisplayName(this.record.type, this.registry);
    const modeLabel = getPromptModeLabel(this.record.type, this.registry);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = this.record.getContextPercent();
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }

    lines.push(row(
      `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — render from component tree
    let contentLines = this.conversationContainer.render(innerW);

    if (contentLines.length === 0) {
      contentLines = [th.fg("dim", "(waiting for first message...)")];
    }

    // Streaming indicator for running agents
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      contentLines.push("");
      contentLines.push(truncateToWidth(th.fg("accent", "● ") + th.fg("dim", act), innerW));
    }

    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    const focusedChildIdx = this.conversationContainer.getFocusedChildIndex(this.scrollOffset, innerW);
    const scrollPct = contentLines.length <= viewportHeight
      ? "100%"
      : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
    const footerLeft = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
    const expandHint = focusedChildIdx >= 0 ? th.fg("accent", "E expand") + th.fg("dim", " · ") : "";
    const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");
    const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(expandHint) - visibleWidth(footerRight));
    lines.push(row(footerLeft + " ".repeat(footerGap) + expandHint + footerRight));
    lines.push(hrBot);

    return lines;
  }

  // fallow-ignore-next-line unused-class-member
  invalidate(): void { /* no cached state to clear */ }

  // fallow-ignore-next-line unused-class-member
  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    const { modelName, tags } = buildInvocationTags(this.record.invocation);
    const parts = modelName ? [modelName, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }
}
