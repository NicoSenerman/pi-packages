/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import {
  Container,
  type Component,
  decodeKittyPrintable,
  Editor,
  type EditorTheme,
  fuzzyFilter,
  Key,
  type Keybinding,
  type KeybindingsManager,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  type OverlayHandle,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderSingleSelectRows } from "./single-select-layout";
import {
  BORDER_HORIZONTAL_OVERHEAD,
  BORDER_INNER_PADDING_HORIZONTAL,
  BORDER_VERTICAL_OVERHEAD,
  MarkdownContentCache,
  MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE,
  MAX_PREVIEW_HEIGHT_STACKED,
  PREVIEW_COLUMN_GAP,
  PREVIEW_MIN_WIDTH,
  STACKED_GAP_ROWS,
  adaptiveLeftWidth,
  computeBoxDimensions,
  decideLayout,
  renderBorderedBox,
  renderPreviewBlock,
  type PreviewLayoutMode,
} from "./preview-box";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const ASK_USER_VERSION: string = (
  _require("./package.json") as { version: string }
).version;

/**
 * Emit a flat `{ type: "string", enum: [...] }` JSON Schema instead of the
 * `anyOf`/`oneOf` shape that `Type.Union([Type.Literal()])` produces. Google's
 * function-calling API rejects the union form. Local copy of pi-ai's StringEnum
 * to avoid a peer dependency for one helper.
 */
function StringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default !== undefined ? { default: options.default } : {}),
  });
}

/**
 * `getMarkdownTheme()` returns a bag of closures that read through a Proxy
 * over the host's theme singleton. The Proxy only throws on property access,
 * not when the bag itself is constructed — so a naive
 * `try { getMarkdownTheme() } catch {}` silently lets a broken bag escape
 * and crashes mid-render the first time pi-tui's Markdown calls
 * `mdTheme.bold(...)`.
 *
 * That broken-bag scenario shows up whenever this extension's bundled copy
 * of `@earendil-works/pi-coding-agent` is a different module instance than
 * the host's — e.g. an older Pi still on the legacy
 * `@mariozechner/pi-coding-agent` scope (≤ 0.73.1) where npm cannot dedupe
 * across scopes, so our copy's theme singleton is never initialised
 * (`globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` is
 * undefined). See https://github.com/edlsh/pi-ask-user/issues/17.
 *
 * Probe `bold("")` to force the Proxy lookup eagerly; on throw, callers
 * fall back to plain `Text` rendering for context blocks.
 */
function safeMarkdownTheme(): MarkdownTheme | undefined {
  try {
    const md = getMarkdownTheme();
    if (!md) return undefined;
    md.bold("");
    return md;
  } catch {
    return undefined;
  }
}

type AskOptionInput = QuestionOption | string;

type AskDisplayMode = "overlay" | "inline";

interface AskParams {
  question: string;
  context?: string;
  options?: AskOptionInput[];
  allowMultiple?: boolean;
  allowFreeform?: boolean;
  allowComment?: boolean;
  displayMode?: AskDisplayMode;
  overlayToggleKey?: string | null;
  commentToggleKey?: string | null;
  timeout?: number;
}

type AskResponse =
  | {
      kind: "selection";
      selections: string[];
      comment?: string;
    }
  | {
      kind: "freeform";
      text: string;
    };

interface AskToolDetails {
  question: string;
  context?: string;
  options: QuestionOption[];
  response: AskResponse | null;
  cancelled: boolean;
  inputError?: string[];
  error?: string;
}

type AskUIResult = AskResponse;

type NormalizedOptions = {
  options: QuestionOption[];
  dropped: string[];
};

function normalizeOptions(options: AskOptionInput[]): NormalizedOptions {
  const dropped: string[] = [];
  const out = options
    .map((option, i) => {
      if (typeof option === "string") {
        return { title: option };
      }
      if (
        option &&
        typeof option === "object" &&
        typeof option.title === "string"
      ) {
        return { title: option.title, description: option.description };
      }
      // Record why this entry was rejected so we can tell the LLM what to fix.
      const why =
        option == null
          ? "was null/undefined"
          : typeof option === "object"
            ? `missing or non-string \`title\` (got: ${JSON.stringify(option).slice(0, 80)})`
            : `wrong type (got ${typeof option}: ${JSON.stringify(option).slice(0, 80)})`;
      dropped.push(`options[${i}] ${why}`);
      return null;
    })
    .filter((option): option is QuestionOption => option !== null);
  return { options: out, dropped };
}

function formatOptionsForMessage(options: QuestionOption[]): string {
  return options
    .map((option, index) => {
      const desc = option.description ? ` — ${option.description}` : "";
      return `${index + 1}. ${option.title}${desc}`;
    })
    .join("\n");
}

function normalizeOptionalComment(
  text: string | null | undefined,
): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function createFreeformResponse(
  text: string | null | undefined,
): AskResponse | null {
  const trimmed = text?.trim();
  return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(
  selections: string[],
  comment?: string | null,
): AskResponse | null {
  const normalizedSelections = selections
    .map((selection) => selection.trim())
    .filter(Boolean);
  if (normalizedSelections.length === 0) return null;

  const normalizedComment = normalizeOptionalComment(comment);
  return normalizedComment
    ? {
        kind: "selection",
        selections: normalizedSelections,
        comment: normalizedComment,
      }
    : { kind: "selection", selections: normalizedSelections };
}

function formatResponseSummary(response: AskResponse): string {
  if (response.kind === "freeform") return response.text;

  const selections = response.selections.join(", ");
  return response.comment ? `${selections} — ${response.comment}` : selections;
}

function buildCommentPrompt(prompt: string, selections: string[]): string {
  const label =
    selections.length === 1 ? "Selected option" : "Selected options";
  const lines = selections.map((selection) => `- ${selection}`).join("\n");
  return `${prompt}\n\n${label}:\n${lines}`;
}

function parseDialogSelections(input: string): string[] {
  return input
    .split(",")
    .map((selection) => selection.trim())
    .filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** LLM-facing message when the user dismisses the question without answering.
 *  Written to guide the model toward a useful recovery instead of panicking or silently retrying. */
const MSG_USER_DISMISSED =
  "User dismissed the question without answering. They may have found the options unclear, not relevant to the real decision, or preferred to reply in plain conversation instead. " +
  "Recovery: either (a) re-ask once with clearer, more concrete options and a richer `context` summarizing the trade-offs (do NOT repeat the exact same question), or (b) proceed with the most reasonable default stated explicitly in chat and let the user correct you. " +
  "If dismissed twice, stop asking and proceed with a sensible stated assumption.";

/** LLM-facing message when the ask UI itself failed to render (not a user decline). */
const MSG_UI_FAILED = (detail: string) =>
  `Ask UI failed to render: ${detail}. This is an environment/rendering issue, NOT the user declining or the question being wrong. ` +
  `Recovery: either fall back to asking the question in plain conversation text, or proceed with a reasonable default stated in chat and let the user correct you. Do not retry the tool with identical input.`;

/** LLM-facing message when the call itself was malformed and SHOULD be retried after fixing */
const MSG_BAD_INPUT = (problems: string[], retryHint: string) =>
  `Your ask_user call was rejected because of these input problems:\n- ${problems.join("\n- ")}\n\n` +
  `How to fix: ${retryHint}\n\n` +
  `This is a fixable input error, NOT a user action and NOT an environment failure — retry the tool with corrected arguments (you will not bother the user by retrying once). ` +
  `Remember: each option is either a string or { title, description? }; per-option fields belong INSIDE the option object, not at the top level; \`options\` is an array; question is a non-empty string.`;

function isSelectionResponse(
  response: AskResponse,
): response is Extract<AskResponse, { kind: "selection" }> {
  return response.kind === "selection";
}

function createSelectListTheme(theme: Theme) {
  return {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  };
}

function createEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (s: string) => theme.fg("accent", s),
    selectList: createSelectListTheme(theme),
  };
}

const BOX_BORDER_LEFT = "";
const BOX_BORDER_RIGHT = "";
// No lateral borders — inner content renders at the full modal width. Kept as
// named constants (both empty) so the earlier `width - BOX_BORDER_OVERHEAD`
// sizing math stays correct (= width) and existing call sites don't need
// changing.
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

const BORDER_DASH = "-";
const BORDER_CORNER_TL = "+";
const BORDER_CORNER_TR = "+";
const BORDER_CORNER_BL = "+";
const BORDER_CORNER_BR = "+";

class BoxBorderTop implements Component {
  private color: (s: string) => string;
  private title?: string;
  private titleColor?: (s: string) => string;
  constructor(
    color: (s: string) => string,
    title?: string,
    titleColor?: (s: string) => string,
  ) {
    this.color = color;
    this.title = title;
    this.titleColor = titleColor;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const inner = Math.max(0, width - 2);
    if (!this.title || inner < this.title.length + 4) {
      return [
        this.color(
          `${BORDER_CORNER_TL}${BORDER_DASH.repeat(inner)}${BORDER_CORNER_TR}`,
        ),
      ];
    }
    const label = ` ${this.title} `;
    const remaining = inner - 1 - label.length;
    const titleStyle = this.titleColor ?? this.color;
    return [
      this.color(`${BORDER_CORNER_TL}${BORDER_DASH}`) +
        titleStyle(label) +
        this.color(
          BORDER_DASH.repeat(Math.max(0, remaining)) + BORDER_CORNER_TR,
        ),
    ];
  }
}

class BoxBorderBottom implements Component {
  private color: (s: string) => string;
  private label?: string;
  private labelColor?: (s: string) => string;
  constructor(
    color: (s: string) => string,
    label?: string,
    labelColor?: (s: string) => string,
  ) {
    this.color = color;
    this.label = label;
    this.labelColor = labelColor;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const inner = Math.max(0, width - 2);
    if (!this.label || inner < this.label.length + 4) {
      return [
        this.color(
          `${BORDER_CORNER_BL}${BORDER_DASH.repeat(inner)}${BORDER_CORNER_BR}`,
        ),
      ];
    }
    const tag = ` ${this.label} `;
    const leftDashes = inner - tag.length - 1;
    const style = this.labelColor ?? this.color;
    return [
      this.color(
        `${BORDER_CORNER_BL}` + BORDER_DASH.repeat(Math.max(0, leftDashes)),
      ) +
        style(tag) +
        this.color(BORDER_DASH + BORDER_CORNER_BR),
    ];
  }
}

function formatKeyList(keys: string[]): string {
  return keys.join("/");
}

function keybindingHint(
  theme: Theme,
  keybindings: KeybindingsManager,
  keybinding: Keybinding,
  description: string,
): string {
  return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
  return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

type ResolvedShortcut =
  | { disabled: false; spec: string; matches: (data: string) => boolean }
  | { disabled: true; spec: null; matches: (data: string) => false };

interface ResolvedAskShortcuts {
  overlayToggle: ResolvedShortcut;
  commentToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
  disabled: true,
  spec: null,
  matches: ((_data: string) => false) as (data: string) => false,
};

const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

function normalizeShortcutSpec(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  if (SHORTCUT_DISABLE_VALUES.has(trimmed)) return null;
  return trimmed;
}

function isValidShortcutSpec(spec: string): boolean {
  // KeyId is canonical lowercase: modifiers (`ctrl|shift|alt|super`) joined by `+`,
  // plus a base key. We do a light syntactic sanity check; matchesKey() does the rest.
  if (!spec) return false;
  if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec))
    return false;
  if (spec.startsWith("+") || spec.endsWith("+")) return false;
  if (spec.includes("++")) return false;
  return true;
}

function buildShortcut(spec: string): ResolvedShortcut {
  return {
    disabled: false,
    spec,
    matches: (data: string) => matchesKey(data, spec as any),
  };
}

function resolveShortcut(
  paramValue: string | null | undefined,
  envValue: string | undefined,
  defaultSpec: string,
): ResolvedShortcut {
  const candidates: Array<string | null | undefined> = [
    paramValue,
    envValue,
    defaultSpec,
  ];
  for (const raw of candidates) {
    const normalized = normalizeShortcutSpec(raw);
    if (normalized === undefined) continue; // not provided, fall through
    if (normalized === null) return DISABLED_SHORTCUT; // explicit disable
    if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
    // Invalid spec: silently fall through to next candidate.
  }
  return DISABLED_SHORTCUT;
}

type AskMode = "select" | "freeform" | "comment";

/**
 * Target modal height when the content fits comfortably. The modal prefers
 * this ratio but grows beyond it (up to the overlay `maxHeight: "85%"` cap)
 * when the preview body or option list needs more rows — so a tall
 * description is shown in full instead of being clipped with
 * `\u2702 N lines hidden` while the terminal still has space. Falls back
 * to this ratio only as a floor on short content (keeps the modal tidy when
 * there are 2–3 options). Effectively: `min(contentHeight, 85% terminal)`
 * with this ratio as the starting budget before content is measured.
 */
const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.45;
/** Max visible lines for the question text before clamping with `…`. */
const QUESTION_MAX_LINES = 1;
/** Max visible lines for the context block before clamping with `…`. */
const CONTEXT_MAX_LINES = 3;

