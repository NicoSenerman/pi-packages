import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "vitest";

import {
  createActiveToolsCacheKey,
  createBeforeAgentStartPromptStateKey,
  shouldApplyCachedAgentStartState,
} from "../src/before-agent-start-cache";
import { getGlobalConfigPath } from "../src/config-paths";
import { DEFAULT_EXTENSION_CONFIG } from "../src/extension-config";
import piPermissionSystemExtension from "../src/index";
import { createPermissionSystemLogger } from "../src/logging";
import {
  createPermissionForwardingLocation,
  isForwardedPermissionRequestForSession,
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
} from "../src/permission-forwarding";
import { PermissionManager } from "../src/permission-manager";
import {
  findSkillPathMatch,
  parseAllSkillPromptSections,
  resolveSkillPromptEntries,
} from "../src/skill-prompt-sanitizer";
import { getPermissionSystemStatus } from "../src/status";
import { sanitizeAvailableToolsSection } from "../src/system-prompt-sanitizer";
import {
  checkRequestedToolRegistration,
  getToolNameFromValue,
} from "../src/tool-registry";
import type {
  PermissionCheckResult,
  PermissionState,
  ScopeConfig,
} from "../src/types";
import {
  canResolveAskPermissionRequest,
  shouldAutoApprovePermissionState,
} from "../src/yolo-mode";

type CreateManagerOptions = {
  mcpServerNames?: readonly string[];
};

function createManager(
  config: ScopeConfig,
  agentFiles: Record<string, string> = {},
  options: CreateManagerOptions = {},
) {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-test-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    globalConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  for (const [name, content] of Object.entries(agentFiles)) {
    writeFileSync(join(agentsDir, `${name}.md`), content, "utf8");
  }

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    mcpServerNames: options.mcpServerNames,
  });

  return {
    manager,
    globalConfigPath,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

type MockHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
) =>
  | Promise<Record<string, unknown> | undefined>
  | Record<string, unknown>
  | undefined;

type ExtensionHarness = {
  baseDir: string;
  cwd: string;
  handlers: Record<string, MockHandler>;
  prompts: string[];
  cleanup: () => Promise<void>;
};

type ExtensionHarnessOptions = {
  cwd?: string;
  hasUI?: boolean;
  selectResponse?: string;
  inputResponse?: string;
};

const INHERITED_SUBAGENT_ENV_KEYS = [
  ...SUBAGENT_ENV_HINT_KEYS,
  SUBAGENT_PARENT_SESSION_ENV_KEY,
] as const;

