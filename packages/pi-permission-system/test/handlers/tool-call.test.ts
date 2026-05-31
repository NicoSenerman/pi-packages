import { describe, expect, it, vi } from "vitest";

import { getEventInput } from "#src/handlers/permission-gate-handler";

import {
  makeCheckResult,
  makeCtx,
  makeHandler,
  makeToolCallEvent,
} from "#test/helpers/handler-fixtures";

// ── SDK stubs ──────────────────────────────────────────────────────────────
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...original };
});

// ── getEventInput ──────────────────────────────────────────────────────────

describe("getEventInput", () => {
  it("returns the input field when present", () => {
    expect(getEventInput({ input: { path: "/foo" } })).toEqual({
      path: "/foo",
    });
  });

  it("returns the arguments field when input is absent", () => {
    expect(getEventInput({ arguments: { command: "ls" } })).toEqual({
      command: "ls",
    });
  });

  it("returns empty object when neither field is present", () => {
    expect(getEventInput({ type: "tool_call" })).toEqual({});
  });

  it("prefers input over arguments when both are present", () => {
    expect(getEventInput({ input: { a: 1 }, arguments: { b: 2 } })).toEqual({
      a: 1,
    });
  });
});

// ── handleToolCall ─────────────────────────────────────────────────────────

describe("handleToolCall", () => {
  it("activates session with ctx", async () => {
    const ctx = makeCtx();
    const { handler, session } = makeHandler();
    await handler.handleToolCall(makeToolCallEvent("read"), ctx);
    expect(session.activate).toHaveBeenCalledWith(ctx);
  });

  it("blocks when tool name cannot be resolved", async () => {
    const { handler } = makeHandler();
    const result = await handler.handleToolCall(
      { type: "tool_call" },
      makeCtx(),
    );
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("tool"),
    });
  });

  it("blocks when tool is not registered", async () => {
    const { handler } = makeHandler({
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{ name: "read" }]),
      },
    });
    const result = await handler.handleToolCall(
      makeToolCallEvent("unknown-tool"),
      makeCtx(),
    );
    expect(result).toMatchObject({ block: true });
  });

  it("returns empty object when tool is allowed", async () => {
    const { handler } = makeHandler();
    const result = await handler.handleToolCall(
      makeToolCallEvent("read"),
      makeCtx(),
    );
    expect(result).toEqual({});
  });

  it("blocks when tool is denied by policy", async () => {
    const { handler } = makeHandler({
      session: {
        checkPermission: vi
          .fn()
          .mockReturnValue(makeCheckResult({ state: "deny" })),
      },
    });
    const result = await handler.handleToolCall(
      makeToolCallEvent("read"),
      makeCtx(),
    );
    expect(result).toMatchObject({ block: true });
  });
});

// ── skill-read gate ────────────────────────────────────────────────────────

describe("handleToolCall — skill-read gate", () => {
  it("blocks a read of a denied skill path", async () => {
    const skillEntry = {
      name: "librarian",
      description: "Research skills",
      location: "/skills/librarian/SKILL.md",
      state: "deny" as const,
      normalizedLocation: "/skills/librarian/SKILL.md",
      normalizedBaseDir: "/skills/librarian",
    };
    const { handler } = makeHandler({
      session: {
        getActiveSkillEntries: vi.fn().mockReturnValue([skillEntry]),
      },
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{ toolName: "read" }]),
      },
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-skill",
      toolName: "read",
      input: { path: "/skills/librarian/SKILL.md" },
    };
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });

  it("allows a read of a non-skill path even when skill entries are present", async () => {
    const skillEntry = {
      name: "librarian",
      description: "Research skills",
      location: "/skills/librarian/SKILL.md",
      state: "deny" as const,
      normalizedLocation: "/skills/librarian/SKILL.md",
      normalizedBaseDir: "/skills/librarian",
    };
    const { handler } = makeHandler({
      session: {
        getActiveSkillEntries: vi.fn().mockReturnValue([skillEntry]),
      },
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{ toolName: "read" }]),
      },
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-ok",
      toolName: "read",
      input: { path: "/test/project/src/index.ts" },
    };
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toEqual({});
  });
});

// ── external-directory gate ────────────────────────────────────────────────

describe("handleToolCall — external-directory gate", () => {
  it("blocks a read of a path outside cwd when policy is deny", async () => {
    const { handler } = makeHandler({
      session: {
        checkPermission: vi
          .fn()
          .mockReturnValue(makeCheckResult({ state: "deny" })),
      },
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{ name: "read" }]),
      },
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-ext",
      name: "read",
      input: { path: "/outside/project/file.ts" },
    };
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });
});

// ── bash external-directory gate ──────────────────────────────────────────

describe("handleToolCall — bash external-directory gate", () => {
  it("blocks a bash command referencing an external path when policy is deny", async () => {
    const { handler } = makeHandler({
      session: {
        checkPermission: vi
          .fn()
          .mockReturnValue(makeCheckResult({ state: "deny" })),
      },
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{ name: "bash" }]),
      },
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-bash-ext",
      name: "bash",
      input: { command: "cat /outside/project/file.ts" },
    };
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });
});

// ── path gate (tools) ─────────────────────────────────────────────────────

describe("handleToolCall — path gate (tools)", () => {
  it("blocks a read of .env when path surface denies *.env", async () => {
    const checkPermission = vi
      .fn()
      .mockImplementation(
        (surface: string, _input: unknown, _agentName?: string) => {
          if (surface === "path") {
            return makeCheckResult({ state: "deny", matchedPattern: "*.env" });
          }
          return makeCheckResult();
        },
      );
    const { handler } = makeHandler({
      session: { checkPermission },
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{ name: "read" }]),
      },
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-path",
      name: "read",
      input: { path: ".env" },
    };
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });

  it("allows a read when path surface allows", async () => {
    const { handler } = makeHandler({
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{ name: "read" }]),
      },
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-path-ok",
      name: "read",
      input: { path: "src/index.ts" },
    };
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toEqual({});
  });
});

// ── bash path gate ────────────────────────────────────────────────────────

describe("handleToolCall — bash path gate", () => {
  it("blocks a bash command accessing .env when path surface denies", async () => {
    const checkPermission = vi
      .fn()
      .mockImplementation(
        (surface: string, _input: unknown, _agentName?: string) => {
          if (surface === "path") {
            return makeCheckResult({ state: "deny", matchedPattern: "*.env" });
          }
          return makeCheckResult();
        },
      );
    const { handler } = makeHandler({
      session: { checkPermission },
      toolRegistry: {
        getAll: vi.fn().mockReturnValue([{ name: "bash" }]),
      },
    });
    const event = {
      type: "tool_call",
      toolCallId: "tc-bash-path",
      name: "bash",
      input: { command: "cat .env" },
    };
    const result = await handler.handleToolCall(event, makeCtx());
    expect(result).toMatchObject({ block: true });
  });
});
