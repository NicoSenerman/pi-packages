import { describe, expect, it, vi } from "vitest";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import type { AgentRecord } from "../../src/types.js";
import { createTestRecord } from "../helpers/make-record.js";
import { createMockSession, toAgentSession } from "../helpers/mock-session.js";
import { STUB_CTX } from "../helpers/stub-ctx.js";

function makeDeps(records: Map<string, AgentRecord> = new Map()) {
  return {
    getRecord: (id: string) => records.get(id),
    emitEvent: vi.fn(),
    steerAgent: vi.fn().mockResolvedValue(undefined),
    queueSteer: vi.fn((_id: string, _msg: string) => true),
  };
}

async function execute(
  deps: ReturnType<typeof makeDeps>,
  params: { agent_id: string; message: string },
) {
  const tool = createSteerTool(deps);
  return tool.execute("tc-1", params, new AbortController().signal, undefined, STUB_CTX);
}

describe("createSteerTool", () => {
  it("returns tool definition with correct name", () => {
    const tool = createSteerTool(makeDeps());
    expect(tool.name).toBe("steer_subagent");
  });

  it("returns not-found message for unknown agent ID", async () => {
    const result = await execute(makeDeps(), { agent_id: "unknown", message: "hi" });
    expect(result.content[0].text).toContain("Agent not found");
  });

  it("rejects steering a non-running agent", async () => {
    const records = new Map([["agent-1", createTestRecord({ status: "completed" })]]);
    const result = await execute(makeDeps(records), { agent_id: "agent-1", message: "hi" });
    expect(result.content[0].text).toContain("not running");
    expect(result.content[0].text).toContain("completed");
  });

  it("queues steer when session is not ready", async () => {
    // No execution state set — session not yet created
    const record = createTestRecord({ status: "running" });
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    const result = await execute(deps, { agent_id: "agent-1", message: "redirect" });
    expect(result.content[0].text).toContain("queued");
    expect(deps.queueSteer).toHaveBeenCalledWith("agent-1", "redirect");
    expect(deps.emitEvent).toHaveBeenCalledWith("subagents:steered", {
      id: "agent-1",
      message: "redirect",
    });
  });

  it("sends steer and emits event on success", async () => {
    const record = createTestRecord({ status: "running" });
    const fakeSession = toAgentSession(createMockSession());
    record.execution = { session: fakeSession, outputFile: undefined };
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    const result = await execute(deps, { agent_id: "agent-1", message: "change plan" });
    expect(deps.steerAgent).toHaveBeenCalledWith(fakeSession, "change plan");
    expect(deps.emitEvent).toHaveBeenCalledWith("subagents:steered", {
      id: "agent-1",
      message: "change plan",
    });
    expect(result.content[0].text).toContain("Steering message sent");
    expect(result.content[0].text).toContain("3 tool uses");
  });

  it("returns error message when steerAgent throws", async () => {
    const record = createTestRecord({ status: "running" });
    record.execution = { session: toAgentSession(createMockSession()), outputFile: undefined };
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    deps.steerAgent.mockRejectedValue(new Error("session closed"));
    const result = await execute(deps, { agent_id: "agent-1", message: "hi" });
    expect(result.content[0].text).toContain("Failed to steer agent");
    expect(result.content[0].text).toContain("session closed");
  });
});
