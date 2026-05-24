import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ForegroundParams, runForeground } from "#src/tools/foreground-runner";
import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";
import { createToolDeps } from "#test/helpers/make-deps";
import { createTestRecord } from "#test/helpers/make-record";
import { createMockSession, toAgentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

function makeConfig(overrides: Partial<ResolvedSpawnConfig> = {}): ResolvedSpawnConfig {
  return {
    identity: {
      subagentType: "general-purpose",
      rawType: "general-purpose",
      fellBack: false,
      displayName: "Agent",
    },
    execution: {
      prompt: "do the task",
      description: "fg task",
      model: undefined,
      effectiveMaxTurns: undefined,
      thinking: undefined,
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      isolation: undefined,
      agentInvocation: {
        modelName: undefined,
        thinking: undefined,
        maxTurns: undefined,
        isolated: false,
        inheritContext: false,
        runInBackground: false,
        isolation: undefined,
      },
    },
    presentation: {
      modelName: undefined,
      agentTags: [],
      detailBase: {
        displayName: "Agent",
        description: "fg task",
        subagentType: "general-purpose",
        modelName: undefined,
        tags: undefined,
      },
    },
    ...overrides,
  };
}

function makeParams(overrides: Partial<ForegroundParams> = {}): ForegroundParams {
  return {
    config: makeConfig(),
    snapshot: STUB_SNAPSHOT,
    parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "session-1" },
    ...overrides,
  };
}

describe("runForeground", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns completion message with tool use count on success", async () => {
    const { manager, widget, agentActivity } = createToolDeps();
    const result = await runForeground(manager, widget, agentActivity, makeParams(), undefined, undefined);
    expect(result.content[0].text).toContain("Agent completed");
    expect(result.content[0].text).toContain("3 tool uses");
    expect(result.content[0].text).toContain("All done.");
  });

  it("returns error message when agent record status is error", async () => {
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockResolvedValue(
          createTestRecord({ status: "error", error: "Context window exceeded" }),
        ),
      },
    });
    const result = await runForeground(deps.manager, deps.widget, deps.agentActivity, makeParams(), undefined, undefined);
    expect(result.content[0].text).toContain("Agent failed");
    expect(result.content[0].text).toContain("Context window exceeded");
  });

  it("returns error text when spawnAndWait throws", async () => {
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockRejectedValue(new Error("runner crashed")),
      },
    });
    const result = await runForeground(deps.manager, deps.widget, deps.agentActivity, makeParams(), undefined, undefined);
    expect(result.content[0].text).toContain("runner crashed");
  });

  it("includes fallback note when fellBack is true", async () => {
    const { manager, widget, agentActivity } = createToolDeps();
    const result = await runForeground(
      manager,
      widget,
      agentActivity,
      makeParams({
        config: makeConfig({
          identity: { subagentType: "general-purpose", rawType: "unknown-type", fellBack: true, displayName: "Agent" },
        }),
      }),
      undefined,
      undefined,
    );
    expect(result.content[0].text).toContain('Unknown agent type "unknown-type"');
  });

  it("calls widget.ensureTimer and widget.markFinished after completion", async () => {
    // spawnAndWait invokes onSessionCreated to register the agent in activity map
    const mockSess = { subscribe: vi.fn().mockReturnValue(() => {}) };
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockImplementation(
          async (_snapshot: any, _type: any, _prompt: any, opts: any) => {
            const record = createTestRecord({ result: "done" });
            opts.onSessionCreated?.(mockSess, record);
            return record;
          },
        ),
      },
    });
    const signal = new AbortController().signal;
    await runForeground(deps.manager, deps.widget, deps.agentActivity, makeParams(), signal, undefined);
    expect(deps.widget.ensureTimer).toHaveBeenCalled();
    expect(deps.widget.markFinished).toHaveBeenCalled();
  });

  it("registers activity tracker in agentActivity on session creation", async () => {
    const mockSess = { subscribe: vi.fn().mockReturnValue(() => {}) };
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockImplementation(
          async (_snapshot: any, _type: any, _prompt: any, opts: any) => {
            const record = createTestRecord({ result: "done" });
            record.execution = { session: toAgentSession(createMockSession()), outputFile: undefined };
            opts.onSessionCreated?.(mockSess, record);
            return record;
          },
        ),
      },
    });
    await runForeground(deps.manager, deps.widget, deps.agentActivity, makeParams(), undefined, undefined);
    // Activity is registered during onSessionCreated and removed on cleanup —
    // markFinished is the evidence that the id was tracked and cleaned up.
    expect(deps.widget.markFinished).toHaveBeenCalledOnce();
  });

  it("calls onUpdate with streaming details while running", async () => {
    let resolve!: (r: any) => void;
    const promise = new Promise<any>((res) => { resolve = res; });
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockReturnValue(promise),
      },
    });
    const onUpdate = vi.fn();
    const runPromise = runForeground(deps.manager, deps.widget, deps.agentActivity, makeParams(), undefined, onUpdate);

    // Advance timer to trigger a spinner tick
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalled();

    resolve(createTestRecord({ result: "done" }));
    await runPromise;
  });

  it("clears spinner interval on error and does not leave it running", async () => {
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawnAndWait: vi.fn().mockRejectedValue(new Error("fail")),
      },
    });
    const onUpdate = vi.fn();
    await runForeground(deps.manager, deps.widget, deps.agentActivity, makeParams(), undefined, onUpdate);

    onUpdate.mockClear();
    await vi.advanceTimersByTimeAsync(200);
    // Interval must have been cleared — no further onUpdate calls
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