async function withIsolatedSubagentEnv<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const originalValues = new Map<string, string | undefined>();
  for (const key of INHERITED_SUBAGENT_ENV_KEYS) {
    originalValues.set(key, process.env[key]);
    delete process.env[key];
  }

  try {
    return await operation();
  } finally {
    for (const [key, value] of originalValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createToolCallHarness(
  config: ScopeConfig,
  toolNames: readonly string[],
  options: ExtensionHarnessOptions = {},
): ExtensionHarness {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-runtime-"));
  const cwd = options.cwd || baseDir;
  const prompts: string[] = [];
  const handlers: Record<string, MockHandler> = {};
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const globalConfigPath = getGlobalConfigPath(baseDir);
  mkdirSync(join(baseDir, "agents"), { recursive: true });
  mkdirSync(dirname(globalConfigPath), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    globalConfigPath,
    `${JSON.stringify({ ...DEFAULT_EXTENSION_CONFIG, ...config }, null, 2)}\n`,
    "utf8",
  );

  process.env.PI_CODING_AGENT_DIR = baseDir;
  try {
    piPermissionSystemExtension({
      on: (name: string, handler: MockHandler): void => {
        handlers[name] = handler;
      },
      registerCommand: (): void => {},
      getAllTools: (): Array<{ name: string }> =>
        toolNames.map((name) => ({ name })),
      setActiveTools: (): void => {},
      registerProvider: (): void => {},
      events: {
        emit: (): void => {},
        on: (): (() => void) => () => undefined,
      },
    } as never);
  } finally {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }

  return {
    baseDir,
    cwd,
    handlers,
    prompts,
    cleanup: async (): Promise<void> => {
      await Promise.resolve(
        handlers.session_shutdown?.(
          {},
          createMockContext(cwd, prompts, options),
        ),
      );
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function createMockContext(
  cwd: string,
  prompts: string[],
  options: ExtensionHarnessOptions = {},
): Record<string, unknown> {
  return {
    cwd,
    hasUI: options.hasUI === true,
    sessionManager: {
      getEntries: (): unknown[] => [],
      getSessionId: (): string => "test-session",
      getSessionDir: (): string => cwd,
    },
    ui: {
      notify: (): void => {},
      setStatus: (): void => {},
      select: async (title: string): Promise<string | undefined> => {
        prompts.push(title);
        return options.selectResponse ?? "Yes";
      },
      input: async (): Promise<string | undefined> => options.inputResponse,
    },
  };
}

async function runToolCall(
  harness: ExtensionHarness,
  event: Record<string, unknown>,
  options: ExtensionHarnessOptions = {},
): Promise<Record<string, unknown>> {
  const handler = harness.handlers.tool_call;
  assert.equal(typeof handler, "function");

  const result = await withIsolatedSubagentEnv(async () =>
    Promise.resolve(
      handler(event, createMockContext(harness.cwd, harness.prompts, options)),
    ),
  );
  return (result ?? {}) as Record<string, unknown>;
}

test("Yolo mode only auto-approves ask-state permissions", () => {
  assert.equal(
    shouldAutoApprovePermissionState("ask", DEFAULT_EXTENSION_CONFIG),
    false,
  );
  assert.equal(
    shouldAutoApprovePermissionState("ask", {
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoApprovePermissionState("deny", {
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    }),
    false,
  );
  assert.equal(
    shouldAutoApprovePermissionState("allow", {
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    }),
    false,
  );
});

test("Yolo mode resolves ask permissions without UI or delegation forwarding", () => {
  assert.equal(
    canResolveAskPermissionRequest({
      config: DEFAULT_EXTENSION_CONFIG,
      hasUI: false,
      isSubagent: false,
    }),
    false,
  );
  assert.equal(
    canResolveAskPermissionRequest({
      config: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      hasUI: false,
      isSubagent: false,
    }),
    true,
  );
  assert.equal(
    canResolveAskPermissionRequest({
      config: DEFAULT_EXTENSION_CONFIG,
      hasUI: false,
      isSubagent: true,
    }),
    true,
  );
});

test("Permission-system status is only exposed when yolo mode is enabled", () => {
  assert.equal(getPermissionSystemStatus(DEFAULT_EXTENSION_CONFIG), undefined);
  assert.equal(
    getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
    "yolo",
  );
});

test("System prompt sanitizer removes the Available tools section and surrounding boilerplate", () => {
  const prompt = [
    "Available tools:",
    "- read: Read file contents",
    "- mcp: Discover, inspect, and call MCP tools across configured servers",
    "",
    "In addition to the tools above, you may have access to other custom tools depending on the project.",
    "",
    "Guidelines:",
    "- Use mcp for MCP discovery first: search by capability, describe one exact tool name, then call it.",
    "- Be concise in your responses",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["read", "mcp"]);

  assert.equal(result.removed, true);
  assert.equal(result.prompt.includes("Available tools:"), false);
  assert.equal(result.prompt.includes("In addition to the tools above"), false);
  assert.match(result.prompt, /Guidelines:/);
  assert.match(result.prompt, /Use mcp for MCP discovery first/i);
});

test("System prompt sanitizer removes denied tool guidelines while keeping global guidance", () => {
  const prompt = [
    "Guidelines:",
    "- Use task when work SHOULD be delegated to one or more specialized agents instead of handled entirely in the current session.",
    "- Use mcp for MCP discovery first: search by capability, describe one exact tool name, then call it.",
    "- Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    "- Be concise in your responses",
    "- Show file paths clearly when working with files",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["bash", "grep", "mcp"]);

  assert.equal(result.removed, true);
  assert.equal(result.prompt.includes("Use task when work SHOULD"), false);
  assert.match(result.prompt, /Use mcp for MCP discovery first/i);
  assert.match(result.prompt, /Prefer grep\/find\/ls tools over bash/i);
  assert.match(result.prompt, /Be concise in your responses/);
  assert.match(
    result.prompt,
    /Show file paths clearly when working with files/,
  );
});

test("System prompt sanitizer removes inactive built-in write guidance", () => {
  const prompt = [
    "Guidelines:",
    "- Use write only for new files or complete rewrites",
    "- When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
    "- Be concise in your responses",
  ].join("\n");

  const result = sanitizeAvailableToolsSection(prompt, ["read"]);

  assert.equal(result.removed, true);
  assert.equal(
    result.prompt.includes("Use write only for new files or complete rewrites"),
    false,
  );
  assert.equal(
    result.prompt.includes("do NOT use cat or bash to display what you did"),
    false,
  );
  assert.match(result.prompt, /Be concise in your responses/);
});

test("Before-agent-start cache dedupes unchanged active-tool exposure and prompt state", () => {
  const allowedTools = ["read", "mcp"];
  const activeToolsKey = createActiveToolsCacheKey(allowedTools);
  const promptStateKey = createBeforeAgentStartPromptStateKey({
    agentName: "code",
    cwd: "C:/workspace/project",
    permissionStamp: "permissions-v1",
    systemPrompt: "Available tools:\n- read\n- mcp",
    allowedToolNames: allowedTools,
  });

  assert.equal(shouldApplyCachedAgentStartState(null, activeToolsKey), true);
  assert.equal(
    shouldApplyCachedAgentStartState(activeToolsKey, activeToolsKey),
    false,
  );
  assert.equal(shouldApplyCachedAgentStartState(null, promptStateKey), true);
  assert.equal(
    shouldApplyCachedAgentStartState(promptStateKey, promptStateKey),
    false,
  );
});

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

    assert.equal(
      shouldApplyCachedAgentStartState(baselineKey, baselineKey),
      false,
    );
    assert.equal(manager.checkPermission("write", {}, undefined).state, "deny");

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

    assert.notEqual(updatedStamp, baselineStamp);

    const invalidatedKey = createBeforeAgentStartPromptStateKey({
      agentName: null,
      cwd: "C:/workspace/project",
      permissionStamp: updatedStamp,
      systemPrompt: "Available tools:\n- read\n- write",
      allowedToolNames: ["read", "write"],
    });

    assert.equal(
      shouldApplyCachedAgentStartState(baselineKey, invalidatedKey),
      true,
    );
    assert.equal(
      manager.checkPermission("write", {}, undefined).state,
      "allow",
    );
  } finally {
    cleanup();
  }
});

test("Permission-system logger respects debug toggle and keeps review log enabled by default", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-logs-"));
  const logsDir = join(baseDir, "logs");
  const debugLogPath = join(logsDir, "debug.jsonl");
  const reviewLogPath = join(logsDir, "review.jsonl");
  const config = { ...DEFAULT_EXTENSION_CONFIG };
  const logger = createPermissionSystemLogger({
    getConfig: () => config,
    debugLogPath,
    reviewLogPath,
    ensureLogsDirectory: () => {
      mkdirSync(logsDir, { recursive: true });
      return undefined;
    },
  });

  try {
    const initialDebugWarning = logger.debug("debug.disabled", {
      sample: true,
    });
    const reviewWarning = logger.review("permission_request.waiting", {
      toolName: "write",
    });

    assert.equal(initialDebugWarning, undefined);
    assert.equal(reviewWarning, undefined);
    assert.equal(existsSync(debugLogPath), false);
    assert.equal(existsSync(reviewLogPath), true);

    config.debugLog = true;
    const enabledDebugWarning = logger.debug("debug.enabled", { sample: true });
    assert.equal(enabledDebugWarning, undefined);
    assert.equal(existsSync(debugLogPath), true);
    assert.match(readFileSync(debugLogPath, "utf8"), /debug\.enabled/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PermissionManager canonical built-in permission checking", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "deny", read: "allow" },
  });

  try {
    const readResult = manager.checkPermission("read", {});
    assert.equal(readResult.state, "allow");
    assert.equal(readResult.source, "tool");

    const writeResult = manager.checkPermission("write", {});
    assert.equal(writeResult.state, "deny");
    assert.equal(writeResult.source, "tool");
  } finally {
    cleanup();
  }
});

test("multiline bash command resolves to allow via universal fallback", () => {
  // Regression test for #73: node -e "..." with embedded newlines was
  // falling through to the hard-coded 'ask' default because wildcardMatch
  // used /^.*$/ (no dotAll), which does not match '\n'.
  const { manager, cleanup } = createManager({
    permission: {
      "*": "allow",
      bash: { "rm -rf *": "deny", "sudo *": "ask" },
    },
  });

  try {
    const command =
      "node -e \"\nimport('x').then(() => {\n  console.log('done');\n});\n\"";
    const result = manager.checkPermission("bash", { command });
    assert.equal(result.state, "allow");
  } finally {
    cleanup();
  }
});

test("Bash specific deny patterns override catch-all within the same config", () => {
  // In the flat format, patterns within a surface map are ordered by insertion.
  // Last-match-wins means specific patterns placed AFTER the catch-all override it.
  const { manager, cleanup } = createManager({
    permission: {
      "*": "ask",
      bash: { "*": "allow", "rm -rf *": "deny" },
    },
  });

  try {
    const denied = manager.checkPermission("bash", { command: "rm -rf build" });
    assert.equal(denied.state, "deny");
    assert.equal(denied.source, "bash");
    assert.equal(denied.matchedPattern, "rm -rf *");

    const allowed = manager.checkPermission("bash", { command: "echo hello" });
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.source, "bash");
    assert.equal(allowed.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

test("MCP wildcard matching uses the registered mcp tool", () => {
  const { manager, cleanup } = createManager({
    permission: {
      "*": "ask",
      mcp: { "*": "deny", "research_*": "ask", "research_query-*": "allow" },
    },
  });

  try {
    const queryDocs = manager.checkPermission("mcp", {
      tool: "research:query-docs",
    });
    assert.equal(queryDocs.state, "allow");
    assert.equal(queryDocs.source, "mcp");
    assert.equal(queryDocs.matchedPattern, "research_query-*");
    assert.equal(queryDocs.target, "research_query-docs");

    const resolve2 = manager.checkPermission("mcp", {
      tool: "research:resolve-context",
    });
    assert.equal(resolve2.state, "ask");
    assert.equal(resolve2.matchedPattern, "research_*");
    assert.equal(resolve2.target, "research_resolve-context");

    const unknown = manager.checkPermission("mcp", { tool: "search:provider" });
    assert.equal(unknown.state, "deny");
    assert.equal(unknown.matchedPattern, "*");
    assert.equal(unknown.target, "search_provider");
  } finally {
    cleanup();
  }
});

test("Arbitrary extension tools use exact-name tool permissions instead of MCP fallback", () => {
  const { manager, cleanup } = createManager({
    permission: {
      "*": "deny",
      third_party_tool: "allow",
      mcp: { "*": "deny" },
    },
  });

  try {
    const allowed = manager.checkPermission("third_party_tool", {});
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.source, "tool");

    // another_extension_tool has no explicit rule — falls through to the
    // universal default (permission["*"] = "deny") with source "default".
    const fallback = manager.checkPermission("another_extension_tool", {});
    assert.equal(fallback.state, "deny");
    assert.equal(fallback.source, "default");
  } finally {
    cleanup();
  }
});

test("Skill permission matching", () => {
  const { manager, cleanup } = createManager({
    permission: {
      "*": "ask",
      skill: {
        "*": "ask",
        "web-*": "deny",
        "requesting-code-review": "allow",
      },
    },
  });

  try {
    const allowed = manager.checkPermission("skill", {
      name: "requesting-code-review",
    });
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "requesting-code-review");
    assert.equal(allowed.source, "skill");

    const denied = manager.checkPermission("skill", {
      name: "web-design-guidelines",
    });
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "web-*");

    const fallback = manager.checkPermission("skill", {
      name: "unknown-skill",
    });
    assert.equal(fallback.state, "ask");
    assert.equal(fallback.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

test("MCP proxy tool infers server-prefixed aliases from configured server names", () => {
  const { manager, cleanup } = createManager(
    {
      permission: {
        "*": "ask",
        mcp: { "exa_*": "deny", exa_get_code_context_exa: "allow" },
      },
    },
    {},
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission("mcp", {
      tool: "get_code_context_exa",
    });
    assert.equal(result.state, "allow");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_get_code_context_exa");
    assert.equal(result.target, "exa_get_code_context_exa");
  } finally {
    cleanup();
  }
});

test("MCP server names in settings.json are not used — only mcp.json is consulted", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-test-"));
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const mcpConfigPath = join(baseDir, "mcp.json");
  const settingsJsonPath = join(baseDir, "settings.json");
  const agentsDir = join(baseDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  const config: ScopeConfig = {
    permission: { "*": "ask", mcp: { "legacy-server_*": "allow" } },
  };

  writeFileSync(
    globalConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }), "utf8");
  writeFileSync(
    settingsJsonPath,
    JSON.stringify({ mcpServers: { "legacy-server": {} } }),
    "utf8",
  );

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    globalMcpConfigPath: mcpConfigPath,
  });

  try {
    const result = manager.checkPermission("mcp", {
      tool: "some_tool_legacy-server",
    });
    assert.equal(result.state, "ask");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("MCP describe mode normalizes qualified tool names without duplicating server prefixes", () => {
  const { manager, cleanup } = createManager(
    {
      permission: {
        "*": "ask",
        mcp: { "exa_*": "deny", exa_web_search_exa: "allow" },
      },
    },
    {},
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission("mcp", {
      describe: "exa:web_search_exa",
      server: "exa",
    });
    assert.equal(result.state, "allow");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_web_search_exa");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

test("Canonical tools map directly without legacy aliases", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "ask", find: "allow", ls: "deny" },
  });

  try {
    const findResult = manager.checkPermission("find", {});
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    const lsResult = manager.checkPermission("ls", {});
    assert.equal(lsResult.state, "deny");
    assert.equal(lsResult.source, "tool");
  } finally {
    cleanup();
  }
});

test("mcp catch-all acts as fallback for unmatched MCP targets", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "ask" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  mcp: allow
---
`,
    },
  );

  try {
    const result = manager.checkPermission(
      "mcp",
      { tool: "exa:web_search_exa" },
      "reviewer",
    );
    assert.equal(result.state, "allow");
    assert.equal(result.source, "mcp");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

test("specific MCP rules override mcp catch-all", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "ask" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  mcp:
    "*": allow
    exa_web_search_exa: deny
---
`,
    },
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const result = manager.checkPermission(
      "mcp",
      { tool: "web_search_exa" },
      "reviewer",
    );
    assert.equal(result.state, "deny");
    assert.equal(result.source, "mcp");
    assert.equal(result.matchedPattern, "exa_web_search_exa");
    assert.equal(result.target, "exa_web_search_exa");
  } finally {
    cleanup();
  }
});

test("specific MCP rules still win when mcp catch-all is deny", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "ask" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  mcp:
    "*": deny
    exa_web_search_exa: allow
---
`,
    },
    {
      mcpServerNames: ["exa"],
    },
  );

  try {
    const allowed = manager.checkPermission(
      "mcp",
      { tool: "web_search_exa" },
      "reviewer",
    );
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.source, "mcp");
    assert.equal(allowed.matchedPattern, "exa_web_search_exa");
    assert.equal(allowed.target, "exa_web_search_exa");

    const fallback = manager.checkPermission(
      "mcp",
      { tool: "other_exa" },
      "reviewer",
    );
    assert.equal(fallback.state, "deny");
    assert.equal(fallback.source, "mcp");
    assert.equal(fallback.target, "exa_other_exa");
  } finally {
    cleanup();
  }
});

test("mcp catch-all in agent frontmatter overrides global default", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "deny" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  mcp: allow
---
`,
    },
  );

  try {
    const readResult = manager.checkPermission("read", {}, "reviewer");
    assert.equal(readResult.state, "deny");
    assert.equal(readResult.source, "tool");

    const mcpResult = manager.checkPermission(
      "mcp",
      { tool: "exa:web_search_exa" },
      "reviewer",
    );
    assert.equal(mcpResult.state, "allow");
    assert.equal(mcpResult.source, "mcp");
  } finally {
    cleanup();
  }
});

