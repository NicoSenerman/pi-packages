import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  complete,
  type ImageContent as PiAiImage,
} from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// -- Config -----------------------------------------------------
/** Default path for the pi-vision user config file (`~/.pi/pi-vision.json`). */
export const getConfigPath = () =>
  path.join(os.homedir(), ".pi", "pi-vision.json");
/** Default path for the pi-vision response cache file (`~/.pi/pi-vision-cache.json`). */
export const getCachePath = () =>
  path.join(os.homedir(), ".pi", "pi-vision-cache.json");

const DEFAULT_CACHE_MAX_ENTRIES = 100;
const DEFAULT_MAX_IMAGES = 4;
/** Provider used when a configured model id has no explicit `provider/` prefix. */
const DEFAULT_VISION_PROVIDER = "neuralwatt";

/** Built-in prompt presets selectable via `/pi-vision:<preset>` commands. */
export const PRESET_PROMPTS = {
  default:
    "Describe this image in detail. If it contains text, transcribe it exactly. If it shows code, reproduce the code. If it shows a UI, describe the layout and elements. Respond in the same language as any text in the image.",
  ocr: "Transcribe all visible text exactly. Preserve line breaks, ordering, punctuation, and layout as much as possible. If text is unclear, mark it as [unclear]. Do not summarize unless needed to explain ambiguous layout.",
  ui: "Analyze this user interface screenshot. Describe the layout, visual hierarchy, controls, labels, states, navigation, and any notable UX issues. Include exact visible text when relevant.",
  code: "Extract and reproduce any visible code exactly. Identify the language if possible, preserve indentation, and mention file names, line numbers, errors, or UI context visible in the image.",
  diagram:
    "Explain this diagram. Identify nodes, labels, arrows, relationships, flow direction, legends, and any implied process. Summarize the core idea after describing the structure.",
  brief:
    "Briefly describe the image in 2-4 concise sentences. Include important text, UI state, code error, or diagram meaning if present.",
} as const;

export type PresetPromptMode = keyof typeof PRESET_PROMPTS;
export type PromptMode = PresetPromptMode | "custom";

export interface VisionConfig {
  model: string;
  prompt?: string;
  promptMode?: PromptMode;
  enabled?: boolean;
  cacheEnabled?: boolean;
  cacheMaxEntries?: number;
  maxImages?: number;
}

