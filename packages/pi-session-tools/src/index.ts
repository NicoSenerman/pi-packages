/**
 * pi-session-tools — Session metadata tools for multi-session workflows.
 *
 * Tools:
 *   set_session_name — Set the session display name (shown in session selector)
 *   get_session_name — Get the current session name
 *   read_session — Read the current session's raw entries (survives compaction)
 *   read_parent_session — Read the parent session's entries from a subagent context
 */

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  formatSummaryText,
  type SessionSummary,
  summarizeEntries,
} from "./entry-summary.js";
import { formatTranscript } from "./format-transcript.js";
import {
  deriveParentSessionFile,
  readParentSessionEntries,
} from "./parent-session.js";

/** Discriminated union stored in tool `details` for the two session-read tools. */
type SessionToolDetails =
  | { kind: "transcript"; summary: SessionSummary }
  | { kind: "status"; message: string };

// ---- rendering helpers ----

/**
 * Compact call label: `read session (types: [...], limit: N)` or `read parent session`.
 * Extra params omitted when not supplied.
 */
function formatCallText(
  label: string,
  args: { types?: string[]; limit?: number },
  theme: Theme,
): string {
  const hints: string[] = [];
  if (args.types && args.types.length > 0)
    hints.push(`types: [${args.types.join(", ")}]`);
  if (args.limit != null) hints.push(`limit: ${args.limit}`);
  const suffix = hints.length > 0 ? ` (${hints.join(", ")})` : "";
  return `${theme.fg("toolTitle", theme.bold(label))}${theme.fg("muted", suffix)}`;
}

/**
 * Collapsed or expanded result text for a session-read tool.
 *
 * Collapsed: one-line summary (or status message) + expand hint.
 * Expanded: full transcript content lines coloured as tool output.
 */
function formatResultText(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: { expanded: boolean },
  theme: Theme,
): string {
  const details = result.details as SessionToolDetails | undefined;
  const outputText =
    result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "";

  if (options.expanded) {
    return outputText
      .split("\n")
      .map((l) => theme.fg("toolOutput", l))
      .join("\n");
  }

  // Collapsed view.
  const hint = keyHint("app.tools.expand", "to expand");
  if (!details) {
    return `${theme.fg("muted", outputText.split("\n")[0] ?? "")} ${hint}`;
  }
  if (details.kind === "status") {
    return `${theme.fg("warning", "\u26a0")} ${theme.fg("muted", details.message)} ${hint}`;
  }
  // kind === "transcript"
  return `${theme.fg("success", "\u2713")} ${theme.fg("muted", formatSummaryText(details.summary))} ${hint}`;
}

export default function sessionTools(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "set_session_name",
      label: "Set Session Name",
      description:
        "Set the current session's display name. " +
        "The name appears in the session selector for identification when resuming work. " +
        "Use a stage-encoded format like '#42 Planning — Extract ExtensionPaths' " +
        "to identify both the issue and the workflow stage.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "The session display name (e.g., '#42 Planning — My feature title')",
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(_toolCallId, params) {
        pi.setSessionName(params.name);
        return {
          content: [
            { type: "text", text: `Session name set to: ${params.name}` },
          ],
          details: undefined,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "get_session_name",
      label: "Get Session Name",
      description:
        "Get the current session's display name, if one has been set.",
      parameters: Type.Object({}),
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute() {
        const name = pi.getSessionName();
        return {
          content: [
            {
              type: "text",
              text: name
                ? `Current session name: ${name}`
                : "No session name set.",
            },
          ],
          details: undefined,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "read_session",
      label: "Read Session",
      description:
        "Read the current session's raw entries from the session file. " +
        "Returns a structured transcript that survives context compaction — use this to inspect " +
        "the full session history including messages, model changes, compaction events, and custom entries. " +
        "The transcript format shows numbered user/assistant turns, one-line tool call summaries with " +
        "correlated results, and metadata events (compaction, model changes). " +
        "Tool result bodies, thinking content, and image data are omitted.",
      parameters: Type.Object({
        types: Type.Optional(
          Type.Array(
            Type.String({
              description:
                'Entry type to include (e.g., "message", "compaction", "model_change", "custom")',
            }),
            {
              description:
                "Filter entries by type. When omitted, all entry types are returned.",
            },
          ),
        ),
        limit: Type.Optional(
          Type.Number({
            description:
              "Return only the most recent N entries (after type filtering). When omitted, all matching entries are returned.",
          }),
        ),
      }),
      renderCall(args, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatCallText("read session", args, theme));
        return text;
      },
      renderResult(result, options, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatResultText(result, options, theme));
        return text;
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(
        _toolCallId: string,
        params: { types?: string[]; limit?: number },
        _signal: unknown,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        let entries = ctx.sessionManager.getEntries();
        if (params.types) {
          const allowed = new Set(params.types);
          entries = entries.filter((e) => allowed.has(e.type));
        }
        if (params.limit != null) {
          entries = entries.slice(-params.limit);
        }
        const summary = summarizeEntries(entries);
        return {
          content: [{ type: "text", text: formatTranscript(entries) }],
          details: { kind: "transcript", summary } as SessionToolDetails,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "read_parent_session",
      label: "Read Parent Session",
      description:
        "Read the parent session's entries when running inside a subagent. " +
        "Derives the parent session file from the subagent directory layout. " +
        "Returns a structured transcript with numbered user/assistant turns, one-line tool call summaries, " +
        "and metadata events. Tool result bodies, thinking content, and image data are omitted. " +
        "Returns an error if not running in a subagent context.",
      parameters: Type.Object({
        types: Type.Optional(
          Type.Array(
            Type.String({
              description:
                'Entry type to include (e.g., "message", "compaction", "model_change")',
            }),
            {
              description:
                "Filter entries by type. When omitted, all entry types are returned.",
            },
          ),
        ),
        limit: Type.Optional(
          Type.Number({
            description:
              "Return only the most recent N entries (after type filtering).",
          }),
        ),
      }),
      renderCall(args, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatCallText("read parent session", args, theme));
        return text;
      },
      renderResult(result, options, theme, context) {
        const text =
          (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(formatResultText(result, options, theme));
        return text;
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- satisfies async tool interface; no actual async work
      async execute(
        _toolCallId: string,
        params: { types?: string[]; limit?: number },
        _signal: unknown,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const sessionFile = ctx.sessionManager.getSessionFile();
        const parentFile = deriveParentSessionFile(sessionFile);
        if (!parentFile) {
          return {
            content: [
              {
                type: "text",
                text: "This session is not running inside a subagent — no parent session available.",
              },
            ],
            details: {
              kind: "status",
              message: "Not running inside a subagent",
            } as SessionToolDetails,
          };
        }

        const allEntries = readParentSessionEntries(parentFile);
        if (!allEntries) {
          return {
            content: [
              {
                type: "text",
                text: `Parent session file not found: ${parentFile}`,
              },
            ],
            details: {
              kind: "status",
              message: `Parent session file not found: ${parentFile}`,
            } as SessionToolDetails,
          };
        }

        let entries = allEntries;
        if (params.types) {
          const allowed = new Set(params.types);
          entries = entries.filter((e) => allowed.has(e.type));
        }
        if (params.limit != null) {
          entries = entries.slice(-params.limit);
        }

        const summary = summarizeEntries(entries);
        return {
          content: [{ type: "text", text: formatTranscript(entries) }],
          details: { kind: "transcript", summary } as SessionToolDetails,
        };
      },
    }),
  );
}
