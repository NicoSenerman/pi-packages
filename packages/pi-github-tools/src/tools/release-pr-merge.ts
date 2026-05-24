import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
} from "#src/lib/config";
import { type MergeMethod, mergeReleasePR } from "#src/lib/release";
import { err, ok } from "#src/tool-result";

export function registerReleasePrMerge(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "release_pr_merge",
    label: "Release PR Merge",
    description:
      "Merge a release-please PR after confirming it is clean. " +
      "Checks MERGEABLE + CLEAN status, merges, and runs git pull --ff-only. " +
      "Returns merge confirmation with new HEAD SHA, or a structured error if not mergeable.",
    promptSnippet:
      "release_pr_merge: Merge a release-please PR after confirming it's clean.",
    parameters: Type.Object({
      pr_number: Type.Number({
        description: "The PR number to merge.",
      }),
      method: Type.Optional(
        Type.Union(
          [
            Type.Literal("rebase"),
            Type.Literal("squash"),
            Type.Literal("merge"),
          ],
          {
            description:
              'Merge strategy: "rebase", "squash", or "merge". Falls back to config, then gh default.',
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const config = loadConfig({
          globalConfigPath: getGlobalConfigPath(
            join(homedir(), ".pi", "agent"),
          ),
          projectConfigPath: getProjectConfigPath(process.cwd()),
        });
        const result = await mergeReleasePR({
          prNumber: params.pr_number,
          method: (params.method ?? config.defaultMergeMethod) as
            | MergeMethod
            | undefined,
          signal,
        });
        return result.isError ? err(result.content) : ok(result.content);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}
