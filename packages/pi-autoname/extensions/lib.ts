/**
 * pi-autoname pure utility functions.
 * Extracted for testability — no side effects, no fs, no network.
 */

/** A name this short was likely a failed AI response */
export const MIN_NAME_LENGTH = 3;

/** Max length for a session name — anything longer is likely a raw sentence */
export const MAX_NAME_LENGTH = 30;

/** Names matching this pattern are raw-slice fallbacks (bad) */
export const RAW_SLICE_RE =
  /^(?:我|你|他|她|它|请|帮|能|可|可以|能不能|请帮|感觉|突然|我想|我想知道|有没有|是不是|为什么|怎么|如何|What|Can|Could|Please|Help|I want|I need|Is there|Why|How)/;

/** Sentence-ending punctuation — a real session name should not contain these */
export const SENTENCE_END_RE = /[。！？!?.…]+\s*$/;

export const MIN_COOLDOWN_MINUTES = 1;
export const MAX_COOLDOWN_MINUTES = 24 * 60;

export const SENSITIVE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, replacement: "$1[REDACTED]" },
  {
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*["']?[^"'\s]+/g,
    replacement: "$1=[REDACTED]",
  },
  {
    re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"'\s,;]+/gi,
    replacement: "$1=[REDACTED]",
  },
];

export interface AutonameConfig {
  enabled?: boolean;
  model?: string;
  fallbackModels?: string[];
  cooldownMinutes?: number;
  debug?: boolean;
  /**
   * When `false` (default), pi-autoname owns session naming:
   * automatic naming runs on first dialogue and periodically
   * (every `cooldownMinutes`), and may overwrite a name the
   * user set via `/name` or `/autoname`. The only escape hatch
   * is `respectManualName: true`, which preserves the legacy
   * behavior of treating a user-issued rename as sticky.
   *
   * Note: with the default behavior, Pi's built-in `/name`
   * command is largely redundant — prefer `/autoname` if you
   * want to force a re-name from the current conversation.
   */
  respectManualName?: boolean;
}

export const DEFAULT_CONFIG: Required<AutonameConfig> = {
  enabled: true,
  /**
   * Default naming model. Resolves (via ctx.modelRegistry.find / getModel)
   * to the `ollama-cloud` provider entry in ~/.pi/agent/models.json, which
   * points at https://ollama.com/v1 (openai-completions API).
   */
  model: "ollama-cloud/deepseek-v4-flash",
  fallbackModels: [],
  cooldownMinutes: 10,
  debug: false,
  respectManualName: false,
};

export function normalizeConfig(input: unknown): AutonameConfig {
  if (!input || typeof input !== "object") return { ...DEFAULT_CONFIG };

  const raw = input as Record<string, unknown>;
  const cooldown =
    typeof raw.cooldownMinutes === "number" &&
    Number.isFinite(raw.cooldownMinutes)
      ? Math.min(
          MAX_COOLDOWN_MINUTES,
          Math.max(MIN_COOLDOWN_MINUTES, raw.cooldownMinutes),
        )
      : DEFAULT_CONFIG.cooldownMinutes;

  return {
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    model:
      typeof raw.model === "string" ? raw.model.trim() : DEFAULT_CONFIG.model,
    fallbackModels: Array.isArray(raw.fallbackModels)
      ? raw.fallbackModels
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [...DEFAULT_CONFIG.fallbackModels],
    cooldownMinutes: cooldown,
    debug: typeof raw.debug === "boolean" ? raw.debug : DEFAULT_CONFIG.debug,
    respectManualName:
      typeof raw.respectManualName === "boolean"
        ? raw.respectManualName
        : DEFAULT_CONFIG.respectManualName,
  };
}

export function redactSensitiveText(text: string): {
  text: string;
  redacted: boolean;
} {
  let redacted = false;
  let output = text;

  for (const { re, replacement } of SENSITIVE_PATTERNS) {
    output = output.replace(re, (...args) => {
      redacted = true;
      return replacement.replace(/\$(\d+)/g, (_, index) =>
        String(args[Number(index)] ?? ""),
      );
    });
  }

  return { text: output, redacted };
}

export function isHighQualityName(name: string): boolean {
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH)
    return false;
  if (RAW_SLICE_RE.test(name)) return false;
  if (SENTENCE_END_RE.test(name)) return false;
  if ((name.match(/[，,。！？!?]/g) || []).length > 1) return false;
  const hasContent =
    /[\u4e00-\u9fff]/.test(name) ||
    /^[A-Za-z][A-Za-z0-9_\-\s]{2,30}$/.test(name);
  return hasContent;
}

export function blockText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ")
    .trim();
}

