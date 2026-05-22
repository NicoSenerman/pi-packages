import { describe, expect, it } from "vitest";
import { buildTypeListText, formatLifetimeTokens, getModelLabelFromConfig, textResult } from "../../src/tools/helpers.js";

describe("textResult", () => {
  it("wraps a message in the tool result shape", () => {
    const result = textResult("hello");
    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: undefined,
    });
  });

  it("includes details when provided", () => {
    const details = { displayName: "Agent", status: "completed" };
    const result = textResult("done", details as any);
    expect(result.details).toBe(details);
  });
});

describe("formatLifetimeTokens", () => {
  it("returns formatted string when tokens > 0", () => {
    const result = formatLifetimeTokens({ lifetimeUsage: { input: 500, output: 500, cacheWrite: 0 } });
    expect(result).toBe("1.0k token");
  });

  it('returns "" when total is zero', () => {
    const result = formatLifetimeTokens({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } });
    expect(result).toBe("");
  });

  it("formats large token counts with k suffix", () => {
    const result = formatLifetimeTokens({ lifetimeUsage: { input: 15000, output: 18800, cacheWrite: 0 } });
    expect(result).toBe("33.8k token");
  });
});

describe("getModelLabelFromConfig", () => {
  it("strips provider prefix", () => {
    expect(getModelLabelFromConfig("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("strips trailing date suffix", () => {
    expect(getModelLabelFromConfig("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("strips both provider prefix and date suffix", () => {
    expect(getModelLabelFromConfig("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("returns the string as-is when no prefix or suffix", () => {
    expect(getModelLabelFromConfig("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("handles model with multiple slashes", () => {
    expect(getModelLabelFromConfig("provider/sub/model-name")).toBe("model-name");
  });
});

describe("buildTypeListText", () => {
  it("lists default agents with their descriptions", () => {
    const registry = {
      getDefaultAgentNames: () => ["general-purpose"],
      getUserAgentNames: () => [],
      resolveAgentConfig: () => ({ description: "General purpose agent", model: undefined }),
    };
    const result = buildTypeListText(registry as any, "/home/.pi");
    expect(result).toContain("- general-purpose: General purpose agent");
  });

  it("includes model suffix for default agents that have a model set", () => {
    const registry = {
      getDefaultAgentNames: () => ["Explore"],
      getUserAgentNames: () => [],
      resolveAgentConfig: () => ({ description: "Fast explorer", model: "anthropic/claude-haiku-4-5" }),
    };
    const result = buildTypeListText(registry as any, "/home/.pi");
    expect(result).toContain("- Explore: Fast explorer (claude-haiku-4-5)");
  });

  it("includes agentDir in the trailing hint line", () => {
    const registry = {
      getDefaultAgentNames: () => [],
      getUserAgentNames: () => [],
      resolveAgentConfig: () => ({ description: "", model: undefined }),
    };
    const result = buildTypeListText(registry as any, "/home/user/.pi");
    expect(result).toContain("/home/user/.pi");
  });

  it("adds Custom agents section when user agents are present", () => {
    const registry = {
      getDefaultAgentNames: () => ["general-purpose"],
      getUserAgentNames: () => ["my-agent"],
      resolveAgentConfig: (name: string) =>
        name === "general-purpose"
          ? { description: "General purpose", model: undefined }
          : { description: "My custom agent", model: undefined },
    };
    const result = buildTypeListText(registry as any, "/home/.pi");
    expect(result).toContain("Custom agents:");
    expect(result).toContain("- my-agent: My custom agent");
  });

  it("omits Custom agents section when no user agents exist", () => {
    const registry = {
      getDefaultAgentNames: () => ["general-purpose"],
      getUserAgentNames: () => [],
      resolveAgentConfig: () => ({ description: "General purpose", model: undefined }),
    };
    const result = buildTypeListText(registry as any, "/home/.pi");
    expect(result).not.toContain("Custom agents:");
  });
});
