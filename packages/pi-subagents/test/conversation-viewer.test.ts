import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  };
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
  wrapText?: (text: string, width: number) => string[];
};

/** Factory for ConversationViewer with sensible defaults. Pass overrides as needed. */
function createTestViewer(options: TestViewerOptions = {}): ConversationViewer {
  const { width = 80, messages = [], activity, wrapText = wrapTextWithAnsi } = options;
  const mockSess = createMockSession();
  mockSess.messages.push(...messages);
  const record = createTestSubagent({ status: "running" });
  record.subagentSession = toSubagentSession(createSubagentSessionStub(mockSess));
  return new ConversationViewer({
    tui: mockTui(30, width),
    record,
    activity,
    theme: ansiTheme(),
    done: vi.fn(),
    registry: testRegistry,
    wrapText,
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
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ]);
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      assertRenderFitsWidths([
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ]);
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      assertRenderFitsWidths([
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ]);
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      assertRenderFitsWidths([
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
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
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
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

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      assertRenderFitsWidths([
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ]);
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    // These tests call buildContentLines() directly (via the private method)
    // because render() has its own truncation via row(). The safety net in
    // buildContentLines is what prevents the TUI crash — it must clamp
    // independently of render().

    /** Call the private buildContentLines method directly. */
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      const viewer = createTestViewer({
        width: w,
        messages: [{ role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] }],
        wrapText: () => ["X".repeat(w + 50)],
      });
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      const viewer = createTestViewer({
        width: w,
        messages: [{ role: "user", content: "hello" }],
        wrapText: () => ["Y".repeat(w + 100)],
      });
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      const viewer = createTestViewer({
        width: w,
        messages: [{ role: "assistant", content: [{ type: "text", text: "response" }] }],
        wrapText: () => ["Z".repeat(w + 100)],
      });
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      const viewer = createTestViewer({
        width: w,
        messages: [{
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        }],
        wrapText: () => ["B".repeat(w + 100)],
      });
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      const viewer = createTestViewer({
        width: w,
        messages: [{ role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] }],
        wrapText: () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`],
      });
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });
  });
});