interface CacheEntry {
  createdAt: string;
  description: string;
  imageHash: string;
  mediaType: string;
  model: string;
  promptHash: string;
  promptMode: PromptMode;
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

interface LoadedConfig {
  config: VisionConfig;
  warning?: string;
}

/** Default pi-vision settings applied when no config file exists or fields are invalid. */
export const DEFAULT_CONFIG: VisionConfig = {
  model: "kimi-k2.6-fast",
  promptMode: "default",
  enabled: true,
  cacheEnabled: true,
  cacheMaxEntries: DEFAULT_CACHE_MAX_ENTRIES,
  maxImages: DEFAULT_MAX_IMAGES,
};

/** Vision models users can select for image description (NeuralWatt-routed). */
// Authoritative NeuralWatt vision-model ids (queried from GET /v1/models, 2026-06-18).
// Some NeuralWatt ids DO contain a slash (zai-org/GLM-5.1-FP8, neuralwatt/kimi-k2.6-long,
// moonshotai/Kimi-K2.5) — resolveModelRef() consults the registry so those resolve correctly.
// Default is kimi-k2.6-fast (non-reasoning) — the reasoning models (kimi-k2.7-code, kimi-k2.6)
// cancel mid-call on the vision path because they exceed Pi's read-tool timeout window before
// finishing thought. Non-reasoning fast tier returns in time reliably.
export const MODELS = [
  "kimi-k2.6-fast",
  "kimi-k2.5-fast",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "neuralwatt/kimi-k2.6-long",
  "moonshotai/Kimi-K2.5",
  "qwen3.6-35b",
  "qwen3.6-35b-fast",
];
/** Names of built-in prompt presets derived from {@link PRESET_PROMPTS}. */
export const PRESET_NAMES = Object.keys(PRESET_PROMPTS) as PresetPromptMode[];

/**
 * Mapping of flat colon-style Pi commands (e.g. `/pi-vision:status`) to their
 * corresponding slash-command arguments and human-readable descriptions.
 * Used to register individual Pi commands that delegate to the unified
 * `handlePiVisionCommand` handler.
 */
const COLON_COMMAND_ALIASES = [
  {
    name: "pi-vision:status",
    command: "status",
    description: "show status, model, prompt mode, and cache stats",
  },
  {
    name: "pi-vision:on",
    command: "on",
    description: "enable image description",
  },
  {
    name: "pi-vision:off",
    command: "off",
    description: "disable image description",
  },
  {
    name: "pi-vision:reset",
    command: "reset",
    description: "reset model, prompt mode, and cache settings",
  },
  {
    name: "pi-vision:prompt",
    command: "prompt",
    description: "show active prompt text",
  },
  {
    name: "pi-vision:prompt-set",
    command: "prompt",
    description: "save and use a custom prompt",
  },
  {
    name: "pi-vision:cache-status",
    command: "cache status",
    description: "show cache status and cache file path",
  },
  {
    name: "pi-vision:cache-on",
    command: "cache on",
    description: "enable response cache",
  },
  {
    name: "pi-vision:cache-off",
    command: "cache off",
    description: "disable response cache",
  },
  {
    name: "pi-vision:cache-clear",
    command: "cache clear",
    description: "clear cached responses",
  },
  {
    name: "pi-vision:cache-max",
    command: "cache max",
    description: "set maximum cache entries",
  },
  {
    name: "pi-vision:model",
    command: "model",
    description: "select vision model from a list",
  },
  {
    name: "pi-vision:mode",
    command: "mode",
    description: "select prompt preset from a list",
  },
  ...PRESET_NAMES.map((preset) => ({
    name: `pi-vision:${preset}`,
    command: preset,
    description: `switch to the ${preset} prompt preset`,
  })),
] as const;

export { COLON_COMMAND_ALIASES };

function isVisionModel(value: unknown): value is string {
  return typeof value === "string" && MODELS.includes(value);
}

function isPresetPromptMode(value: unknown): value is PresetPromptMode {
  return (
    typeof value === "string" &&
    PRESET_NAMES.includes(value as PresetPromptMode)
  );
}

function isPromptMode(value: unknown): value is PromptMode {
  return value === "custom" || isPresetPromptMode(value);
}

/**
 * Resolve a configured vision-model string into `(provider, modelId)` for
 * `modelRegistry.find()`. Model ids in this setup embed HuggingFace-style author
 * prefixes (e.g. `moonshotai/Kimi-K2.7-Code`, `Qwen/Qwen3.6-35B-A3B`) where
 * the part before the `/` is **not** a Pi provider — it's part of the id.
 *
 * Strategy: first try the whole string as a model id under the default vision
 * provider. If that doesn't resolve AND the string contains a `/`, try
 * treating the prefix as an explicit provider. Returns the best resolution
 * found (or the default-provider attempt if none resolve, so the downstream
 * `could not resolve` error reports a sensible value).
 */
export function resolveModelRef(
  ref: string,
  registry: { find(provider: string, modelId: string): unknown } | undefined,
): { provider: string; modelId: string } {
  const trimmed = ref.trim();

  // 1. Whole string as id under default provider (handles moonshotai/Kimi-K2.7-Code etc.)
  if (registry && registry.find(DEFAULT_VISION_PROVIDER, trimmed)) {
    return { provider: DEFAULT_VISION_PROVIDER, modelId: trimmed };
  }

  // 2. Explicit provider prefix (e.g. "neuralwatt/kimi-k2.6-long" → provider=neuralwatt, id=kimi-k2.6-long)
  const idx = trimmed.indexOf("/");
  if (idx > 0) {
    const provider = trimmed.slice(0, idx);
    const modelId = trimmed.slice(idx + 1);
    if (registry && registry.find(provider, modelId)) {
      return { provider, modelId };
    }
  }

  // 3. No registry to consult, or nothing resolved — return the default-provider
  //    attempt so error messages report the configured value verbatim.
  return { provider: DEFAULT_VISION_PROVIDER, modelId: trimmed };
}

function normalizeConfig(
  raw: Partial<VisionConfig>,
  warnings: string[] = [],
): VisionConfig {
  const config: VisionConfig = { ...DEFAULT_CONFIG };

  if ("model" in raw) {
    if (typeof raw.model === "string" && raw.model.trim()) {
      // Accept any non-empty model string (provider/model-id or bare id).
      config.model = raw.model;
    } else if (raw.model !== undefined) {
      warnings.push(
        `Invalid model "${String(raw.model)}". Using ${DEFAULT_CONFIG.model}.`,
      );
    }
  }

  if ("prompt" in raw) {
    if (typeof raw.prompt === "string") {
      config.prompt = raw.prompt;
    } else if (raw.prompt !== undefined) {
      warnings.push("prompt must be a string. Using the active preset prompt.");
    }
  }

  if ("promptMode" in raw) {
    if (isPromptMode(raw.promptMode)) {
      config.promptMode = raw.promptMode;
    } else if (raw.promptMode !== undefined) {
      warnings.push(
        `Unknown promptMode "${String(raw.promptMode)}". Using default.`,
      );
    }
  } else if (typeof raw.prompt === "string") {
    config.promptMode = "custom";
  }

  if ("enabled" in raw) {
    if (typeof raw.enabled === "boolean") {
      config.enabled = raw.enabled;
    } else if (raw.enabled !== undefined) {
      warnings.push("enabled must be true or false. Using enabled=true.");
    }
  }

  if ("cacheEnabled" in raw) {
    if (typeof raw.cacheEnabled === "boolean") {
      config.cacheEnabled = raw.cacheEnabled;
    } else if (raw.cacheEnabled !== undefined) {
      warnings.push(
        "cacheEnabled must be true or false. Using cacheEnabled=true.",
      );
    }
  }

  if ("cacheMaxEntries" in raw) {
    if (
      Number.isInteger(raw.cacheMaxEntries) &&
      (raw.cacheMaxEntries || 0) > 0
    ) {
      config.cacheMaxEntries = raw.cacheMaxEntries;
    } else if (raw.cacheMaxEntries !== undefined) {
      warnings.push(
        `cacheMaxEntries must be a positive integer. Using ${DEFAULT_CACHE_MAX_ENTRIES}.`,
      );
    }
  }

  if ("maxImages" in raw) {
    const normalized = normalizeMaxImages(raw.maxImages);
    config.maxImages = normalized;
    if (raw.maxImages !== normalized) {
      warnings.push(
        `maxImages must be a positive integer. Using ${DEFAULT_MAX_IMAGES}.`,
      );
    }
  }

  return config;
}

function loadConfigResult(configPath = getConfigPath()): LoadedConfig {
  try {
    const rawText = fs.readFileSync(configPath, "utf-8");
    const raw = JSON.parse(rawText);

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        config: { ...DEFAULT_CONFIG },
        warning: `Config ${configPath} must be a JSON object. Using defaults.`,
      };
    }

