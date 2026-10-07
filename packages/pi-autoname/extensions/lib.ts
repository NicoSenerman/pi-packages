/**
 * pi-autoname pure utility functions.
 * Extracted for testability — no side effects, no network.
 * `loadRegistryDefaults` is the one fs reader; everything else stays pure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, replacement: "$1[REDACTED]" },
  { re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*["']?[^"'\s]+/g, replacement: "$1=[REDACTED]" },
  { re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"'\s,;]+/gi, replacement: "$1=[REDACTED]" },
];

export interface DialoguePart {
  role: "user" | "assistant";
  text: string;
}

export type NamingLanguage = "Chinese" | "English" | "Spanish" | "Japanese" | "Korean";

const SPANISH_MARKERS =
  /\b(?:el|la|los|las|un|una|que|para|por|con|como|cómo|qué|sesión|archivo|gracias|hola|puedes|necesito|también|esto|esta)\b/gi;
const ENGLISH_MARKERS =
  /\b(?:the|and|for|with|this|that|please|help|session|file|error|thanks|hello|can|need|you)\b/gi;

function naturalLanguageText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:^|\s)(?:~\/|\/)[^\s]+/g, " ")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:const|let|var|function|class|import|export|return)\b|[{};]|=>/.test(line))
    .join(" ");
}

function scriptCount(text: string, script: RegExp): number {
  return (text.match(script) ?? []).length;
}

/**
 * Determines the language from user-authored natural-language text only.
 * CJK scripts receive extra weight so paths and code identifiers do not
 * outweigh prose in a Chinese, Japanese, or Korean request.
 */
export function detectDominantUserLanguage(parts: DialoguePart[]): NamingLanguage | undefined {
  const scores: Record<NamingLanguage, number> = {
    Chinese: 0,
    English: 0,
    Spanish: 0,
    Japanese: 0,
    Korean: 0,
  };
  const firstSeen = new Map<NamingLanguage, number>();
  let seen = 0;

  const addScore = (language: NamingLanguage, score: number) => {
    if (score <= 0) return;
    if (!firstSeen.has(language)) firstSeen.set(language, seen);
    scores[language] += score;
  };

  for (const part of parts) {
    if (part.role !== "user") continue;
    const text = naturalLanguageText(part.text);
    const han = scriptCount(text, /\p{Script=Han}/gu);
    const kana = scriptCount(text, /[\u3040-\u30ff\u31f0-\u31ff]/gu);
    const hangul = scriptCount(text, /\p{Script=Hangul}/gu);
    const hasCjk = han > 0 || kana > 0 || hangul > 0;
    addScore(kana > 0 ? "Japanese" : "Chinese", (kana > 0 ? kana + han : han) * 2);
    addScore("Korean", hangul * 2);
    // A user message that already contains CJK is a CJK-language message: the
    // Latin characters inside it (paths, code identifiers, or system log/error
    // noise co-injected into the same message) must not dilute the user's CJK
    // intent. Only purely-Latin user messages contribute to English.
    // Latin script is not automatically English. Score Spanish vs English from
    // function words so a Spanish (or mixed) user is not forced into English.
    if (!hasCjk) {
      const latin = scriptCount(text, /\p{Script=Latin}/gu);
      const spanish = (text.match(SPANISH_MARKERS) ?? []).length;
      const english = (text.match(ENGLISH_MARKERS) ?? []).length;
      addScore(spanish > english && spanish > 0 ? "Spanish" : "English", latin);
    }
    seen += 1;
  }

  return (Object.keys(scores) as NamingLanguage[])
    .filter((language) => scores[language] > 0)
    .sort((left, right) => scores[right] - scores[left] || (firstSeen.get(left) ?? Infinity) - (firstSeen.get(right) ?? Infinity))[0];
}

function localeLanguageName(locale: string): string {
  const primary = locale.trim().replace(/_/g, "-").split("-")[0]?.toLowerCase();
  if (primary === "zh") return "Chinese";
  if (primary === "ja") return "Japanese";
  if (primary === "ko") return "Korean";
  if (primary === "es") return "Spanish";
  if (primary === "en") return "English";
  return locale.trim();
}

