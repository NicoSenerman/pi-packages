import { describe, expect, it } from "vitest";
import { sanitizeTaskFields, sanitizeTerminalText } from "./sanitize.js";

describe("sanitizeTerminalText", () => {
	it("drops complete ANSI/C1 escape sequences without printable remnants", () => {
		expect(sanitizeTerminalText("safe\u001b[31mred\u001b[0m\u009b2J")).toBe("safered");
	});

	it("drops OSC sequences including their payload", () => {
		expect(sanitizeTerminalText("a\u001b]0;evil title\u0007b\u001b]8;;http://x\u001b\\c")).toBe("abc");
	});

	it("keeps task fields on one terminal line", () => {
		expect(sanitizeTerminalText("one\ntwo\tthree\r")).toBe("one two three ");
		expect(sanitizeTerminalText("a\u2028b\u2029c")).toBe("a b c");
	});

	it("removes bare control characters and bidi overrides", () => {
		expect(sanitizeTerminalText("a\u0007b\u007fc\u202egfedcba\u202c")).toBe("abcgfedcba");
	});
});

describe("sanitizeTaskFields", () => {
	it("strips model-controlled fields and leaves the rest", () => {
		const task = sanitizeTaskFields({
			id: 1,
			subject: "sub\u001b[31m",
			description: "d\u202ee",
			activeForm: "a\u0007b",
			owner: "o\u200e",
			status: "pending" as const,
		});
		expect(task).toEqual({
			id: 1,
			subject: "sub",
			description: "de",
			activeForm: "ab",
			owner: "o",
			status: "pending",
		});
	});
});