    const warnings: string[] = [];
    const config = normalizeConfig(raw, warnings);
    return {
      config,
      warning: warnings.length
        ? `Invalid ${configPath}: ${warnings.join(" ")}`
        : undefined,
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG } };
    }

    return {
      config: { ...DEFAULT_CONFIG },
      warning: `Could not read ${configPath}: ${err?.message || String(err)}. Using defaults.`,
    };
  }
}

/** Load pi-vision config from disk, falling back to {@link DEFAULT_CONFIG} for missing or invalid fields. */
export function loadConfig(configPath = getConfigPath()): VisionConfig {
  return loadConfigResult(configPath).config;
}

/** Persist pi-vision config to the path returned by {@link getConfigPath}. */
export function saveConfig(c: VisionConfig, configPath = getConfigPath()) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(normalizeConfig(c), null, 2));
}

// -- Cache ------------------------------------------------------
function loadCache(cachePath = getCachePath()): CacheFile {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (
      raw?.version === 1 &&
      raw.entries &&
      typeof raw.entries === "object" &&
      !Array.isArray(raw.entries)
    ) {
      return raw;
    }
  } catch {
    // Empty or invalid cache: start fresh.
  }
  return { version: 1, entries: {} };
}

function saveCache(cache: CacheFile, cachePath = getCachePath()) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