/** Builds an explicit language requirement for the naming model. */
export function getNamingLanguageInstruction(parts: DialoguePart[], fallbackLocale?: string): string {
  const language = detectDominantUserLanguage(parts);
  if (language === "Chinese") return "Write the label in Chinese, preserving the Simplified or Traditional script used by the user. This language is determined from user messages only.";
  if (language === "English") {
    return "Write the label in the same language as the user messages. Keep English when the user wrote English; do not translate Spanish or another Latin-script language into English. This language is determined from user messages only.";
  }
  if (language) return `Write the label in ${language}. This language is determined from user messages only.`;
  if (fallbackLocale?.trim()) return `No natural-language user text was detected. Use the language selected in the user's Pi locale: ${localeLanguageName(fallbackLocale)}.`;
  return "No natural-language user text was detected. Infer the label language from user messages only, never from assistant messages.";
}

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
   * Last-resort naming model. The shared utility-models registry
   * (~/.pi/agent/utility-models.json, `autoname` role) supplies the default
   * when present; the consumer's own pi-autoname.json always wins.
   */
  model: "ollama-cloud/glm-5.3-flash",
  fallbackModels: [],
  cooldownMinutes: 10,
  debug: false,
  respectManualName: false,
};

/**
 * Read the shared utility-models registry's `autoname` role. Returns
 * undefined on any read/parse error — callers fall back to DEFAULT_CONFIG.
 */
export function loadRegistryDefaults(
  agentDir: string,
): Partial<Pick<AutonameConfig, "model" | "fallbackModels">> {
  try {
    const raw = readFileSync(join(agentDir, "utility-models.json"), "utf-8");
    const entry = JSON.parse(raw)?.autoname;
    if (!entry || typeof entry.model !== "string") return {};
    const fallbacks = Array.isArray(entry.fallbacks)
      ? entry.fallbacks.filter((f: unknown): f is string => typeof f === "string")
      : [];
    return {
      model: entry.model.trim(),
      ...(fallbacks.length ? { fallbackModels: fallbacks } : {}),
    };
  } catch {
    return {};
  }
}

export function normalizeConfig(input: unknown): AutonameConfig {
  if (!input || typeof input !== "object") return { ...DEFAULT_CONFIG };

  const raw = input as Record<string, unknown>;
  const cooldown =
    typeof raw.cooldownMinutes === "number" && Number.isFinite(raw.cooldownMinutes)
      ? Math.min(MAX_COOLDOWN_MINUTES, Math.max(MIN_COOLDOWN_MINUTES, raw.cooldownMinutes))
      : DEFAULT_CONFIG.cooldownMinutes;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    model: typeof raw.model === "string" ? raw.model.trim() : DEFAULT_CONFIG.model,
    fallbackModels: Array.isArray(raw.fallbackModels)
      ? raw.fallbackModels
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [...DEFAULT_CONFIG.fallbackModels],
    cooldownMinutes: cooldown,
    debug: typeof raw.debug === "boolean" ? raw.debug : DEFAULT_CONFIG.debug,
    respectManualName:
      typeof raw.respectManualName === "boolean" ? raw.respectManualName : DEFAULT_CONFIG.respectManualName,
  };
}

export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let output = text;

  for (const { re, replacement } of SENSITIVE_PATTERNS) {
    output = output.replace(re, (...args) => {
      redacted = true;
      return replacement.replace(/\$(\d+)/g, (_, index) => String(args[Number(index)] ?? ""));
    });
  }

  return { text: output, redacted };
}

