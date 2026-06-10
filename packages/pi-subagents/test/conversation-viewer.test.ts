import { Theme, initTheme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { ConversationViewer } from "#src/ui/conversation-viewer";
import { createTestSubagent } from "./helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "./helpers/mock-session";

const testRegistry = new AgentTypeRegistry(() => new Map());

// ── Helpers ────────────────────────────────────────────────────────────

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

/**
 * Create a real Theme instance for testing.
 * Uses the dark theme default since we need the full Theme class
 * (with fg, bg, bold, italic, etc.) for the component constructors.
 */
function createTestTheme(): Theme {
  // Initialize the global theme singleton so component constructors
  // that read from the global theme work.
  initTheme("dark");
  // After init, we can construct a Theme instance. The components read from
  // the global singleton, not from our instance, but our instance is still
  // needed for the ConversationViewer's own rendering (borders, header, etc.)
  // which uses the Theme class methods.
  const fgColors: Record<string, string | number> = {
    accent: "#5f5faf",
    border: "#585858",
    borderAccent: "#5f5faf",
    borderMuted: "#666666",
    success: "#5f875f",
    error: "#875f5f",
    warning: "#87875f",
    muted: "#808080",
    dim: "#666666",
    text: "#d0d0d0",
    thinkingText: "#808080",
    userMessageText: "#d0d0d0",
    customMessageText: "#d0d0d0",
    customMessageLabel: "#af87d7",
    toolTitle: "#5f5faf",
    toolOutput: "#d0d0d0",
    mdHeading: "#5f5faf",
    mdLink: "#5f5faf",
    mdLinkUrl: "#808080",
    mdCode: "#5f875f",
    mdCodeBlock: "#d0d0d0",
    mdCodeBlockBorder: "#585858",
    mdQuote: "#666666",
    mdQuoteBorder: "#585858",
    mdHr: "#585858",
    mdListBullet: "#5f5faf",
    toolDiffAdded: "#5f875f",
    toolDiffRemoved: "#875f5f",
    toolDiffContext: "#666666",
    syntaxComment: "#666666",
    syntaxKeyword: "#5f5faf",
    syntaxFunction: "#af87d7",
    syntaxVariable: "#d0d0d0",
    syntaxString: "#5f875f",
    syntaxNumber: "#af87d7",
    syntaxType: "#af87d7",
    syntaxOperator: "#808080",
    syntaxPunctuation: "#808080",
    thinkingOff: "#666666",
    thinkingMinimal: "#808080",
    thinkingLow: "#5f8787",
    thinkingMedium: "#5f8787",
    thinkingHigh: "#5f5faf",
    thinkingXhigh: "#5f875f",
    bashMode: "#5f875f",
  };
  const bgColors: Record<string, string | number> = {
    selectedBg: "#303030",
    userMessageBg: "#303030",
    customMessageBg: "#303030",
    toolPendingBg: "#303030",
    toolSuccessBg: "#303530",
    toolErrorBg: "#353030",
  };
  return new Theme(fgColors, bgColors, "truecolor");
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

/** Options accepted by `createTestViewer`. */
type TestViewerOptions = {
  width?: number;
  messages?: unknown[];
  activity?: AgentActivityTracker;
};

/** Factory for ConversationViewer with sensible defaults. Pass overrides as needed. */
function createTestViewer(options: TestViewerOptions = {}): ConversationViewer {
  const { width = 80, messages = [], activity } = options;
  const mockSess = createMockSession();
  mockSess.messages.push(...messages);
  const record = createTestSubagent({ status: "running" });
  record.subagentSession = toSubagentSession(createSubagentSessionStub(mockSess));
  return new ConversationViewer({
    tui: mockTui(30, width),
    record,
    activity,
    theme: createTestTheme(),
    done: vi.fn(),
    registry: testRegistry,
  });
}

/**
 * Assert that rendering the given messages fits within each of the given widths.
 * Defaults to the standard test widths [40, 80, 120, 216].
 */
function assertRenderFitsWidths(
  messages: unknown[],
  widths = [40, 80, 120, 216],
  options?: TestViewerOptions,
): void {
  for (const w of widths) {
    const viewer = createTestViewer({ ...options, width: w, messages });
    assertAllLinesFit(viewer.render(w), w);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("ConversationViewer", () => {
  describe("render width safety", () => {
    it("no line exceeds width with empty messages", () => {
      assertRenderFitsWidths([]);
    });

    it("no line exceeds width with plain text messages", () => {
      assertRenderFitsWidths([
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ]);
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      assertRenderFitsWidths([
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
      ]);
    });

    it("no line exceeds width with bashExecution messages", () => {
      assertRenderFitsWidths([
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ]);
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      assertRenderFitsWidths(
        [
          { role: "user", content: "do the thing" },
          { role: "assistant", content: [{ type: "text", text: "working on it" }] },
        ],
        [40, 80, 120, 216],
        { activity: activity as unknown as AgentActivityTracker },
      );
    });

    it("no line exceeds width with tool calls", () => {
      assertRenderFitsWidths([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", id: "t1", name: "read", arguments: { path: "/very/long/path/".repeat(20) + "file.txt" } },
          ],
        },
      ]);
    });

    it("no line exceeds width at narrow terminal", () => {
      assertRenderFitsWidths(
        [
          { role: "user", content: "Hello world, this is a normal sentence." },
          { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
        ],
        [8, 10, 15, 20],
      );
    });

    it("no line exceeds width with tool results", () => {
      const longContent = "X".repeat(500);
      assertRenderFitsWidths([
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/index.ts" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "t1",
          content: [{ type: "text", text: longContent }],
        },
      ]);
    });
  });
});
