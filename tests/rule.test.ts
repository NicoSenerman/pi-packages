import { describe, expect, test } from "vitest";
import type { Rule, Ruleset } from "../src/rule";
import { evaluate, evaluateFirst } from "../src/rule";

describe("evaluate", () => {
  const allowBashGit: Rule = {
    surface: "bash",
    pattern: "git *",
    action: "allow",
  };
  const denyBashGitPush: Rule = {
    surface: "bash",
    pattern: "git push *",
    action: "deny",
  };
  const allowRead: Rule = { surface: "read", pattern: "*", action: "allow" };
  const askMcp: Rule = { surface: "mcp", pattern: "*", action: "ask" };
  const allowSkillLibrarian: Rule = {
    surface: "skill",
    pattern: "librarian",
    action: "allow",
  };
  const askSpecialExtDir: Rule = {
    surface: "special",
    pattern: "external_directory",
    action: "ask",
  };

  test("returns matching rule when a rule matches", () => {
    const ruleset: Ruleset = [allowBashGit];
    const result = evaluate("bash", "git status", ruleset);
    expect(result).toEqual(allowBashGit);
  });

  test("returns synthetic rule with 'ask' when no rules match and no defaultAction", () => {
    const result = evaluate("bash", "npm install", [allowBashGit]);
    expect(result.surface).toBe("bash");
    expect(result.pattern).toBe("npm install");
    expect(result.action).toBe("ask");
  });

  test("returns synthetic rule with custom defaultAction when no rules match", () => {
    const result = evaluate("bash", "npm install", [allowBashGit], "deny");
    expect(result.surface).toBe("bash");
    expect(result.pattern).toBe("npm install");
    expect(result.action).toBe("deny");
  });

  test("defaultAction does not affect matched rules", () => {
    const result = evaluate("bash", "git status", [allowBashGit], "deny");
    expect(result).toEqual(allowBashGit);
  });

  test("returns synthetic rule for empty ruleset", () => {
    const result = evaluate("mcp", "exa_search", []);
    expect(result.surface).toBe("mcp");
    expect(result.pattern).toBe("exa_search");
    expect(result.action).toBe("ask");
  });

  test("matches rules for all permission surfaces", () => {
    expect(evaluate("read", "src/foo.ts", [allowRead]).action).toBe("allow");
    expect(evaluate("mcp", "exa_search", [askMcp]).action).toBe("ask");
    expect(evaluate("skill", "librarian", [allowSkillLibrarian]).action).toBe(
      "allow",
    );
    expect(
      evaluate("special", "external_directory", [askSpecialExtDir]).action,
    ).toBe("ask");
  });

  test("last-match-wins: later conflicting rule overrides earlier", () => {
    const ruleset: Ruleset = [allowBashGit, denyBashGitPush];
    const result = evaluate("bash", "git push origin main", ruleset);
    expect(result).toEqual(denyBashGitPush);
  });

  test("last-match-wins: broad deny followed by specific allow", () => {
    const denyAll: Rule = { surface: "bash", pattern: "*", action: "deny" };
    const allowStatus: Rule = {
      surface: "bash",
      pattern: "git status",
      action: "allow",
    };
    const result = evaluate("bash", "git status", [denyAll, allowStatus]);
    expect(result).toEqual(allowStatus);
  });

  test("wildcard surface in rule matches any surface value", () => {
    const universalAllow: Rule = {
      surface: "*",
      pattern: "*",
      action: "allow",
    };
    expect(evaluate("bash", "anything", [universalAllow]).action).toBe("allow");
    expect(evaluate("mcp", "something", [universalAllow]).action).toBe("allow");
    expect(evaluate("skill", "librarian", [universalAllow]).action).toBe(
      "allow",
    );
  });

  test("specific surface rule does not match a different surface", () => {
    const ruleset: Ruleset = [allowBashGit];
    // bash rule should not match mcp surface
    const result = evaluate("mcp", "git status", ruleset);
    expect(result.action).toBe("ask"); // falls back to default
  });

  test("merged rulesets: rules from later scope take priority", () => {
    const globalRules: Ruleset = [
      { surface: "bash", pattern: "git *", action: "ask" },
    ];
    const agentRules: Ruleset = [
      { surface: "bash", pattern: "git *", action: "allow" },
    ];
    const merged = [...globalRules, ...agentRules];
    const result = evaluate("bash", "git status", merged);
    expect(result.action).toBe("allow"); // agent rule wins
  });

  test("merged rulesets: earlier scope used when later scope has no match", () => {
    const globalRules: Ruleset = [
      { surface: "bash", pattern: "git *", action: "allow" },
    ];
    const agentRules: Ruleset = [
      { surface: "bash", pattern: "npm *", action: "deny" },
    ];
    // git status matches global but not agent rule
    const merged = [...globalRules, ...agentRules];
    const result = evaluate("bash", "git status", merged);
    expect(result.action).toBe("allow"); // global rule is the last match for this pattern
  });

  test("empty ruleset returns synthetic default", () => {
    const result = evaluate("bash", "git status", []);
    expect(result.surface).toBe("bash");
    expect(result.pattern).toBe("git status");
    expect(result.action).toBe("ask");
  });

  test("rule.layer is ignored by evaluate() — matching is identical with or without it", () => {
    const withLayer: Rule = {
      surface: "bash",
      pattern: "git *",
      action: "allow",
      layer: "config",
    };
    const withoutLayer: Rule = {
      surface: "bash",
      pattern: "git *",
      action: "allow",
    };
    const withDefault: Rule = {
      surface: "bash",
      pattern: "*",
      action: "ask",
      layer: "default",
    };
    // Both rules with and without layer field produce the same match.
    expect(evaluate("bash", "git status", [withLayer]).action).toBe("allow");
    expect(evaluate("bash", "git status", [withoutLayer]).action).toBe("allow");
    // Layer metadata does not affect last-match-wins ordering.
    const ruleset: Rule[] = [withDefault, withLayer];
    expect(evaluate("bash", "git status", ruleset)).toEqual(withLayer);
    // A rule with layer: "default" still wins if it is last in the array.
    const reversedRuleset: Rule[] = [withLayer, withDefault];
    expect(evaluate("bash", "git status", reversedRuleset)).toEqual(
      withDefault,
    );
  });
});

