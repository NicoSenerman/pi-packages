import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsAgentFileOps } from "../../src/ui/agent-file-ops.js";

describe("FsAgentFileOps", () => {
  let ops: FsAgentFileOps;
  let testDir: string;

  beforeEach(() => {
    ops = new FsAgentFileOps();
    testDir = join(tmpdir(), `agent-file-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("exists", () => {
    it("returns true for an existing file", () => {
      const filePath = join(testDir, "test.md");
      writeFileSync(filePath, "content", "utf-8");
      expect(ops.exists(filePath)).toBe(true);
    });

    it("returns false for a non-existing file", () => {
      expect(ops.exists(join(testDir, "missing.md"))).toBe(false);
    });
  });

  describe("read", () => {
    it("returns file content for an existing file", () => {
      const filePath = join(testDir, "test.md");
      writeFileSync(filePath, "hello world", "utf-8");
      expect(ops.read(filePath)).toBe("hello world");
    });

    it("returns undefined for a non-existing file", () => {
      expect(ops.read(join(testDir, "missing.md"))).toBeUndefined();
    });
  });

  describe("write", () => {
    it("writes content to a file", () => {
      const filePath = join(testDir, "output.md");
      ops.write(filePath, "written content");
      expect(readFileSync(filePath, "utf-8")).toBe("written content");
    });

    it("ensures parent directories exist", () => {
      const filePath = join(testDir, "nested", "deep", "output.md");
      ops.write(filePath, "deep content");
      expect(readFileSync(filePath, "utf-8")).toBe("deep content");
    });
  });

  describe("remove", () => {
    it("removes an existing file", () => {
      const filePath = join(testDir, "to-delete.md");
      writeFileSync(filePath, "delete me", "utf-8");
      ops.remove(filePath);
      expect(existsSync(filePath)).toBe(false);
    });
  });

  describe("ensureDir", () => {
    it("creates a directory if it does not exist", () => {
      const dirPath = join(testDir, "new-dir", "sub-dir");
      ops.ensureDir(dirPath);
      expect(existsSync(dirPath)).toBe(true);
    });

    it("is a no-op if the directory already exists", () => {
      const dirPath = join(testDir, "existing-dir");
      mkdirSync(dirPath);
      ops.ensureDir(dirPath);
      expect(existsSync(dirPath)).toBe(true);
    });
  });

  describe("findAgentFile", () => {
    it("returns the first matching file path from ordered directories", () => {
      const dir1 = join(testDir, "project-agents");
      const dir2 = join(testDir, "personal-agents");
      mkdirSync(dir1, { recursive: true });
      mkdirSync(dir2, { recursive: true });
      writeFileSync(join(dir1, "my-agent.md"), "project version", "utf-8");
      writeFileSync(join(dir2, "my-agent.md"), "personal version", "utf-8");

      expect(ops.findAgentFile("my-agent", [dir1, dir2])).toBe(join(dir1, "my-agent.md"));
    });

    it("returns a match from a later directory when earlier directories have no match", () => {
      const dir1 = join(testDir, "project-agents");
      const dir2 = join(testDir, "personal-agents");
      mkdirSync(dir1, { recursive: true });
      mkdirSync(dir2, { recursive: true });
      writeFileSync(join(dir2, "my-agent.md"), "personal version", "utf-8");

      expect(ops.findAgentFile("my-agent", [dir1, dir2])).toBe(join(dir2, "my-agent.md"));
    });

    it("returns undefined when no directory contains the agent file", () => {
      const dir1 = join(testDir, "project-agents");
      mkdirSync(dir1, { recursive: true });

      expect(ops.findAgentFile("missing-agent", [dir1])).toBeUndefined();
    });
  });
});
