import { Text } from "@earendil-works/pi-tui";
import {
  isTerminalErrorStatus,
  type SubagentStatus,
} from "#src/lifecycle/subagent-state";
import type { NotificationDetails } from "#src/observation/notification";
import { formatMs, formatTokens, formatTurns } from "#src/ui/display";
import { GLYPHS } from "#src/ui/glyphs";

/** Narrow theme interface — only the methods the renderer actually calls. */
interface RendererTheme {
  fg(style: string, text: string): string;
  bold(text: string): string;
}

/** Narrow message interface — only the fields the renderer reads. */
interface RendererMessage {
  details?: NotificationDetails;
}

/** Narrow render options — only the fields the renderer reads. */
interface RenderOptions {
  expanded: boolean;
}

// ---- Pure helpers (exported for unit testing) ----

/** Resolved status→presentation product: icon glyph/style and status label. */
export interface StatusPresentation {
  iconGlyph: string;
  iconStyle: string;
  statusText: string;
}

/** Decide the icon and status label for a notification's status, once. */
export function resolveStatusPresentation(status: SubagentStatus): StatusPresentation {
  if (isTerminalErrorStatus(status))
    return { iconGlyph: GLYPHS.failure, iconStyle: "error", statusText: status };
  const statusText = status === "steered" ? "completed (steered)" : "completed";
  return { iconGlyph: GLYPHS.success, iconStyle: "success", statusText };
}

/** Fields `buildStatsParts` reads from a `NotificationDetails`. */
type StatsSource = Pick<
  NotificationDetails,
  "turnCount" | "maxTurns" | "toolUses" | "totalTokens" | "durationMs"
>;

/** Assemble the stats-line parts (turns, tool uses, tokens, duration), omitting zero fields. */
export function buildStatsParts(d: StatsSource): string[] {
  const parts: string[] = [];
  if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
  if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
  return parts;
}

/**
 * Content lines for the result preview: the whole result (capped at 30 lines)
 * when expanded, or just the first line (capped at 80 columns) when collapsed.
 */
export function buildPreviewLines(resultPreview: string, expanded: boolean): string[] {
  if (expanded) return resultPreview.split("\n").slice(0, 30);
  return [resultPreview.split("\n")[0]?.slice(0, 80) ?? ""];
}

/**
 * Create the notification renderer callback for `pi.registerMessageRenderer`.
 * Returns a factory so the renderer is independently testable without the Pi SDK.
 */
export function createNotificationRenderer() {
  return (message: RendererMessage, { expanded }: RenderOptions, theme: RendererTheme): Text | undefined => {
    const d = message.details;
    if (!d) return undefined;

    const { iconGlyph, iconStyle, statusText } = resolveStatusPresentation(d.status);

    // Line 1: icon + agent description + status
    let line = `${theme.fg(iconStyle, iconGlyph)} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

    // Line 2: stats
    const parts = buildStatsParts(d);
    if (parts.length) {
      line += "\n  " + parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
    }

    // Line 3: result preview (collapsed) or full (expanded)
    const previewLines = buildPreviewLines(d.resultPreview, expanded);
    if (expanded) {
      for (const l of previewLines) line += "\n" + theme.fg("dim", `  ${l}`);
    } else {
      line += "\n  " + theme.fg("dim", `${GLYPHS.subLine}  ${previewLines[0] ?? ""}`);
    }

    // Line 4: output file link (if present)
    if (d.outputFile) {
      line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
    }

    return new Text(line, 0, 0);
  };
}

/**
 * Create the update renderer callback for `pi.registerMessageRenderer`
 * (`subagent-update`): one line — glyph, description, the message's first line.
 */
export function createUpdateRenderer() {
  return (
    message: { details?: { description: string; message: string } },
    _options: RenderOptions,
    theme: RendererTheme,
  ): Text | undefined => {
    const d = message.details;
    if (!d) return undefined;
    const first = d.message.split("\n")[0] ?? "";
    const line =
      `${theme.fg("dim", GLYPHS.toolCall)} ${theme.bold(d.description)} ` +
      theme.fg("dim", `— ${first}`);
    return new Text(line, 0, 0);
  };
}

/** Theme that leaves every string untouched — pi has no TUI theme under RPC. */
const IDENTITY_THEME: RendererTheme = {
  fg: (_style, text) => text,
  bold: (text) => text,
};

/** pi RPC hosts (piru) cannot run message renderers; render the card headlessly. */
const RPC_CARD_WIDTH = 96;

/**
 * Post-process a headless card for chat hosts that hard-wrap: drop the
 * component's padding rows and shorten the transcript line to its basename
 * (the full path is noise at chat width; the nudge and the viewer carry it).
 */
function tidyRpcCard(lines: string[]): string {
  return lines
    .map((line) =>
      line.trimEnd().replace(/transcript: (\S+\/)([^/\s]+)$/, "transcript: $2"),
    )
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/**
 * Pre-render a notification/update card to plain lines for RPC hosts. Uses the
 * same registered renderers native pi uses, so piru chat and native pi stay in
 * lockstep as the card layout evolves.
 */
export function renderNotificationCardForRpc(details: NotificationDetails): string {
  const shortFile = details.outputFile?.split("/").pop();
  const component = createNotificationRenderer()(
    { details: shortFile ? { ...details, outputFile: shortFile } : details },
    { expanded: false },
    IDENTITY_THEME,
  );
  return component ? tidyRpcCard(component.render(RPC_CARD_WIDTH)) : "";
}

/** The update counterpart of renderNotificationCardForRpc. */
export function renderUpdateCardForRpc(details: { description: string; message: string }): string {
  const component = createUpdateRenderer()({ details }, { expanded: false }, IDENTITY_THEME);
  return component ? tidyRpcCard(component.render(RPC_CARD_WIDTH)) : "";
}