test("Agent frontmatter canonical tools resolve correctly", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "deny" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  find: allow
  ls: deny
---
`,
    },
  );

  try {
    const findResult = manager.checkPermission("find", {}, "reviewer");
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    const lsResult = manager.checkPermission("ls", {}, "reviewer");
    assert.equal(lsResult.state, "deny");
    assert.equal(lsResult.source, "tool");
  } finally {
    cleanup();
  }
});

test("All surface names work in agent frontmatter flat permission format", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "deny" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  find: allow
  task: allow
  mcp: allow
---
`,
    },
  );

  try {
    const findResult = manager.checkPermission("find", {}, "reviewer");
    assert.equal(findResult.state, "allow");
    assert.equal(findResult.source, "tool");

    // In flat format any surface key works, including extension tools
    const taskResult = manager.checkPermission("task", {}, "reviewer");
    assert.equal(taskResult.state, "allow");
    assert.equal(taskResult.source, "tool");

    // mcp: allow catches all MCP targets
    const mcpResult = manager.checkPermission(
      "mcp",
      { tool: "exa:web_search_exa" },
      "reviewer",
    );
    assert.equal(mcpResult.state, "allow");
  } finally {
    cleanup();
  }
});

test("task uses exact-name tool permissions like any registered extension tool", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "deny", task: "allow" },
  });

  try {
    const taskResult = manager.checkPermission("task", {});
    assert.equal(taskResult.state, "allow");
    assert.equal(taskResult.source, "tool");
  } finally {
    cleanup();
  }
});

test("Tool registry resolves event tool names from string and object payloads", () => {
  assert.equal(getToolNameFromValue("  read  "), "read");
  assert.equal(getToolNameFromValue({ toolName: "write" }), "write");
  assert.equal(getToolNameFromValue({ name: "find" }), "find");
  assert.equal(getToolNameFromValue({ tool: "grep" }), "grep");
  assert.equal(getToolNameFromValue({}), null);
});

test("Tool registry blocks unregistered tools and handles aliases", () => {
  const registeredTools = [
    { toolName: "mcp" },
    { toolName: "read" },
    { toolName: "bash" },
  ];

  const unknownCheck = checkRequestedToolRegistration(
    "third_party_tool",
    registeredTools,
  );
  assert.equal(unknownCheck.status, "unregistered");
  if (unknownCheck.status === "unregistered") {
    assert.deepEqual(unknownCheck.availableToolNames, ["bash", "mcp", "read"]);
  }

  const aliasCheck = checkRequestedToolRegistration(
    "legacy_read",
    registeredTools,
    { legacy_read: "read" },
  );
  assert.equal(aliasCheck.status, "registered");

  const missingNameCheck = checkRequestedToolRegistration(
    "   ",
    registeredTools,
  );
  assert.equal(missingNameCheck.status, "missing-tool-name");
});

