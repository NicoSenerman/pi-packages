import { describe, expect, it } from "vitest";
import { normalizeInput } from "../src/input-normalizer";

describe("normalizeInput — non-MCP surfaces", () => {
  describe("special / external_directory", () => {
    it("uses path from input as the lookup value", () => {
      const result = normalizeInput(
        "external_directory",
        { path: "/other/project" },
        [],
      );
      expect(result.surface).toBe("external_directory");
      expect(result.values).toEqual(["/other/project"]);
      expect(result.resultExtras).toEqual({});
    });

    it("falls back to '*' when path is missing", () => {
      const result = normalizeInput("external_directory", {}, []);
      expect(result.values).toEqual(["*"]);
    });

    it("falls back to '*' when path is not a string", () => {
      const result = normalizeInput("external_directory", { path: 42 }, []);
      expect(result.values).toEqual(["*"]);
    });

    it("handles null input", () => {
      const result = normalizeInput("external_directory", null, []);
      expect(result.values).toEqual(["*"]);
    });
  });

  describe("skill", () => {
    it("uses skill name from input.name", () => {
      const result = normalizeInput("skill", { name: "librarian" }, []);
      expect(result.surface).toBe("skill");
      expect(result.values).toEqual(["librarian"]);
      expect(result.resultExtras).toEqual({});
    });

    it("falls back to '*' when name is missing", () => {
      const result = normalizeInput("skill", {}, []);
      expect(result.values).toEqual(["*"]);
    });

    it("falls back to '*' when name is not a string", () => {
      const result = normalizeInput("skill", { name: 99 }, []);
      expect(result.values).toEqual(["*"]);
    });
  });

  describe("bash", () => {
    it("uses command from input.command", () => {
      const result = normalizeInput("bash", { command: "git status" }, []);
      expect(result.surface).toBe("bash");
      expect(result.values).toEqual(["git status"]);
      expect(result.resultExtras).toEqual({ command: "git status" });
    });

    it("uses empty string when command is missing", () => {
      const result = normalizeInput("bash", {}, []);
      expect(result.values).toEqual([""]);
      expect(result.resultExtras).toEqual({ command: "" });
    });

    it("uses empty string when command is not a string", () => {
      const result = normalizeInput("bash", { command: 42 }, []);
      expect(result.values).toEqual([""]);
      expect(result.resultExtras).toEqual({ command: "" });
    });
  });

  describe("tool surfaces (read, write, edit, grep, find, ls, extension tools)", () => {
    it("uses '*' as the lookup value for built-in tools", () => {
      for (const tool of ["read", "write", "edit", "grep", "find", "ls"]) {
        const result = normalizeInput(tool, {}, []);
        expect(result.surface).toBe(tool);
        expect(result.values).toEqual(["*"]);
        expect(result.resultExtras).toEqual({});
      }
    });

    it("uses '*' as the lookup value for extension tools", () => {
      const result = normalizeInput("my_extension_tool", { some: "input" }, []);
      expect(result.surface).toBe("my_extension_tool");
      expect(result.values).toEqual(["*"]);
      expect(result.resultExtras).toEqual({});
    });
  });
});
