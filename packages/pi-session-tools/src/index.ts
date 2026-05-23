/**
 * pi-session-tools — Session metadata tools for multi-session workflows.
 *
 * Tools:
 *   set_session_name — Set the session display name (shown in session selector)
 *   get_session_name — Get the current session name
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
}