test("getToolPermission returns tool-level policy for canonical and extension tools", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "ask" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  bash: deny
  read: deny
  task: allow
---
`,
    },
  );

  try {
    const bashPermission = manager.getToolPermission("bash", "reviewer");
    assert.equal(bashPermission, "deny");

    const taskPermission = manager.getToolPermission("task", "reviewer");
    assert.equal(taskPermission, "allow");

    const readPermission = manager.getToolPermission("read", "reviewer");
    assert.equal(readPermission, "deny");

    const defaultBashPermission = manager.getToolPermission("bash");
    assert.equal(defaultBashPermission, "ask");

    const { manager: manager2, cleanup: cleanup2 } = createManager({
      permission: { "*": "deny", bash: "allow" },
    });

    try {
      const globalBashPermission = manager2.getToolPermission("bash");
      assert.equal(globalBashPermission, "allow");
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});

test("getToolPermission supports arbitrary extension tool names", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "deny", third_party_tool: "allow" },
  });

  try {
    const explicitPermission = manager.getToolPermission("third_party_tool");
    assert.equal(explicitPermission, "allow");

    const fallbackPermission = manager.getToolPermission(
      "missing_extension_tool",
    );
    assert.equal(fallbackPermission, "deny");
  } finally {
    cleanup();
  }
});

test("Yolo mode bypasses delegated ask routing when no parent forwarding target is available", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {},
  });

  assert.equal(targetSessionId, null);
  assert.equal(
    canResolveAskPermissionRequest({
      config: { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true },
      hasUI: false,
      isSubagent: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoApprovePermissionState("ask", {
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    }),
    true,
  );
});

test("Permission forwarding resolves the parent interactive session from subagent runtime env", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {
      PI_AGENT_ROUTER_PARENT_SESSION_ID: "parent-session",
    },
  });

  assert.equal(targetSessionId, "parent-session");
});

test("Permission forwarding does not guess a target session when subagent runtime env is missing", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: false,
    isSubagent: true,
    currentSessionId: "child-session",
    env: {},
  });

  assert.equal(targetSessionId, null);
});

test("Permission forwarding uses session-scoped directories per interactive session", () => {
  const forwardingRoot = join(tmpdir(), "pi-permission-system-forwarding-root");
  const sessionA = createPermissionForwardingLocation(
    forwardingRoot,
    "session-a",
  );
  const sessionB = createPermissionForwardingLocation(
    forwardingRoot,
    "session-b",
  );

  assert.notEqual(sessionA.sessionRootDir, sessionB.sessionRootDir);
  assert.notEqual(sessionA.requestsDir, sessionB.requestsDir);
  assert.notEqual(sessionA.responsesDir, sessionB.responsesDir);
});

test("Permission forwarding request routing only matches the intended UI session", () => {
  assert.equal(
    isForwardedPermissionRequestForSession(
      { targetSessionId: "session-a" },
      "session-a",
    ),
    true,
  );
  assert.equal(
    isForwardedPermissionRequestForSession(
      { targetSessionId: "session-a" },
      "session-b",
    ),
    false,
  );
});

test("Permission forwarding rejects unresolved sentinel session ids", () => {
  const targetSessionId = resolvePermissionForwardingTargetSessionId({
    hasUI: true,
    isSubagent: false,
    currentSessionId: "unknown",
  });

  assert.equal(targetSessionId, null);
});

// ---------------------------------------------------------------------------
// Project-level and per-agent config scope tests
// ---------------------------------------------------------------------------

type CreateManagerWithProjectOptions = CreateManagerOptions & {
  projectConfig?: ScopeConfig;
  projectAgentFiles?: Record<string, string>;
};

function createManagerWithProject(
  config: ScopeConfig,
  agentFiles: Record<string, string> = {},
  options: CreateManagerWithProjectOptions = {},
) {
  const baseDir = mkdtempSync(
    join(tmpdir(), "pi-permission-system-proj-test-"),
  );
  const globalConfigPath = join(baseDir, "pi-permissions.jsonc");
  const agentsDir = join(baseDir, "agents");
  const projectRoot = join(baseDir, "project");
  const projectGlobalConfigPath = join(projectRoot, "pi-permissions.jsonc");
  const projectAgentsDir = join(projectRoot, "agents");

  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(projectAgentsDir, { recursive: true });

  writeFileSync(
    globalConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  if (options.projectConfig) {
    writeFileSync(
      projectGlobalConfigPath,
      `${JSON.stringify(options.projectConfig, null, 2)}\n`,
      "utf8",
    );
  }

  for (const [name, content] of Object.entries(agentFiles)) {
    writeFileSync(join(agentsDir, `${name}.md`), content, "utf8");
  }

  for (const [name, content] of Object.entries(
    options.projectAgentFiles ?? {},
  )) {
    writeFileSync(join(projectAgentsDir, `${name}.md`), content, "utf8");
  }

  const manager = new PermissionManager({
    globalConfigPath,
    agentsDir,
    projectGlobalConfigPath,
    projectAgentsDir,
    mcpServerNames: options.mcpServerNames,
  });

  return {
    manager,
    cleanup: (): void => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

test("Project-level config overrides base bash patterns", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      permission: {
        "*": "allow",
        bash: { "*": "ask", "rm -rf *": "deny" },
      },
    },
    {},
    {
      projectConfig: {
        permission: { bash: { "rm -rf build": "allow" } },
      },
    },
  );

  try {
    const allowed = manager.checkPermission("bash", {
      command: "rm -rf build",
    });
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "rm -rf build");

    const denied = manager.checkPermission("bash", {
      command: "rm -rf node_modules",
    });
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "rm -rf *");
  } finally {
    cleanup();
  }
});

test("System-agent config overrides project-level bash patterns", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      permission: { "*": "allow", bash: "ask" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  bash:
    "git log *": allow
---
`,
    },
    {
      projectConfig: {
        permission: { bash: { "git *": "deny" } },
      },
    },
  );

  try {
    const allowed = manager.checkPermission(
      "bash",
      { command: "git log --oneline" },
      "reviewer",
    );
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "git log *");

    const denied = manager.checkPermission(
      "bash",
      { command: "git status" },
      "reviewer",
    );
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "git *");
  } finally {
    cleanup();
  }
});

test("Project-agent config overrides system-agent tool rules", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      permission: { "*": "ask" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  read: deny
---
`,
    },
    {
      projectAgentFiles: {
        reviewer: `---
name: reviewer
permission:
  read: allow
---
`,
      },
    },
  );

  try {
    const result = manager.checkPermission("read", {}, "reviewer");
    assert.equal(result.state, "allow");
    assert.equal(result.source, "tool");
  } finally {
    cleanup();
  }
});

test("Full precedence chain base < project < system-agent < project-agent for universal default", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      permission: { "*": "deny" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  "*": ask
---
`,
    },
    {
      projectConfig: {
        permission: { "*": "allow" },
      },
      projectAgentFiles: {
        reviewer: `---
name: reviewer
permission:
  "*": deny
---
`,
      },
    },
  );

  try {
    const reviewerResult = manager.checkPermission(
      "custom_extension_tool",
      {},
      "reviewer",
    );
    assert.equal(reviewerResult.state, "deny");
    assert.equal(reviewerResult.source, "default");

    const globalResult = manager.checkPermission("custom_extension_tool", {});
    assert.equal(globalResult.state, "allow");
    assert.equal(globalResult.source, "default");
  } finally {
    cleanup();
  }
});

