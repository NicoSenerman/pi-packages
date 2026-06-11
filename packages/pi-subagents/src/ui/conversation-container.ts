/**
 * conversation-container.ts — Manages a Container of Pi TUI components for
 * the conversation view.
 *
 * Encapsulates component tree construction, incremental updates, and
 * line-to-component mapping for scroll/expand interactions.
 */

import {
	ToolExecutionComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, type MarkdownTheme } from "@earendil-works/pi-tui";
import { type MapperDeps, buildConversationComponents } from "#src/ui/message-mapper";

// Re-export for consumers that need MapperDeps
export type { MapperDeps } from "#src/ui/message-mapper";

// ── Types ────────────────────────────────────────────────────────────────────

/** Component that supports expand/collapse. */
interface Expandable {
	expanded: boolean;
	setExpanded(expanded: boolean): void;
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
	if (c.loader && typeof c.loader === "object" && typeof (c.loader as any).stop === "function") {
		try { (c.loader as any).stop(); } catch { /* best effort */ }
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

		const result = buildConversationComponents(messages, this.deps, this.mdTheme);
		this.pendingTools = result.pendingTools;
		for (const child of result.children) {
			this.container.addChild(child);
		}
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
		const children = (this.container as any).children as Component[] | undefined;
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
	}

	// ── Private ────────────────────────────────────────────────────────────

	/** Find the expandable child at the given child index, or its nearest expandable neighbor. */
	private getExpandableChild(childIndex: number): Expandable | undefined {
		const children = (this.container as any).children as Component[] | undefined;
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