export function smartFallbackName(text: string): string {
  let s = text.slice(0, 200).replace(/\n/g, " ").trim();

  s = s
    .replace(
      /^(?:我(?:觉得|感觉|发现|想要|想知道|怀疑)?\s*|你(?:能|可以|帮)\s*(?:我\s*)?|请(?:你|帮我)?\s*|Can you\s*(?:please\s*)?|Could you\s*(?:please\s*)?|Please\s*(?:help me\s*)?|I\s*(?:think|feel|want|need|noticed)\s*(?:that\s*)?|Is it possible to\s*|I wonder if\s*|I'm wondering about\s*)/i,
      "",
    )
    .trim();

  const sentenceEnd = s.match(/[.!?。！？]/);
  if (sentenceEnd && sentenceEnd.index! < 60) {
    s = s.slice(0, sentenceEnd.index! + 1);
  } else if (s.length > 45) {
    const cut = s.lastIndexOf(" ", 45);
    s = cut > 10 ? s.slice(0, cut) : s.slice(0, 42);
  }

  s = s.replace(/(?:吗|呢|吧|啊|呀|哦|嘛|的|了|着|过)[\s,，.。]*$/, "").trim();
  s = s.replace(/[。！？!?.…]+\s*$/, "").trim();

  // Final guard: clamp to MAX_NAME_LENGTH so the result always passes
  // isHighQualityName's length check. Without this, a fallback of 31-45
  // chars passes the 45-char cut above but is rejected by the 30-char
  // quality gate — leaving the user with no name at all.
  if (s.length > MAX_NAME_LENGTH) {
    // For Latin text, cut at the last word boundary ≤ MAX_NAME_LENGTH
    // so we don't split a word in half. For CJK (no spaces), hard-cut.
    const slice = s.slice(0, MAX_NAME_LENGTH);
    const lastSpace = slice.lastIndexOf(" ");
    s = lastSpace > MIN_NAME_LENGTH ? slice.slice(0, lastSpace) : slice;
    // Re-strip any trailing punctuation the cut may have exposed.
    s = s.replace(/[。！？!?.…,，\s]+$/, "").trim();
  }

  return s || text.slice(0, 40).replace(/\n/g, " ").trim();
}

/** A persisted pi-autoname state marker — one of three flavors. */
export type RenameMarker =
  | { kind: "ai"; name: string; source: "ai"; timestamp: number }
  | { kind: "fallback"; name: string; source: "fallback"; timestamp: number }
  | { kind: "user_rename"; name: string; timestamp: number };

/**
 * Parse a single `pi-autoname-state` entry's `data` payload into a typed
 * RenameMarker. Returns undefined when the payload doesn't match any
 * known shape (e.g. legacy entries from older versions, or corrupted
 * data). When parsing the timestamp, defaults to 0 if missing/invalid
 * so that the marker is still useful for relative ordering.
 */
export function parseRenameMarker(data: unknown): RenameMarker | undefined {
  if (!data || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;

  // user_rename flavor — written by agent_end when it detects a /name
  // out-of-band change.
  if (obj.event === "user_rename" && typeof obj.name === "string") {
    return {
      kind: "user_rename",
      name: obj.name,
      timestamp: typeof obj.timestamp === "number" ? obj.timestamp : 0,
    };
  }

  // ai / fallback flavor — written after a successful naming pass.
  if (obj.source === "ai" && typeof obj.name === "string") {
    return {
      kind: "ai",
      name: obj.name,
      source: "ai",
      timestamp: typeof obj.timestamp === "number" ? obj.timestamp : 0,
    };
  }
  if (obj.source === "fallback" && typeof obj.name === "string") {
    return {
      kind: "fallback",
      name: obj.name,
      source: "fallback",
      timestamp: typeof obj.timestamp === "number" ? obj.timestamp : 0,
    };
  }

  return undefined;
}

export function getFirstDialogue(branch: any[]) {
  let firstUser: string | undefined;
  let firstAssistant: string | undefined;

  for (const entry of branch) {
    if (entry?.type === "message" && entry.message) {
      const role = entry.message.role;
      const text = blockText(entry.message.content);
      if (!text) continue;
      if (!firstUser && role === "user") firstUser = text;
      if (firstUser && !firstAssistant && role === "assistant") {
        firstAssistant = text;
        break;
      }
    }

    if (entry?.type === "compaction" && !firstUser) {
      const summary = blockText(entry.summary ?? entry.content);
      if (summary) firstUser = summary;
    }
  }

  return { firstUser, firstAssistant };
}

export function getRecentDialogue(branch: any[], maxMessages = 6) {
  const items: Array<{ role: string; text: string }> = [];
  for (const entry of branch) {
    if (entry?.type === "message" && entry.message) {
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = blockText(entry.message.content);
      if (!text) continue;
      items.push({ role, text });
    }
  }
  return items.slice(-maxMessages);
}

/** Collapse whitespace in a command/string to a single line. */
function oneLiner(s: string): string {
  return String(s).replace(/\s+/g, " ").trim();
}

/** Strip home/project prefixes so tool-call markers stay short. */
function shortPath(p: string): string {
  return String(p)
    .replace(/^.*\/Documents\//, "")
    .replace(/^.*\/Projects\//, "");
}

/**
 * Summarize a single tool call into a short inline marker token like
 * `read src/foo.ts`, `run: git status`, `delegate→researcher`. Keeps the
 * naming prompt compact while still telling the model what was DONE.
 */
function summarizeToolCall(name: string, args: any): string {
  if (!args || typeof args !== "object") return name;
  const a = args as Record<string, unknown>;
  const path = typeof a.path === "string" ? (a.path as string) : undefined;
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return path ? `${name} ${shortPath(path)}` : name;
    case "bash":
      return typeof a.command === "string"
        ? `run: ${oneLiner(a.command).slice(0, 80)}`
        : "bash";
    case "grep":
      return typeof a.pattern === "string"
        ? `grep "${String(a.pattern).slice(0, 30)}"`
        : "grep";
    case "find":
      return typeof a.pattern === "string" ? `find ${a.pattern}` : "find";
    case "subagent":
      // Accept either `agent` (current) or `subagent_type` (older/generic).
      return typeof a.agent === "string" || typeof a.subagent_type === "string"
        ? `delegate→${(a.agent as string) || (a.subagent_type as string)}`
        : "delegate";
    case "todo":
      return "todo";
    default:
      return name;
  }
}

/**
 * Extract a rich dialogue transcript including tool calls, so the naming
 * model can see what was actually DONE (files touched, commands run),
 * not just greetings. Assistant messages include their tool calls inline
 * as `[→ edit src/foo.ts]`, `[→ run: git status]`, `[→ delegate→worker]`.
 * Thinking blocks are skipped (internal, not a work signal).
 *
 * Returns: the FIRST user message (the intent) + the LAST `maxAssistantTurns`
 * assistant turns. A user-only session (no assistant reply yet) still
 * returns `[firstUser]` so first-dialogue naming can name it — v1 skipped
 * these entirely.
 */
export function getRichDialogue(
  branch: any[],
  maxAssistantTurns = 12,
): Array<{ role: string; text: string }> {
  let firstUser: { role: string; text: string } | undefined;
  const assistantTurns: Array<{ role: string; text: string }> = [];

  for (const entry of branch) {
    if (entry?.type !== "message" || !entry.message) continue;
    const role: string = entry.message.role;
    const content = entry.message.content;

    // toolResult role messages are noise (tool output piped back to the
    // assistant) — skip them entirely so the transcript stays clean.
    if (role === "toolResult" || (role !== "user" && role !== "assistant")) {
      continue;
    }

    if (typeof content === "string") {
      const text = content.trim();
      if (!text) continue;
      if (role === "user" && !firstUser) {
        firstUser = { role: "user", text };
      } else if (role === "assistant") {
        assistantTurns.push({ role: "assistant", text });
      }
      continue;
    }

    if (!Array.isArray(content)) continue;

    if (role === "user") {
      // For user messages, collect text blocks only — tool results are
      // noisy and the user's intent is in the text. (Tool-result
      // content typically arrives as role=toolResult anyway.)
      const text = content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join(" ")
        .trim();
      if (text && !firstUser) {
        firstUser = { role: "user", text };
      }
      continue;
    }

    // role === "assistant": collect text blocks + summarize each toolCall
    // inline as a readable marker.
    const segments: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        const t = block.text.trim();
        if (t) segments.push(t);
      } else if (block.type === "toolCall") {
        const marker = summarizeToolCall(
          typeof block.name === "string" ? block.name : "tool",
          block.arguments,
        );
        segments.push(`[→ ${marker}]`);
      }
      // skip thinking blocks — internal reasoning, not a work signal.
    }
    const text = segments.join(" ").trim();
    if (text) {
      assistantTurns.push({ role: "assistant", text });
    }
  }

  const result: Array<{ role: string; text: string }> = [];
  if (firstUser) result.push(firstUser);
  // Keep the most recent maxAssistantTurns so the prompt reflects
  // the latest work, not stale early turns.
  const recent = assistantTurns.slice(-maxAssistantTurns);
  result.push(...recent);
  return result;
}
