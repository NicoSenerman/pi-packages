/**
 * /worktree — create an isolated git worktree + peer Pi session for an issue.
 *
 * Project-local extension (auto-discovered from `.pi/extensions/`). Registers a
 * `/worktree <issue> [initial-command]` slash command that shells out to
 * `scripts/worktree-new.sh` via `pi.exec` — no LLM turn, runs directly in code.
 *
 * The script creates a branch + worktree under
 * `~/development/pi/pi-packages-worktrees/issue-<N>`, runs `pnpm install`, and
 * spawns a new WezTerm tab whose CWD is the worktree, launching Pi with an
 * initial prompt (default `/plan-issue <N>`) already submitted.
 *
 * Usage:
 *   /worktree 42              → branch issue-42-<slug>, peer session runs /plan-issue 42
 *   /worktree 42 build-plan   → peer session runs /build-plan 42 instead
 */

import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SCRIPT_REL_PATH = "scripts/worktree-new.sh";

// pnpm install dominates the runtime; give it generous headroom.
const TIMEOUT_MS = 5 * 60 * 1000;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("worktree", {
    description:
      "Create an isolated worktree + peer Pi session for an issue (usage: /worktree <issue> [command])",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const issue = tokens[0];

      if (!issue || !/^[0-9]+$/.test(issue)) {
        ctx.ui.notify(
          "Usage: /worktree <issue-number> [initial-command]",
          "warning",
        );
        return;
      }

      // tokens[1..] become the optional initial-command override for the peer
      // session (e.g. `build-plan`); the script defaults to `/plan-issue <N>`.
      const scriptArgs = [issue, ...tokens.slice(1)];
      const scriptPath = path.join(ctx.cwd, SCRIPT_REL_PATH);

      ctx.ui.notify(
        `Creating worktree for issue #${issue} (pnpm install may take a moment)…`,
        "info",
      );

      const result = await pi.exec("/bin/bash", [scriptPath, ...scriptArgs], {
        cwd: ctx.cwd,
        timeout: TIMEOUT_MS,
      });

      if (result.code === 0) {
        // Surface the script's final summary line (worktree path / branch / tab).
        const lastLine =
          result.stdout
            .trimEnd()
            .split("\n")
            .filter((line) => line.trim())
            .pop() ?? `Worktree created for issue #${issue}.`;
        ctx.ui.notify(lastLine, "info");
      } else {
        const detail = (result.stderr || result.stdout)
          .trim()
          .split("\n")
          .pop();
        ctx.ui.notify(
          `worktree-new.sh failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
          "error",
        );
      }
    },
  });
}