describe("evaluateFirst", () => {
  const defaultRule: Rule = {
    surface: "*",
    pattern: "*",
    action: "ask",
    layer: "default",
  };
  const allowBash: Rule = {
    surface: "bash",
    pattern: "git *",
    action: "allow",
    layer: "config",
  };
  const denyMcp: Rule = {
    surface: "mcp",
    pattern: "exa_search",
    action: "deny",
    layer: "config",
  };

  test("returns the first candidate that matches a non-default rule", () => {
    const rules: Ruleset = [defaultRule, allowBash];
    const result = evaluateFirst("bash", ["git status", "*"], rules);
    expect(result.rule).toEqual(allowBash);
    expect(result.value).toBe("git status");
  });

  test("skips candidates that only match the default rule", () => {
    // "npm install" matches only the default; "*" also matches only the
    // default — falls back to first candidate.
    const rules: Ruleset = [defaultRule];
    const result = evaluateFirst("bash", ["npm install", "*"], rules);
    expect(result.rule.layer).toBe("default");
    expect(result.value).toBe("npm install");
  });

  test("falls back to first candidate when all candidates match only the default", () => {
    const rules: Ruleset = [defaultRule];
    const result = evaluateFirst("bash", ["a", "b", "c"], rules);
    expect(result.value).toBe("a");
  });

  test("stops at first non-default match, does not continue to remaining candidates", () => {
    // "exa_search" matches denyMcp (non-default). The loop stops there;
    // "mcp" is never evaluated even though it would match a different rule.
    const allowMcpCatchAll: Rule = {
      surface: "mcp",
      pattern: "mcp",
      action: "allow",
      layer: "config",
    };
    const rules: Ruleset = [defaultRule, denyMcp, allowMcpCatchAll];
    const result = evaluateFirst("mcp", ["exa_search", "mcp"], rules);
    expect(result.rule).toEqual(denyMcp);
    expect(result.value).toBe("exa_search");
  });

  test("skips candidates that match only the default and continues to next", () => {
    // "unknown_tool" matches only the universal default;
    // "exa_search" matches denyMcp (non-default) — that is the result.
    const rules: Ruleset = [defaultRule, denyMcp];
    const result = evaluateFirst("mcp", ["unknown_tool", "exa_search"], rules);
    expect(result.rule).toEqual(denyMcp);
    expect(result.value).toBe("exa_search");
  });

  test("single-candidate array behaves like evaluate()", () => {
    const rules: Ruleset = [defaultRule, allowBash];
    const result = evaluateFirst("bash", ["git status"], rules);
    expect(result.rule).toEqual(allowBash);
    expect(result.value).toBe("git status");
  });

  test("uses '*' as fallback value when values array is empty", () => {
    const rules: Ruleset = [defaultRule];
    const result = evaluateFirst("bash", [], rules);
    expect(result.value).toBe("*");
  });
});
