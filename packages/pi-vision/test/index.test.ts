import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock complete() from pi-ai. describeImages calls complete(model, context, opts)
// and joins text from response.content.
const completeMock = vi.fn(async () => ({
  stopReason: "stop",
  content: [{ type: "text", text: "image description" }],
}));

vi.mock("@earendil-works/pi-ai", () => ({
  complete: completeMock,
}));

import {
  COLON_COMMAND_ALIASES,
  DEFAULT_CONFIG,
  createPiVisionExtension,
  describeImage,
  extractImage,
  hasImageContent,
  loadConfig,
  saveConfig,
} from "../src/index";

const tempDirs: string[] = [];

function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vision-"));
  tempDirs.push(dir);
  return path.join(dir, "nested", "pi-vision.json");
}

function setupExtension(configPath = tempConfigPath()) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const pi = {
    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, handler);
    }),
    registerCommand: vi.fn((name: string, command: any) => {
      commands.set(name, command);
    }),
  };

  createPiVisionExtension({ configPath })(pi as any);
  return { handlers, commands, configPath };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  completeMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("image extraction", () => {
  it("extracts Pi image blocks with source data", () => {
    expect(
      extractImage([
        { type: "text", text: "ignored" },
        { type: "image", source: { data: "abc", mediaType: "image/jpeg" } },
      ]),
    ).toEqual({ base64: "abc", mediaType: "image/jpeg" });
  });

  it("extracts legacy image blocks and data URLs", () => {
    expect(extractImage([{ type: "image", data: "xyz" }])).toEqual({
      base64: "xyz",
      mediaType: "image/png",
    });
    expect(
      extractImage([
        {
          type: "image_url",
          image_url: { url: "data:image/webp;base64,webpdata" },
        },
      ]),
    ).toEqual({ base64: "webpdata", mediaType: "image/webp" });
  });

  it("detects image-bearing content", () => {
    expect(hasImageContent([{ type: "text", text: "no image" }])).toBe(false);
    expect(
      hasImageContent([
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ]),
    ).toBe(true);
  });
});

describe("config", () => {
  it("returns defaults when config is absent or invalid", () => {
    const configPath = tempConfigPath();
    expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "not json");
    expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
  });

  it("reads and writes config while preserving defaults", () => {
    const configPath = tempConfigPath();
    saveConfig({ model: "moonshotai/Kimi-K2.6", enabled: false }, configPath);

    expect(loadConfig(configPath)).toMatchObject({
      ...DEFAULT_CONFIG,
      model: "moonshotai/Kimi-K2.6",
      enabled: false,
    });
  });
});

describe("vision API", () => {
  it("sends image data to the vision model via complete() and returns text", async () => {
    completeMock.mockResolvedValueOnce({
      stopReason: "stop",
      content: [{ type: "text", text: "image description" }],
    });

    const visionModel = {
      id: "Kimi-K2.7-Code",
      provider: "neuralwatt",
      input: ["text", "image"],
    };
    await expect(
      describeImage(
        { base64: "abc", mediaType: "image/png" },
        visionModel as any,
        "describe it",
        { apiKey: "secret" },
      ),
    ).resolves.toBe("image description");

    expect(completeMock).toHaveBeenCalledTimes(1);
    const [model, context, opts] = completeMock.mock.calls[0] as unknown as [
      any,
      any,
      any,
    ];
    expect(model).toBe(visionModel);
    expect(opts.apiKey).toBe("secret");
    const userContent = context.messages[0].content as any[];
    expect(userContent[0].type).toBe("text");
    expect(userContent[1]).toEqual({ type: "text", text: "Image 1:" });
    expect(userContent[2]).toEqual({
      type: "image",
      data: "abc",
      mimeType: "image/png",
    });
  });

  it("throws when the vision model returns an empty response", async () => {
    completeMock.mockResolvedValueOnce({
      stopReason: "stop",
      content: [{ type: "text", text: "   " }],
    });

    await expect(
      describeImage(
        { base64: "abc", mediaType: "image/png" },
        { id: "m", provider: "neuralwatt", input: ["text", "image"] } as any,
        "describe it",
        { apiKey: "secret" },
      ),
    ).rejects.toThrow(/empty response/);
  });

  it("surfaces cancelled requests", async () => {
    completeMock.mockResolvedValueOnce({
      stopReason: "aborted",
      content: [{ type: "text", text: "partial" }],
    });

    await expect(
      describeImage(
        { base64: "abc", mediaType: "image/png" },
        { id: "m", provider: "neuralwatt", input: ["text", "image"] } as any,
        "describe it",
        { apiKey: "secret" },
      ),
    ).rejects.toThrow(/cancelled/);
  });
});