export function isHighQualityName(name: string): boolean {
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) return false;
  if (RAW_SLICE_RE.test(name)) return false;
  if (SENTENCE_END_RE.test(name)) return false;
  if ((name.match(/[，,。！？!?]/g) || []).length > 1) return false;
  return /[\p{L}\p{N}]/u.test(name);
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
      /^(?:我(?:觉得|感觉|发现|想要|想知道|怀疑)?\s*|你(?:能|可以|帮)\s*(?:我\s*)?|请(?:你|帮我)?\s*|Can you\s*(?:please\s*)?(?:help me\s*)?|Could you\s*(?:please\s*)?(?:help me\s*)?|Please\s*(?:help me\s*)?|I\s*(?:think|feel|want|need|noticed)\s*(?:that\s*)?|Is it possible to\s*|I wonder if\s*|I'm wondering about\s*)/i,
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

  // Keep fallbacks inside the quality gate. A 31-45 char slice passes the
  // cut above and is then rejected, leaving the session unnamed.
  if (s.length > MAX_NAME_LENGTH) {
    const slice = s.slice(0, MAX_NAME_LENGTH);
    const lastSpace = slice.lastIndexOf(" ");
    s = lastSpace > MIN_NAME_LENGTH ? slice.slice(0, lastSpace) : slice;
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

  // user_rename flavor — written when session_info_changed observes a /name
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

export function getRecentDialogue(branch: any[], maxMessages = 6): DialoguePart[] {
  const items: DialoguePart[] = [];

  for (let index = branch.length - 1; index >= 0 && items.length < maxMessages; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || !entry.message) continue;

    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = blockText(entry.message.content);
    if (text) items.push({ role, text });
  }

  return items.reverse();
}

/**
 * Old sessions without an autoname marker should be named from their current
 * topic, while a new session keeps the first-dialogue behavior.
 */
export function getInitialDialogue(branch: any[]): DialoguePart[] {
  const recent = getRecentDialogue(branch);
  let messageCount = 0;
  for (let index = branch.length - 1; index >= 0 && messageCount <= 2; index -= 1) {
    const role = branch[index]?.message?.role;
    if (role === "user" || role === "assistant") messageCount += 1;
  }

  if (messageCount > 2) return recent;

  const { firstUser, firstAssistant } = getFirstDialogue(branch);
  if (!firstUser || !firstAssistant) return [];
  return [
    { role: "user", text: firstUser },
    { role: "assistant", text: firstAssistant },
  ];
}

function oneLiner(s: string): string {
  return String(s).replace(/\s+/g, " ").trim();
}

function shortPath(p: string): string {
  return String(p)
    .replace(/^.*\/Documents\//, "")
    .replace(/^.*\/Projects\//, "");
}

function summarizeToolCall(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return name;
  const a = args as Record<string, unknown>;
  const path = typeof a.path === "string" ? a.path : undefined;
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
 * First user intent plus recent assistant turns, with tool calls inlined as
 * `[→ edit src/foo.ts]`. Used as extra context so names reflect work done,
 * not only greetings. Thinking blocks and tool results are skipped.
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
    if (role === "toolResult" || (role !== "user" && role !== "assistant")) continue;

    if (typeof content === "string") {
      const text = content.trim();
      if (!text) continue;
      if (role === "user" && !firstUser) firstUser = { role: "user", text };
      else if (role === "assistant") assistantTurns.push({ role: "assistant", text });
      continue;
    }

    if (!Array.isArray(content)) continue;

    if (role === "user") {
      const text = content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join(" ")
        .trim();
      if (text && !firstUser) firstUser = { role: "user", text };
      continue;
    }

    const segments: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        const t = block.text.trim();
        if (t) segments.push(t);
      } else if (block.type === "toolCall") {
        segments.push(
          `[→ ${summarizeToolCall(typeof block.name === "string" ? block.name : "tool", block.arguments)}]`,
        );
      }
    }
    const text = segments.join(" ").trim();
    if (text) assistantTurns.push({ role: "assistant", text });
  }

  const result: Array<{ role: string; text: string }> = [];
  if (firstUser) result.push(firstUser);
  result.push(...assistantTurns.slice(-maxAssistantTurns));
  return result;
}
