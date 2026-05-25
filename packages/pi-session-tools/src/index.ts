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
} from "@earendil-works/pi-coding-agent";
import {
  deriveParentSessionFile,
  readParentSessionEntries,
} from "./parent-session.js";

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
        "Returns JSONL entries that survive context compaction — use this to inspect " +
        "the full session history including messages, model changes, compaction events, and custom entries.",
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
        return {
          content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
          details: undefined,
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
            details: undefined,
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
            details: undefined,
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

        return {
          content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
          details: undefined,
        };
      },
    }),
  );
}
