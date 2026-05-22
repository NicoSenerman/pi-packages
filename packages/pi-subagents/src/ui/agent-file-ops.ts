/**
 * agent-file-ops.ts — Filesystem abstraction for agent .md file operations.
 *
 * Decouples menu sub-modules from direct `node:fs` imports, making them
 * testable via plain stub objects without `vi.mock()`.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---- Interface ----

/** Filesystem operations for agent `.md` files. */
export interface AgentFileOps {
  exists(filePath: string): boolean;
  read(filePath: string): string | undefined;
  write(filePath: string, content: string): void;
  remove(filePath: string): void;
  ensureDir(dirPath: string): void;
  findAgentFile(name: string, dirs: string[]): string | undefined;
}

// ---- Production implementation ----

/** Production implementation wrapping `node:fs` synchronous APIs. */
export class FsAgentFileOps implements AgentFileOps {
  exists(filePath: string): boolean {
    return existsSync(filePath);
  }

  read(filePath: string): string | undefined {
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return undefined;
    }
  }

  write(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf-8");
  }

  remove(filePath: string): void {
    unlinkSync(filePath);
  }

  ensureDir(dirPath: string): void {
    mkdirSync(dirPath, { recursive: true });
  }

  findAgentFile(name: string, dirs: string[]): string | undefined {
    for (const dir of dirs) {
      const p = join(dir, `${name}.md`);
      if (existsSync(p)) return p;
    }
    return undefined;
  }
}
