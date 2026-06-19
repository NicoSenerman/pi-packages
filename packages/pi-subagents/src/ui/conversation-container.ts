/**
 * conversation-container.ts — Manages a Container of Pi TUI components for
 * the conversation view.
 *
 * Encapsulates component tree construction, incremental updates, and
 * line-to-component mapping for scroll/expand interactions.
 */

import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Spacer,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  type MapperDeps,
  buildConversationComponents,
} from "#src/ui/message-mapper";

// Re-export for consumers that need MapperDeps
export type { MapperDeps } from "#src/ui/message-mapper";

// ── Types ────────────────────────────────────────────────────────────────────

/** Component that supports expand/collapse. */
interface Expandable {
  expanded: boolean;
  setExpanded(expanded: boolean): void;
}

// ── Streaming detection helpers ─────────────────────────────────────────────
//
// The conversation view mirrors the main chat's persistent-streaming-component
// pattern (interactive-mode.js ~2258-2280): one AssistantMessageComponent is
// created for the in-progress assistant message, and `updateContent(livePartial)`
// is called on each message_update instead of tearing down + rebuilding the
// entire component tree every 80ms.
//
// NOTE on "in progress" detection: AssistantMessage.stopReason is NOT a reliable
// "still streaming" flag. Providers (e.g. Anthropic) initialize stopReason to
// "stop" on message_start and only reassign it on message_delta. So a partial
// and a finalized normal assistant message both carry stopReason "stop". We
// therefore drive streaming state from AgentSessionEvent types (message_start /
// message_update / message_end) rather than from message shape alone. A
// spinner-tick fallback (no event) uses role + agent.status as a heuristic.

/** Minimal shape of an assistant/message object we inspect at runtime. */
interface MessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

// ── Component tree disposal ──────────────────────────────────────────────────

/**
 * Recursively dispose a component tree — stops Loaders, clears intervals,
 * and prevents orphaned timers from firing requestRender().
 *
 * Walks children, contentContainers, and named loader properties.
 * All cleanup is best-effort — errors are swallowed so a failed stop()
 * on one component doesn't prevent cleanup of siblings.
 */
export function disposeComponentTree(component: unknown): void {
  if (!component || typeof component !== "object") return;

  const c = component as Record<string, unknown>;

  // Stop Loader timers (the primary source of orphaned intervals).
  // Do NOT call dispose() on arbitrary components — that can trigger
  // side effects in extensions or other subsystems.
  if (
    c.loader &&
    typeof c.loader === "object" &&
    typeof (c.loader as any).stop === "function"
  ) {
    try {
      (c.loader as any).stop();
    } catch {
      /* best effort */
    }
  }

  // Recurse into Container children
  if (Array.isArray(c.children)) {
    for (const child of c.children) {
      disposeComponentTree(child);
    }
  }

  // Some components nest content inside a contentContainer
  if (c.contentContainer) {
    disposeComponentTree(c.contentContainer);
  }
}

// ── ConversationContainer ────────────────────────────────────────────────────

export class ConversationContainer {
  private container: Container;
  private pendingTools: Map<string, ToolExecutionComponent>;
  private deps: MapperDeps;
  private mdTheme: MarkdownTheme;

  // ── Streaming state ───────────────────────────────────────────────────
  // Persistent component + live message reference for the in-progress
  // assistant message. Across message_update ticks we call
  // `streamingComponent.updateContent(event.message)` (the live partial carried
  // by the AgentSessionEvent — NOT messages[last], which during streaming is
  // the PREVIOUS finalized assistant message because AgentCore only pushes the
  // finalized message to state.messages on message_end). Mirrors the main
  // chat's streamingComponent pattern (interactive-mode.js ~2258-2280).
  private streamingComponent?: AssistantMessageComponent;
  private streamingMessageRef?: MessageLike;
  /** ToolCall ids (content block ids) currently rendered inline for the
   *  streaming assistant message — used to avoid duplicate
   *  ToolExecutionComponents when a new toolCall block appears mid-stream. */
  private streamingToolIds = new Set<string>();
  /** Number of messages rendered as part of the last rebuildFromSnapshot /
   *  streaming-message_start setup. Used by the spinner-tick safety-net to
   *  decide whether there's new structural state to render (vs a no-op when
   *  only the streaming partial is changing, which is handled event-driven). */
  private lastRebuiltMessageCount = 0;

