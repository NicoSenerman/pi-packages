import { describe, expect, it, vi } from "vitest";
import { type BackgroundParams, spawnBackground } from "#src/tools/background-spawner";
import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";
import { AgentActivityTracker } from "#src/ui/agent-activity-tracker";
import { createToolDeps } from "#test/helpers/make-deps";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

function makeConfig(overrides: Partial<ResolvedSpawnConfig> = {}): ResolvedSpawnConfig {
  return {
    identity: {
      subagentType: "general-purpose",
      rawType: "general-purpose",
      fellBack: false,
      displayName: "General-purpose",
    },
    execution: {
      prompt: "do something",
      description: "bg task",
      model: undefined,
      effectiveMaxTurns: undefined,
      thinking: undefined,
      inheritContext: false,
      runInBackground: true,
      agentInvocation: {
        modelName: undefined,
        thinking: undefined,
        maxTurns: undefined,
        inheritContext: false,
        runInBackground: true,
      },
    },
    presentation: {
      modelName: undefined,
      agentTags: [],
      detailBase: {
        displayName: "General-purpose",
        description: "bg task",
        subagentType: "general-purpose",
        modelName: undefined,
        tags: undefined,
      },
    },
    ...overrides,
  };
}

function makeParams(overrides: Partial<BackgroundParams> = {}): BackgroundParams {
  return {
    config: makeConfig(),
    snapshot: STUB_SNAPSHOT,
    parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "session-1", toolCallId: "tc-1" },
    settings: { maxConcurrent: 4 },
    ...overrides,
  };
}

describe("spawnBackground", () => {
  it("registers an AgentActivityTracker in agentActivity map", () => {
    const { manager, runtime } = createToolDeps();
    spawnBackground(manager, runtime, runtime.agentActivity, makeParams());
    expect(runtime.agentActivity.get("agent-1")).toBeInstanceOf(AgentActivityTracker);
  });

  it("calls runtime.ensureTimer and runtime.update after spawn", () => {
    const { manager, runtime } = createToolDeps();
    spawnBackground(manager, runtime, runtime.agentActivity, makeParams());
    expect(runtime.ensureTimer).toHaveBeenCalledOnce();
    expect(runtime.update).toHaveBeenCalledOnce();
  });

  it("passes parentSession.toolCallId to manager.spawn so manager wires NotificationState", () => {
    const { manager, runtime } = createToolDeps();
    spawnBackground(manager, runtime, runtime.agentActivity, makeParams({ parentSession: { toolCallId: "tc-99" } }));
    const spawnOpts = (manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(spawnOpts.parentSession?.toolCallId).toBe("tc-99");
  });

  it("returns text result with agent ID and description", () => {
    const { manager, runtime } = createToolDeps();
    const result = spawnBackground(
      manager,
      runtime,
      runtime.agentActivity,
      makeParams({
        config: makeConfig({
          execution: {
            prompt: "do something",
            description: "my task",
            model: undefined,
            effectiveMaxTurns: undefined,
            thinking: undefined,
            inheritContext: false,
            runInBackground: true,
            agentInvocation: { modelName: undefined, thinking: undefined, maxTurns: undefined, inheritContext: false, runInBackground: true },
          },
        }),
      }),
    );
    expect(result.content[0].text).toContain("agent-1");
    expect(result.content[0].text).toContain("my task");
  });

  it("mentions 'queued' in result when record status is queued", () => {
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawn: vi.fn().mockReturnValue("bg-2"),
        getRecord: vi.fn().mockReturnValue(createTestSubagent({ status: "queued" })),
      },
    });
    const result = spawnBackground(deps.manager, deps.runtime, deps.runtime.agentActivity, makeParams({ settings: { maxConcurrent: 4 } }));
    expect(result.content[0].text).toContain("queued");
    expect(result.content[0].text).toContain("max 4 concurrent");
  });

  it("mentions 'started' in result when record is running", () => {
    const { manager, runtime } = createToolDeps();
    const result = spawnBackground(manager, runtime, runtime.agentActivity, makeParams());
    expect(result.content[0].text).toContain("started");
  });

  it("includes output file path in result when present", () => {
    const record = createTestSubagent({ status: "running" });
    record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/bg.jsonl"));
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawn: vi.fn().mockReturnValue("bg-3"),
        getRecord: vi.fn().mockReturnValue(record),
      },
    });
    const result = spawnBackground(deps.manager, deps.runtime, deps.runtime.agentActivity, makeParams());
    expect(result.content[0].text).toContain("/sessions/bg.jsonl");
  });

  it("returns error text when manager.spawn throws", () => {
    const deps = createToolDeps({
      manager: {
        ...createToolDeps().manager,
        spawn: vi.fn().mockImplementation(() => { throw new Error("spawn failed"); }),
        getRecord: vi.fn(),
      },
    });
    const result = spawnBackground(deps.manager, deps.runtime, deps.runtime.agentActivity, makeParams());
    expect(result.content[0].text).toContain("spawn failed");
  });
});