describe("extension behavior", () => {
  it("describes images when the active model lacks image input", async () => {
    completeMock.mockResolvedValueOnce({
      stopReason: "stop",
      content: [{ type: "text", text: "described" }],
    });
    const { handlers } = setupExtension();
    const imageBlock = { type: "image", data: "abc", mediaType: "image/png" };

    const result = await handlers.get("tool_result")?.(
      { toolName: "read", content: [imageBlock] },
      {
        // Active model is text-only: gate should fire.
        model: { provider: "openai", input: ["text"] },
        modelRegistry: {
          find: vi.fn(() => ({
            id: "Kimi-K2.7-Code",
            provider: "neuralwatt",
            input: ["text", "image"],
          })),
          getApiKeyAndHeaders: vi.fn(async () => ({
            ok: true,
            apiKey: "secret",
            headers: {},
          })),
        },
        signal: undefined,
      },
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining(
        "[pi-vision: moonshotai/Kimi-K2.7-Code | images: 1]",
      ),
    });
    expect(result.content[0].text).toContain("described");
  });

  it("does not intercept when the active model already supports images", async () => {
    const { handlers } = setupExtension();
    const find = vi.fn(() => ({
      id: "m",
      provider: "neuralwatt",
      input: ["text", "image"],
    }));
    const describeSpy = vi.fn();

    await expect(
      handlers.get("tool_result")?.(
        { toolName: "read", content: [{ type: "image", data: "abc" }] },
        {
          // Active model supports images: gate should pass through (no vision call).
          model: { provider: "anthropic", input: ["text", "image"] },
          modelRegistry: {
            find,
            getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
          },
          signal: undefined,
        },
      ),
    ).resolves.toBeUndefined();

    expect(find).not.toHaveBeenCalled();
    expect(describeSpy).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("does not intercept when no current model is set", async () => {
    const { handlers } = setupExtension();

    await expect(
      handlers.get("tool_result")?.(
        { toolName: "read", content: [{ type: "image", data: "abc" }] },
        {
          model: undefined,
          modelRegistry: { find: vi.fn(), getApiKeyAndHeaders: vi.fn() },
          signal: undefined,
        },
      ),
    ).resolves.toBeUndefined();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("falls back to original image when the vision model throws", async () => {
    completeMock.mockRejectedValueOnce(new Error("boom from provider"));
    const { handlers } = setupExtension();
    const imageBlock = { type: "image", data: "abc", mediaType: "image/png" };

    const result = await handlers.get("tool_result")?.(
      { toolName: "read", content: [imageBlock] },
      {
        model: { provider: "openai", input: ["text"] },
        modelRegistry: {
          find: vi.fn(() => ({
            id: "m",
            provider: "neuralwatt",
            input: ["text", "image"],
          })),
          getApiKeyAndHeaders: vi.fn(async () => ({
            ok: true,
            apiKey: "secret",
            headers: {},
          })),
        },
        signal: undefined,
      },
    );

    expect(result.content).toEqual([
      { type: "text", text: "[pi-vision error: boom from provider]" },
      imageBlock,
    ]);
  });

  it("reports when the vision model cannot be resolved", async () => {
    const { handlers } = setupExtension();
    const imageBlock = { type: "image", data: "abc", mediaType: "image/png" };

    const result = await handlers.get("tool_result")?.(
      { toolName: "read", content: [imageBlock] },
      {
        model: { provider: "openai", input: ["text"] },
        modelRegistry: {
          find: vi.fn(() => undefined),
          getApiKeyAndHeaders: vi.fn(),
        },
        signal: undefined,
      },
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining(
        "[pi-vision error: could not resolve vision model",
      ),
    });
    // original image preserved
    expect(result.content).toContain(imageBlock);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("returns a cache entry without calling complete() on the second read", async () => {
    completeMock.mockResolvedValueOnce({
      stopReason: "stop",
      content: [{ type: "text", text: "cached desc" }],
    });
    const { handlers } = setupExtension();
    const imageBlock = { type: "image", data: "uniq", mediaType: "image/png" };
    const ctx = {
      model: { provider: "openai", input: ["text"] },
      modelRegistry: {
        find: vi.fn(() => ({
          id: "m",
          provider: "neuralwatt",
          input: ["text", "image"],
        })),
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true,
          apiKey: "secret",
          headers: {},
        })),
      },
      signal: undefined,
    };

    await handlers.get("tool_result")?.(
      { toolName: "read", content: [imageBlock] },
      ctx,
    );
    const second = await handlers.get("tool_result")?.(
      { toolName: "read", content: [imageBlock] },
      ctx,
    );

    // Only the first call hit complete(); the second came from cache.
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(second.content[0].type).toBe("text");
    expect(second.content[0].text).toContain("cache hit");
    expect(second.content[0].text).toContain("cached desc");
  });
});

describe("commands", () => {
  it("handles command status, toggles, model switching, and unknown", async () => {
    const { commands, configPath } = setupExtension();
    const command = commands.get("pi-vision");
    const notify = vi.fn();
    const ctx = { ui: { notify } };

    expect(
      command
        .getArgumentCompletions("moonshotai/Kimi-K")
        .map((c: any) => c.value),
    ).toEqual([
      "moonshotai/Kimi-K2.7-Code",
      "moonshotai/Kimi-K2.6",
      "moonshotai/Kimi-K2.5",
    ]);

    // status (default; implies on because DEFAULT_CONFIG.enabled)
    await command.handler("", ctx);
    const last = (s: number) =>
      notify.mock.calls[notify.mock.calls.length - s]?.[0];
    expect(notify.mock.lastCall?.[0]).toContain("pi-vision: ON");
    expect(notify.mock.lastCall?.[0]).toContain("prompt: default");
    expect(notify.mock.lastCall?.[0]).toContain("cache: ON");
    expect(notify.mock.lastCall?.[1]).toBe("info");

    await command.handler("off", ctx);
    expect(loadConfig(configPath).enabled).toBe(false);
    expect(notify).toHaveBeenLastCalledWith("pi-vision: OFF", "info");

    await command.handler("moonshotai/Kimi-K2.6", ctx);
    expect(loadConfig(configPath)).toMatchObject({
      model: "moonshotai/Kimi-K2.6",
      enabled: true,
    });
    expect(notify).toHaveBeenLastCalledWith(
      "pi-vision model -> moonshotai/Kimi-K2.6",
      "info",
    );

    await command.handler("ocr", ctx);
    expect(loadConfig(configPath)).toMatchObject({ promptMode: "ocr" });
    expect(loadConfig(configPath)).not.toHaveProperty("prompt");
    expect(notify).toHaveBeenLastCalledWith(
      "pi-vision prompt mode -> ocr",
      "info",
    );

    await command.handler("cache off", ctx);
    expect(loadConfig(configPath).cacheEnabled).toBe(false);
    expect(notify).toHaveBeenLastCalledWith("pi-vision cache: OFF", "info");

    await command.handler("unknown", ctx);
    expect(notify).toHaveBeenLastCalledWith(
      "Unknown command: unknown. Try /pi-vision:model, /pi-vision:mode, or /pi-vision:status.",
      "error",
    );
  });

  it("registers colon flat commands and delegates to the shared handler", async () => {
    const { commands, configPath } = setupExtension();
    const notify = vi.fn();
    const ctx = { ui: { notify } };

    for (const alias of COLON_COMMAND_ALIASES) {
      expect(commands.has(alias.name)).toBe(true);
      expect(commands.get(alias.name)?.description).toContain(
        alias.description,
      );
    }

    await commands.get("pi-vision:off")?.handler("", ctx);
    expect(loadConfig(configPath).enabled).toBe(false);
    expect(notify).toHaveBeenLastCalledWith("pi-vision: OFF", "info");

    await commands.get("pi-vision:ocr")?.handler("", ctx);
    expect(loadConfig(configPath).promptMode).toBe("ocr");

    await commands
      .get("pi-vision:prompt-set")
      ?.handler("Describe UI layout", ctx);
    expect(loadConfig(configPath)).toMatchObject({
      promptMode: "custom",
      prompt: "Describe UI layout",
    });

    await commands.get("pi-vision:cache-max")?.handler("42", ctx);
    expect(loadConfig(configPath).cacheMaxEntries).toBe(42);
    expect(notify).toHaveBeenLastCalledWith(
      "pi-vision cache max -> 42",
      "info",
    );
  });

  it("selects model and prompt mode via colon commands when TUI is available", async () => {
    const { commands, configPath } = setupExtension();
    const notify = vi.fn();
    const select = vi.fn();
    const ctx = { ui: { notify, select }, hasUI: true, signal: undefined };

    select.mockResolvedValueOnce("moonshotai/Kimi-K2.6");
    await commands.get("pi-vision:model")?.handler("", ctx);
    expect(select).toHaveBeenCalledWith(
      "Select vision model",
      MODELS_EXPECTED,
      { signal: undefined },
    );
    expect(loadConfig(configPath)).toMatchObject({
      model: "moonshotai/Kimi-K2.6",
      enabled: true,
    });
    expect(notify).toHaveBeenLastCalledWith(
      "pi-vision model -> moonshotai/Kimi-K2.6",
      "info",
    );

    select.mockResolvedValueOnce("ocr");
    await commands.get("pi-vision:mode")?.handler("", ctx);
    expect(select).toHaveBeenCalledWith(
      "Select prompt preset",
      ["default", "ocr", "ui", "code", "diagram", "brief"],
      { signal: undefined },
    );
    expect(loadConfig(configPath)).toMatchObject({ promptMode: "ocr" });
    expect(loadConfig(configPath)).not.toHaveProperty("prompt");
    expect(notify).toHaveBeenLastCalledWith(
      "pi-vision prompt mode -> ocr",
      "info",
    );
  });

  it("requires TUI for selection-driven model and mode colon commands", async () => {
    const { commands } = setupExtension();
    const notify = vi.fn();
    const select = vi.fn();
    const ctx = { ui: { notify, select }, hasUI: false };

    await commands.get("pi-vision:model")?.handler("", ctx);
    expect(select).not.toHaveBeenCalled();
    expect(notify).toHaveBeenLastCalledWith(
      "pi-vision:model requires the Pi TUI. In non-interactive mode use /pi-vision <model>.",
      "warning",
    );

    await commands.get("pi-vision:mode")?.handler("", ctx);
    expect(notify).toHaveBeenLastCalledWith(
      "pi-vision:mode requires the Pi TUI. In non-interactive mode use /pi-vision mode <preset>.",
      "warning",
    );
  });
});

const MODELS_EXPECTED = [
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.6",
  "kimi-k2.6-fast",
  "neuralwatt/kimi-k2.6-long",
  "moonshotai/Kimi-K2.5",
  "kimi-k2.5-fast",
  "Qwen/Qwen3.6-35B-A3B",
  "mistralai/Devstral-Small-2-24B-Instruct-2512",
];
