import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { AgentTool } from "#src/tools/agent-tool";
import { MODEL_PICKER_TITLE_PREFIX } from "#src/tools/model-picker";
import { createToolDeps } from "#test/helpers/make-deps";
import { createTestSubagent } from "#test/helpers/make-subagent";

const AVAILABLE_MODELS = [
  { id: "model-a", name: "Model A", provider: "provA" },
  { id: "model-b", name: "Model B", provider: "provB" },
  { id: "model-c", name: "Model C", provider: "provC" },
];

function makePickCtx(
  selectImpl: (
    title: string,
    options: unknown[],
    opts?: unknown,
  ) => unknown = () => undefined,
) {
  return { ui: { select: vi.fn().mockImplementation(selectImpl) } };
}

function depsWithPicker(overrides: Parameters<typeof createToolDeps>[0] = {}) {
  const deps = createToolDeps({
    settings: {
      defaultMaxTurns: undefined as number | undefined,
      maxConcurrent: 4,
      agentModelPicker: true,
      agentModelDefault: undefined,
      setAgentModelDefault: vi.fn(),
      modelScopeAsked: false,
      markModelScopeAsked: vi.fn(),
      acquirePickerLock: vi.fn().mockResolvedValue(() => {}),
      clearSessionModelDefault: vi.fn(),
    },
    ...overrides,
  });
  deps.runtime.getModelInfo = vi.fn(() => ({
    parentModel: {
      id: "claude-sonnet",
      name: "Claude Sonnet",
      provider: "anthropic",
    },
    modelRegistry: {
      getAvailable: () => AVAILABLE_MODELS,
      getAll: () => AVAILABLE_MODELS,
      find: (p: string, id: string) =>
        AVAILABLE_MODELS.find((m) => m.provider === p && m.id === id),
    },
  }));
  return deps;
}

function execute(
  deps: ReturnType<typeof createToolDeps>,
  params: Record<string, unknown>,
  ctx: Record<string, unknown> = makePickCtx(),
) {
  return new AgentTool(
    deps.manager,
    deps.runtime,
    deps.settings,
    deps.registry,
    deps.agentDir,
  ).execute("tc-1", params, new AbortController().signal, vi.fn(), ctx);
}

describe("AgentTool — model picker gating", () => {
  it("does not fire when neither setting nor pick_model is enabled", async () => {
    const deps = createToolDeps();
    const select = vi.fn();
    const result = await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      { ui: { select } },
    );
    expect(select).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("background");
  });

  it("fires when settings.agentModelPicker is true", async () => {
    const deps = depsWithPicker();
    deps.manager.getRecord = vi
      .fn()
      .mockReturnValue(createTestSubagent({ status: "running" }));
    const ctx = makePickCtx(() => "");
    await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      ctx,
    );
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });

  it("fires when params.pick_model is true and setting is off", async () => {
    const deps = createToolDeps(); // agentModelPicker: false
    deps.runtime.getModelInfo = vi.fn(() => ({
      parentModel: {
        id: "claude-sonnet",
        name: "Claude Sonnet",
        provider: "anthropic",
      },
      modelRegistry: {
        getAvailable: () => AVAILABLE_MODELS,
        getAll: () => AVAILABLE_MODELS,
        find: () => undefined,
      },
    }));
    deps.manager.getRecord = vi
      .fn()
      .mockReturnValue(createTestSubagent({ status: "running" }));
    const ctx = makePickCtx(() => "");
    await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        pick_model: true,
        run_in_background: true,
      },
      ctx,
    );
    expect(ctx.ui.select).toHaveBeenCalledOnce();
  });

  it("skips when params.model is set explicitly", async () => {
    const deps = depsWithPicker();
    const ctx = makePickCtx(() => "provA/model-a");
    const result = await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        model: "provB/model-b",
        run_in_background: true,
      },
      ctx,
    );
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("background");
  });

  it("skips when the agent config hardcodes a model", async () => {
    const deps = depsWithPicker({
      registry: new AgentTypeRegistry(
        () =>
          new Map([
            [
              "scoped-agent",
              {
                name: "scoped-agent",
                description: "d",
                systemPrompt: "s",
                promptMode: "replace" as const,
                model: "provC/model-c",
              },
            ],
          ]),
      ),
    });
    const ctx = makePickCtx(() => "");
    await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "scoped-agent",
        run_in_background: true,
      },
      ctx,
    );
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(deps.manager.spawn).toHaveBeenCalled();
  });

  it("skips on resume calls", async () => {
    const deps = depsWithPicker();
    deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
    const ctx = makePickCtx(() => "");
    const result = await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        resume: "nonexistent",
      },
      ctx,
    );
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Agent not found");
  });

  it("skips silently when ctx.ui.select is unavailable (headless)", async () => {
    const deps = depsWithPicker();
    deps.manager.getRecord = vi
      .fn()
      .mockReturnValue(createTestSubagent({ status: "running" }));
    const result = await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      { ui: {} },
    );
    expect(result.content[0].text).toContain("background");
  });
});