  constructor(deps: MapperDeps) {
    this.deps = deps;
    this.container = new Container();
    this.pendingTools = new Map();
    this.mdTheme = getMarkdownTheme();
  }

  /** Fully rebuild the component tree from a snapshot of messages. */
  rebuildFromSnapshot(messages: readonly unknown[]): void {
    // Dispose existing component tree to stop orphaned Loader timers
    for (const child of this.container.children) {
      disposeComponentTree(child);
    }
    this.container.clear();
    this.pendingTools.clear();
    // Drop streaming refs so a reused container rebinds on next snapshot.
    // NOTE: rebuildFromSnapshot is called on message_end (the message is now in
    // messages, so the mapper will create a finalized AssistantMessageComponent
    // for it) and on structural events. We deliberately do NOT preserve the
    // streaming component across a rebuild — the rebuild recreates the
    // finalized version from the snapshot.
    this.streamingComponent = undefined;
    this.streamingMessageRef = undefined;
    this.streamingToolIds.clear();

    const result = buildConversationComponents(
      messages,
      this.deps,
      this.mdTheme,
    );
    this.pendingTools = result.pendingTools;
    for (const child of result.children) {
      this.container.addChild(child);
    }
    this.lastRebuiltMessageCount = messages.length;
  }

  /** Clear a prior streaming assistant component (disposes children). */
  private clearStreamingComponent(): void {
    if (this.streamingComponent) {
      disposeComponentTree(this.streamingComponent);
      const idx = (this.container as any).children.indexOf(
        this.streamingComponent,
      );
      if (idx >= 0) {
        (this.container as any).children.splice(idx, 1);
      }
      this.streamingComponent = undefined;
    }
    this.streamingMessageRef = undefined;
    this.streamingToolIds.clear();
  }

  /**
   * Construct a fresh streaming AssistantMessageComponent from the live
   * partial carried by an AgentSessionEvent (matching the main chat's
   * message_start case). Used both for message_start and for the
   * "component missing on message_update" recovery path (overlay opened
   * mid-stream).
   */
  private createStreamingComponent(message: MessageLike): void {
    // A prior message's streaming component may still be live (e.g. message_end
    // was missed, or two assistant turns share a session). Dispose it first.
    this.clearStreamingComponent();

    const comp = new AssistantMessageComponent(
      message as any,
      this.deps.hideThinkingBlock,
      this.mdTheme,
      this.deps.hideThinkingBlock ? "Thinking..." : undefined,
    );
    if (this.container.children.length > 0) {
      this.container.addChild(new Spacer(1));
    }
    this.container.addChild(comp);
    this.streamingComponent = comp;
    this.streamingMessageRef = message;
    this.streamingToolIds.clear();
  }

