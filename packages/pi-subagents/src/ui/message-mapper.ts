/**
 * message-mapper.ts — Maps agent session messages to Pi TUI component instances.
 *
 * Follows the same pattern as the main chat's `addMessageToChat()` /
 * `renderSessionContext()` in interactive-mode.js, but builds a standalone
 * component tree for the subagent viewers rather than the live chat.
 */

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	Theme,
	ToolExecutionComponent,
	UserMessageComponent,
	parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { type Component, type MarkdownTheme, type TUI, Spacer } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

/** Dependencies shared by the mapper and its consumers. */
export interface MapperDeps {
	theme: Theme;
	ui: TUI;
	cwd: string;
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
}

/** The result of building conversation components from a snapshot. */
export interface MapperResult {
	/** Ordered children to add to a Container. */
	children: Component[];
	/** Pending tool components waiting for their toolResult. Keyed by toolCallId. */
	pendingTools: Map<string, ToolExecutionComponent>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract text content from a user message (string or content array). */
function getUserMessageText(msg: { content: unknown }): string | undefined {
	if (typeof msg.content === "string") {
		return msg.content;
	}
	if (Array.isArray(msg.content)) {
		const texts: string[] = [];
		for (const item of msg.content) {
			if (item && typeof item === "object" && "type" in item && item.type === "text" && typeof item.text === "string") {
				texts.push(item.text);
			}
		}
		return texts.length > 0 ? texts.join("\n") : undefined;
	}
	return undefined;
}

/** Type guard for bash execution messages. */
function isBashExecution(msg: { role: string }): msg is {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
} {
	return msg.role === "bashExecution";
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build component instances from an array of session messages.
 *
 * Mirrors the main chat's `renderSessionContext()`: it iterates messages,
 * creating the appropriate component for each one and matching toolResult
 * messages to their preceding ToolExecutionComponent via toolCallId.
 */
export function buildConversationComponents(
	messages: readonly unknown[],
	deps: MapperDeps,
	mdTheme: MarkdownTheme,
): MapperResult {
	const { ui, cwd, toolOutputExpanded, hideThinkingBlock } = deps;
	const children: Component[] = [];
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const renderedPendingTools = new Map<string, ToolExecutionComponent>();

	for (const raw of messages) {
		const msg = raw as { role: string; [key: string]: unknown };

		if (msg.role === "assistant") {
			// Assistant component
			const assistantComponent = new AssistantMessageComponent(
				msg as any,
				hideThinkingBlock,
				mdTheme,
				hideThinkingBlock ? "Thinking..." : undefined,
			);
			// Add spacer before assistant message if there are already children
			if (children.length > 0) {
				children.push(new Spacer(1));
			}
			children.push(assistantComponent);

			// Render tool call components inline
			const content = msg.content as Array<{ type: string; id?: string; name?: string; arguments?: any }>;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "toolCall" && block.id && block.name) {
						const toolDef = undefined; // No extension tool definitions in subagent context
						const component = new ToolExecutionComponent(
							block.name,
							block.id,
							block.arguments ?? {},
							{ showImages: false },
							toolDef,
							ui,
							cwd,
						);
						component.setExpanded(toolOutputExpanded);
						children.push(component);

						// If the assistant message was aborted/errored, push an error result
						if (msg.stopReason === "aborted" || msg.stopReason === "error") {
							let errorMessage: string;
							if (msg.stopReason === "aborted") {
								errorMessage = "Operation aborted";
							} else {
								errorMessage = (msg.errorMessage as string) || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(block.id, component);
						}
					}
				}
			}
		} else if (msg.role === "toolResult") {
			// Match tool results to pending tool components
			const toolCallId = msg.toolCallId as string;
			const component = renderedPendingTools.get(toolCallId);
			if (component) {
				component.updateResult(msg as any);
				renderedPendingTools.delete(toolCallId);
			} else {
				// Standalone toolResult without a preceding tool call component
				// Create a minimal ToolExecutionComponent showing just the result
				const toolName = (msg.toolName as string) ?? "unknown";
				const component = new ToolExecutionComponent(
					toolName,
					toolCallId ?? `orphan-${Date.now()}`,
					{},
					{ showImages: false },
					undefined,
					ui,
					cwd,
				);
				component.setExpanded(toolOutputExpanded);
				component.updateResult(msg as any);
				if (children.length > 0) {
					children.push(new Spacer(1));
				}
				children.push(component);
			}
		} else if (msg.role === "user") {
			const textContent = getUserMessageText(msg as any);
			if (textContent) {
				if (children.length > 0) {
					children.push(new Spacer(1));
				}
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					// Render skill block (collapsible)
					const skillComponent = new SkillInvocationMessageComponent(skillBlock, mdTheme);
					skillComponent.setExpanded(toolOutputExpanded);
					children.push(skillComponent);
					// Render user message separately if present
					if (skillBlock.userMessage) {
						children.push(new Spacer(1));
						const userComponent = new UserMessageComponent(skillBlock.userMessage, mdTheme);
						children.push(userComponent);
					}
				} else {
					const userComponent = new UserMessageComponent(textContent, mdTheme);
					children.push(userComponent);
				}
			}
		} else if (isBashExecution(msg)) {
			const bashComponent = new BashExecutionComponent(msg.command, ui, msg.excludeFromContext ?? false);
			if (msg.output) {
				bashComponent.appendOutput(msg.output);
			}
			bashComponent.setComplete(
				msg.exitCode,
				msg.cancelled,
				undefined,
				msg.fullOutputPath,
			);
			bashComponent.setExpanded(toolOutputExpanded);
			children.push(bashComponent);
		} else if (msg.role === "custom") {
			// Respect the display flag — if explicitly false, skip
			if (msg.display === false) continue;
			const component = new CustomMessageComponent(msg as any, undefined, mdTheme);
			component.setExpanded(toolOutputExpanded);
			if (children.length > 0) {
				children.push(new Spacer(1));
			}
			children.push(component);
		} else if (msg.role === "compactionSummary") {
			if (children.length > 0) {
				children.push(new Spacer(1));
			}
			const component = new CompactionSummaryMessageComponent(msg as any, mdTheme);
			component.setExpanded(toolOutputExpanded);
			children.push(component);
		} else if (msg.role === "branchSummary") {
			if (children.length > 0) {
				children.push(new Spacer(1));
			}
			const component = new BranchSummaryMessageComponent(msg as any, mdTheme);
			component.setExpanded(toolOutputExpanded);
			children.push(component);
		}
		// toolResult role is handled above — skip others
	}

	// Transfer any still-pending tools (for live streaming)
	for (const [toolCallId, component] of renderedPendingTools) {
		pendingTools.set(toolCallId, component);
	}

	return { children, pendingTools };
}
