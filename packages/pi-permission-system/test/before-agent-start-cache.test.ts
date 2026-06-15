import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createBeforeAgentStartPromptStateKey } from "#src/before-agent-start-cache";
import { createManager } from "#test/helpers/manager-harness";

test("Before-agent-start prompt cache invalidates on permission changes while runtime enforcement stays authoritative", () => {
  const { manager, globalConfigPath, cleanup } = createManager({
    permission: { "*": "allow", write: "deny" },
  });

  try {
    const baselineStamp = manager.getPolicyCacheStamp();
    const baselineKey = createBeforeAgentStartPromptStateKey({
      agentName: null,
      cwd: "C:/workspace/project",
      permissionStamp: baselineStamp,
      systemPrompt: "Available tools:\n- read\n- write",
      allowedToolNames: ["read"],
    });

    expect(manager.checkPermission("write", {}, undefined).state).toBe("deny");

    const updatedConfig = `${JSON.stringify(
      { permission: { "*": "allow", write: "allow" } },
      null,
      2,
    )}\n`;

    let updatedStamp = baselineStamp;
    for (
      let attempt = 0;
      attempt < 10 && updatedStamp === baselineStamp;
      attempt += 1
    ) {
      const waitUntil = Date.now() + 2;
      while (Date.now() < waitUntil) {
        // Wait for the filesystem timestamp granularity to advance.
      }

      writeFileSync(globalConfigPath, updatedConfig, "utf8");
      updatedStamp = manager.getPolicyCacheStamp();
    }

    expect(updatedStamp).not.toBe(baselineStamp);

    const invalidatedKey = createBeforeAgentStartPromptStateKey({
      agentName: null,
      cwd: "C:/workspace/project",
      permissionStamp: updatedStamp,
      systemPrompt: "Available tools:\n- read\n- write",
      allowedToolNames: ["read", "write"],
    });

    expect(invalidatedKey).not.toBe(baselineKey);
    expect(manager.checkPermission("write", {}, undefined).state).toBe("allow");
  } finally {
    cleanup();
  }
});