test("Project-agent applies even without a matching system-agent file", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      permission: { "*": "allow" },
    },
    {},
    {
      projectAgentFiles: {
        reviewer: `---
name: reviewer
permission:
  read: deny
---
`,
      },
    },
  );

  try {
    const agentResult = manager.checkPermission("read", {}, "reviewer");
    assert.equal(agentResult.state, "deny");
    assert.equal(agentResult.source, "tool");

    const globalResult = manager.checkPermission("read", {});
    assert.equal(globalResult.state, "allow");
    assert.equal(globalResult.source, "tool");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// PI_CODING_AGENT_DIR support
// ---------------------------------------------------------------------------

test("PermissionManager reads config from PI_CODING_AGENT_DIR when set", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-envdir-"));
  const agentsDir = join(baseDir, "agents");
  const newConfigPath = getGlobalConfigPath(baseDir);
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(dirname(newConfigPath), { recursive: true });

  const config: ScopeConfig = {
    permission: { "*": "deny", read: "allow" },
  };
  writeFileSync(newConfigPath, JSON.stringify(config), "utf8");

  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = baseDir;
  try {
    const manager = new PermissionManager();
    const result = manager.checkPermission("read", {});
    assert.equal(result.state, "allow");

    const result2 = manager.checkPermission("write", {});
    assert.equal(result2.state, "deny");
  } finally {
    if (original !== undefined) {
      process.env.PI_CODING_AGENT_DIR = original;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Skill prompt sanitization - multi-block regression tests
// ---------------------------------------------------------------------------

test("parseAllSkillPromptSections finds every available_skills block", () => {
  const prompt = [
    "Some preamble",
    "<available_skills>",
    "  <skill>",
    "    <name>skill-one</name>",
    "    <description>First skill</description>",
    "    <location>/path/to/one</location>",
    "  </skill>",
    "</available_skills>",
    "Some content between",
    "<available_skills>",
    "  <skill>",
    "    <name>skill-two</name>",
    "    <description>Second skill</description>",
    "    <location>/path/to/two</location>",
    "  </skill>",
    "</available_skills>",
    "Footer",
  ].join("\n");

  const sections = parseAllSkillPromptSections(prompt);

  assert.equal(sections.length, 2);
  assert.equal(sections[0].entries[0]?.name, "skill-one");
  assert.equal(sections[1].entries[0]?.name, "skill-two");
});

test("REGRESSION: resolveSkillPromptEntries sanitizes every available_skills block", () => {
  const { manager, cleanup } = createManager({
    permission: {
      "*": "ask",
      skill: { "denied-skill": "deny" },
    },
  });

  try {
    const prompt = [
      "System prompt start",
      "<available_skills>",
      "  <skill>",
      "    <name>visible-skill</name>",
      "    <description>Allowed skill</description>",
      "    <location>/skills/visible/index.ts</location>",
      "  </skill>",
      "  <skill>",
      "    <name>denied-skill</name>",
      "    <description>Denied in first block</description>",
      "    <location>/skills/blocked/one.ts</location>",
      "  </skill>",
      "</available_skills>",
      "Agent identity section",
      "<available_skills>",
      "  <skill>",
      "    <name>denied-skill</name>",
      "    <description>Denied in second block</description>",
      "    <location>/skills/blocked/two.ts</location>",
      "  </skill>",
      "</available_skills>",
      "System prompt end",
    ].join("\n");

    const result = resolveSkillPromptEntries(prompt, manager, null, "/cwd");

    assert.equal(
      result.prompt.includes("denied-skill"),
      false,
      "Denied skill should be removed from every block",
    );
    assert.equal(
      result.prompt.includes("visible-skill"),
      true,
      "Visible skill should remain in the prompt",
    );
    assert.equal(
      (result.prompt.match(/<available_skills>/g) || []).length,
      1,
      "Fully denied blocks should be removed",
    );
    assert.deepEqual(
      result.entries.map((entry) => entry.name),
      ["visible-skill"],
      "Tracked skill entries should exclude denied skills",
    );
  } finally {
    cleanup();
  }
});

test("REGRESSION: resolveSkillPromptEntries keeps only visible skills available for path matching", () => {
  const { manager, cleanup } = createManager({
    permission: {
      "*": "ask",
      skill: { "blocked-skill": "deny" },
    },
  });

  try {
    const prompt = [
      "System prompt start",
      "<available_skills>",
      "  <skill>",
      "    <name>blocked-skill</name>",
      "    <description>Blocked skill</description>",
      "    <location>@./skills/blocked/entry.ts</location>",
      "  </skill>",
      "</available_skills>",
      "Middle section",
      "<available_skills>",
      "  <skill>",
      "    <name>visible-skill</name>",
      "    <description>Visible skill</description>",
      "    <location>@./skills/visible/entry.ts</location>",
      "  </skill>",
      "</available_skills>",
      "System prompt end",
    ].join("\n");

    const result = resolveSkillPromptEntries(prompt, manager, null, "/cwd");
    const visiblePath = resolve("/cwd", "./skills/visible/file.ts");
    const blockedPath = resolve("/cwd", "./skills/blocked/file.ts");
    const matchedVisibleSkill = findSkillPathMatch(
      process.platform === "win32" ? visiblePath.toLowerCase() : visiblePath,
      result.entries,
    );
    const matchedBlockedSkill = findSkillPathMatch(
      process.platform === "win32" ? blockedPath.toLowerCase() : blockedPath,
      result.entries,
    );

    assert.equal(matchedVisibleSkill?.name, "visible-skill");
    assert.equal(
      matchedBlockedSkill,
      null,
      "Denied skills should not remain in tracked entries",
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// external_directory special permission
// ---------------------------------------------------------------------------

test("external_directory permission falls back to universal default when not explicitly configured", () => {
  // Empty permission: everything defaults to "ask" (least privilege).
  const { manager, cleanup } = createManager({ permission: {} });

  try {
    const result = manager.checkPermission("external_directory", {});
    assert.equal(result.state, "ask");
    assert.equal(result.source, "special");
    assert.equal(result.matchedPattern, undefined);
  } finally {
    cleanup();
  }
});

test("external_directory permission respects explicit deny", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "allow", external_directory: "deny" },
  });

  try {
    const result = manager.checkPermission("external_directory", {});
    assert.equal(result.state, "deny");
    assert.equal(result.source, "special");
    assert.equal(result.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

test("external_directory permission can be explicitly allowed", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "allow", external_directory: "allow" },
  });

  try {
    const result = manager.checkPermission("external_directory", {});
    assert.equal(result.state, "allow");
    assert.equal(result.source, "special");
    assert.equal(result.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

test("external_directory permission respects per-agent override", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "allow", external_directory: "deny" },
    },
    {
      trusted: `---
name: trusted
permission:
  external_directory: allow
---
`,
    },
  );

  try {
    // Global policy denies external_directory
    const globalResult = manager.checkPermission("external_directory", {});
    assert.equal(globalResult.state, "deny");

    // Trusted agent overrides to allow
    const agentResult = manager.checkPermission(
      "external_directory",
      {},
      "trusted",
    );
    assert.equal(agentResult.state, "allow");
    assert.equal(agentResult.source, "special");
  } finally {
    cleanup();
  }
});

test("external_directory permission is not affected by unrelated surface keys", () => {
  // Flat format: unknown surface keys are just rules for that surface.
  // external_directory resolves from its own rule, not from unrelated keys.
  const { manager, cleanup } = createManager({
    permission: { "*": "allow", external_directory: "allow" },
  });

  try {
    // external_directory still resolves from its own entry
    const extResult = manager.checkPermission("external_directory", {});
    assert.equal(extResult.state, "allow");
    assert.equal(extResult.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

test("skill pattern map in agent frontmatter overrides global skill policy", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "deny", skill: "deny" },
    },
    {
      reviewer: `---
name: reviewer
permission:
  skill:
    "*": ask
    "pi-*": allow
---
`,
    },
  );

  try {
    // Matches agent frontmatter pi-* pattern
    const allowed = manager.checkPermission(
      "skill",
      { name: "pi-code-review" },
      "reviewer",
    );
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "pi-*");
    assert.equal(allowed.source, "skill");

    // Falls through to agent frontmatter catch-all
    const asked = manager.checkPermission(
      "skill",
      { name: "other-skill" },
      "reviewer",
    );
    assert.equal(asked.state, "ask");
    assert.equal(asked.matchedPattern, "*");

    // No agent override — global deny applies
    const denied = manager.checkPermission("skill", { name: "pi-code-review" });
    assert.equal(denied.state, "deny");
    assert.equal(denied.source, "skill");
  } finally {
    cleanup();
  }
});

test("external_directory pattern map in agent frontmatter overrides global policy", () => {
  const { manager, cleanup } = createManager(
    {
      permission: { "*": "allow", external_directory: "deny" },
    },
    {
      trusted: `---
name: trusted
permission:
  external_directory:
    "*": deny
    "~/Downloads/*": allow
---
`,
    },
  );

  try {
    // Matches agent frontmatter ~/Downloads/* pattern
    const allowed = manager.checkPermission(
      "external_directory",
      { path: `${homedir()}/Downloads/file.txt` },
      "trusted",
    );
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "~/Downloads/*");
    assert.equal(allowed.source, "special");

    // Falls through to agent frontmatter catch-all deny
    const denied = manager.checkPermission(
      "external_directory",
      { path: `${homedir()}/Documents/secret.txt` },
      "trusted",
    );
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "*");

    // No agent override — global deny applies
    const globalDenied = manager.checkPermission("external_directory", {});
    assert.equal(globalDenied.state, "deny");
    assert.equal(globalDenied.source, "special");
  } finally {
    cleanup();
  }
});

test("project-agent frontmatter skill rules override global-agent frontmatter skill rules", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      permission: { "*": "deny" },
    },
    {
      analyst: `---
name: analyst
permission:
  skill:
    "*": ask
---
`,
    },
    {
      projectAgentFiles: {
        analyst: `---
name: analyst
permission:
  skill:
    "pi-*": allow
    "*": deny
---
`,
      },
    },
  );

  try {
    // Project-agent pi-* wins over global-agent *: ask
    const allowed = manager.checkPermission(
      "skill",
      { name: "pi-code-review" },
      "analyst",
    );
    assert.equal(allowed.state, "allow");
    assert.equal(allowed.matchedPattern, "pi-*");

    // Project-agent *: deny wins over global-agent *: ask
    const denied = manager.checkPermission(
      "skill",
      { name: "other-skill" },
      "analyst",
    );
    assert.equal(denied.state, "deny");
    assert.equal(denied.matchedPattern, "*");
  } finally {
    cleanup();
  }
});

