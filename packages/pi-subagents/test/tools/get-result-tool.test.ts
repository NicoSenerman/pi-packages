import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { NotificationState } from "#src/notification-state";
import { createGetResultTool } from "#src/tools/get-result-tool";
import type { AgentRecord } from "#src/types";
import { createTestRecord } from "#test/helpers/make-record";
import { createMockSession, toAgentSession } from "#test/helpers/mock-session";
import { STUB_CTX } from "#test/helpers/stub-ctx";

const testRegistry = new AgentTypeRegistry(() => new Map());

function makeDeps(records: Map<string, AgentRecord> = new Map()) {
  return {
    getRecord: (id: string) => records.get(id),
    cancelNudge: vi.fn(),
    getConversation: vi.fn(),
    registry: testRegistry,
  };
}

async function execute(deps: ReturnType<typeof makeDeps>, params: { agent_id: string; wait?: boolean; verbose?: boolean }) {
  const tool = createGetResultTool(
    deps.getRecord,
    deps.cancelNudge,
    deps.getConversation,
    deps.registry,
  );
  return tool.execute("tc-1", params, new AbortController().signal, undefined, STUB_CTX);
}

describe("createGetResultTool", () => {
  it("returns tool definition with correct name", () => {
    const deps = makeDeps();
    const tool = createGetResultTool(deps.getRecord, deps.cancelNudge, deps.getConversation, deps.registry);
    expect(tool.name).toBe("get_subagent_result");
  });

  it("includes promptSnippet", () => {
    const deps = makeDeps();
    const tool = createGetResultTool(deps.getRecord, deps.cancelNudge, deps.getConversation, deps.registry);
    expect(tool.promptSnippet).toBe(
      "get_subagent_result: Check status and retrieve results from a background agent.",
    );
  });

  it("returns not-found message for unknown agent ID", async () => {
    const result = await execute(makeDeps(), { agent_id: "unknown" });
    expect(result.content[0].text).toContain("Agent not found");
  });

  it("returns status and result for completed agent", async () => {
    const records = new Map([["agent-1", createTestRecord()]]);
    const result = await execute(makeDeps(records), { agent_id: "agent-1" });
    const text = result.content[0].text;
    expect(text).toContain("Agent: agent-1");
    expect(text).toContain("completed");
    expect(text).toContain("All done.");
  });

  it("shows running message for in-progress agent", async () => {
    const records = new Map([["agent-1", createTestRecord({ status: "running", completedAt: undefined })]]);
    const result = await execute(makeDeps(records), { agent_id: "agent-1" });
    expect(result.content[0].text).toContain("still running");
  });

  it("shows error for failed agent", async () => {
    const records = new Map([["agent-1", createTestRecord({ status: "error", error: "timeout" })]]);
    const result = await execute(makeDeps(records), { agent_id: "agent-1" });
    expect(result.content[0].text).toContain("Error: timeout");
  });

  it("marks notification consumed and cancels nudge for completed agent", async () => {
    const record = createTestRecord();
    record.notification = new NotificationState("tc-1");
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    await execute(deps, { agent_id: "agent-1" });
    expect(record.notification.resultConsumed).toBe(true);
    expect(deps.cancelNudge).toHaveBeenCalledWith("agent-1");
  });

  it("still cancels nudge for completed agent without NotificationState", async () => {
    const record = createTestRecord();
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    await execute(deps, { agent_id: "agent-1" });
    expect(deps.cancelNudge).toHaveBeenCalledWith("agent-1");
  });

  it("does not cancel nudge for running agent", async () => {
    const record = createTestRecord({ status: "running", completedAt: undefined });
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    await execute(deps, { agent_id: "agent-1" });
    expect(deps.cancelNudge).not.toHaveBeenCalled();
  });

  it("waits for promise when wait=true and agent is running", async () => {
    const record = createTestRecord({
      status: "running",
      completedAt: undefined,
      promise: Promise.resolve().then(() => {
        record.markCompleted("Finished after wait.");
      }) as Promise<string>,
    });
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    const result = await execute(deps, { agent_id: "agent-1", wait: true });
    // After waiting, the record is completed and result is shown
    expect(result.content[0].text).toContain("Finished after wait.");
  });

  it("calls notification.markConsumed() when record has a NotificationState", async () => {
    const record = createTestRecord();
    record.notification = new NotificationState("tc-1");
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    await execute(deps, { agent_id: "agent-1" });
    expect(record.notification.resultConsumed).toBe(true);
  });

  it("includes conversation when verbose=true", async () => {
    const record = createTestRecord();
    record.execution = { session: toAgentSession(createMockSession()), outputFile: undefined };
    const records = new Map([["agent-1", record]]);
    const deps = makeDeps(records);
    deps.getConversation.mockReturnValue("User: hello\nAssistant: hi");
    const result = await execute(deps, { agent_id: "agent-1", verbose: true });
    expect(result.content[0].text).toContain("--- Agent Conversation ---");
    expect(result.content[0].text).toContain("User: hello");
  });
});