/**
 * Responsive chrome budget for the ask modal. Returned by
 * `AskComponent.computeChromeBudget(width, availableHeight)` and consumed by
 * BOTH `availableOptionRows` (overlayMaxHeight - staticLineCount) AND
 * `applyChromeBudget` (which mutates the live Spacer/Text skeleton). One
 * object, two consumers — so the rendered chrome always matches the row
 * budget the option list was capped to.
 */
interface ChromeBudget {
  /** Total spacer lines the layout gets (distributed across the 5–6 spacers). */
  spacerLines: number;
  /** Whether the `ask_user` title row is shown (hidden when very tight). */
  showTitle: boolean;
  /** Full static-line count: borders + spacers + (title?) + question + context + help. */
  staticLineCount: number;
}

const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";

// Vim-style aliases for navigating option lists. ctrl+j/k are safe in the
// searchable single-select because they don't collide with fuzzy-search input.
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");

function matchesSelectUp(
  data: string,
  keybindings: KeybindingsManager,
): boolean {
  return (
    keybindings.matches(data, "tui.select.up") ||
    matchesKey(data, Key.shift("tab")) ||
    matchesKey(data, VIM_SELECT_UP_KEY)
  );
}

function matchesSelectDown(
  data: string,
  keybindings: KeybindingsManager,
): boolean {
  return (
    keybindings.matches(data, "tui.select.down") ||
    matchesKey(data, Key.tab) ||
    matchesKey(data, VIM_SELECT_DOWN_KEY)
  );
}

function buildCustomUIOptions(
  displayMode: AskDisplayMode,
  onHandle?: (handle: OverlayHandle) => void,
) {
  switch (displayMode) {
    case "inline":
      return undefined;
    case "overlay":
      return {
        overlay: true,
        overlayOptions: {
          anchor: "center" as const,
          width: ASK_OVERLAY_WIDTH,
          minWidth: ASK_OVERLAY_MIN_WIDTH,
          maxHeight: "85%",
          margin: 1,
        },
        ...(onHandle ? { onHandle } : {}),
      };
    default: {
      const _exhaustive: never = displayMode;
      void _exhaustive;
      return {
        overlay: true,
        overlayOptions: {
          anchor: "center" as const,
          width: ASK_OVERLAY_WIDTH,
          minWidth: ASK_OVERLAY_MIN_WIDTH,
          maxHeight: "85%",
          margin: 1,
        },
        ...(onHandle ? { onHandle } : {}),
      };
    }
  }
}

class MultiSelectList implements Component {
  private options: QuestionOption[];
  private allowFreeform: boolean;
  private allowComment: boolean;
  private theme: Theme;
  private tui: TUI;
  private keybindings: KeybindingsManager;
  private commentToggle: ResolvedShortcut;
  private selectedIndex = 0;
  private checked = new Set<number>();
  private commentEnabled = false;
  // Inline freeform input state (issue #3): when the freeform row is focused
  // and the user types, printable chars populate `inlineFreeformText` in
  // place — no editor mode switch. `inlineFreeformActive` is set on the
  // first printable keystroke / Space-activate and cleared on navigation away
  // or Escape. Enter submits the typed text directly via `onSubmit`.
  private inlineFreeformText = "";
  private inlineFreeformActive = false;
  // Height budget for the option-list window. Set by AskComponent from the
  // terminal-height ratio so the modal never exceeds ~1/4 of terminal rows.
  // Mirrors WrappedSingleSelectList.maxVisibleRows. Default kept modest (6) so
  // the first paint — before AskComponent.render's setMaxVisibleRows lands —
  // is not wildly oversized in the now-tiny modal.
  private maxVisibleRows = 6;
  private cachedWidth?: number;
  private cachedLines?: string[];
  // #3 — per-option markdown render cache (mirrors WrappedSingleSelectList).
  // Created lazily once a markdown theme is available; stays undefined when
  // the host theme is broken, in which case buildPreviewLines falls back to a
  // plain-text render path.
  private previewCache?: MarkdownContentCache;

  public onCancel?: () => void;
  public onSubmit?: (result: string[]) => void;
  public onEnterFreeform?: () => void;

  constructor(
    options: QuestionOption[],
    allowFreeform: boolean,
    allowComment: boolean,
    theme: Theme,
    tui: TUI,
    keybindings: KeybindingsManager,
    commentToggle: ResolvedShortcut,
  ) {
    this.options = options;
    this.allowFreeform = allowFreeform;
    this.allowComment = allowComment;
    this.theme = theme;
    this.tui = tui;
    this.keybindings = keybindings;
    this.commentToggle = commentToggle;
    const mdTheme = safeMarkdownTheme();
    if (mdTheme) {
      this.previewCache = new MarkdownContentCache(
        this.options,
        this.theme,
        mdTheme,
      );
    }
  }

  public isCommentEnabled(): boolean {
    return this.commentEnabled;
  }