test("project-agent frontmatter external_directory rules override global-agent frontmatter rules", () => {
  const { manager, cleanup } = createManagerWithProject(
    {
      permission: { "*": "allow", external_directory: "deny" },
    },
    {
      analyst: `---
name: analyst
permission:
  external_directory: ask
---
`,
    },
    {
      projectAgentFiles: {
        analyst: `---
name: analyst
permission:
  external_directory: allow
---
`,
      },
    },
  );

  try {
    // Project-agent allow wins over global-agent ask
    const result = manager.checkPermission("external_directory", {}, "analyst");
    assert.equal(result.state, "allow");
    assert.equal(result.source, "special");

    // Without agent context, global config deny applies
    const globalResult = manager.checkPermission("external_directory", {});
    assert.equal(globalResult.state, "deny");
  } finally {
    cleanup();
  }
});

test("tool_call blocks path-bearing tools outside cwd when external_directory is denied", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-permission-system-boundary-"));
  const cwd = join(rootDir, "repo");
  const siblingPath = join(rootDir, "repo-sibling", "secret.txt");
  mkdirSync(join(rootDir, "repo-sibling"), { recursive: true });

  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "deny" },
    },
    ["read"],
    { cwd },
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "external-deny",
      input: { path: siblingPath },
    });

    assert.equal(result.block, true);
    assert.match(
      String(result.reason),
      /external directory permission denial/i,
    );
    assert.match(String(result.reason), /repo-sibling/);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("tool_call allows path-bearing tools inside cwd without external_directory prompt", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "deny" },
    },
    ["read"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "read",
      toolCallId: "internal-allow",
      input: { path: join(harness.cwd, "src", "index.ts") },
    });

    assert.deepEqual(result, {});
    assert.deepEqual(harness.prompts, []);
  } finally {
    await harness.cleanup();
  }
});

test("tool_call blocks external_directory ask when no confirmation channel is available", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "ask" },
    },
    ["write"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "write",
      toolCallId: "external-ask-no-ui",
      input: {
        path: join(harness.cwd, "..", "outside.txt"),
        content: "blocked",
      },
    });

    assert.equal(result.block, true);
    assert.match(
      String(result.reason),
      /requires approval, but no interactive UI is available/i,
    );
  } finally {
    await harness.cleanup();
  }
});

test("tool_call prompts for external_directory and then falls through to normal tool policy", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "ask" },
    },
    ["grep"],
  );

  try {
    const externalPath = join(harness.cwd, "..", "external-search-root");
    const result = await runToolCall(
      harness,
      {
        toolName: "grep",
        toolCallId: "external-ask-approved",
        input: { pattern: "needle", path: externalPath },
      },
      { hasUI: true, selectResponse: "Yes" },
    );

    assert.deepEqual(result, {});
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /external directory access/i);
    assert.match(harness.prompts[0], /grep/);
    assert.match(harness.prompts[0], /external-search-root/);
  } finally {
    await harness.cleanup();
  }
});

test("tool_call skips external_directory checks for optional path tools without a path", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "deny" },
    },
    ["find"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "find",
      toolCallId: "find-default-cwd",
      input: { pattern: "*.ts" },
    });

    assert.deepEqual(result, {});
    assert.deepEqual(harness.prompts, []);
  } finally {
    await harness.cleanup();
  }
});

// --- bash external_directory integration tests (#39) ---

test("tool_call blocks bash command with external path when external_directory is denied", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "deny" },
    },
    ["bash"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "bash",
      toolCallId: "bash-external-deny",
      input: { command: "cat /etc/hosts" },
    });

    assert.equal(result.block, true);
    assert.match(
      String(result.reason),
      /external directory permission denial/i,
    );
    assert.match(String(result.reason), /\/etc\/hosts/);
  } finally {
    await harness.cleanup();
  }
});

test("tool_call allows bash command with only internal paths when external_directory is denied", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "deny" },
    },
    ["bash"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "bash",
      toolCallId: "bash-internal-allow",
      input: { command: "cat src/index.ts" },
    });

    assert.deepEqual(result, {});
  } finally {
    await harness.cleanup();
  }
});

test("tool_call prompts for bash command with external path when external_directory is ask", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "ask" },
    },
    ["bash"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "bash",
      toolCallId: "bash-external-ask-no-ui",
      input: { command: "cat /etc/hosts" },
    });

    // No UI available in default harness, so it should block
    assert.equal(result.block, true);
    assert.match(
      String(result.reason),
      /requires approval.*no interactive UI/i,
    );
  } finally {
    await harness.cleanup();
  }
});

test("tool_call allows bash command with external path when external_directory is allow", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "allow" },
    },
    ["bash"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "bash",
      toolCallId: "bash-external-allow",
      input: { command: "cat /etc/hosts" },
    });

    // Should pass through to normal bash permission (which is also allow)
    assert.deepEqual(result, {});
  } finally {
    await harness.cleanup();
  }
});

test("tool_call applies bash pattern permissions after external_directory allow", async () => {
  const harness = createToolCallHarness(
    {
      permission: {
        "*": "allow",
        external_directory: "allow",
        bash: { "*": "allow", "cat *": "deny" },
      },
    },
    ["bash"],
  );

  try {
    const result = await runToolCall(harness, {
      toolName: "bash",
      toolCallId: "bash-pattern-deny-after-ext-allow",
      input: { command: "cat /etc/hosts" },
    });

    // external_directory allows, but bash pattern denies
    assert.equal(result.block, true);
    assert.match(String(result.reason), /not permitted/i);
  } finally {
    await harness.cleanup();
  }
});

test("generic ask prompts include serialized tool input for informed approval", async () => {
  const harness = createToolCallHarness(
    {
      permission: { "*": "ask" },
    },
    ["weather_lookup"],
  );

  try {
    const result = await runToolCall(
      harness,
      {
        toolName: "weather_lookup",
        toolCallId: "generic-tool-input",
        input: { city: "Chicago", units: "metric" },
      },
      { hasUI: true, selectResponse: "No" },
    );

    assert.equal(result.block, true);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /weather_lookup/);
    assert.match(harness.prompts[0], /\{"city":"Chicago","units":"metric"\}/);
  } finally {
    await harness.cleanup();
  }
});

