/**
 * Preview box helpers for the ask_user split-pane / stacked preview.
 *
 * Lifted from a richer predecessor extension and adapted to this fork:
 *   - reads `option.description` (not a separate `preview` field)
 *   - takes `QuestionOption[]` directly (no multi-question questionnaire)
 *   - no i18n — uses a literal `NO_PREVIEW_TEXT` placeholder
 *   - drops the inline-notes affordance (fork has no notes editor)
 *
 * Three concerns live here:
 *   #2 `stripFenceMarkers` / `renderBorderedBox` / `computeBoxDimensions` +
 *      border constants + `MAX_PREVIEW_HEIGHT_*` height caps
 *   #3 `MarkdownContentCache` — per-option markdown render cache keyed by
 *      width, self-invalidating on width change
 *   #4 `decideLayout` / `adaptiveLeftWidth` / `columnWidths` / `bodyWidths` +
 *      layout constants — adaptive left-column width + stacked fallback
 *
 * Compiles standalone (only pre-existing pi-tui / node module-resolution noise).
 */

import {
  Markdown,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { QuestionOption } from "./single-select-layout.ts";

// ---------------------------------------------------------------------------
// #2 — Bordered markdown box + truncation indicator
// ---------------------------------------------------------------------------

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const ANSI_OSC8_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FENCE_MARKER_RE = /^`{3}/;

export const BORDER_VERTICAL_OVERHEAD = 2;
export const BORDER_HORIZONTAL_OVERHEAD = 2;
export const BORDER_INNER_PADDING_HORIZONTAL = 1;
export const BOX_MIN_CONTENT_WIDTH = 40;

export function stripFenceMarkers(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const clean = line.replace(ANSI_SGR_RE, "").replace(ANSI_OSC8_RE, "");
    return !FENCE_MARKER_RE.test(clean);
  });
}

export function renderBorderedBox(
  lines: readonly string[],
  width: number,
  colorFn: (s: string) => string,
  hidden = 0,
): string[] {
  const dashSpan = Math.max(1, width - BORDER_HORIZONTAL_OVERHEAD);
  const contentInner = Math.max(
    1,
    dashSpan - 2 * BORDER_INNER_PADDING_HORIZONTAL,
  );
  const pad = " ".repeat(BORDER_INNER_PADDING_HORIZONTAL);
  const top = colorFn(`┌${"─".repeat(dashSpan)}┐`);
  const out: string[] = [top];
  for (const line of lines) {
    const padded = truncateToWidth(line, contentInner, "", true);
    out.push(`${colorFn("│")}${pad}${padded}${pad}${colorFn("│")}`);
  }
  if (hidden > 0) {
    const indicator = ` ✂ ── ${hidden} lines hidden ── `;
    const space = dashSpan - indicator.length;
    const leftFill = "─".repeat(Math.max(0, Math.floor(space / 2)));
    const rightFill = "─".repeat(
      Math.max(0, dashSpan - leftFill.length - indicator.length),
    );
    out.push(colorFn(`└${leftFill}${indicator}${rightFill}┘`));
  } else {
    out.push(colorFn(`└${"─".repeat(dashSpan)}┘`));
  }
  return out;
}

export function computeBoxDimensions(
  contentLines: readonly string[],
  maxInnerWidth: number,
): { innerWidth: number; boxWidth: number } {
  let widest = Math.min(BOX_MIN_CONTENT_WIDTH, maxInnerWidth);
  for (const line of contentLines) {
    const w = visibleWidth(line.replace(/\s+$/, ""));
    if (w > widest) widest = w;
  }
  const innerWidth = Math.min(widest, maxInnerWidth);
  const boxWidth =
    innerWidth +
    BORDER_HORIZONTAL_OVERHEAD +
    2 * BORDER_INNER_PADDING_HORIZONTAL;
  return { innerWidth, boxWidth };
}

// ---------------------------------------------------------------------------
// #3 — Markdown render cache
// ---------------------------------------------------------------------------

export const MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE = 20;
export const MAX_PREVIEW_HEIGHT_STACKED = 15;
export const NO_PREVIEW_TEXT = "No preview available";

/**
 * Per-option markdown render cache. The fork rebuilds `new Markdown(...)` on
 * every redraw without this — that re-parses the whole markdown body each
 * frame. Cache keys on (optionIndex, innerWidth); Markdown instances are
 * `.invalidate()`-d whenever `innerWidth` changes so the next `bodyFor()` for
 * that option re-renders at the new width.
 *
 * Adapted from the predecessor extension: reads `option.description`, takes
 * `QuestionOption[]` directly, no i18n placeholder.
 */
export class MarkdownContentCache {
  private readonly composedTexts: Map<number, string>;
  private readonly markdownCache: Map<number, Markdown>;
  private cachedWidth: number | undefined;
  private readonly theme: Theme;
  private readonly markdownTheme: MarkdownTheme;

  // Footer baked into every cached option body so a per-option Markdown
  // instance stays reusable across redraws. Set at construction; the
  // single/multi lists pass the right affordance string.
  private readonly footerMarkdown: string;

  constructor(
    options: QuestionOption[],
    theme: Theme,
    markdownTheme: MarkdownTheme,
    footerMarkdown = "Press `Enter` to select this option.",
  ) {
    this.theme = theme;
    this.markdownTheme = markdownTheme;
    this.footerMarkdown = footerMarkdown;
    this.composedTexts = new Map();
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const raw = opt?.description;
      if (!raw || raw.length === 0) continue;
      // Compose the same body shape the predecessor rendered inline:
      //   ## {title}
      //   {description}
      //   ---
      //   Press Enter to select this option.
      // The fork has no separate `preview` field, so the cache composes the
      // full body (title + separator + description + fixed footer) per
      // option up front.
      const title = opt?.title ?? "";
      this.composedTexts.set(
        i,
        `## ${title}\n\n${raw}\n\n---\n\n${this.footerMarkdown}`,
      );
    }
    this.markdownCache = new Map();
  }

  hasAnyPreview(): boolean {
    return this.composedTexts.size > 0;
  }

  has(optionIndex: number): boolean {
    return this.composedTexts.has(optionIndex);
  }

  bodyFor(optionIndex: number, innerWidth: number): string[] {
    if (this.cachedWidth !== innerWidth) {
      for (const md of this.markdownCache.values()) md.invalidate();
      this.cachedWidth = innerWidth;
    }
    const text = this.composedTexts.get(optionIndex);
    if (!text) {
      const placeholder = this.theme.fg("dim", NO_PREVIEW_TEXT);
      const pad = Math.max(0, innerWidth - visibleWidth(placeholder));
      return [placeholder + " ".repeat(pad)];
    }
    let md = this.markdownCache.get(optionIndex);
    if (!md) {
      md = new Markdown(text, 0, 0, this.markdownTheme);
      this.markdownCache.set(optionIndex, md);
    }
    return stripFenceMarkers(md.render(innerWidth));
  }

  invalidate(): void {
    for (const md of this.markdownCache.values()) md.invalidate();
    this.cachedWidth = undefined;
  }
}

