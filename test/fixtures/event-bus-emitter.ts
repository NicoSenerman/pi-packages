/**
 * Fixture extension for the EventBus acceptance test.
 *
 * Registers `/emit-touched <path...>` which forwards the supplied paths
 * onto the `autoformat:touched` channel. Drives the production
 * extension's pi.events subscription end-to-end without requiring an
 * LLM-driven tool call.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function eventBusEmitter(pi: ExtensionAPI): void {
  pi.registerCommand("emit-touched", {
    description: "Emit autoformat:touched for the supplied paths",
    handler: async (args) => {
      const paths = args
        .split(/\s+/)
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
      if (paths.length === 0) {
        return;
      }
      pi.events.emit("autoformat:touched", { paths });
    },
  });
}