test("getResolvedPolicyPaths returns correct paths and existence when files exist", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "policy-paths-exist-"));
  try {
    const globalConfigPath = join(tempDir, "pi-permissions.jsonc");
    const agentsDir = join(tempDir, "agents");
    const projectConfigPath = join(tempDir, "project", "pi-permissions.jsonc");
    const projectAgentsDir = join(tempDir, "project", "agents");

    writeFileSync(globalConfigPath, "{}", "utf-8");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(join(tempDir, "project"), { recursive: true });
    writeFileSync(projectConfigPath, "{}", "utf-8");
    mkdirSync(projectAgentsDir, { recursive: true });

    const pm = new PermissionManager({
      globalConfigPath,
      agentsDir,
      projectGlobalConfigPath: projectConfigPath,
      projectAgentsDir,
    });

    const result = pm.getResolvedPolicyPaths();

    assert.equal(result.globalConfigPath, globalConfigPath);
    assert.equal(result.globalConfigExists, true);
    assert.equal(result.projectConfigPath, projectConfigPath);
    assert.equal(result.projectConfigExists, true);
    assert.equal(result.agentsDir, agentsDir);
    assert.equal(result.agentsDirExists, true);
    assert.equal(result.projectAgentsDir, projectAgentsDir);
    assert.equal(result.projectAgentsDirExists, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("getResolvedPolicyPaths returns false for missing files and null for absent project paths", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "policy-paths-missing-"));
  try {
    const globalConfigPath = join(tempDir, "does-not-exist.jsonc");
    const agentsDir = join(tempDir, "no-agents");

    const pm = new PermissionManager({
      globalConfigPath,
      agentsDir,
    });

    const result = pm.getResolvedPolicyPaths();

    assert.equal(result.globalConfigPath, globalConfigPath);
    assert.equal(result.globalConfigExists, false);
    assert.equal(result.projectConfigPath, null);
    assert.equal(result.projectConfigExists, false);
    assert.equal(result.agentsDir, agentsDir);
    assert.equal(result.agentsDirExists, false);
    assert.equal(result.projectAgentsDir, null);
    assert.equal(result.projectAgentsDirExists, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- config issues tests ---

test("PermissionManager.getConfigIssues returns empty array for clean config", () => {
  const config: ScopeConfig = {
    permission: { "*": "ask", external_directory: "ask" },
  };
  const { manager, cleanup } = createManager(config);
  try {
    const issues = manager.getConfigIssues();
    assert.equal(issues.length, 0);
  } finally {
    cleanup();
  }
});

test("PermissionManager.getConfigIssues returns empty array for empty config", () => {
  const { manager, cleanup } = createManager({});
  try {
    const issues = manager.getConfigIssues();
    assert.equal(issues.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Session-scoped approval tests (#45)
// ---------------------------------------------------------------------------

test("session approval: first prompt with 'Yes, for this session' skips subsequent prompts under same prefix", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-session-approval-"));
  const cwd = join(rootDir, "repo");
  const siblingDir = join(rootDir, "sibling-project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(siblingDir, { recursive: true });

  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "ask" },
    },
    ["read", "grep"],
    { cwd },
  );

  try {
    // First access — user selects "Yes, for this session"
    const result1 = await runToolCall(
      harness,
      {
        toolName: "read",
        toolCallId: "ext-session-1",
        input: { path: join(siblingDir, "src", "foo.ts") },
      },
      { hasUI: true, selectResponse: "Yes, for this session" },
    );
    assert.deepEqual(result1, {});
    assert.equal(harness.prompts.length, 1);

    // Second access under same prefix — should skip prompt
    const result2 = await runToolCall(
      harness,
      {
        toolName: "read",
        toolCallId: "ext-session-2",
        input: { path: join(siblingDir, "src", "bar.ts") },
      },
      { hasUI: true, selectResponse: "Yes, for this session" },
    );
    assert.deepEqual(result2, {});
    // No new prompt — still just the original one
    assert.equal(harness.prompts.length, 1);

    // Third access with different tool under same prefix — also skipped
    const result3 = await runToolCall(
      harness,
      {
        toolName: "grep",
        toolCallId: "ext-session-3",
        input: { pattern: "needle", path: join(siblingDir, "src", "baz.ts") },
      },
      { hasUI: true, selectResponse: "Yes, for this session" },
    );
    assert.deepEqual(result3, {});
    assert.equal(harness.prompts.length, 1);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("session approval: different directory prefix still prompts", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-session-approval-"));
  const cwd = join(rootDir, "repo");
  const siblingA = join(rootDir, "sibling-a");
  const siblingB = join(rootDir, "sibling-b");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(siblingA, { recursive: true });
  mkdirSync(siblingB, { recursive: true });

  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "ask" },
    },
    ["read"],
    { cwd },
  );

  try {
    // Approve sibling-a/src/ for session
    await runToolCall(
      harness,
      {
        toolName: "read",
        toolCallId: "ext-diff-1",
        input: { path: join(siblingA, "src", "foo.ts") },
      },
      { hasUI: true, selectResponse: "Yes, for this session" },
    );
    assert.equal(harness.prompts.length, 1);

    // Access sibling-b — different prefix, should prompt again
    await runToolCall(
      harness,
      {
        toolName: "read",
        toolCallId: "ext-diff-2",
        input: { path: join(siblingB, "src", "bar.ts") },
      },
      { hasUI: true, selectResponse: "Yes" },
    );
    assert.equal(harness.prompts.length, 2);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("session approval: session_shutdown clears session approvals", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-session-approval-"));
  const cwd = join(rootDir, "repo");
  const siblingDir = join(rootDir, "sibling");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(siblingDir, { recursive: true });

  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "ask" },
    },
    ["read"],
    { cwd },
  );

  try {
    // Approve for session
    await runToolCall(
      harness,
      {
        toolName: "read",
        toolCallId: "ext-shutdown-1",
        input: { path: join(siblingDir, "src", "foo.ts") },
      },
      { hasUI: true, selectResponse: "Yes, for this session" },
    );
    assert.equal(harness.prompts.length, 1);

    // Trigger session_shutdown (clears cache)
    const shutdownCtx = createMockContext(cwd, harness.prompts, {
      hasUI: true,
      selectResponse: "Yes",
    });
    await Promise.resolve(harness.handlers.session_shutdown?.({}, shutdownCtx));

    // Access same path again — should prompt because cache was cleared
    const result = await runToolCall(
      harness,
      {
        toolName: "read",
        toolCallId: "ext-shutdown-2",
        input: { path: join(siblingDir, "src", "foo.ts") },
      },
      { hasUI: true, selectResponse: "Yes" },
    );
    assert.deepEqual(result, {});
    assert.equal(harness.prompts.length, 2);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("session approval: bash external directory with 'Yes, for this session' skips subsequent prompts", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-session-approval-"));
  const cwd = join(rootDir, "repo");
  mkdirSync(cwd, { recursive: true });

  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "ask" },
    },
    ["bash"],
    { cwd },
  );

  try {
    const externalPath = join(rootDir, "other-project", "src");
    // First bash command referencing external path
    const result1 = await runToolCall(
      harness,
      {
        toolName: "bash",
        toolCallId: "bash-session-1",
        input: { command: `ls ${externalPath}/foo.ts` },
      },
      { hasUI: true, selectResponse: "Yes, for this session" },
    );
    assert.deepEqual(result1, {});
    assert.equal(harness.prompts.length, 1);

    // Second bash command referencing path under same prefix — skips prompt
    const result2 = await runToolCall(
      harness,
      {
        toolName: "bash",
        toolCallId: "bash-session-2",
        input: { command: `cat ${externalPath}/bar.ts` },
      },
      { hasUI: true, selectResponse: "Yes, for this session" },
    );
    assert.deepEqual(result2, {});
    assert.equal(harness.prompts.length, 1);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("session approval: regular 'Yes' does not create session approval", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-session-approval-"));
  const cwd = join(rootDir, "repo");
  const siblingDir = join(rootDir, "sibling");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(siblingDir, { recursive: true });

  const harness = createToolCallHarness(
    {
      permission: { "*": "allow", external_directory: "ask" },
    },
    ["read"],
    { cwd },
  );

  try {
    // Approve once with "Yes" (not session)
    await runToolCall(
      harness,
      {
        toolName: "read",
        toolCallId: "ext-once-1",
        input: { path: join(siblingDir, "src", "foo.ts") },
      },
      { hasUI: true, selectResponse: "Yes" },
    );
    assert.equal(harness.prompts.length, 1);

    // Same prefix — should still prompt since we used "Yes" not session
    await runToolCall(
      harness,
      {
        toolName: "read",
        toolCallId: "ext-once-2",
        input: { path: join(siblingDir, "src", "bar.ts") },
      },
      { hasUI: true, selectResponse: "Yes" },
    );
    assert.equal(harness.prompts.length, 2);
  } finally {
    await harness.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Session-aware checkPermission() integration
// ---------------------------------------------------------------------------

test("checkPermission returns source 'session' when session rules cover the external_directory path", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "allow" },
  });

  try {
    const sessionRules = [
      {
        surface: "external_directory",
        pattern: "/other/project/*",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    const result = manager.checkPermission(
      "external_directory",
      { path: "/other/project/src/foo.ts" },
      undefined,
      sessionRules,
    );
    assert.equal(result.state, "allow");
    assert.equal(result.source, "session");
    assert.equal(result.matchedPattern, "/other/project/*");
  } finally {
    cleanup();
  }
});

test("checkPermission falls back to config policy when session rules do not cover the path", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "allow", external_directory: "deny" },
  });

  try {
    const sessionRules = [
      {
        surface: "external_directory",
        pattern: "/other/project/*",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    // Path NOT under /other/project/ — session rules don't match.
    const result = manager.checkPermission(
      "external_directory",
      { path: "/completely/different/path.ts" },
      undefined,
      sessionRules,
    );
    assert.equal(result.state, "deny");
    assert.equal(result.source, "special");
  } finally {
    cleanup();
  }
});

test("checkPermission with empty session rules is identical to call without sessionRules arg", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "allow", external_directory: "deny" },
  });

  try {
    const withEmpty = manager.checkPermission(
      "external_directory",
      { path: "/other/project/foo.ts" },
      undefined,
      [],
    );
    const withoutArg = manager.checkPermission("external_directory", {
      path: "/other/project/foo.ts",
    });
    const expected: PermissionCheckResult = {
      toolName: "external_directory",
      state: "deny",
      matchedPattern: "*",
      source: "special",
      origin: "global",
    };
    assert.deepEqual(withEmpty, expected);
    assert.deepEqual(withoutArg, expected);
  } finally {
    cleanup();
  }
});