  /**
   * Incrementally update the conversation view from a live messages snapshot.
   *
   * This is the PRIMARY streaming path — called from the agent-monitor's
   * subscribe callback on AgentSessionEvents. It sources the live assistant
   * partial from `event.message` (NOT `messages[last]`): AgentCore only pushes
   * the finalized message to state.messages on `message_end`, so during
   * streaming `messages[last]` is the PREVIOUS assistant message (or a
   * user/toolResult message). The event payload carries the growing partial —
   * this mirrors interactive-mode.js ~2258-2280.
   *
   * Decision matrix (event-driven):
   *  - message_start (assistant) → backfill any unrendered messages in
   *    `messages` (e.g. the user prompt), then create a fresh persistent
   *    streaming AssistantMessageComponent from event.message. NO rebuild from
   *    `messages` (it lacks the partial).
   *  - message_start (user/custom/etc.) → rebuildFromSnapshot(messages): these
   *    roles land in state.messages immediately.
   *  - message_update (assistant) + existing streamingComponent →
   *    updateContent(event.message) in place; also create inline
   *    ToolExecutionComponents for any NEW toolCall blocks. NO rebuild.
   *  - message_update (assistant) WITHOUT streamingComponent (opened
   *    mid-stream) → create one from event.message.
   *  - message_end → rebuildFromSnapshot(messages): the finalized message is
   *    now in messages, the mapper recreates a finalized component.
   *  - other events (tool_execution_*, turn_*, agent_*) → rebuild
   *    (structural state changes).
   *
   * Spinner-tick safety-net (no event): if `messages.length` grew since the
   *    last rebuild, rebuildFromSnapshot(messages); otherwise no-op (the
   *    event-driven path is the source of truth for streaming growth).
   */
  updateLivePartial(
    messages: readonly unknown[],
    event?: AgentSessionEvent,
  ): void {
    if (event) {
      switch (event.type) {
        case "message_start": {
          const msg = event.message as MessageLike | undefined;
          if (msg && msg.role === "assistant") {
            // Backfill any messages that arrived (user prompt, etc.) but are
            // not yet rendered before appending the streaming component.
            if (messages.length > this.lastRebuiltMessageCount) {
              // Rebuild (this does NOT include the partial — it's not in
              // messages yet). The streaming component is appended below.
              this.rebuildFromSnapshot(messages);
            } else if (this.streamingComponent) {
              // No new structural messages, but a prior streaming component is
              // still live (previous ended without message_end, or two turns).
              this.clearStreamingComponent();
            }
            this.createStreamingComponent(msg);
            return;
          }
          // user / custom / toolResult roles land in state.messages now.
          this.rebuildFromSnapshot(messages);
          return;
        }
        case "message_update": {
          const msg = event.message as MessageLike | undefined;
          if (msg && msg.role === "assistant") {
            if (!this.streamingComponent) {
              // Opened mid-stream (missed message_start) — establish one now.
              if (messages.length > this.lastRebuiltMessageCount) {
                this.rebuildFromSnapshot(messages);
              }
              this.createStreamingComponent(msg);
              return;
            }
            this.updateStreamingMessage(msg);
            return;
          }
          // Non-assistant update — rebuild (rare during streaming).
          this.rebuildFromSnapshot(messages);
          return;
        }
        case "message_end": {
          // The finalized message is now in state.messages — rebuild so the
          // mapper recreates it as a finalized component and any toolResult
          // messages that follow land correctly.
          this.clearStreamingComponent();
          this.rebuildFromSnapshot(messages);
          return;
        }
        default:
          // tool_execution_*, turn_*, agent_*: structural state — rebuild.
          this.rebuildFromSnapshot(messages);
          return;
      }
    }

    // Spinner-tick fallback (no event): the event-driven path is the source of
    // truth for streaming growth. Only rebuild if structural state changed
    // (messages.length grew) since the last rebuild. Otherwise no-op — the
    // streaming component continues to be updated by events.
    if (messages.length !== this.lastRebuiltMessageCount) {
      this.rebuildFromSnapshot(messages);
    }
    // No-op: nothing structural changed, streaming handled by events.
  }