// ---------------------------------------------------------------------------
// #4 — Adaptive left-column width + stacked fallback
// ---------------------------------------------------------------------------

export const PREVIEW_MIN_WIDTH = 100;
export const PREVIEW_COLUMN_GAP = 2;
export const PREVIEW_PADDING_LEFT = 1;
export const STACKED_GAP_ROWS = 1;
export const MIN_LEFT = 30;
export const MAX_LEFT_RATIO = 0.5;
export const MIN_PREVIEW_WIDTH = 45;
export const CONFIRMED_OVERHEAD = 2;

export type PreviewLayoutMode = "side-by-side" | "stacked";

export function decideLayout(
  terminalWidth: number,
  paneWidth: number,
): PreviewLayoutMode {
  return terminalWidth >= PREVIEW_MIN_WIDTH && paneWidth >= PREVIEW_MIN_WIDTH
    ? "side-by-side"
    : "stacked";
}

/**
 * Choose the left (options) column width based on the widest option title
 * plus the selection chrome (pointer, number prefix, checkbox/confirmed
 * overhead). Capped to a max ratio of the pane and gated by a minimum
 * preview width on the right.
 *
 * Adapted from the predecessor extension: param is `QuestionOption[]`,
 * measures `item.title` (was `item.label`).
 */
export function adaptiveLeftWidth(
  items: QuestionOption[],
  totalForNumbering: number,
  paneWidth: number,
): number {
  const prefixW = String(Math.max(1, totalForNumbering)).length + 4;
  const confirmedOverhead = CONFIRMED_OVERHEAD;
  let maxLabel = 0;
  for (const item of items) {
    const w = visibleWidth(item.title);
    if (w > maxLabel) maxLabel = w;
  }
  const desired = maxLabel + prefixW + confirmedOverhead;
  const ratioCapped = Math.min(desired, Math.floor(paneWidth * MAX_LEFT_RATIO));
  const available = paneWidth - PREVIEW_COLUMN_GAP - MIN_PREVIEW_WIDTH;
  return Math.max(MIN_LEFT, Math.min(ratioCapped, Math.max(1, available)));
}