test("session rules for one surface do not affect checks on other surfaces", () => {
  const { manager, cleanup } = createManager({
    // Empty permission: universal default is "ask" from DEFAULT_UNIVERSAL_FALLBACK.
    permission: {},
  });

  try {
    const sessionRules = [
      {
        surface: "external_directory",
        pattern: "/other/project/*",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    // Bash check — session rules should not affect bash decisions.
    const bashResult = manager.checkPermission(
      "bash",
      { command: "git status" },
      undefined,
      sessionRules,
    );
    assert.equal(bashResult.state, "ask");
    assert.equal(bashResult.source, "bash");

    // MCP check — session rules should not affect MCP decisions.
    const mcpResult = manager.checkPermission(
      "mcp",
      { tool: "exa:search" },
      undefined,
      sessionRules,
    );
    assert.equal(mcpResult.state, "ask");
    assert.equal(mcpResult.source, "default");
  } finally {
    cleanup();
  }
});

test("session rules override config deny for external_directory", () => {
  const { manager, cleanup } = createManager({
    permission: { "*": "allow", external_directory: "deny" },
  });

  try {
    const sessionRules = [
      {
        surface: "external_directory",
        pattern: "/other/project/*",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    // Session approval overrides config deny for the covered path.
    const result = manager.checkPermission(
      "external_directory",
      { path: "/other/project/src/foo.ts" },
      undefined,
      sessionRules,
    );
    assert.equal(result.state, "allow");
    assert.equal(result.source, "session");
  } finally {
    cleanup();
  }
});

// ── Session rule evaluation for all surfaces ─────────────────────────────

test("checkPermission returns source 'session' for bash when session rules match", () => {
  const { manager, cleanup } = createManager({ permission: {} });

  try {
    const sessionRules = [
      {
        surface: "bash",
        pattern: "git *",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    const result = manager.checkPermission(
      "bash",
      { command: "git status --short" },
      undefined,
      sessionRules,
    );
    assert.equal(result.state, "allow");
    assert.equal(result.source, "session");
    assert.equal(result.matchedPattern, "git *");
  } finally {
    cleanup();
  }
});

test("checkPermission returns source 'session' for bash when session rule is exact match", () => {
  const { manager, cleanup } = createManager({ permission: {} });

  try {
    const sessionRules = [
      {
        surface: "bash",
        pattern: "ls",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    const result = manager.checkPermission(
      "bash",
      { command: "ls" },
      undefined,
      sessionRules,
    );
    assert.equal(result.state, "allow");
    assert.equal(result.source, "session");
  } finally {
    cleanup();
  }
});

test("checkPermission falls back to config for bash when session rules do not match the command", () => {
  const { manager, cleanup } = createManager({ permission: { bash: "deny" } });

  try {
    const sessionRules = [
      {
        surface: "bash",
        pattern: "git *",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    const result = manager.checkPermission(
      "bash",
      { command: "npm run build" },
      undefined,
      sessionRules,
    );
    assert.equal(result.state, "deny");
    assert.equal(result.source, "bash");
  } finally {
    cleanup();
  }
});

test("checkPermission returns source 'session' for mcp when session rules match the target", () => {
  const { manager, cleanup } = createManager({ permission: {} });

  try {
    const sessionRules = [
      {
        surface: "mcp",
        pattern: "exa:*",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    const result = manager.checkPermission(
      "mcp",
      { tool: "exa:search" },
      undefined,
      sessionRules,
    );
    assert.equal(result.state, "allow");
    assert.equal(result.source, "session");
  } finally {
    cleanup();
  }
});

test("checkPermission returns source 'session' for skill when session rules match", () => {
  const { manager, cleanup } = createManager({ permission: {} });

  try {
    const sessionRules = [
      {
        surface: "skill",
        pattern: "librarian",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    const result = manager.checkPermission(
      "skill",
      { name: "librarian" },
      undefined,
      sessionRules,
    );
    assert.equal(result.state, "allow");
    assert.equal(result.source, "session");
    assert.equal(result.matchedPattern, "librarian");
  } finally {
    cleanup();
  }
});

test("checkPermission returns source 'session' for tool surface when session rules match", () => {
  const { manager, cleanup } = createManager({ permission: {} });

  try {
    const sessionRules = [
      {
        surface: "read",
        pattern: "*",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    const result = manager.checkPermission("read", {}, undefined, sessionRules);
    assert.equal(result.state, "allow");
    assert.equal(result.source, "session");
  } finally {
    cleanup();
  }
});

test("bash session rules do not bleed into mcp checks", () => {
  const { manager, cleanup } = createManager({ permission: {} });

  try {
    const sessionRules = [
      {
        surface: "bash",
        pattern: "git *",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    const result = manager.checkPermission(
      "mcp",
      { tool: "exa:search" },
      undefined,
      sessionRules,
    );
    // bash session rule must not affect mcp surface
    assert.notEqual(result.source, "session");
  } finally {
    cleanup();
  }
});

// Suppress unused import warning — PermissionState used in type annotations
const _unused: PermissionState = "ask";
void _unused;