function hash(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getActivePrompt(c: VisionConfig): string {
  if (c.promptMode === "custom") return c.prompt || PRESET_PROMPTS.default;
  return (
    PRESET_PROMPTS[(c.promptMode || "default") as PresetPromptMode] ||
    PRESET_PROMPTS.default
  );
}

function getPromptLabel(c: VisionConfig): PromptMode {
  if (c.promptMode === "custom") return "custom";
  if (isPresetPromptMode(c.promptMode)) return c.promptMode;
  return "default";
}

function makeCacheKey(img: ImageData, model: string, prompt: string): string {
  const base64 = img.base64 || "";
  const imageHash = hash(Buffer.from(base64, "base64"));
  return hash(
    JSON.stringify({
      imageHash,
      mediaType: img.mediaType,
      url: img.url,
      model,
      prompt,
    }),
  );
}

function makeCacheEntry(
  img: ImageData,
  model: string,
  prompt: string,
  mode: PromptMode,
  description: string,
): CacheEntry {
  const base64 = img.base64 || "";
  return {
    createdAt: new Date().toISOString(),
    description,
    imageHash: hash(Buffer.from(base64, "base64")),
    mediaType: img.mediaType || "unknown",
    model,
    promptHash: hash(prompt),
    promptMode: mode,
  };
}

function pruneCache(cache: CacheFile, maxEntries: number) {
  const entries = Object.entries(cache.entries).sort(
    ([, a], [, b]) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  cache.entries = Object.fromEntries(entries.slice(0, maxEntries));
}

function cacheStats(cachePath = getCachePath()): {
  entries: number;
  path: string;
} {
  return {
    entries: Object.keys(loadCache(cachePath).entries).length,
    path: cachePath,
  };
}

function clearCache(cachePath = getCachePath()) {
  saveCache({ version: 1, entries: {} }, cachePath);
}

function statusText(
  c: VisionConfig,
  configPath: string,
  cachePath: string,
  warning?: string,
): string {
  const stats = cacheStats(cachePath);
  const prompt = getActivePrompt(c);
  return [
    `pi-vision: ${c.enabled !== false ? "ON" : "OFF"}`,
    `model: ${c.model}`,
    `prompt: ${getPromptLabel(c)}`,
    `cache: ${c.cacheEnabled !== false ? "ON" : "OFF"} (${stats.entries} entries, max ${c.cacheMaxEntries})`,
    `config: ${configPath}`,
    `cache file: ${stats.path}`,
    warning ? `warning: ${warning}` : undefined,
    `maxImages: ${c.maxImages || DEFAULT_MAX_IMAGES}`,
    `active prompt: ${prompt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// -- Image extraction ------------------------------------------
/** Normalized image payload extracted from Pi message content blocks. */
export interface ImageData {
  base64?: string;
  mediaType?: string;
  url?: string;
}

/** {@link ImageData} with a stable label for multi-image vision requests. */
export interface LabeledImageData extends ImageData {
  index: number;
  label: string;
}

/** Coerce a config value to a positive integer image limit, defaulting to {@link DEFAULT_MAX_IMAGES}. */
export function normalizeMaxImages(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_MAX_IMAGES;
  return Math.max(1, Math.floor(value));
}

function extractImageFromBlock(block: any): ImageData | null {
  if (block.type === "image" && block.source?.data) {
    return {
      base64: block.source.data,
      mediaType:
        block.source.mediaType || block.source.media_type || "image/png",
    };
  }
  if (block.type === "image" && block.data) {
    return {
      base64: block.data,
      mediaType: block.mediaType || block.media_type || "image/png",
    };
  }
  if (block.type === "image_url" && block.image_url?.url) {
    const url = block.image_url.url;
    if (url.startsWith("data:")) {
      const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
      if (match) return { base64: match[2], mediaType: match[1] };
      return null;
    }
    return { url };
  }
  return null;
}

/** Return the first extractable image from Pi message content blocks, if any. */
export function extractImage(content: any[]): ImageData | null {
  for (const block of content) {
    const img = extractImageFromBlock(block);
    if (img) return img;
  }
  return null;
}

/** Extract up to `limit` labeled images from Pi message content blocks. */
export function extractImages(
  content: any[],
  limit = Number.POSITIVE_INFINITY,
): LabeledImageData[] {
  const images: LabeledImageData[] = [];
  for (const block of content) {
    const image = extractImageFromBlock(block);
    if (!image) continue;
    const index = images.length + 1;
    images.push({ ...image, index, label: `Image ${index}` });
    if (images.length >= limit) break;
  }
  return images;
}

/** Count how many images can be extracted from Pi message content blocks. */
export function countExtractableImages(content: any[]): number {
  return extractImages(content).length;
}

/** Return whether Pi message content includes image or image_url blocks. */
export function hasImageContent(content: any[]): boolean {
  return content.some((b) => b.type === "image" || b.type === "image_url");
}

/** Build the user prompt sent to the vision model, including image labels and skip notes. */
export function visionPrompt(
  prompt: string,
  images: LabeledImageData[],
  skippedCount = 0,
): string {
  const labels = images.map((img) => img.label).join(", ");
  const skipped =
    skippedCount > 0
      ? ` ${skippedCount} additional image(s) were omitted due to the configured limit.`
      : "";
  return `${prompt}\n\nYou are receiving ${images.length} image(s), in the same order Pi provided them: ${labels}. Use these exact labels in the answer. Give per-image observations first, then any cross-image comparison or combined conclusion.${skipped}`;
}

/** Format a vision model response for injection back into Pi chat context. */
export function formatVisionResult(
  model: string,
  description: string,
  imageCount: number,
  skippedCount = 0,
): string {
  const skipped = skippedCount > 0 ? `, skipped: ${skippedCount}` : "";
  return `[pi-vision: ${model} | images: ${imageCount}${skipped}]\n\n${description}`;
}

// -- Vision API call -------------------------------------------
/**
 * Describe one or more labeled images via the configured vision model using
 * Pi's official `complete()` primitive (respects provider compat, auth, abort,
 * and the model registry's resolved request headers).
 */
export async function describeImages(
  images: LabeledImageData[],
  visionModel: Model<Api>,
  prompt: string,
  auth: { apiKey?: string; headers?: Record<string, string> },
  skippedCount = 0,
  signal?: AbortSignal,
): Promise<string> {
  const userContent: (PiAiImage | { type: "text"; text: string })[] = [
    { type: "text", text: visionPrompt(prompt, images, skippedCount) },
  ];
  for (const img of images) {
    userContent.push({ type: "text", text: `${img.label}:` });
    // pi-ai ImageContent: { type: "image", data: string, mimeType: string }
    userContent.push({
      type: "image",
      data: img.base64 || "",
      mimeType: img.mediaType || "image/png",
    });
  }

  const response = await complete(
    visionModel,
    {
      messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
    },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === "aborted") {
    throw new Error("pi-vision: vision request was cancelled");
  }
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error(
      "pi-vision: vision model returned an empty response. The original image was left attached.",
    );
  }
  return text;
}

/** Describe a single image via the configured vision model (convenience wrapper around {@link describeImages}). */
export async function describeImage(
  img: ImageData,
  visionModel: Model<Api>,
  prompt: string,
  auth: { apiKey?: string; headers?: Record<string, string> },
  signal?: AbortSignal,
): Promise<string> {
  const images: LabeledImageData[] = [{ ...img, index: 1, label: "Image 1" }];
  return describeImages(images, visionModel, prompt, auth, 0, signal);
}

/** Optional override paths for pi-vision config and cache files in tests or custom installs. */
export interface PiVisionExtensionOptions {
  configPath?: string;
  cachePath?: string;
}

// -- Extension --------------------------------------------------
/** Create the Pi extension that intercepts image messages and runs pi-vision. */
export function createPiVisionExtension(
  options: PiVisionExtensionOptions = {},
) {
  const configPath = options.configPath || getConfigPath();
  const cachePath = options.cachePath || getCachePath();

  return function piVisionExtension(pi: ExtensionAPI) {
    let { config, warning: configWarning } = loadConfigResult(configPath);

    // Captured from session_start — used in tool_result to drive the footer slot.
    // Mirrors the pi-quick-lint pattern: a tiny footer indicator (key "vis")
    // that lights up while a vision call is in flight and goes dim otherwise.
    let ui: {
      setStatus: (id: string, text: string | undefined) => void;
      theme: {
        fg: (
          color: "accent" | "success" | "error" | "warning" | "dim",
          text: string,
        ) => string;
      };
    } | null = null;

    // Reload config on session start.
    pi.on("session_start", async (_event, ctx) => {
      const loaded = loadConfigResult(configPath);
      config = loaded.config;
      configWarning = loaded.warning;
      if (ctx.ui?.setStatus) {
        ui = { setStatus: ctx.ui.setStatus, theme: ctx.ui.theme };
        // Idle footer slot — matches pi-quick-lint's `ql` convention.
        ctx.ui.setStatus("vis", ctx.ui.theme.fg("dim", "vis"));
      }
    });

    /** Set the footer to the in-flight vision state: green "vis → <model>". */
    const markInFlight = (label: string) => {
      ui?.setStatus("vis", ui.theme.fg("success", `vis → ${label}`));
    };
    /** Restore the idle footer state. */
    const markIdle = () => {
      ui?.setStatus("vis", ui.theme.fg("dim", "vis"));
    };

    // Intercept read tool results containing images — only when the active
    // model lacks image input (the whole point of the extension). If the active
    // model already supports images, let it handle the image natively.
    pi.on("tool_result", async (event, ctx) => {
      if (event.toolName !== "read") return;
      if (config.enabled === false) return;

      const currentModel = ctx.model;
      if (!currentModel) return;
      if (
        Array.isArray(currentModel.input) &&
        currentModel.input.includes("image")
      )
        return;

      const content = event.content as any[];
      if (!Array.isArray(content) || !hasImageContent(content)) return;

      const maxImages = normalizeMaxImages(config.maxImages);
      const totalImages = countExtractableImages(content);
      const images = extractImages(content, maxImages);
      if (!images.length) return;
      const skippedCount = Math.max(0, totalImages - images.length);

      const originalImages = content.filter(
        (b: any) => b.type === "image" || b.type === "image_url",
      );

      if (configWarning) {
        return {
          content: [
            {
              type: "text",
              text: `[pi-vision config warning: ${configWarning}]`,
            },
            ...originalImages,
          ],
        };
      }

      const prompt = getActivePrompt(config);
      const promptMode = getPromptLabel(config);

      // Cache: use first image hash + model + prompt as key.
      const cacheKey = makeCacheKey(images[0], config.model, prompt);

      if (config.cacheEnabled !== false) {
        const cache = loadCache(cachePath);
        const hit = cache.entries[cacheKey];
        if (hit) {
          // Cache hits don't touch the network — leave the footer in its idle state.
          return {
            content: [
              {
                type: "text",
                text: `[pi-vision: ${config.model}, prompt=${promptMode}, cache hit]\n\n${hit.description}`,
              },
            ],
          };
        }
      }

      // From here on we're about to make a network call — light up the footer.
      markInFlight(config.model);

      // Resolve the typed vision Model object from Pi's model registry.
      // resolveModelRef consults the registry so model ids like
      // `moonshotai/Kimi-K2.7-Code` (where the `/` prefix is part of the id,
      // not a provider) resolve correctly under the default vision provider.
      const { provider, modelId } = resolveModelRef(
        config.model,
        ctx.modelRegistry as
          | { find(p: string, m: string): unknown }
          | undefined,
      );
      const visionModel = ctx.modelRegistry.find(provider, modelId);
      if (!visionModel) {
        markIdle();
        return {
          content: [
            {
              type: "text",
              text: `[pi-vision error: could not resolve vision model '${config.model}'. Configure via /pi-vision:model]`,
            },
            ...originalImages,
          ],
        };
      }

      // Resolve auth (API key + headers) for the vision model.
      let auth: { apiKey?: string; headers?: Record<string, string> } = {};
      try {
        const resolved =
          await ctx.modelRegistry.getApiKeyAndHeaders(visionModel);
        if (resolved.ok)
          auth = { apiKey: resolved.apiKey, headers: resolved.headers };
      } catch {
        // fall through to no-auth error
      }

      if (!auth.apiKey) {
        markIdle();
        return {
          content: [
            {
              type: "text",
              text: `[pi-vision error: no API key for '${config.model}'. Run: pi --login ${provider}]`,
            },
            ...originalImages,
          ],
        };
      }

      try {
        const description = await describeImages(
          images,
          visionModel,
          prompt,
          auth,
          skippedCount,
          ctx.signal,
        );
        if (config.cacheEnabled !== false) {
          const cache = loadCache(cachePath);
          cache.entries[cacheKey] = makeCacheEntry(
            images[0],
            config.model,
            prompt,
            promptMode,
            description,
          );
          pruneCache(
            cache,
            config.cacheMaxEntries || DEFAULT_CACHE_MAX_ENTRIES,
          );
          saveCache(cache, cachePath);
        }
        return {
          content: [
            {
              type: "text",
              text: formatVisionResult(
                config.model,
                description,
                images.length,
                skippedCount,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `[pi-vision error: ${err.message}]`,
            },
            ...originalImages,
          ],
        };
      } finally {
        // Restore idle footer regardless of success/failure/cancel.
        markIdle();
      }
    });

    /**
     * Unified handler for all `/pi-vision` sub-commands (status, on, off,
     * reset, prompt, mode, cache, and model switching / prompt presets).
     *
     * @param args - Raw argument string after the command name (e.g. `"status"`, `"cache on"`, a model name).
     * @param ctx  - Pi command context providing `ui.notify` for user feedback and `signal` for abort support.
     */
    const handlePiVisionCommand = async (args: string, ctx: any) => {
      const trimmed = args.trim();
      const [command, ...rest] = trimmed.split(/\s+/).filter(Boolean);

      if (!trimmed || command === "status") {
        ctx.ui.notify(
          statusText(config, configPath, cachePath, configWarning),
          configWarning ? "warning" : "info",
        );
        return;
      }

      if (command === "on") {
        config.enabled = true;
        configWarning = undefined;
        saveConfig(config, configPath);
        ctx.ui.notify(`pi-vision: ON (${config.model})`, "info");
        return;
      }

      if (command === "off") {
        config.enabled = false;
        configWarning = undefined;
        saveConfig(config, configPath);
        ctx.ui.notify("pi-vision: OFF", "info");
        return;
      }

      if (command === "reset") {
        config = { ...DEFAULT_CONFIG };
        configWarning = undefined;
        saveConfig(config, configPath);
        ctx.ui.notify("pi-vision: reset to defaults", "info");
        return;
      }

      if (command === "prompt") {
        const nextPrompt = rest.join(" ").trim();
        if (!nextPrompt) {
          ctx.ui.notify(getActivePrompt(config), "info");
          return;
        }
        config.prompt = nextPrompt;
        config.promptMode = "custom";
        configWarning = undefined;
        saveConfig(config, configPath);
        ctx.ui.notify("pi-vision prompt: custom prompt saved", "info");
        return;
      }

      if (command === "model") {
        const modelArg = rest.join(" ").trim();
        if (modelArg) {
          if (isVisionModel(modelArg)) {
            config.model = modelArg;
            config.enabled = true;
            configWarning = undefined;
            saveConfig(config, configPath);
            ctx.ui.notify(`pi-vision model -> ${config.model}`, "info");
          } else {
            ctx.ui.notify(
              `Unknown model. Available: ${MODELS.join(", ")}`,
              "error",
            );
          }
          return;
        }

        if (!ctx.hasUI) {
          ctx.ui.notify(
            "pi-vision:model requires the Pi TUI. In non-interactive mode use /pi-vision <model>.",
            "warning",
          );
          return;
        }

        const selected = await ctx.ui.select(
          "Select vision model",
          [...MODELS],
          { signal: ctx.signal },
        );
        if (!selected || !isVisionModel(selected)) return;

        config.model = selected;
        config.enabled = true;
        configWarning = undefined;
        saveConfig(config, configPath);
        ctx.ui.notify(`pi-vision model -> ${config.model}`, "info");
        return;
      }

      if (command === "mode") {
        const mode = rest.join(" ").trim();
        if (!mode) {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              "pi-vision:mode requires the Pi TUI. In non-interactive mode use /pi-vision mode <preset>.",
              "warning",
            );
            return;
          }

          const selected = await ctx.ui.select(
            "Select prompt preset",
            [...PRESET_NAMES],
            { signal: ctx.signal },
          );
          if (!selected || !isPresetPromptMode(selected)) return;

          config.promptMode = selected;
          config.prompt = undefined;
          configWarning = undefined;
          saveConfig(config, configPath);
          ctx.ui.notify(`pi-vision prompt mode -> ${selected}`, "info");
          return;
        }

        if (isPresetPromptMode(mode)) {
          config.promptMode = mode;
          config.prompt = undefined;
          configWarning = undefined;
          saveConfig(config, configPath);
          ctx.ui.notify(`pi-vision prompt mode -> ${mode}`, "info");
        } else {
          ctx.ui.notify(
            `Unknown prompt mode. Available: ${PRESET_NAMES.join(", ")}`,
            "error",
          );
        }
        return;
      }

      if (command === "cache") {
        const subcommand = rest[0];
        if (!subcommand || subcommand === "status") {
          const stats = cacheStats(cachePath);
          ctx.ui.notify(
            `pi-vision cache: ${config.cacheEnabled !== false ? "ON" : "OFF"}, ${stats.entries} entries, max ${config.cacheMaxEntries}\n${stats.path}`,
            "info",
          );
          return;
        }
        if (subcommand === "on") {
          config.cacheEnabled = true;
          configWarning = undefined;
          saveConfig(config, configPath);
          ctx.ui.notify("pi-vision cache: ON", "info");
          return;
        }
        if (subcommand === "off") {
          config.cacheEnabled = false;
          configWarning = undefined;
          saveConfig(config, configPath);
          ctx.ui.notify("pi-vision cache: OFF", "info");
          return;
        }
        if (subcommand === "clear") {
          clearCache(cachePath);
          ctx.ui.notify("pi-vision cache: cleared", "info");
          return;
        }
        if (subcommand === "max") {
          const maxEntries = Number(rest[1]);
          if (Number.isInteger(maxEntries) && maxEntries > 0) {
            config.cacheMaxEntries = maxEntries;
            configWarning = undefined;
            saveConfig(config, configPath);
            const cache = loadCache(cachePath);
            pruneCache(cache, maxEntries);
            saveCache(cache, cachePath);
            ctx.ui.notify(`pi-vision cache max -> ${maxEntries}`, "info");
          } else {
            ctx.ui.notify(
              "Usage: /pi-vision:cache-max <positive integer>",
              "error",
            );
          }
          return;
        }
        ctx.ui.notify(
          "Unknown cache command. Try /pi-vision:cache-status, /pi-vision:cache-clear, /pi-vision:cache-on, or /pi-vision:cache-off.",
          "error",
        );
        return;
      }

      if (isPresetPromptMode(command)) {
        config.promptMode = command;
        config.prompt = undefined;
        configWarning = undefined;
        saveConfig(config, configPath);
        ctx.ui.notify(`pi-vision prompt mode -> ${command}`, "info");
        return;
      }

      if (isVisionModel(trimmed)) {
        config.model = trimmed;
        config.enabled = true;
        configWarning = undefined;
        saveConfig(config, configPath);
        ctx.ui.notify(`pi-vision model -> ${config.model}`, "info");
      } else {
        ctx.ui.notify(
          `Unknown command: ${trimmed}. Try /pi-vision:model, /pi-vision:mode, or /pi-vision:status.`,
          "error",
        );
      }
    };

    // Legacy /pi-vision space-dispatch (kept for backward compatibility).
    pi.registerCommand("pi-vision", {
      description:
        "Configure the vision model, prompt presets, and response cache. Prefer colon commands such as /pi-vision:status.",
      getArgumentCompletions(prefix: string) {
        const options = [
          "status",
          "on",
          "off",
          "reset",
          "prompt",
          "cache on",
          "cache off",
          "cache clear",
          "cache status",
          "cache max ",
          ...MODELS,
          ...PRESET_NAMES,
          ...PRESET_NAMES.map((m) => `mode ${m}`),
        ];
        return options
          .filter((m) => m.startsWith(prefix))
          .map((m) => ({ value: m, label: m }));
      },
      handler: async (args, ctx) => {
        await handlePiVisionCommand(String(args ?? "").trim(), ctx);
      },
    });

    for (const alias of COLON_COMMAND_ALIASES) {
      pi.registerCommand(alias.name, {
        description: `pi-vision: ${alias.description}. Alias for /pi-vision ${alias.command}.`,
        handler: async (args, ctx) => {
          const value = String(args ?? "").trim();
          await handlePiVisionCommand(
            value ? `${alias.command} ${value}` : alias.command,
            ctx,
          );
        },
      });
    }
  };
}

export default createPiVisionExtension();