  /**
   * Cap on the number of visible list rows; the list windows internally
   * (scroll-to-focus) when there are more options than `rows`. Mirrors
   * WrappedSingleSelectList.setMaxVisibleRows — guards against < 1.
   */
  setMaxVisibleRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows));
    if (next !== this.maxVisibleRows) {
      this.maxVisibleRows = next;
      this.invalidate();
    }
  }

  /**
   * Render the freeform row as an inline input field (issue #3). When not
   * active, shows the dim "Type something." prompt; when active, shows the
   * typed text followed by a block cursor `▏` so the user sees where they're
   * typing — no editor mode switch, no full-screen UI change.
   */
  private renderInlineFreeformRow(width: number, isSelected: boolean): string {
    const theme = this.theme;
    const prefix = isSelected ? theme.fg("accent", "→") : " ";
    if (!this.inlineFreeformActive) {
      const label = theme.fg("dim", "Type something.");
      return `${prefix}   ${label}`;
    }
    const cur = theme.fg("accent", "▏");
    const text = this.inlineFreeformText
      ? theme.fg("text", this.inlineFreeformText)
      : "";
    return `${prefix}   ${text}${cur}`;
  }

  /**
   * Handle printable/erase/submit input for the inline freeform field
   * (issue #3). Returns `true` when the input was consumed (so the caller
   * skips the normal list navigation/toggle logic). Backspace erases a char;
   * Escape deactivates the field (stays on the row, clears text);
   * Enter/confirm is handled by the caller's confirm branch which reads
   * `inlineFreeformText` directly.
   */
  private handleInlineFreeformInput(data: string): boolean {
    if (
      this.keybindings.matches(data, "tui.editor.deleteCharBackward") ||
      matchesKey(data, Key.backspace)
    ) {
      if (this.inlineFreeformActive && this.inlineFreeformText.length > 0) {
        const chars = [...this.inlineFreeformText];
        chars.pop();
        this.inlineFreeformText = chars.join("");
        this.invalidate();
      }
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.inlineFreeformActive) {
        this.inlineFreeformActive = false;
        this.inlineFreeformText = "";
        this.invalidate();
      }
      return true;
    }
    // Printable char capture (mirrors WrappedSingleSelectList.getPrintableInput).
    const ch = decodeKittyPrintable(data);
    if (ch !== undefined) {
      this.inlineFreeformActive = true;
      this.inlineFreeformText += ch;
      this.invalidate();
      return true;
    }
    const chars = [...data];
    if (chars.length === 1) {
      const code = chars[0]!.charCodeAt(0);
      if (code >= 32 && code !== 0x7f && (code < 0x80 || code > 0x9f)) {
        this.inlineFreeformActive = true;
        this.inlineFreeformText += chars[0]!;
        this.invalidate();
        return true;
      }
    }
    // Not a printable/erase/escape input — let the caller handle navigation etc.
    // (But if the field is already active, swallow other control keys so they
    // don't toggle options underneath the cursor.)
    if (this.inlineFreeformActive) {
      return true;
    }
    return false;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.previewCache?.invalidate();
  }

  private getItemCount(): number {
    return (
      this.options.length +
      (this.allowComment ? 1 : 0) +
      (this.allowFreeform ? 1 : 0)
    );
  }

  private getCommentToggleIndex(): number | null {
    return this.allowComment ? this.options.length : null;
  }

  private getFreeformIndex(): number {
    return this.options.length + (this.allowComment ? 1 : 0);
  }

  private isCommentToggleRow(index: number): boolean {
    const toggleIndex = this.getCommentToggleIndex();
    return toggleIndex !== null && index === toggleIndex;
  }

  private isFreeformRow(index: number): boolean {
    return this.allowFreeform && index === this.getFreeformIndex();
  }

  private toggle(index: number): void {
    if (index < 0 || index >= this.options.length) return;
    if (this.checked.has(index)) this.checked.delete(index);
    else this.checked.add(index);
  }

  private toggleComment(): void {
    if (!this.allowComment) return;
    this.commentEnabled = !this.commentEnabled;
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
      return;
    }

    const count = this.getItemCount();
    if (count === 0) {
      this.onCancel?.();
      return;
    }

    // Inline freeform: when the freeform row is focused, printable input is
    // captured into the inline text buffer (no editor mode switch). Backspace
    // erases, Enter submits, Escape deactivates (stays on the row). Up/Down
    // navigation is suppressed while actively typing so the cursor stays in
    // the field — mirror a real input. Issue #3.
    if (
      this.allowFreeform &&
      this.isFreeformRow(this.selectedIndex) &&
      this.handleInlineFreeformInput(data)
    ) {
      return;
    }

    if (
      this.allowComment &&
      !this.commentToggle.disabled &&
      this.commentToggle.matches(data)
    ) {
      this.toggleComment();
      return;
    }

    if (matchesSelectUp(data, this.keybindings)) {
      this.inlineFreeformActive = false;
      this.selectedIndex =
        this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
      this.invalidate();
      return;
    }

    if (matchesSelectDown(data, this.keybindings)) {
      this.inlineFreeformActive = false;
      this.selectedIndex =
        this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
      this.invalidate();
      return;
    }

    const numMatch = data.match(/^[1-9]$/);
    if (numMatch) {
      const idx = Number.parseInt(numMatch[0], 10) - 1;
      if (idx >= 0 && idx < this.options.length) {
        this.inlineFreeformActive = false;
        this.toggle(idx);
        this.selectedIndex = Math.min(idx, count - 1);
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, Key.space)) {
      if (this.isCommentToggleRow(this.selectedIndex)) {
        this.toggleComment();
        return;
      }
      if (this.isFreeformRow(this.selectedIndex)) {
        // Space on the freeform row: if actively typing, insert a space; else
        // activate the inline field (no editor mode switch).
        if (this.inlineFreeformActive) {
          this.inlineFreeformText += " ";
          this.invalidate();
        } else {
          this.inlineFreeformActive = true;
          this.invalidate();
        }
        return;
      }
      this.toggle(this.selectedIndex);
      this.invalidate();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.isCommentToggleRow(this.selectedIndex)) {
        this.toggleComment();
        return;
      }
      if (this.isFreeformRow(this.selectedIndex)) {
        // Enter on the freeform row: submit the inline text if any, else fall
        // back to the legacy editor mode (empty input activation).
        const trimmed = this.inlineFreeformText.trim();
        if (trimmed) {
          this.inlineFreeformActive = false;
          this.onSubmit?.([trimmed]);
        } else {
          // Empty: activate the inline field instead of switching to the editor.
          this.inlineFreeformActive = true;
          this.invalidate();
        }
        return;
      }

      const selectedTitles = Array.from(this.checked)
        .sort((a, b) => a - b)
        .map((i) => this.options[i]?.title)
        .filter((t): t is string => !!t);

      const fallback = this.options[this.selectedIndex]?.title;
      const result =
        selectedTitles.length > 0 ? selectedTitles : fallback ? [fallback] : [];

      if (result.length > 0) this.onSubmit?.(result);
      else this.onCancel?.();
    }
  }

  /**
   * #1 — Split-pane widths for multi-select, mirroring
   * WrappedSingleSelectList.getSplitPaneWidths. Uses the same
   * SINGLE_SELECT_SPLIT_PANE_* guard constants and the #4
   * adaptiveLeftWidth() helper so the left column tracks the widest option
   * title instead of a fixed 42%.
   *
   * Public so `AskComponent.render` can compute the two-column body's left/right
   * widths itself (the list no longer owns the split in two-column mode).
   */
  public getSplitPaneWidths(
    width: number,
  ): { left: number; right: number } | null {
    if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

    const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
    if (
      availableWidth <
      SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH +
        SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH
    ) {
      return null;
    }

    const adaptiveLeft = adaptiveLeftWidth(
      this.options,
      this.options.length,
      availableWidth,
    );
    const left = Math.max(
      SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
      Math.min(
        adaptiveLeft,
        availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH,
      ),
    );
    const right = availableWidth - left;

    if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
    return { left, right };
  }

  /**
   * #1 — Build the option-list rows. Extracted from the old inline render()
   * loop so the split-pane path can render list rows WITHOUT descriptions
   * (hideDescriptions=true) to avoid double-showing them in the side preview.
   *
   * Public so `AskComponent.render` can render the list-only column of the
   * two-column body via `renderListOnly`. Signature unchanged.
   */
  public buildListLines(width: number, hideDescriptions = false): string[] {
    const theme = this.theme;
    const count = this.getItemCount();
    const maxVisible = Math.min(count, this.maxVisibleRows);

    if (count === 0) {
      return [theme.fg("warning", "No options")];
    }

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        count - maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + maxVisible, count);

    const lines: string[] = [];

    for (let i = startIndex; i < endIndex; i++) {
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? theme.fg("accent", "→") : " ";

      if (this.isCommentToggleRow(i)) {
        const checkbox = this.commentEnabled
          ? theme.fg("success", "[✓]")
          : theme.fg("dim", "[ ]");
        const label = isSelected
          ? theme.fg("accent", theme.bold(COMMENT_TOGGLE_LABEL))
          : theme.fg("text", theme.bold(COMMENT_TOGGLE_LABEL));
        lines.push(
          truncateToWidth(`${prefix}   ${checkbox} ${label}`, width, ""),
        );
        continue;
      }

      if (this.isFreeformRow(i)) {
        const line = this.renderInlineFreeformRow(width, isSelected);
        lines.push(truncateToWidth(line, width, ""));
        continue;
      }

      const option = this.options[i];
      if (!option) continue;

      const checkbox = this.checked.has(i)
        ? theme.fg("success", "[✓]")
        : theme.fg("dim", "[ ]");
      const num = theme.fg("dim", `${i + 1}.`);
      const title = isSelected
        ? theme.fg("accent", theme.bold(option.title))
        : theme.fg("text", theme.bold(option.title));

      const firstLine = `${prefix} ${num} ${checkbox} ${title}`;
      lines.push(truncateToWidth(firstLine, width, ""));

      if (!hideDescriptions && option.description) {
        const indent = "      ";
        const wrapWidth = Math.max(10, width - indent.length);
        const mdTheme = safeMarkdownTheme();
        let descLines: string[];
        if (mdTheme) {
          const md = new Markdown(option.description, 0, 0, mdTheme);
          descLines = md.render(wrapWidth).filter((l) => l.trim() !== "");
        } else {
          descLines = wrapTextWithAnsi(option.description, wrapWidth);
        }
        for (const w of descLines) {
          lines.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
        }
      }
    }

    if (startIndex > 0 || endIndex < count) {
      lines.push(
        theme.fg(
          "dim",
          truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, ""),
        ),
      );
    }

    return lines;
  }

  /**
   * #1 — Build the bordered preview pane for the focused option. Mirrors
   * WrappedSingleSelectList.buildPreviewLines: caches the per-option markdown
   * body via MarkdownContentCache (#3) and wraps it in a bordered box (#2)
   * with a `✂ … lines hidden …` indicator when truncated. Synthetic
   * (comment-toggle / freeform) rows fall back to a throwaway Markdown render.
   *
   * Public so `AskComponent.render` can compose the preview into the
   * full-right-side two-column body (the list no longer renders its own
   * preview in two-column mode). Signature unchanged from the private form.
   */
  public buildPreviewLines(width: number, maxLines: number): string[] {
    if (maxLines <= 0 || width < 1) return [];

    const mdTheme = safeMarkdownTheme();
    const cache = this.previewCache;

    // Normal-option path: cache holds the composed title+separator+
    // description+footer body per option. Multi-select never filters its
    // options, so the cache index IS the selectedIndex for real option rows.
    if (
      cache &&
      mdTheme &&
      !this.isCommentToggleRow(this.selectedIndex) &&
      !this.isFreeformRow(this.selectedIndex) &&
      cache.has(this.selectedIndex)
    ) {
      // `terminalWidth` here drives the inner decideLayout that picks the box
      // height cap (side-by-side=20 vs stacked=15). It must be the REAL
      // terminal width — passing the pane `width` (narrower than the terminal
      // after the list column takes its share) would wrongly force stacked and
      // cap the side-by-side preview at 15 instead of 20. Mirrors the fix in
      // render() above; nullish-coalesce for safety.
      const { lines } = renderPreviewBlock({
        paneWidth: width,
        terminalWidth: this.tui.terminal.columns ?? width,
        optionIndex: this.selectedIndex,
        cache,
        theme: this.theme,
        maxLines,
      });
      if (lines.length <= maxLines) return lines;
      if (maxLines === 1) {
        return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];
      }
      const visible = lines.slice(0, maxLines - 1);
      visible.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
      return visible;
    }

    // Synthetic / no-cache path: compose inline and render via a throwaway
    // Markdown, then wrap in the same bordered box so both modes look alike.
    let md = "";
    if (this.isCommentToggleRow(this.selectedIndex)) {
      md += "## Additional context\n\n";
      md += `Currently: **${this.commentEnabled ? "Enabled" : "Disabled"}**\n\n`;
      md +=
        "Turn this on when the selected option needs extra explanation before the tool submits.\n";
    } else if (this.isFreeformRow(this.selectedIndex)) {
      md += "## Custom response\n\n";
      md += "Open the editor to write **any** answer.\n\n";
      md += "*Use this when none of the listed options fit.*\n";
    } else {
      const selected = this.options[this.selectedIndex];
      if (!selected) {
        md += "*No option selected*\n";
      } else {
        md += `## ${selected.title}\n\n`;
        if (selected.description?.trim()) {
          md += `${selected.description}\n`;
        } else {
          md += "*No additional details provided for this option.*\n";
        }
      }
    }

    let rawLines: string[];
    if (mdTheme) {
      const mdComponent = new Markdown(md.trim(), 0, 0, mdTheme);
      rawLines = mdComponent.render(
        Math.max(
          1,
          width -
            BORDER_HORIZONTAL_OVERHEAD -
            2 * BORDER_INNER_PADDING_HORIZONTAL,
        ),
      );
    } else {
      rawLines = [];
      for (const line of wrapTextWithAnsi(
        md.trim(),
        Math.max(10, width - BORDER_HORIZONTAL_OVERHEAD),
      )) {
        rawLines.push(line);
      }
    }
    while (
      rawLines.length > 0 &&
      rawLines[rawLines.length - 1]?.trim() === ""
    ) {
      rawLines.pop();
    }

    if (rawLines.length === 0) {
      return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];
    }

    const cap = maxLines;
    const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD);
    const truncated = rawLines.length > contentBudget;
    const hidden = truncated ? rawLines.length - contentBudget : 0;
    const contentLines = truncated
      ? rawLines.slice(0, contentBudget)
      : rawLines;
    const maxInnerWidth = Math.max(
      1,
      width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL,
    );
    const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
    const colorFn = (s: string) => this.theme.fg("accent", s);
    return renderBorderedBox(contentLines, boxWidth, colorFn, hidden);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const count = this.getItemCount();
    if (count === 0) {
      this.cachedLines = [this.theme.fg("warning", "No options")];
      this.cachedWidth = width;
      return this.cachedLines;
    }

    // Whether the focused row is worth a preview. Synthetic comment-toggle /
    // freeform rows always get one; real options only when they carry a
    // description. Otherwise render flat (current behaviour).
    const hasUsablePreview =
      this.isCommentToggleRow(this.selectedIndex) ||
      this.isFreeformRow(this.selectedIndex) ||
      !!this.options[this.selectedIndex]?.description?.trim();

    const splitPane = this.getSplitPaneWidths(width);
    const layout: PreviewLayoutMode = decideLayout(
      this.tui.terminal.columns ?? width,
      width,
    );
    let lines: string[];

    if (
      !hasUsablePreview ||
      (!splitPane && layout === "stacked" && width < 60)
    ) {
      // Flat.
      lines = this.buildListLines(width);
    } else if (splitPane && layout === "side-by-side") {
      // #1 — Side-by-side split pane: list rows (no descriptions) zipped with
      // the bordered preview pane, split by the ` │ ` separator — mirroring
      // WrappedSingleSelectList.render.
      const listLines = this.buildListLines(splitPane.left, true);
      const previewLines = this.buildPreviewLines(
        splitPane.right,
        Math.min(MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE, this.maxVisibleRows),
      );
      const rowCount = Math.max(listLines.length, previewLines.length);
      const separator = this.theme.fg(
        "dim",
        SINGLE_SELECT_SPLIT_PANE_SEPARATOR,
      );
      lines = Array.from({ length: rowCount }, (_, index) => {
        const left = truncateToWidth(
          listLines[index] ?? "",
          splitPane.left,
          "",
          true,
        );
        const right = truncateToWidth(
          previewLines[index] ?? "",
          splitPane.right,
          "",
        );
        return `${left}${separator}${right}`;
      });
    } else {
      // #5 — Stacked fallback: list full-width, blank gap, bordered preview.
      const listLines = this.buildListLines(width);
      const previewLines = this.buildPreviewLines(
        width,
        Math.min(
          MAX_PREVIEW_HEIGHT_STACKED,
          Math.max(2, Math.floor(this.maxVisibleRows / 2)),
        ),
      );
      if (previewLines.length === 0) {
        lines = listLines;
      } else {
        lines = [
          ...listLines,
          ...Array(STACKED_GAP_ROWS).fill(""),
          ...previewLines,
        ];
      }
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  /**
   * Two-column-body hook: does ANY focused-able row carry a preview body?
   *
   * `AskComponent.render` uses this to decide whether to engage the
   * full-right-side two-column layout: the preview pane is only worth a column
   * when at least one option carries a description OR a synthetic row
   * (comment-toggle / freeform) is present (those always render a body even
   * with no option descriptions). Mirrors the per-focus `hasUsablePreview`
   * check in `render` but OR'd across all items, not just the focused one.
   */
  public hasAnyPreview(): boolean {
    if (this.allowComment || this.allowFreeform) return true;
    if (this.previewCache?.hasAnyPreview()) return true;
    return this.options.some((o) => !!o.description?.trim());
  }

  /**
   * Two-column-body hook: render ONLY the option-list rows (no internal
   * split-pane / stacked preview composition). `AskComponent.render` calls
   * this for the left column of the two-column body and composes the preview
   * itself via `buildPreviewLines`.
   *
   * Equivalent to `buildListLines(width, true)` (descriptions hidden — the
   * preview column already shows the focused option's description, so the left
   * column must not duplicate them inline). The `maxVisibleRows` windowing is
   * applied by `buildListLines` itself.
   */
  public renderListOnly(width: number): string[] {
    return this.buildListLines(width, true);
  }
}

class WrappedSingleSelectList implements Component {
  private options: QuestionOption[];
  private allowFreeform: boolean;
  private allowComment: boolean;
  private theme: Theme;
  private tui: TUI;
  private keybindings: KeybindingsManager;
  private commentToggle: ResolvedShortcut;
  private selectedIndex = 0;
  private searchQuery = "";
  private commentEnabled = false;
  private maxVisibleRows = 6;
  // Inline freeform input state (issue #3) — mirrors MultiSelectList.
  private inlineFreeformText = "";
  private inlineFreeformActive = false;
  private cachedWidth?: number;
  private cachedLines?: string[];
  // #3 — per-option markdown render cache. Created lazily once a markdown
  // theme is available (safeMarkdownTheme()); stays undefined when the host
  // theme is broken, in which case buildPreviewLines falls back to the
  // legacy plain-text render path that does not touch Markdown at all.
  private previewCache?: MarkdownContentCache;

  public onCancel?: () => void;
  public onSubmit?: (result: string) => void;
  public onEnterFreeform?: () => void;

  constructor(
    options: QuestionOption[],
    allowFreeform: boolean,
    allowComment: boolean,
    theme: Theme,
    tui: TUI,
    keybindings: KeybindingsManager,
    commentToggle: ResolvedShortcut,
  ) {
    this.options = options;
    this.allowFreeform = allowFreeform;
    this.allowComment = allowComment;
    this.theme = theme;
    this.tui = tui;
    this.keybindings = keybindings;
    this.commentToggle = commentToggle;
    const mdTheme = safeMarkdownTheme();
    if (mdTheme) {
      this.previewCache = new MarkdownContentCache(
        this.options,
        this.theme,
        mdTheme,
      );
    }
  }

  public isCommentEnabled(): boolean {
    return this.commentEnabled;
  }

  setMaxVisibleRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows));
    if (next !== this.maxVisibleRows) {
      this.maxVisibleRows = next;
      this.invalidate();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.previewCache?.invalidate();
  }

  /**
   * Handle printable/erase input for the inline freeform field (issue #3).
   * Unlike MultiSelectList, the single-select list also feeds printable input
   * to its search filter — so this is only consulted when the freeform row is
   * the focused row AND the field is already active, or the keystroke would
   * activate it. Returns `true` when the input was consumed.
   */
  private handleInlineFreeformInput(data: string): boolean {
    if (
      this.keybindings.matches(data, "tui.editor.deleteCharBackward") ||
      matchesKey(data, Key.backspace)
    ) {
      if (this.inlineFreeformActive && this.inlineFreeformText.length > 0) {
        const chars = [...this.inlineFreeformText];
        chars.pop();
        this.inlineFreeformText = chars.join("");
        this.invalidate();
      }
      return true;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.inlineFreeformActive) {
        this.inlineFreeformActive = false;
        this.inlineFreeformText = "";
        this.invalidate();
      }
      return true;
    }
    const ch = decodeKittyPrintable(data);
    if (ch !== undefined) {
      this.inlineFreeformActive = true;
      this.inlineFreeformText += ch;
      this.invalidate();
      return true;
    }
    const chars = [...data];
    if (chars.length === 1) {
      const code = chars[0]!.charCodeAt(0);
      if (code >= 32 && code !== 0x7f && (code < 0x80 || code > 0x9f)) {
        this.inlineFreeformActive = true;
        this.inlineFreeformText += chars[0]!;
        this.invalidate();
        return true;
      }
    }
    if (this.inlineFreeformActive) return true;
    return false;
  }

  private getFilteredOptions(): QuestionOption[] {
    return fuzzyFilter(
      this.options,
      this.searchQuery,
      (option) => `${option.title} ${option.description ?? ""}`,
    );
  }

  private getItemCount(filteredOptions: QuestionOption[]): number {
    return (
      filteredOptions.length +
      (this.allowComment ? 1 : 0) +
      (this.allowFreeform ? 1 : 0)
    );
  }

  private isCommentToggleRow(
    index: number,
    filteredOptions: QuestionOption[],
  ): boolean {
    return this.allowComment && index === filteredOptions.length;
  }

  private isFreeformRow(
    index: number,
    filteredOptions: QuestionOption[],
  ): boolean {
    return (
      this.allowFreeform &&
      index === filteredOptions.length + (this.allowComment ? 1 : 0)
    );
  }

  private toggleComment(): void {
    if (!this.allowComment) return;
    this.commentEnabled = !this.commentEnabled;
    this.invalidate();
  }

  private setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.selectedIndex = 0;
    this.invalidate();
  }

  private popSearchCharacter(): void {
    if (!this.searchQuery) return;
    const characters = [...this.searchQuery];
    characters.pop();
    this.setSearchQuery(characters.join(""));
  }

  private getPrintableInput(data: string): string | null {
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) return kittyPrintable;

    const characters = [...data];
    if (characters.length !== 1) return null;

    const [character] = characters;
    if (!character) return null;

    const code = character.charCodeAt(0);
    if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return null;
    }

    return character;
  }

  private styleListLine(
    line: string,
    width: number,
    isSelected: boolean,
  ): string {
    const trimmed = line.trim();

    if (trimmed.startsWith("(")) {
      return truncateToWidth(this.theme.fg("dim", line), width, "");
    }

    if (isSelected) {
      return truncateToWidth(
        this.theme.fg("accent", this.theme.bold(line)),
        width,
        "",
      );
    }

    if (line.startsWith("      ")) {
      return truncateToWidth(this.theme.fg("muted", line), width, "");
    }

    if (line.startsWith("→")) {
      return truncateToWidth(
        this.theme.fg("accent", this.theme.bold(line)),
        width,
        "",
      );
    }

    return truncateToWidth(this.theme.fg("text", line), width, "");
  }

  /**
   * Split-pane widths. Mirrors `MultiSelectList.getSplitPaneWidths`. Made
   * public so `AskComponent.render` can compute the two-column body's
   * left/right widths itself (the list no longer owns the split in
   * two-column mode). Signature unchanged.
   */
  public getSplitPaneWidths(
    width: number,
  ): { left: number; right: number } | null {
    if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

    const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
    if (
      availableWidth <
      SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH +
        SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH
    ) {
      return null;
    }

    // #4 — adaptive left column width based on the widest option title, capped
    // to a max ratio of the pane and gated by a minimum preview width on the
    // right. Falls back to this.options to measure label widths; the filtered
    // view may shrink the visible max, but a stable measurement keeps the
    // column from jittering on every keystroke.
    const adaptiveLeft = adaptiveLeftWidth(
      this.options,
      this.options.length,
      availableWidth,
    );
    const left = Math.max(
      SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
      Math.min(
        adaptiveLeft,
        availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH,
      ),
    );
    const right = availableWidth - left;

    if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
    return { left, right };
  }

  /**
   * Build the option-list rows (Filter: line + windowed option rows). Made
   * public so `AskComponent.render` can render the list-only left column of
   * the two-column body via `renderListOnly`. Signature unchanged.
   */
  public buildListLines(
    width: number,
    filteredOptions: QuestionOption[],
    hideDescriptions = false,
  ): string[] {
    const lines: string[] = [];
    const count = this.getItemCount(filteredOptions);
    const searchValue = this.searchQuery
      ? this.theme.fg("text", this.searchQuery)
      : this.theme.fg("dim", "type to filter");
    lines.push(
      truncateToWidth(
        `${this.theme.fg("accent", "Filter:")} ${searchValue}`,
        width,
        "",
      ),
    );

    if (this.searchQuery && filteredOptions.length === 0) {
      lines.push(
        truncateToWidth(
          this.theme.fg("warning", "No matching options"),
          width,
          "",
        ),
      );
    }

    if (count === 0) {
      if (!this.searchQuery) {
        lines.push(
          truncateToWidth(this.theme.fg("warning", "No options"), width, ""),
        );
      }
      return lines.slice(0, this.maxVisibleRows);
    }

    const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
    const optionRows = renderSingleSelectRows({
      options: filteredOptions,
      selectedIndex: this.selectedIndex,
      width,
      allowFreeform: this.allowFreeform,
      allowComment: this.allowComment,
      commentEnabled: this.commentEnabled,
      maxRows,
      hideDescriptions,
      freeformText: this.inlineFreeformText,
      freeformActive: this.inlineFreeformActive,
      renderDescription: (text: string, w: number) => {
        const mdTheme = safeMarkdownTheme();
        if (!mdTheme) return wrapTextWithAnsi(text, w);
        const md = new Markdown(text, 0, 0, mdTheme);
        return md.render(w).filter((l) => l.trim() !== "");
      },
    });
    const optionLines = optionRows.map((row) =>
      this.styleListLine(row.line, width, row.selected),
    );

    lines.push(...optionLines);
    return lines.slice(0, this.maxVisibleRows);
  }

  /**
   * Build the bordered preview pane for the focused option. Made public so
   * `AskComponent.render` can compose the preview into the full-right-side
   * two-column body (the list no longer renders its own preview in
   * two-column mode). 2-arg signature matches `MultiSelectList.buildPreviewLines`
   * so `AskComponent.render` can call either list type uniformly; the filtered
   * options are derived internally via `getFilteredOptions()` (deterministic
   * within a single synchronous render, so repeating the call is safe).
   */
  public buildPreviewLines(width: number, maxLines: number): string[] {
    const filteredOptions = this.getFilteredOptions();
    if (maxLines <= 0 || width < 1) return [];

    const mdTheme = safeMarkdownTheme();
    // Cap + box math (improvements #2 + #3). `maxLines` is the box budget the
    // caller chose (side-by-side: MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE=20; stacked:
    // MAX_PREVIEW_HEIGHT_STACKED=15). renderPreviewBlock subtracts the border
    // overhead internally and emits a `✂ … lines hidden …` indicator when
    // the body overflows.
    const cache = this.previewCache;

    // Normal-option path: the cache holds the composed title+separator+
    // description+footer body per option index. Hand the right pane width to
    // renderPreviewBlock which calls cache.bodyFor(innerWidth) + wraps it.
    if (
      cache &&
      mdTheme &&
      !this.isCommentToggleRow(this.selectedIndex, filteredOptions) &&
      !this.isFreeformRow(this.selectedIndex, filteredOptions)
    ) {
      const selected = filteredOptions[this.selectedIndex];
      // Map the filtered index back to the cache's option index. The cache is
      // keyed on the ORIGINAL options array (constructed once, before
      // filtering), so find the option in the original list.
      const cacheIndex = selected ? this.options.indexOf(selected) : -1;
      if (cacheIndex >= 0 && cache.has(cacheIndex)) {
        // `terminalWidth` drives the inner decideLayout that picks the box
        // height cap (side-by-side=20 vs stacked=15). Must be the REAL
        // terminal width, not the pane `width`, or the side-by-side preview
        // would self-cap at 15 instead of 20. Mirrors the render() fix.
        const { lines } = renderPreviewBlock({
          paneWidth: width,
          terminalWidth: this.tui.terminal.columns ?? width,
          optionIndex: cacheIndex,
          cache,
          theme: this.theme,
          maxLines,
        });
        // The box already self-caps to its own budget; honour the caller's
        // maxLines only if it is tighter.
        if (lines.length <= maxLines) return lines;
        if (maxLines === 1) {
          return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];
        }
        const visible = lines.slice(0, maxLines - 1);
        visible.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
        return visible;
      }
    }

    // Synthetic / no-cache path: comment-toggle, freeform, no-description
    // options, or a broken host theme. Compose the markdown inline and render
    // via a throwaway Markdown instance, then wrap in the same bordered box.
    let md = "";
    let hasBody = true;
    if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
      md += "## Additional context\n\n";
      md += `Currently: **${this.commentEnabled ? "Enabled" : "Disabled"}**\n\n`;
      md +=
        "Turn this on when the selected option needs extra explanation before the tool submits.\n";
    } else if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
      md += "## Custom response\n\n";
      md += "Open the editor to write **any** answer.\n\n";
      md += "*Use this when none of the listed options fit.*\n";
    } else {
      const selected = filteredOptions[this.selectedIndex];
      if (!selected) {
        md += "*No option selected*\n";
      } else {
        md += `## ${selected.title}\n\n`;
        if (selected.description?.trim()) {
          md += `${selected.description}\n`;
        } else {
          hasBody = false;
          md += "*No additional details provided for this option.*\n";
        }
      }
    }

    // The synthetic panels always have a body; only the no-description option
    // case is `!hasBody` — and in that case the cache path above already
    // returned (cache.has would be false), so we still render the placeholder.
    void hasBody;

    let rawLines: string[];
    if (mdTheme) {
      const mdComponent = new Markdown(md.trim(), 0, 0, mdTheme);
      rawLines = mdComponent.render(
        Math.max(
          1,
          width -
            BORDER_HORIZONTAL_OVERHEAD -
            2 * BORDER_INNER_PADDING_HORIZONTAL,
        ),
      );
    } else {
      rawLines = [];
      for (const line of wrapTextWithAnsi(
        md.trim(),
        Math.max(10, width - BORDER_HORIZONTAL_OVERHEAD),
      )) {
        rawLines.push(line);
      }
    }
    while (
      rawLines.length > 0 &&
      rawLines[rawLines.length - 1]?.trim() === ""
    ) {
      rawLines.pop();
    }

    if (rawLines.length === 0) {
      return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];
    }

    // Height cap + bordered box (#2). Conservative budget matching the cache
    // path so both render modes look identical.
    const cap = maxLines;
    const contentBudget = Math.max(1, cap - BORDER_VERTICAL_OVERHEAD);
    const truncated = rawLines.length > contentBudget;
    const hidden = truncated ? rawLines.length - contentBudget : 0;
    const contentLines = truncated
      ? rawLines.slice(0, contentBudget)
      : rawLines;
    const maxInnerWidth = Math.max(
      1,
      width - BORDER_HORIZONTAL_OVERHEAD - 2 * BORDER_INNER_PADDING_HORIZONTAL,
    );
    const { boxWidth } = computeBoxDimensions(contentLines, maxInnerWidth);
    const colorFn = (s: string) => this.theme.fg("accent", s);
    return renderBorderedBox(contentLines, boxWidth, colorFn, hidden);
  }

  handleInput(data: string): void {
    if (this.inlineFreeformActive && matchesKey(data, Key.escape)) {
      this.inlineFreeformActive = false;
      this.inlineFreeformText = "";
      this.invalidate();
      return;
    }
    if (this.searchQuery && matchesKey(data, Key.escape)) {
      this.setSearchQuery("");
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
      return;
    }

    // Inline freeform (issue #3): when the freeform row is focused, route
    // printable/erase input to the inline field instead of the search filter.
    // Space activates (or inserts a space if already active). Navigation
    // up/down deactivates the field. Enter submits the typed text.
    const filteredOptions0 = this.getFilteredOptions();
    const count0 = this.getItemCount(filteredOptions0);
    if (
      this.allowFreeform &&
      count0 > 0 &&
      this.isFreeformRow(this.selectedIndex, filteredOptions0) &&
      !this.keybindings.matches(data, "tui.select.confirm")
    ) {
      if (matchesKey(data, Key.space)) {
        if (this.inlineFreeformActive) {
          this.inlineFreeformText += " ";
        } else {
          this.inlineFreeformActive = true;
        }
        this.invalidate();
        return;
      }
      if (this.handleInlineFreeformInput(data)) {
        return;
      }
    }

    if (
      this.allowComment &&
      !this.commentToggle.disabled &&
      this.commentToggle.matches(data)
    ) {
      this.toggleComment();
      return;
    }

    const filteredOptions = this.getFilteredOptions();
    const count = this.getItemCount(filteredOptions);

    if (matchesSelectUp(data, this.keybindings) && count > 0) {
      this.inlineFreeformActive = false;
      this.selectedIndex =
        this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
      this.invalidate();
      return;
    }

    if (matchesSelectDown(data, this.keybindings) && count > 0) {
      this.inlineFreeformActive = false;
      this.selectedIndex =
        this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
      this.invalidate();
      return;
    }

    const numMatch = data.match(/^[1-9]$/);
    if (numMatch && filteredOptions.length > 0) {
      const idx = Number.parseInt(numMatch[0], 10) - 1;
      if (idx >= 0 && idx < filteredOptions.length) {
        this.inlineFreeformActive = false;
        this.selectedIndex = idx;
        this.invalidate();
        return;
      }
    }

    if (
      matchesKey(data, Key.space) &&
      count > 0 &&
      this.isCommentToggleRow(this.selectedIndex, filteredOptions)
    ) {
      this.toggleComment();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
      if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
        this.toggleComment();
        return;
      }
      if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
        // Enter on the freeform row: submit inline text if any, else activate
        // the inline field (no editor mode switch).
        const trimmed = this.inlineFreeformText.trim();
        if (trimmed) {
          this.inlineFreeformActive = false;
          this.onSubmit?.(trimmed);
        } else {
          this.inlineFreeformActive = true;
          this.invalidate();
        }
        return;
      }

      const result = filteredOptions[this.selectedIndex]?.title;
      if (result) this.onSubmit?.(result);
      else this.onCancel?.();
      return;
    }

    // When the freeform field is active, swallow backspace (erase) here so it
    // doesn't pop the search filter — `handleInlineFreeformInput` above
    // already handled the freeform-focused case, but guard anyway.
    if (
      this.inlineFreeformActive &&
      (this.keybindings.matches(data, "tui.editor.deleteCharBackward") ||
        matchesKey(data, Key.backspace))
    ) {
      return;
    }

    if (
      this.keybindings.matches(data, "tui.editor.deleteCharBackward") ||
      matchesKey(data, Key.backspace)
    ) {
      this.popSearchCharacter();
      return;
    }

    const printableInput = this.getPrintableInput(data);
    if (printableInput) {
      this.setSearchQuery(this.searchQuery + printableInput);
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const filteredOptions = this.getFilteredOptions();
    const count = this.getItemCount(filteredOptions);
    this.selectedIndex =
      count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

    // Whether the focused row is worth showing a preview for. Synthetic rows
    // (comment-toggle, freeform) always get a preview; real options only when
    // they carry a description. When none do, render flat (current behaviour)
    // — no point in a split or stacked pane for an empty body.
    const hasUsablePreview =
      this.isCommentToggleRow(this.selectedIndex, filteredOptions) ||
      this.isFreeformRow(this.selectedIndex, filteredOptions) ||
      !!filteredOptions[this.selectedIndex]?.description?.trim();

    const splitPane = this.getSplitPaneWidths(width);
    const layout: PreviewLayoutMode = decideLayout(
      this.tui.terminal.columns ?? width,
      width,
    );
    let lines: string[];

    if (
      !hasUsablePreview ||
      (!splitPane && layout === "stacked" && width < 60)
    ) {
      // Flat: terminal too narrow for any preview, or nothing to preview.
      lines = this.buildListLines(width, filteredOptions);
    } else if (splitPane && layout === "side-by-side") {
      // Side-by-side: zip list pane + bordered preview pane with the separator.
      const listLines = this.buildListLines(
        splitPane.left,
        filteredOptions,
        true,
      );
      const previewLines = this.buildPreviewLines(
        splitPane.right,
        Math.min(MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE, this.maxVisibleRows),
      );
      const rowCount = Math.min(
        this.maxVisibleRows,
        Math.max(listLines.length, previewLines.length),
      );
      const separator = this.theme.fg(
        "dim",
        SINGLE_SELECT_SPLIT_PANE_SEPARATOR,
      );
      lines = Array.from({ length: rowCount }, (_, index) => {
        const left = truncateToWidth(
          listLines[index] ?? "",
          splitPane.left,
          "",
          true,
        );
        const right = truncateToWidth(
          previewLines[index] ?? "",
          splitPane.right,
          "",
        );
        return `${left}${separator}${right}`;
      });
    } else {
      // #5 — Stacked fallback: render the list full-width, then a blank gap,
      // then the bordered preview block below (cap MAX_PREVIEW_HEIGHT_STACKED).
      const listLines = this.buildListLines(width, filteredOptions);
      const previewLines = this.buildPreviewLines(
        width,
        Math.min(
          MAX_PREVIEW_HEIGHT_STACKED,
          Math.max(2, Math.floor(this.maxVisibleRows / 2)),
        ),
      );
      if (previewLines.length === 0) {
        lines = listLines;
      } else {
        lines = [
          ...listLines,
          ...Array(STACKED_GAP_ROWS).fill(""),
          ...previewLines,
        ];
      }
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  /**
   * Two-column-body hook: does ANY focused-able row carry a preview body?
   *
   * `AskComponent.render` uses this to decide whether to engage the
   * full-right-side two-column layout: the preview pane is only worth a
   * column when at least one option carries a description OR a synthetic row
   * (comment-toggle / freeform) is present (those always render a body even
   * with no option descriptions). Mirrors the per-focus `hasUsablePreview`
   * check in `render` but OR'd across all items, not just the focused one.
   */
  public hasAnyPreview(): boolean {
    if (this.allowComment || this.allowFreeform) return true;
    if (this.previewCache?.hasAnyPreview()) return true;
    return this.options.some((o) => !!o.description?.trim());
  }

  /**
   * Two-column-body hook: render ONLY the option-list rows (no internal
   * split-pane / stacked preview composition). `AskComponent.render` calls
   * this for the left column of the two-column body and composes the preview
   * itself via `buildPreviewLines`.
   *
   * Equivalent to `buildListLines(width, getFilteredOptions(), true)`
   * (descriptions hidden — the preview column already shows the focused
   * option's description, so the left column must not duplicate them inline).
   * The `maxVisibleRows` windowing is applied by `buildListLines` itself.
   */
  public renderListOnly(width: number): string[] {
    return this.buildListLines(width, this.getFilteredOptions(), true);
  }
}

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
class AskComponent extends Container {
  private question: string;
  private context?: string;
  private options: QuestionOption[];
  private allowMultiple: boolean;
  private allowFreeform: boolean;
  private allowComment: boolean;
  private displayMode: AskDisplayMode;
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private shortcuts: ResolvedAskShortcuts;
  private onDone: (result: AskUIResult | null) => void;

  private mode: AskMode = "select";
  /**
   * Last inner content width seen in `render` (terminal width minus side
   * borders). Stashed so `updateStaticText` / `computeChromeBudget` can clamp
   * the question / context text at the same width the chrome actually
   * renders at — keeping clamped line counts in lockstep with rendered rows.
   */
  private lastInnerWidth = 80;
  private pendingSelections: string[] = [];
  private freeformDraft = "";
  private commentDraft = "";

  // Static layout components
  private titleText: Text;
  private questionText: Text;
  private contextComponent?: Component;
  private modeContainer: Container;
  private helpText: Text;

  // Chrome spacers, held by reference so `applyChromeBudget` can compress
  // them (Spacer.setLines(0) renders nothing). Layout rows that compress:
  // top ├─ title ├─ [context] ├─ question ├─ mode ├─ help ├─ bottom.
  private topSpacer?: Spacer;
  private titleSpacer?: Spacer;
  private contextSpacer?: Spacer;
  private modeSpacer?: Spacer;
  private helpSpacer?: Spacer;
  private bottomSpacer?: Spacer;

  // Last applied chrome budget, so `invalidate` (called by the TUI on theme/
  // size change, which re-runs `updateStaticText` and resets the title) can
  // re-apply the title suppression before the next `super.render`.
  private appliedChromeBudget?: ChromeBudget;

  // Mode components
  private singleSelectList?: WrappedSingleSelectList;
  private multiSelectList?: MultiSelectList;
  private editor?: Editor;

  // Focusable - propagate to Editor for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (this.editor && (this.mode === "freeform" || this.mode === "comment")) {
      (this.editor as any).focused = value;
    }
  }

  constructor(
    question: string,
    context: string | undefined,
    options: QuestionOption[],
    allowMultiple: boolean,
    allowFreeform: boolean,
    allowComment: boolean,
    displayMode: AskDisplayMode,
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    shortcuts: ResolvedAskShortcuts,
    onDone: (result: AskUIResult | null) => void,
  ) {
    super();

    this.question = question;
    this.context = context;
    this.options = options;
    this.allowMultiple = allowMultiple;
    this.allowFreeform = allowFreeform;
    this.allowComment = allowComment;
    this.displayMode = displayMode;
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.shortcuts = shortcuts;
    this.onDone = onDone;

    // Layout skeleton
    this.addChild(
      new BoxBorderTop(
        (s: string) => theme.fg("accent", s),
        "ask_user",
        (s: string) => theme.fg("dim", theme.bold(s)),
      ),
    );
    this.topSpacer = new Spacer(1);
    this.addChild(this.topSpacer);

    this.titleText = new Text("", 1, 0);
    this.addChild(this.titleText);
    this.titleSpacer = new Spacer(1);
    this.addChild(this.titleSpacer);

    this.questionText = new Text("", 1, 0);
    this.addChild(this.questionText);

    if (this.context) {
      this.contextSpacer = new Spacer(1);
      this.addChild(this.contextSpacer);
      const mdTheme = safeMarkdownTheme();
      if (mdTheme) {
        this.contextComponent = new Markdown("", 1, 0, mdTheme);
      } else {
        this.contextComponent = new Text("", 1, 0);
      }
      this.addChild(this.contextComponent);
    }

    this.modeSpacer = new Spacer(1);
    this.addChild(this.modeSpacer);

    this.modeContainer = new Container();
    this.addChild(this.modeContainer);

    this.helpSpacer = new Spacer(1);
    this.addChild(this.helpSpacer);
    this.helpText = new Text("", 1, 0);
    this.addChild(this.helpText);

    this.bottomSpacer = new Spacer(1);
    this.addChild(this.bottomSpacer);
    this.addChild(
      new BoxBorderBottom(
        (s: string) => theme.fg("accent", s),
        `v${ASK_USER_VERSION}`,
        (s: string) => theme.fg("dim", s),
      ),
    );

    this.updateStaticText();
    this.showSelectMode();
  }

  override invalidate(): void {
    super.invalidate();
    this.updateStaticText();
    this.updateHelpText();
    // `updateStaticText` re-sets the title text; `updateHelpText` may touch
    // rows nearby. Re-apply the chrome budget so the title stays suppressed
    // (set to "") and spacers stay compressed for the next `super.render`.
    if (this.appliedChromeBudget)
      this.applyChromeBudget(this.appliedChromeBudget);
  }

  override render(width: number): string[] {
    const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);
    this.lastInnerWidth = innerWidth;

    // Height budget. The modal starts at the ratio floor but grows to fit
    // content (preview body + option list + chrome) up to ~85% of the
    // terminal — so a tall description renders in full instead of being
    // clipped with `\u2702 N lines hidden` while the terminal has space.
    // `availableOptionRows` is derived from this after measuring chrome; the
    // editor (freeform/comment) has no row-cap API and relies on the safety
    // slice below as a fallback.
    const terminalRows = this.tui.terminal.rows ?? 24;
    const ratioFloor = Math.max(
      12,
      Math.floor(terminalRows * ASK_OVERLAY_MAX_HEIGHT_RATIO),
    );
    const terminalCeiling = Math.max(
      ratioFloor,
      Math.floor(terminalRows * 0.85),
    );
    // Content-driven growth: measure the content we'd actually render so the
    // modal grows to fit instead of clipping. The preview body is the usual
    // limiting factor; budget for the tallest option's body (capped at the
    // terminal ceiling). This is a measurement pass — the real render happens
    // below via super.render / renderTwoColumnBody.
    const measuredContentRows = this.measureContentRows(innerWidth);
    const overlayMaxHeight = Math.min(
      terminalCeiling,
      Math.max(ratioFloor, measuredContentRows),
    );
    const chromeBudget = this.computeChromeBudget(innerWidth, overlayMaxHeight);
    this.applyChromeBudget(chromeBudget);
    const availableOptionRows = Math.max(
      2,
      overlayMaxHeight - chromeBudget.staticLineCount,
    );
    if (this.mode === "select" && !this.allowMultiple) {
      this.ensureSingleSelectList().setMaxVisibleRows(availableOptionRows);
    } else if (this.mode === "select" && this.allowMultiple) {
      this.ensureMultiSelectList().setMaxVisibleRows(availableOptionRows);
    }

    // Render children at the inner width (excluding side border characters).
    //
    // Two-column body path: when the modal is wide enough to split the body
    // into two columns (terminal ≥84 cols AND decideLayout picks
    // side-by-side, i.e. terminal ≥100 cols) AND at least one option carries
    // a preview body, render a TWO-COLUMN body: the LEFT column stacks the
    // chrome (title + question + context + mode spacer) on top of the option
    // list (rendered list-only, no internal split/preview), and the RIGHT
    // column runs the preview pane for the focused option down the FULL body
    // height — aligned with the question at the top instead of starting only
    // at the option-list row. The top decorative spacer is rendered ABOVE
    // the body (full-width) and the help row + bottom decorative spacer are
    // rendered BELOW the body (full-width); only the body itself is zipped.
    //
    // In every other case (narrow terminal, no descriptions, stacked layout,
    // or a non-select mode using the editor), fall through to the flat path:
    // `super.render(innerWidth)` renders the whole vertical stack full-width
    // and lets the list do its own flat/stacked/split composition as before.
    const activeList: MultiSelectList | WrappedSingleSelectList | undefined =
      this.mode === "select"
        ? this.allowMultiple
          ? this.multiSelectList
          : this.singleSelectList
        : undefined;
    const splitPane = activeList
      ? activeList.getSplitPaneWidths(innerWidth)
      : null;
    const layout: PreviewLayoutMode | undefined = activeList
      ? decideLayout(this.tui.terminal.columns ?? innerWidth, innerWidth)
      : undefined;
    const engageTwoColumn =
      !!activeList &&
      !!splitPane &&
      layout === "side-by-side" &&
      activeList.hasAnyPreview();

    let rawLines: string[];
    if (engageTwoColumn && splitPane) {
      rawLines = this.renderTwoColumnBody(
        innerWidth,
        splitPane.left,
        splitPane.right,
        overlayMaxHeight,
        activeList,
      );
    } else {
      rawLines = super.render(innerWidth);
    }

    // Safety slice — belt-and-suspenders for editor content (freeform/comment
    // modes have no row-cap API) and pathological tiny-terminal cases. In
    // select modes the list already windows to `availableOptionRows` so this
    // should NOT fire there; guard it to editor/non-select modes only to avoid
    // slicing away real option rows when the 1/4-screen cap makes the budget
    // tight. Preserve top + bottom chrome.
    if (this.mode !== "select" && rawLines.length > overlayMaxHeight) {
      const bottomFixed = 2; // help line + bottom border (last 2 rendered rows)
      const topFixed = Math.max(1, overlayMaxHeight - bottomFixed);
      const head = rawLines.slice(0, topFixed);
      const tail = rawLines.slice(rawLines.length - bottomFixed);
      rawLines = [...head, ...tail];
    }

    // First and last lines are the top/bottom box borders — pass through at full width.
    // Inner lines render at full innerWidth with no side borders (lateral
    // borders removed per request — only top + bottom frame the modal).
    const borderColor = (s: string) => this.theme.fg("accent", s);
    const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
    return rawLines.map((line, index) => {
      if (index === 0 || index === rawLines.length - 1) {
        // Box top/bottom borders already rendered at innerWidth — re-render at full width
        if (index === 0)
          return new BoxBorderTop(borderColor, "ask_user", titleColor).render(
            width,
          )[0];
        return new BoxBorderBottom(
          borderColor,
          `v${ASK_USER_VERSION}`,
          (s: string) => this.theme.fg("dim", s),
        ).render(width)[0];
      }
      // No side borders — just pad/truncate to innerWidth.
      return truncateToWidth(line, innerWidth, "", true);
    });
  }

  /**
   * Compose the two-column body for `render`'s wide-terminal path.
   *
   * Layout (top → bottom):
   *   ┌─ BoxBorderTop        (full innerWidth; the caller's side-border loop
   *   │                        re-renders it at full `width`, so the line here
   *   │                        is just a placeholder so index 0 is the border)
   *   ├─ topSpacer            (full innerWidth — decorative padding ABOVE body)
   *   ├─┬ BODY (two columns, spans full innerWidth = left + sep + right):
   *   │ │   LEFT col  = title + titleSpacer + question + [contextSpacer +
   *   │ │               contextComponent] + modeSpacer + option list
   *   │ │               (rendered list-only via `list.renderListOnly`, no
   *   │ │               internal split/preview), all at `leftWidth`
   *   │ │   RIGHT col = preview pane for the focused option
   *   │ │               (`list.buildPreviewLines`) at `rightWidth`, padded with
   *   │ │               blanks to the body height — so the preview runs the FULL
   *   │ │               body height and aligns with the question at the top
   *   ├─ helpSpacer + helpText (full innerWidth — help stays full-width,
   *   │                          below the body)
   *   ├─ bottomSpacer        (full innerWidth)
   *   └─ BoxBorderBottom      (placeholder; re-rendered at full `width` by caller)
   *
   * `leftWidth + separator.length + rightWidth === innerWidth` (guaranteed by
   * `getSplitPaneWidths`), so each zipped body line already spans `innerWidth`
   * exactly and the caller's side-border wrapping is a no-op on body rows. The
   * ╭╮╰╯ corner borders + side │ are applied uniformly by the caller on the
   * returned `rawLines`.
   *
   * The preview's max height budget = the body height (chrome lines + list
   * rows). `renderPreviewBlock` internally caps the bordered box at
   * `MAX_PREVIEW_HEIGHT_SIDE_BY_SIDE` (20); `buildPreviewLines` then trims with
   * a `…` indicator if the caller's maxLines is tighter. Passing the full body
   * height lets the preview fill all available rows.
   */
  private renderTwoColumnBody(
    innerWidth: number,
    leftWidth: number,
    rightWidth: number,
    bodyBudget: number,
    list: MultiSelectList | WrappedSingleSelectList,
  ): string[] {
    const theme = this.theme;
    const borderColor = (s: string) => theme.fg("accent", s);
    const titleColor = (s: string) => theme.fg("dim", theme.bold(s));
    const bottomLabelColor = (s: string) => theme.fg("dim", s);
    const separator = theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);

    // Chrome + list rendered at `leftWidth` so they wrap into the left column.
    // Spacers render width-agnostic empty strings; Text/Markdown wrap to the
    // given width. The list is rendered list-ONLY (no internal split/preview) —
    // this is the whole point of the restructure.
    const chromeLines: string[] = [];
    if (this.titleText) chromeLines.push(...this.titleText.render(leftWidth));
    if (this.titleSpacer)
      chromeLines.push(...this.titleSpacer.render(leftWidth));
    if (this.questionText)
      chromeLines.push(...this.questionText.render(leftWidth));
    if (this.context) {
      if (this.contextSpacer)
        chromeLines.push(...this.contextSpacer.render(leftWidth));
      if (this.contextComponent)
        chromeLines.push(...this.contextComponent.render(leftWidth));
    }
    if (this.modeSpacer) chromeLines.push(...this.modeSpacer.render(leftWidth));

    const listLines = list.renderListOnly(leftWidth);
    const leftColumnLines = [...chromeLines, ...listLines];

    // Preview for the focused option, allowed to fill the BODY region height
    // — NOT capped at the left column's content length. The body region is the
    // rows between the top border/spacer and the help spacer/text/bottom
    // border. This lets the preview grow tall even when the left column is
    // short (few options + terse chrome) — fixing the `✂ N lines hidden`
    // that fired while the right column still had physical space. The left
    // column pads blank below the list when the preview is taller.
    const nonBodyRows =
      2 +
      /* borders */ 1 +
      /* topSpacer */ 1 +
      /* helpSpacer */ 1 +
      /* helpText */ 1; /* bottomSpacer */
    const bodyRegionRows = Math.max(0, bodyBudget - nonBodyRows);
    const maxPreviewLines = bodyRegionRows;
    const previewLines = list.buildPreviewLines(
      rightWidth,
      Math.max(0, maxPreviewLines),
    );

    const bodyHeight = Math.max(leftColumnLines.length, previewLines.length);
    const bodyLines: string[] = [];
    for (let i = 0; i < bodyHeight; i++) {
      const left = truncateToWidth(
        leftColumnLines[i] ?? "",
        leftWidth,
        "",
        true,
      );
      const right = truncateToWidth(
        previewLines[i] ?? "",
        rightWidth,
        "",
        true,
      );
      bodyLines.push(`${left}${separator}${right}`);
    }

    // Help row + spacers render full-width (innerWidth) — they sit ABOVE and
    // BELOW the two-column body, not inside it. Spacer.render returns empty
    // strings which the caller's side-border pad fills to innerWidth.
    const helpLines: string[] = [];
    if (this.helpSpacer) helpLines.push(...this.helpSpacer.render(innerWidth));
    if (this.helpText) helpLines.push(...this.helpText.render(innerWidth));
    const topSpacerLines = this.topSpacer
      ? this.topSpacer.render(innerWidth)
      : [];
    const bottomSpacerLines = this.bottomSpacer
      ? this.bottomSpacer.render(innerWidth)
      : [];

    // Borders are placeholders at innerWidth; the caller re-renders index 0
    // and the last line as full `width` corner borders (identical to the flat
    // path), so their content here is irrelevant as long as each is a single
    // line.
    const boxTopLine = new BoxBorderTop(
      borderColor,
      "ask_user",
      titleColor,
    ).render(innerWidth)[0];
    const boxBottomLine = new BoxBorderBottom(
      borderColor,
      `v${ASK_USER_VERSION}`,
      bottomLabelColor,
    ).render(innerWidth)[0];

    return [
      boxTopLine,
      ...topSpacerLines,
      ...bodyLines,
      ...helpLines,
      ...bottomSpacerLines,
      boxBottomLine,
    ];
  }

  private countWrappedLines(text: string, width: number): number {
    return Math.max(1, wrapTextWithAnsi(text, Math.max(10, width - 2)).length);
  }

  /**
   * Clamp prose to `maxLines` rows at `width` cols, appending `…` to the
   * last visible line when truncation occurs. Used for the question and
   * context text so a verbose LLM call can't crowd the option list / editor
   * out of the small (1/4-screen) modal. Rendered text and the chrome-budget
   * count share this clamp, so the budget math stays in lockstep with what's
   * actually drawn (no divergence between reserved rows and rendered rows).
   */
  private clampTextToLines(
    text: string,
    width: number,
    maxLines: number,
  ): string {
    const wrapWidth = Math.max(10, width - 2);
    const wrapped = wrapTextWithAnsi(text, wrapWidth);
    if (wrapped.length <= maxLines) return text;
    const kept = wrapped.slice(0, maxLines);
    // Replace the last kept line's content with itself + an ellipsis, trimmed
    // to the wrap width so the `…` always renders without wrapping.
    const lastIdx = kept.length - 1;
    kept[lastIdx] = truncateToWidth(`${kept[lastIdx]}…`, wrapWidth, "");
    return kept.join("\n");
  }

  /**
   * Line count of `clampTextToLines(text, width, maxLines)` — the budget
   * counterpart. Must mirror `clampTextToLines` exactly so `computeChromeBudget`
   * reserves the same number of rows `updateStaticText` actually renders.
   */
  private countClampedLines(
    text: string,
    width: number,
    maxLines: number,
  ): number {
    return Math.min(maxLines, this.countWrappedLines(text, width));
  }

  /**
   * Measurement pass for content-driven modal height (issue #2): estimate
   * how many rows the select-mode body will actually need so `render` can
   * grow `overlayMaxHeight` past the ratio floor to fit a tall preview or a
   * long option list, instead of clipping with `\u2702 N lines hidden`.
   *
   * Counts: chrome (using the unbounded budget so nothing compresses) + the
   * larger of (a) the option-list windowed rows and (b) the focused/max
   * preview body rows. The preview body is measured via the list's
   * `buildPreviewLines` against the right-pane width the two-column path
   * would use; for the flat path we measure against full innerWidth. This is
   * a best-effort estimate — the real render still has the safety slice.
   */
  private measureContentRows(innerWidth: number): number {
    if (this.mode !== "select") {
      // Editor (freeform/comment) modes: hard to predict line count; let the
      // ratio floor + safety slice handle it.
      return 0;
    }
    const chrome = this.computeChromeBudget(
      innerWidth,
      Number.POSITIVE_INFINITY,
    ).staticLineCount;

    const list = this.allowMultiple
      ? this.multiSelectList
      : this.singleSelectList;
    if (!list) return chrome + 4;

    // Option-list rows: window to a generous number (cap at total items) —
    // the list windows internally, but for sizing we want the natural count
    // so long lists can scroll rather than forcing the modal tall.
    const itemCount =
      list instanceof MultiSelectList
        ? ((list as any).getItemCount?.() ?? this.options.length)
        : this.options.length;
    const listRows = Math.min(itemCount, 12);

    // Preview body estimation: measure the focused option's body at the pane
    // width the two-column path would use. Falls back to innerWidth.
    const splitPane = list.getSplitPaneWidths(innerWidth);
    const previewWidth = splitPane?.right ?? innerWidth;
    let maxPreviewRows = 0;
    try {
      maxPreviewRows = list.buildPreviewLines(
        previewWidth,
        Number.POSITIVE_INFINITY,
      ).length;
    } catch {
      maxPreviewRows = 0;
    }

    const body = Math.max(listRows, maxPreviewRows);
    return chrome + body;
  }

  private countStaticLines(width: number): number {
    // Deprecated single-arg form kept for any external callers/tests; defers
    // to computeChromeBudget with an effectively-unbounded height so it
    // never compresses (full chrome). AskComponent.render passes the real
    // overlay height via computeChromeBudget directly.
    return this.computeChromeBudget(width, Number.POSITIVE_INFINITY)
      .staticLineCount;
  }

  /**
   * Computing the chrome budget is deterministic and central to the
   * responsive modal: the same `ChromeBudget` feeds BOTH the rendered chrome
   * (`applyChromeBudget` mutates spacers/title) AND `availableOptionRows`
   * (`overlayMaxHeight - staticLineCount`). If they ever disagree, the list
   * would be capped to a row count that cannot actually fit beside the
   * chrome — causing underflow (clipped options) or wasted empty rows. So
   * this is the single source of truth for how much vertical chrome the modal
   * consumes at a given (width, height).
   *
   * Compression ladder (keyed on the tentative middle budget — i.e. rows
   * left for the option list AFTER chrome):
   *   - middle >= 8:  full chrome (spacerLines 5/6, title shown)
   *   - middle >= 5:  compress spacers to 2 (keep mode + help), title shown
   *   - middle >= 3:  compress spacers to 1 (keep mode only), title shown
   *   - middle  < 3:  compress spacers to 1, title HIDDEN (question is the
   *                   load-bearing label; the `ask_user` banner is not)
   * When `availableHeight` is Infinity (legary `countStaticLines(width)`
   * caller), `middle` is Infinity so the ladder picks full chrome.
   */
  private computeChromeBudget(
    width: number,
    availableHeight: number,
  ): ChromeBudget {
    // Mirror `updateStaticText`'s clamp exactly — the budget must reserve the
    // same number of rows that actually get rendered, or the list region drifts
    // out of sync with the chrome above it.
    const questionLines = this.countClampedLines(
      this.question,
      width,
      QUESTION_MAX_LINES,
    );
    const contextLines = this.context
      ? 1 + this.countClampedLines(this.context, width, CONTEXT_MAX_LINES)
      : 0;
    const borderLines = 2;
    const helpLines = 1;

    const fullSpacerLines = this.context ? 6 : 5;
    const fullTitleLines = 1;
    const fullStatic =
      borderLines +
      fullSpacerLines +
      fullTitleLines +
      questionLines +
      contextLines +
      helpLines;
    const middle = availableHeight - fullStatic;

    let spacerLines: number;
    let showTitle: boolean;
    if (middle >= 8) {
      spacerLines = fullSpacerLines;
      showTitle = true;
    } else if (middle >= 5) {
      spacerLines = 2;
      showTitle = true;
    } else if (middle >= 3) {
      spacerLines = 1;
      showTitle = true;
    } else {
      spacerLines = 1;
      showTitle = false;
    }

    const staticLineCount =
      borderLines +
      spacerLines +
      (showTitle ? fullTitleLines : 0) +
      questionLines +
      contextLines +
      helpLines;
    return { spacerLines, showTitle, staticLineCount };
  }

  /**
   * Apply a chrome budget to the live layout skeleton: set each Spacer's line
   * count and toggle the title text. The Spacer distribution priority (which
   * spacers keep their 1 line when the budget is tight) is: modeSpacer and
   * helpSpacer first (closest to the option list — the list wants adjacent
   * breathing room), then the decorative top/bottom/title/context spacers.
   * `Spacer.setLines(0)` renders nothing; `Text.setText("")` also renders
   * nothing (Text with empty text short-circuits to `[]`), so both chrome
   * rows can be fully hidden rather than left as blank padding.
   *
   * Called from `render` BEFORE `super.render` so children render at the
   * compressed sizes, and re-applied from `invalidate` after `updateStaticText`
   * resets the title text (so a theme/size change can't un-suppress it for a
   * frame).
   */
  private applyChromeBudget(budget: ChromeBudget): void {
    this.appliedChromeBudget = budget;
    const ordered: Spacer[] = [
      // Priority: nearest-to-list first.
      this.modeSpacer,
      this.helpSpacer,
      this.topSpacer,
      this.bottomSpacer,
      this.titleSpacer,
      this.contextSpacer,
    ].filter((s): s is Spacer => s !== undefined);
    let remaining = budget.spacerLines;
    for (const spacer of ordered) {
      const lines = remaining > 0 ? 1 : 0;
      if (spacer.lines !== lines) spacer.setLines(lines);
      remaining -= lines;
    }

    if (budget.showTitle) {
      // `updateStaticText` owns the real title content; if we previously
      // suppressed it, restore it now so the next `super.render` shows it.
      const theme = this.theme;
      const title = this.mode === "comment" ? "Optional comment" : "Question";
      this.titleText.setText(theme.fg("accent", theme.bold(title)));
    } else {
      this.titleText.setText("");
    }
  }

  private updateStaticText(): void {
    const theme = this.theme;
    const title = this.mode === "comment" ? "Optional comment" : "Question";
    this.titleText.setText(theme.fg("accent", theme.bold(title)));
    // Clamp the question (2 lines) and context (3 lines) so a verbose LLM
    // call can't crowd the option list / editor out of the small modal.
    // `computeChromeBudget` uses the matching line counts so budget↔render
    // stay in lockstep. Width is the inner content width minus side borders.
    const innerW = this.lastInnerWidth;
    const clampedQuestion = this.clampTextToLines(
      this.question,
      innerW,
      QUESTION_MAX_LINES,
    );
    this.questionText.setText(theme.fg("text", theme.bold(clampedQuestion)));
    if (this.contextComponent && this.context) {
      const clampedContext = this.clampTextToLines(
        this.context,
        innerW,
        CONTEXT_MAX_LINES,
      );
      if (this.contextComponent instanceof Markdown) {
        (this.contextComponent as Markdown).setText(
          `**Context:**\n${clampedContext}`,
        );
      } else {
        (this.contextComponent as Text).setText(
          `${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", clampedContext)}`,
        );
      }
    }
  }

  private updateHelpText(): void {
    const theme = this.theme;
    const overlayHint =
      this.displayMode === "overlay" && !this.shortcuts.overlayToggle.disabled
        ? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide")
        : null;
    const commentHint =
      this.allowComment && !this.shortcuts.commentToggle.disabled
        ? literalHint(
            theme,
            this.shortcuts.commentToggle.spec,
            "toggle context",
          )
        : null;
    if (this.mode === "freeform" || this.mode === "comment") {
      const alternateCancelKeys = this.keybindings
        .getKeys("tui.select.cancel")
        .filter((key) => key !== "escape" && key !== "esc");
      const hints = [
        keybindingHint(
          theme,
          this.keybindings,
          "tui.input.submit",
          this.mode === "comment" ? "submit/skip" : "submit",
        ),
        keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
        literalHint(theme, "esc", "back"),
        overlayHint,
        alternateCancelKeys.length > 0
          ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
          : null,
      ]
        .filter((hint): hint is string => !!hint)
        .join(" • ");
      this.helpText.setText(theme.fg("dim", hints));
      return;
    }

    if (this.allowMultiple) {
      const hints = [
        literalHint(theme, "↑↓", "navigate"),
        literalHint(theme, "space", "toggle"),
        commentHint,
        overlayHint,
        keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
        keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
      ]
        .filter((hint): hint is string => !!hint)
        .join(" • ");
      this.helpText.setText(theme.fg("dim", hints));
    } else {
      const alternateCancelKeys = this.keybindings
        .getKeys("tui.select.cancel")
        .filter((key) => key !== "escape" && key !== "esc");
      const hints = [
        literalHint(theme, "type", "filter"),
        keybindingHint(
          theme,
          this.keybindings,
          "tui.editor.deleteCharBackward",
          "erase",
        ),
        literalHint(theme, "↑↓", "navigate"),
        commentHint,
        overlayHint,
        keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
        literalHint(theme, "esc", "clear/cancel"),
        alternateCancelKeys.length > 0
          ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
          : null,
      ]
        .filter((hint): hint is string => !!hint)
        .join(" • ");
      this.helpText.setText(theme.fg("dim", hints));
    }
  }

  private ensureSingleSelectList(): WrappedSingleSelectList {
    if (this.singleSelectList) return this.singleSelectList;

    const list = new WrappedSingleSelectList(
      this.options,
      this.allowFreeform,
      this.allowComment,
      this.theme,
      this.tui,
      this.keybindings,
      this.shortcuts.commentToggle,
    );
    list.onSubmit = (result) =>
      this.handleSelectionSubmit([result], list.isCommentEnabled());
    list.onCancel = () => this.onDone(null);
    list.onEnterFreeform = () => this.showFreeformMode();

    this.singleSelectList = list;
    return list;
  }

  private ensureMultiSelectList(): MultiSelectList {
    if (this.multiSelectList) return this.multiSelectList;

    const list = new MultiSelectList(
      this.options,
      this.allowFreeform,
      this.allowComment,
      this.theme,
      this.tui,
      this.keybindings,
      this.shortcuts.commentToggle,
    );
    list.onCancel = () => this.onDone(null);
    list.onSubmit = (result) =>
      this.handleSelectionSubmit(result, list.isCommentEnabled());
    list.onEnterFreeform = () => this.showFreeformMode();

    this.multiSelectList = list;
    return list;
  }

  private ensureEditor(): Editor {
    if (this.editor) return this.editor;
    const editor = new Editor(this.tui, createEditorTheme(this.theme));
    editor.disableSubmit = false;
    editor.onSubmit = (text: string) => {
      this.handleEditorSubmit(text);
    };
    this.editor = editor;
    return editor;
  }

  private saveEditorDraft(): void {
    if (!this.editor) return;
    const getText = (this.editor as any).getText;
    if (typeof getText !== "function") return;

    const currentText = String(getText.call(this.editor) ?? "");
    if (this.mode === "freeform") {
      this.freeformDraft = currentText;
    } else if (this.mode === "comment") {
      this.commentDraft = currentText;
    }
  }

  private setEditorText(text: string): void {
    const editor = this.ensureEditor();
    const setText = (editor as any).setText;
    if (typeof setText === "function") {
      setText.call(editor, text);
    }
  }

  private handleSelectionSubmit(
    selections: string[],
    wantsComment: boolean,
  ): void {
    if (this.allowComment && wantsComment) {
      this.pendingSelections = selections;
      this.commentDraft = "";
      this.showCommentMode();
      return;
    }

    this.onDone(createSelectionResponse(selections));
  }

  private handleEditorSubmit(text: string): void {
    if (this.mode === "freeform") {
      this.onDone(createFreeformResponse(text));
      return;
    }

    if (this.mode === "comment") {
      this.commentDraft = text;
      this.onDone(createSelectionResponse(this.pendingSelections, text));
    }
  }

  private showSelectMode(): void {
    if (this.mode === "freeform" || this.mode === "comment") {
      this.saveEditorDraft();
    }

    this.mode = "select";
    this.pendingSelections = [];
    this.modeContainer.clear();

    if (this.allowMultiple) {
      this.modeContainer.addChild(this.ensureMultiSelectList());
    } else {
      this.modeContainer.addChild(this.ensureSingleSelectList());
    }

    this.updateHelpText();
    this.invalidate();
    this.tui.requestRender();
  }

  private showFreeformMode(): void {
    if (this.mode === "comment") {
      this.saveEditorDraft();
    }

    this.mode = "freeform";
    this.modeContainer.clear();

    const editor = this.ensureEditor();
    this.setEditorText(this.freeformDraft);
    (editor as any).focused = this._focused;

    this.modeContainer.addChild(
      new Text(
        this.theme.fg("accent", this.theme.bold("Custom response")),
        1,
        0,
      ),
    );
    this.modeContainer.addChild(new Spacer(1));
    this.modeContainer.addChild(editor);

    this.updateHelpText();
    this.invalidate();
    this.tui.requestRender();
  }

  private showCommentMode(): void {
    if (this.mode === "freeform") {
      this.saveEditorDraft();
    }

    this.mode = "comment";
    this.modeContainer.clear();

    const editor = this.ensureEditor();
    this.setEditorText(this.commentDraft);
    (editor as any).focused = this._focused;

    const selectedLabel =
      this.pendingSelections.length === 1
        ? "Selected option:"
        : "Selected options:";
    this.modeContainer.addChild(
      new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0),
    );
    this.modeContainer.addChild(
      new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0),
    );
    this.modeContainer.addChild(new Spacer(1));
    this.modeContainer.addChild(editor);

    this.updateHelpText();
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.mode === "freeform" || this.mode === "comment") {
      if (matchesKey(data, Key.escape)) {
        this.showSelectMode();
        return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.onDone(null);
        return;
      }

      this.ensureEditor().handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.allowMultiple) {
      this.ensureMultiSelectList().handleInput?.(data);
      this.tui.requestRender();
      return;
    }

    this.ensureSingleSelectList().handleInput?.(data);
    this.tui.requestRender();
  }
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
async function askViaDialogs(
  ui: { select: Function; input: Function },
  question: string,
  context: string | undefined,
  options: QuestionOption[],
  allowMultiple: boolean,
  allowFreeform: boolean,
  allowComment: boolean,
  timeout?: number,
): Promise<AskUIResult | null> {
  const dialogOpts = timeout ? { timeout } : undefined;
  const prompt = context ? `${question}\n\nContext:\n${context}` : question;

  if (allowMultiple) {
    const optionList = formatOptionsForMessage(options);
    const rawSelections = (await ui.input(
      `${prompt}\n\nOptions (select one or more):\n${optionList}`,
      "Type your selection(s)...",
      dialogOpts,
    )) as string | undefined;
    if (isCancelledInput(rawSelections)) return null;

    const selections = parseDialogSelections(rawSelections);
    if (selections.length === 0) return null;

    if (!allowComment) {
      return createSelectionResponse(selections);
    }

    const comment = (await ui.input(
      buildCommentPrompt(prompt, selections),
      "Optional comment (press Enter to skip)...",
      dialogOpts,
    )) as string | undefined;
    return createSelectionResponse(selections, comment);
  }

  const selectOptions = options.map((o) => o.title);
  if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

  const selected = (await ui.select(prompt, selectOptions, dialogOpts)) as
    string | undefined;
  if (isCancelledInput(selected)) return null;

  if (selected === FREEFORM_SENTINEL) {
    const answer = (await ui.input(
      prompt,
      "Type your answer...",
      dialogOpts,
    )) as string | undefined;
    if (isCancelledInput(answer)) return null;
    return createFreeformResponse(answer);
  }

  if (!allowComment) {
    return createSelectionResponse([selected]);
  }

  const comment = (await ui.input(
    buildCommentPrompt(prompt, [selected]),
    "Optional comment (press Enter to skip)...",
    dialogOpts,
  )) as string | undefined;
  return createSelectionResponse([selected], comment);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask exactly one focused question per call. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
    promptSnippet:
      "Ask the user one focused question with optional multiple-choice answers to gather information interactively",
    promptGuidelines: [
      "Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
      "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
      "Ask exactly one focused question per ask_user call.",
      "Do not combine multiple numbered, multipart, or unrelated questions into one ask_user prompt.",
    ],
    // Block other tool calls in the same assistant turn until the user answers,
    // so the model can't batch ask_user with bash/edit/write and let those run
    // (potentially with side effects) before the user sees the prompt.
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask the user" }),
      context: Type.Optional(
        Type.String({
          description:
            "Relevant context to show before the question (summary of findings)",
        }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String({ description: "Short title for this option" }),
            Type.Object({
              title: Type.String({
                description: "Short title for this option",
              }),
              description: Type.Optional(
                Type.String({
                  description: "Longer description explaining this option",
                }),
              ),
            }),
          ]),
          { description: "List of options for the user to choose from" },
        ),
      ),
      allowMultiple: Type.Optional(
        Type.Boolean({
          description: "Allow selecting multiple options. Default: false",
        }),
      ),
      allowFreeform: Type.Optional(
        Type.Boolean({
          description: "Add a freeform text option. Default: true",
        }),
      ),
      allowComment: Type.Optional(
        Type.Boolean({
          description:
            "Collect an optional comment after selecting one or more options. Default: false",
        }),
      ),
      overlayToggleKey: Type.Optional(
        Type.String({
          description:
            "Shortcut for hiding/showing the overlay popup (overlay mode only), e.g. 'alt+o' or 'ctrl+shift+h'. Pass 'off' to disable. Default: PI_ASK_USER_OVERLAY_TOGGLE_KEY env var if set, otherwise 'alt+o'.",
        }),
      ),
      commentToggleKey: Type.Optional(
        Type.String({
          description:
            "Shortcut for toggling the optional comment/extra-context row when allowComment is true, e.g. 'ctrl+g'. Pass 'off' to disable. Default: PI_ASK_USER_COMMENT_TOGGLE_KEY env var if set, otherwise 'ctrl+g'.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: MSG_USER_DISMISSED }],
          details: {
            question: params.question,
            options: [],
            response: null,
            cancelled: true,
          } as AskToolDetails,
        };
      }

      const {
        question,
        context,
        options: rawOptions = [],
        allowMultiple = false,
        allowFreeform = true,
        allowComment = false,
        overlayToggleKey,
        commentToggleKey,
        timeout,
      } = params as AskParams;
      const envMode = process.env.PI_ASK_USER_DISPLAY_MODE;
      const effectiveDisplayMode: AskDisplayMode =
        envMode === "overlay" || envMode === "inline" ? envMode : "inline";
      const shortcuts: ResolvedAskShortcuts = {
        overlayToggle: resolveShortcut(
          overlayToggleKey,
          process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
          DEFAULT_OVERLAY_TOGGLE_KEY,
        ),
        commentToggle: resolveShortcut(
          commentToggleKey,
          process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
          DEFAULT_COMMENT_TOGGLE_KEY,
        ),
      };
      const { options, dropped } = normalizeOptions(rawOptions);
      const normalizedContext = context?.trim() || undefined;

      // Soft-validation checkpoint: detect malformed input the schema can't see
      // (dropped option entries, missing question, too few options) and hand the
      // model a precise, retry-guided diagnostic. This is distinct from a user
      // dismiss (MSG_USER_DISMISSED) and a UI render failure (MSG_UI_FAILED).
      const inputProblems: string[] = [];
      if (dropped.length > 0) inputProblems.push(...dropped);
      if (!question || !question.trim())
        inputProblems.push("\`question\` is missing or empty");
      if (options.length > 0 && options.length < 2) {
        inputProblems.push(
          "\`options\` has only 1 entry — structured choice needs at least 2 (or drop options and use freeform text input instead)",
        );
      }
      if (rawOptions.length > 0 && options.length === 0) {
        inputProblems.push(
          "every entry in \`options\` was rejected during normalization",
        );
      }
      if (inputProblems.length > 0) {
        const retryHint =
          "Re-issue ask_user with: a non-empty \`question\` string; \`options\` as an array where each entry is either a string or { title: string, description?: string }; fix each problem listed above." +
          (dropped.length > 0
            ? " Check the rejected entries shown above and fix their shape."
            : "") +
          (options.length < 2 && rawOptions.length > 0
            ? " Add at least 2 valid options, or set options=[] and keep allowFreeform=true for a free-text question."
            : "");
        return {
          content: [
            { type: "text", text: MSG_BAD_INPUT(inputProblems, retryHint) },
          ],
          isError: true,
          details: {
            question,
            context: normalizedContext,
            options,
            response: null,
            cancelled: false,
            inputError: inputProblems,
          } as AskToolDetails,
        };
      }

      if (!ctx.hasUI || !ctx.ui) {
        const optionText =
          options.length > 0
            ? `\n\nOptions:\n${formatOptionsForMessage(options)}`
            : "";
        const freeformHint = allowFreeform
          ? "\n\nYou can also answer freely."
          : "";
        const commentHint = allowComment
          ? "\n\nAfter choosing an option, you may add an optional comment."
          : "";
        const contextText = normalizedContext
          ? `\n\nContext:\n${normalizedContext}`
          : "";
        return {
          content: [
            {
              type: "text",
              text: `Ask requires interactive mode. Please answer:\n\n${question}${contextText}${optionText}${freeformHint}${commentHint}`,
            },
          ],
          isError: true,
          details: {
            question,
            context: normalizedContext,
            options,
            response: null,
            cancelled: false,
            error: "no_interactive_ui",
          } as AskToolDetails,
        };
      }

      if (options.length === 0) {
        const prompt = normalizedContext
          ? `${question}\n\nContext:\n${normalizedContext}`
          : question;
        const answer = await ctx.ui.input(
          prompt,
          "Type your answer...",
          timeout ? { timeout } : undefined,
        );
        const response = createFreeformResponse(answer);

        if (!response) {
          return {
            content: [{ type: "text", text: MSG_USER_DISMISSED }],
            details: {
              question,
              context: normalizedContext,
              options,
              response: null,
              cancelled: true,
            } as AskToolDetails,
          };
        }

        pi.events.emit("ask:answered", {
          question,
          context: normalizedContext,
          response,
        });
        return {
          content: [
            {
              type: "text",
              text: `User answered: ${formatResponseSummary(response)}`,
            },
          ],
          details: {
            question,
            context: normalizedContext,
            options,
            response,
            cancelled: false,
          } as AskToolDetails,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: "Waiting for user input..." }],
        details: {
          question,
          context: normalizedContext,
          options,
          response: null,
          cancelled: false,
        },
      });

      let result: AskUIResult | null;
      let overlayHandle: OverlayHandle | undefined;
      let removeOverlayInputListener: (() => void) | undefined;
      let hasAnnouncedHide = false;
      try {
        const customFactory = (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (result: AskUIResult | null) => void,
        ) => {
          if (signal) {
            const onAbort = () => done(null);
            signal.addEventListener("abort", onAbort, { once: true });
          }

          if (timeout && timeout > 0) {
            setTimeout(() => done(null), timeout);
          }

          return new AskComponent(
            question,
            normalizedContext,
            options,
            allowMultiple,
            allowFreeform,
            allowComment,
            effectiveDisplayMode,
            tui,
            theme,
            keybindings,
            shortcuts,
            done,
          );
        };

        // Register a raw terminal input listener for the overlay-toggle key so the
        // overlay can be toggled even while it is hidden (hidden overlays do not
        // receive input). Inline mode does not need this because the prompt is
        // already non-modal. Skipped entirely if the user disabled the shortcut.
        const overlayToggle = shortcuts.overlayToggle;
        if (
          effectiveDisplayMode === "overlay" &&
          !overlayToggle.disabled &&
          typeof ctx.ui.onTerminalInput === "function"
        ) {
          removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
            if (!overlayToggle.matches(data) || !overlayHandle)
              return undefined;
            const nextHidden = !overlayHandle.isHidden();
            overlayHandle.setHidden(nextHidden);
            if (nextHidden && !hasAnnouncedHide) {
              hasAnnouncedHide = true;
              ctx.ui.notify?.(
                `ask_user hidden — press ${overlayToggle.spec} to reopen`,
                "info",
              );
            }
            return { consume: true };
          });
        }

        const customResult = await ctx.ui.custom<AskUIResult | null>(
          customFactory,
          buildCustomUIOptions(effectiveDisplayMode, (handle) => {
            overlayHandle = handle;
          }),
        );

        if (customResult !== undefined) {
          result = customResult;
        } else {
          // RPC/headless mode: degrade to select()/input() dialog protocol
          result = await askViaDialogs(
            ctx.ui,
            question,
            normalizedContext,
            options,
            allowMultiple,
            allowFreeform,
            allowComment,
            timeout,
          );
        }
      } catch (error) {
        const detail =
          error instanceof Error
            ? `${error.message}\n${error.stack ?? ""}`
            : String(error);
        return {
          content: [{ type: "text", text: MSG_UI_FAILED(detail) }],
          isError: true,
          details: { error: detail },
        };
      } finally {
        removeOverlayInputListener?.();
      }

      if (result === null) {
        pi.events.emit("ask:cancelled", {
          question,
          context: normalizedContext,
          options,
        });
        return {
          content: [{ type: "text", text: MSG_USER_DISMISSED }],
          details: {
            question,
            context: normalizedContext,
            options,
            response: null,
            cancelled: true,
          } as AskToolDetails,
        };
      }

      pi.events.emit("ask:answered", {
        question,
        context: normalizedContext,
        response: result,
      });
      return {
        content: [
          {
            type: "text",
            text: `User answered: ${formatResponseSummary(result)}`,
          },
        ],
        details: {
          question,
          context: normalizedContext,
          options,
          response: result,
          cancelled: false,
        } as AskToolDetails,
      };
    },

    renderCall(args, theme) {
      const question = (args.question as string) || "";
      const rawOptions = Array.isArray(args.options) ? args.options : [];
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg("muted", question);
      if (rawOptions.length > 0) {
        const labels = rawOptions.map((o: unknown) =>
          typeof o === "string" ? o : ((o as QuestionOption)?.title ?? ""),
        );
        text +=
          "\n" +
          theme.fg(
            "dim",
            `  ${rawOptions.length} option(s): ${labels.join(", ")}`,
          );
      }
      if (args.allowMultiple) {
        text += theme.fg("dim", " [multi-select]");
      }
      if (args.allowComment) {
        text += theme.fg("dim", " [optional comment]");
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      const details = result.details as
        (AskToolDetails & { error?: string }) | undefined;

      if (details?.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      if (options.isPartial) {
        const waitingText =
          result.content
            ?.filter(
              (part: { type?: string; text?: string }) => part?.type === "text",
            )
            .map((part: { text?: string }) => part.text ?? "")
            .join("\n")
            .trim() || "Waiting for user input...";
        return new Text(theme.fg("muted", waitingText), 0, 0);
      }

      if (!details || details.cancelled || !details.response) {
        // Render a label matching the actual failure mode, not a blanket "Cancelled".
        // The LLM-facing message text (in result.content) already carries full recovery
        // guidance; this label is just the at-a-glance TUI summary.
        let label: string;
        let tone: "warning" | "error" = "warning";
        if (details?.inputError && details.inputError.length > 0) {
          label = `✗ Bad input (${details.inputError.length} issue${details.inputError.length === 1 ? "" : "s"})`;
          tone = "error";
        } else if (details?.error === "no_interactive_ui") {
          label = "⊘ No interactive UI";
        } else if (details?.cancelled) {
          label = "⊘ Dismissed by user";
        } else if (!details) {
          label = "Cancelled";
        } else {
          // No response but not cancelled and no flagged error — true cancel/timeout.
          label = "Cancelled";
        }
        return new Text(theme.fg(tone, label), 0, 0);
      }

      const response = details.response;
      let text = theme.fg("success", "✓ ");
      if (response.kind === "freeform") {
        text += theme.fg("muted", "(wrote) ");
      }
      text += theme.fg("accent", formatResponseSummary(response));

      if (options.expanded) {
        text += "\n" + theme.fg("dim", `Q: ${details.question}`);
        if (details.context) {
          text += "\n" + theme.fg("dim", details.context);
        }

        if (isSelectionResponse(response) && details.options.length > 0) {
          const selectedTitles = new Set(response.selections);
          text += "\n" + theme.fg("dim", "Options:");
          for (const opt of details.options) {
            const desc = opt.description ? ` — ${opt.description}` : "";
            const marker = selectedTitles.has(opt.title)
              ? theme.fg("success", "●")
              : theme.fg("dim", "○");
            text += `\n  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
          }
          if (response.comment) {
            text += `\n${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}`;
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