export function columnWidths(
  paneWidth: number,
  adaptiveLeft: number,
): { leftWidth: number; rightWidth: number; gap: number } {
  const gap = PREVIEW_COLUMN_GAP;
  const leftWidth = Math.min(adaptiveLeft, Math.max(1, paneWidth - gap - 1));
  const rightWidth = Math.max(1, paneWidth - leftWidth - gap);
  return { leftWidth, rightWidth, gap };
}

export function bodyWidths(
  paneWidth: number,
  mode: PreviewLayoutMode,
  adaptiveLeft: number,
): { optionsWidth: number; previewWidth: number } {
  if (mode === "stacked") {
    return { optionsWidth: paneWidth, previewWidth: paneWidth };
  }
  const { leftWidth, rightWidth } = columnWidths(paneWidth, adaptiveLeft);
  return {
    optionsWidth: leftWidth,
    previewWidth: Math.max(1, rightWidth - PREVIEW_PADDING_LEFT),
  };
}

// ---------------------------------------------------------------------------
// Composed helper — render a focused option's preview as a bordered box.
// Used by both WrappedSingleSelectList and MultiSelectList. Encapsulates the
// cap/budget/truncate/box sequence so each render path stays in sync.
// ---------------------------------------------------------------------------

export interface RenderPreviewBlockParams {
  /** Adaptive pane width (terminal width minus the ask box chrome). */
  paneWidth: number;
  /** Full terminal width — used by `decideLayout`. */
  terminalWidth: number;
  /** Index of the focused option (0-based, into the cache's option list). */
  optionIndex: number;
  /** Cache holding the markdown bodies. */
  cache: MarkdownContentCache;
  /** Theme for the box border color. */
  theme: Theme;
}

/**
 * Renders the bordered preview block for the currently focused option.
 * Returns `{ lines, mode }`:
 *   - `mode` is the layout `decideLayout()` picked (side-by-side vs stacked)
 *   - `lines` is the box-framed markdown body, already height-capped to
 *     `MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE` (20) for side-by-side or
 *     `MAX_PREVIEW_HEIGHT_STACKED` (15) for stacked, with a
 *     `✂ ── N lines hidden ──` indicator on the bottom border when truncated.
 *
 * If the focused option has no preview text, returns `{ lines: [], mode }`
 * (the caller should then render flat — no preview pane at all).
 *
 * `cache.bodyFor()` returns the fully-composed body per option (title heading
 * `## {title}`, the description, an `---` separator, and a fixed enter/toggle
 * footer baked in at cache construction). This is the single entrypoint used by
 * both `WrappedSingleSelectList.buildPreviewLines` and
 * `MultiSelectList.buildPreviewLines`, so the cap/budget/truncate/box
 * sequence stays identical across both list types.
 */
export function renderPreviewBlock({
  paneWidth,
  terminalWidth,
  optionIndex,
  cache,
  theme,
}: RenderPreviewBlockParams): { lines: string[]; mode: PreviewLayoutMode } {
  const mode = decideLayout(terminalWidth, paneWidth);
  const cap =
    mode === "side-by-side"
      ? MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE
      : MAX_PREVIEW_HEIGHT_STACKED;
  const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD);
  const maxInnerWidth = Math.max(
    1,
    paneWidth -
      BORDER_HORIZONTAL_OVERHEAD -
      2 * BORDER_INNER_PADDING_HORIZONTAL,
  );

  if (!cache.has(optionIndex)) return { lines: [], mode };

  const raw = cache.bodyFor(optionIndex, maxInnerWidth);
  const truncated = raw.length > contentBudget;
  const hidden = truncated ? raw.length - contentBudget : 0;
  const contentLines = truncated ? raw.slice(0, contentBudget) : raw;

  const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
  const colorFn = (s: string) => theme.fg("accent", s);
  const boxedLines = renderBorderedBox(contentLines, boxWidth, colorFn, hidden);
  return { lines: boxedLines, mode };
}

// ---------------------------------------------------------------------------
// `renderPreviewBlock` is the single preference entrypoint above. The helpers
// (`stripFenceMarkers`, `computeBoxDimensions`, `renderBorderedBox`, the
// `MAX_PREVIEW_HEIGHT_*` caps, and `MarkdownContentCache`) are exported so the
// call site can additionally fread-comment-toggle / freeform rows directly
// with a throwaway `new Markdown(...)` when those synthetic panels need a
// bespoke body the per-option cache does not cover.
// ---------------------------------------------------------------------------