describe("AgentTool — model picker outcomes", () => {
  it("cancelled (undefined) aborts the spawn with a cancellation message", async () => {
    const deps = depsWithPicker();
    const ctx = makePickCtx(() => undefined);
    const result = await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      ctx,
    );
    expect(result.content[0].text).toContain(
      "Agent spawn cancelled (model picker).",
    );
    expect(deps.manager.spawn).not.toHaveBeenCalled();
    expect(deps.manager.spawnAndWait).not.toHaveBeenCalled();
  });

  it('"" (inherit) proceeds with the unchanged config', async () => {
    const deps = depsWithPicker();
    deps.manager.getRecord = vi
      .fn()
      .mockReturnValue(createTestSubagent({ status: "running" }));
    const ctx = makePickCtx(() => "");
    const result = await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      ctx,
    );
    expect(result.content[0].text).toContain("background");
    const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock
      .calls[0][3];
    // parent model inherited — no explicit override applied
    expect(spawnOpts.model?.id ?? spawnOpts.model).toBeTruthy();
  });

  it("a picked model is injected as params.model and re-resolved", async () => {
    const deps = depsWithPicker();
    deps.manager.getRecord = vi
      .fn()
      .mockReturnValue(createTestSubagent({ status: "running" }));
    const ctx = makePickCtx(() => "provA/model-a");
    await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      ctx,
    );
    const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock
      .calls[0][3];
    expect(spawnOpts.model?.id).toBe("model-a");
    expect(spawnOpts.model?.provider).toBe("provA");
  });

  it("an unresolvable picked model surfaces the resolution error", async () => {
    const deps = depsWithPicker();
    const ctx = makePickCtx(() => "provX/nope");
    const result = await execute(
      deps,
      {
        prompt: "t",
        description: "d",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      ctx,
    );
    expect(result.content[0].text).toContain("provX/nope");
    expect(deps.manager.spawn).not.toHaveBeenCalled();
  });
});

describe("AgentTool — picker dialog shape", () => {
  it("keeps the piru-matched title prefix and passes a 120s timeout", async () => {
    const deps = depsWithPicker();
    deps.manager.getRecord = vi
      .fn()
      .mockReturnValue(createTestSubagent({ status: "running" }));
    const ctx = makePickCtx(() => "");
    await execute(
      deps,
      {
        prompt: "t",
        description: "my task",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      ctx,
    );
    const [title, options, opts] = ctx.ui.select.mock.calls[0] as [
      string,
      { title: string; value: string }[],
      { timeout: number },
    ];
    expect(title.startsWith(MODEL_PICKER_TITLE_PREFIX)).toBe(true);
    expect(title).toContain("general-purpose");
    expect(title).toContain("my task");
    expect(opts.timeout).toBe(120000);
    expect(options[0]).toEqual({
      title: "inherit parent (anthropic/claude-sonnet)",
      description: "use the current session model",
      value: "",
    });
  });

  it("sorts options MRU-descending from the pi-model-sort state file", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-picker-mru-"));
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "pi-model-sort.json"),
      JSON.stringify({
        lastUsed: { "provB/model-b": 2000, "provA/model-a": 1000 },
      }),
    );
    try {
      const deps = depsWithPicker({ agentDir });
      deps.manager.getRecord = vi
        .fn()
        .mockReturnValue(createTestSubagent({ status: "running" }));
      const ctx = makePickCtx(() => "");
      await execute(
        deps,
        {
          prompt: "t",
          description: "d",
          subagent_type: "general-purpose",
          run_in_background: true,
        },
        ctx,
      );
      const options = (
        ctx.ui.select.mock.calls[0] as [string, { value: string }[]]
      )[1];
      // after the inherit option, each model emits one plain row
      const plain = options.slice(1).map((o) => o.value);
      expect(plain).toEqual([
        "provB/model-b",
        "provA/model-a",
        "provC/model-c",
      ]);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("treats a malformed MRU file as empty ordering (alphabetical after inherit)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-picker-mru-bad-"));
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "pi-model-sort.json"),
      "not json {{{",
    );
    try {
      const deps = depsWithPicker({ agentDir });
      deps.manager.getRecord = vi
        .fn()
        .mockReturnValue(createTestSubagent({ status: "running" }));
      const ctx = makePickCtx(() => "");
      await execute(
        deps,
        {
          prompt: "t",
          description: "d",
          subagent_type: "general-purpose",
          run_in_background: true,
        },
        ctx,
      );
      const options = (
        ctx.ui.select.mock.calls[0] as [string, { value: string }[]]
      )[1];
      // malformed MRU → alphabetical, plain pick rows only
      const plain = options.slice(1).map((o) => o.value);
      expect(plain).toEqual([
        "provA/model-a",
        "provB/model-b",
        "provC/model-c",
      ]);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
