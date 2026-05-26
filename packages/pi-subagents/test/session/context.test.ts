import { describe, expect, it } from "vitest";
import { extractText } from "#src/session/context";

describe("extractText", () => {
  it("returns empty string for an empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("extracts text from a single text block", () => {
    expect(extractText([{ type: "text", text: "hello" }])).toBe("hello");
  });

  it("joins multiple text blocks with newlines", () => {
    expect(
      extractText([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("skips non-text blocks", () => {
    expect(
      extractText([
        { type: "thinking", thinking: "..." },
        { type: "text", text: "visible" },
        { type: "tool_use", name: "bash" },
      ]),
    ).toBe("visible");
  });

  it("returns empty string when no text blocks exist", () => {
    expect(extractText([{ type: "tool_result" }, { type: "thinking" }])).toBe("");
  });
});
