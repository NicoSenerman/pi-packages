import { homedir } from "node:os";
import path from "node:path";

import type { FormatScope } from "./format-scope.js";
import { isInFormatScope } from "./format-scope.js";

type ToolResultPayload = {
  path?: unknown;
};

/**
 * A mutation-source handler turns a tool result event into zero or more
 * candidate file paths. Paths may be relative (resolved against `cwd` by
 * the queue) or absolute. The queue handles dedupe and scope filtering.
 */
export type MutationSourceHandler = (
  toolName: string,
  payload: unknown,
  output: string,
) => string[];

const writeOrEditHandler: MutationSourceHandler = (toolName, payload) => {
  if (toolName !== "write" && toolName !== "edit") {
    return [];
  }
  if (!isToolResultPayload(payload) || typeof payload.path !== "string") {
    return [];
  }
  return [payload.path];
};

export type TouchedFilesQueueOptions = {
  cwd: string;
  scope?: FormatScope;
  /** Defaults to the built-in write/edit handler only. */
  handlers?: MutationSourceHandler[];
};

export class TouchedFilesQueue {
  private readonly cwd: string;
  private readonly handlers: MutationSourceHandler[];
  private readonly scope: FormatScope | undefined;
  private readonly touchedFiles = new Set<string>();

  constructor(cwdOrOptions: string | TouchedFilesQueueOptions) {
    if (typeof cwdOrOptions === "string") {
      this.cwd = cwdOrOptions;
      this.handlers = [writeOrEditHandler];
      this.scope = undefined;
      return;
    }
    this.cwd = cwdOrOptions.cwd;
    this.handlers = cwdOrOptions.handlers ?? [writeOrEditHandler];
    this.scope = cwdOrOptions.scope;
  }

  /**
   * Record a tool result. `output` is the textual stdout/stderr from the
   * tool (used by shell wrapper handlers); pass `""` if unavailable.
   */
  recordToolResult(toolName: string, payload: unknown, output = ""): void {
    for (const handler of this.handlers) {
      const candidates = handler(toolName, payload, output);
      for (const candidate of candidates) {
        this.add(candidate);
      }
    }
  }

  /** Add an externally produced candidate path (e.g., from a snapshot tracker). */
  addPath(filePath: string): void {
    this.add(filePath);
  }

  flush(): string[] {
    const files = [...this.touchedFiles];
    this.touchedFiles.clear();
    return files;
  }

  private add(filePath: string): void {
    if (typeof filePath !== "string" || filePath.length === 0) {
      return;
    }
    const normalized = normalizePath(this.cwd, filePath);
    if (this.scope && !isInFormatScope(normalized, this.scope)) {
      return;
    }
    this.touchedFiles.add(normalized);
  }
}

function isToolResultPayload(value: unknown): value is ToolResultPayload {
  return typeof value === "object" && value !== null;
}

function expandTilde(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(homedir(), filePath.slice(2));
  }
  return filePath;
}

function normalizePath(cwd: string, filePath: string): string {
  const expanded = expandTilde(filePath);
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.normalize(path.resolve(cwd, expanded));
}

// ---------------------------------------------------------------------------
// Built-in handlers used by the extension wiring.
// ---------------------------------------------------------------------------

export { writeOrEditHandler };