  /** Update the persistent streaming component with the live partial message.
   *
   *  Mirrors interactive-mode.js message_update: updateContent(event.message)
   *  in place, then scan the partial's content for NEW toolCall blocks and
   *  create inline ToolExecutionComponents for them (so mid-stream tool calls
   *  render without a full rebuild — which would lose the partial since
   *  state.messages doesn't contain it during streaming). */
  private updateStreamingMessage(msg: MessageLike): void {
    if (!this.streamingComponent) return;
    try {
      this.streamingComponent.updateContent(msg as any);
      this.streamingComponent.invalidate();
      this.streamingMessageRef = msg;

      // Inline-create ToolExecutionComponents for newly-appearing toolCall
      // blocks (mirrors interactive-mode.js:2272+). NOTE: AssistantMessageComponent
      // only renders text/thinking content — toolCall blocks render as separate
      // ToolExecutionComponent siblings, exactly like the mapper does for
      // finalized messages.
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block &&
            typeof block === "object" &&
            (block as { type?: string }).type === "toolCall" &&
            typeof (block as { id?: string }).id === "string"
          ) {
            const id = (block as { id: string }).id;
            if (this.streamingToolIds.has(id)) continue;
            const name = (block as { name?: string }).name;
            if (!name) continue;
            const component = new ToolExecutionComponent(
              name,
              id,
              (block as { arguments?: any }).arguments ?? {},
              { showImages: false },
              undefined,
              this.deps.ui,
              this.deps.cwd,
            );
            component.setExpanded(this.deps.toolOutputExpanded);
            this.container.addChild(component);
            this.streamingToolIds.add(id);
          }
        }
      }
    } catch {
      // If updateContent throws, fall back to a full rebuild next tick.
      this.clearStreamingComponent();
    }
  }

  /** Return the live message reference currently being streamed, if any. */
  getStreamingMessageRef(): unknown | undefined {
    return this.streamingMessageRef;
  }

  /**
   * Append only new messages incrementally.
   *
   * For simplicity and correctness (message types can interact, e.g. assistant
   * + toolCall + toolResult), this currently does a full rebuild. The
   * Container.clear() + rebuild is fast enough for the message counts typical
   * in subagent sessions.
   */
  appendNewMessages(messages: readonly unknown[]): void {
    this.rebuildFromSnapshot(messages);
  }

  /** Render all children to a string array at the given width. */
  render(width: number): string[] {
    return this.container.render(width);
  }

  /**
   * Toggle expand/collapse on the Nth expandable component.
   *
   * The index refers to the position among ALL children (not just expandable
   * ones). Spacers and non-expandable components are skipped.
   */
  toggleExpanded(childIndex: number): void {
    const target = this.getExpandableChild(childIndex);
    if (target) {
      target.setExpanded(!target.expanded);
    }
  }

  /**
   * Get the child component index for the focused content line.
   *
   * Walks children in order, counting rendered lines until reaching the
   * scroll offset. Returns the child index that contains the focused line,
   * or -1 if no component matches.
   */
  getFocusedChildIndex(scrollOffset: number, width: number): number {
    const children = (this.container as any).children as
      | Component[]
      | undefined;
    if (!children || children.length === 0) return -1;

    let lineCount = 0;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const rendered = child.render(width);
      if (lineCount + rendered.length > scrollOffset) {
        return i;
      }
      lineCount += rendered.length;
    }
    return -1;
  }

  /** Invalidate the container (force re-render on next render call). */
  invalidate(): void {
    this.container.invalidate();
  }

  /** Dispose all child components, stopping Loaders and clearing intervals. */
  dispose(): void {
    for (const child of this.container.children) {
      disposeComponentTree(child);
    }
    this.container.clear();
    this.pendingTools.clear();
    // Drop streaming refs so a reused container rebinds on next snapshot.
    this.streamingComponent = undefined;
    this.streamingMessageRef = undefined;
    this.streamingToolIds.clear();
    this.lastRebuiltMessageCount = 0;
  }

  // ── Private ────────────────────────────────────────────────────────────

  /** Find the expandable child at the given child index, or its nearest expandable neighbor. */
  private getExpandableChild(childIndex: number): Expandable | undefined {
    const children = (this.container as any).children as
      | Component[]
      | undefined;
    if (!children) return undefined;

    // Try the exact index first
    if (childIndex >= 0 && childIndex < children.length) {
      const candidate = children[childIndex] as any;
      if (this.isExpandable(candidate)) return candidate;
    }

    // Search neighbors — forward then backward
    for (let offset = 1; offset <= 3; offset++) {
      for (const idx of [childIndex + offset, childIndex - offset]) {
        if (idx >= 0 && idx < children.length) {
          const candidate = children[idx] as any;
          if (this.isExpandable(candidate)) return candidate;
        }
      }
    }

    return undefined;
  }

  /** Check if a component supports expand/collapse. */
  private isExpandable(component: any): component is Expandable {
    return (
      component != null &&
      typeof component === "object" &&
      typeof component.expanded === "boolean" &&
      typeof component.setExpanded === "function"
    );
  }
}
