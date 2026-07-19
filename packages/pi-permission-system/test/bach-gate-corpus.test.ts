/**
 * BACH-gate validation corpus — integration-level regression net.
 *
 * Drives the REAL integration path end-to-end for each corpus command:
 *   tree-sitter parse → `resolveBashCommandCheck` (chain decomposition +
 *   most-restrictive-wins) → `describeToolGate` (builds `promptDetails` with
 *   `fullCommand` from `input.command`) → real `PermissionPrompter`
 *   (BACH + auto-approve) → assert force-prompt vs. auto-approve.
 *
 * This is the layer the original suite lacked: it tests the *wiring*, not
 * `requiresBachPrompt` in isolation. A destructive op on any line of a
 * multi-line/chained program must trip the gate even when the permissive
 * default config (`"*": "allow"`) lets every unit resolve `allow` — that was
 * the gap that let a `wrangler deploy` after a leading `cd` auto-approve
 * ungated.
 *
 * Add real-world command shapes here as they surface in production. Each entry
 * pins the contract for the BACH gate as the regex/parser evolve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeToolGate } from "#src/handlers/gates/tool";
import { resolveBashCommandCheck } from "#src/handlers/gates/bash-command";
import { BashProgram } from "#src/handlers/gates/bash-program";
import type { ToolCallContext } from "#src/handlers/gates/types";
import {
  PermissionPrompter,
  type PermissionPrompterDeps,
} from "#src/permission-prompter";
import type { ScopedPermissionResolver } from "#src/permission-resolver";
import {
  TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH,
  TOOL_INPUT_PREVIEW_MAX_LENGTH,
  TOOL_TEXT_SUMMARY_MAX_LENGTH,
} from "#src/tool-input-preview";
import { ToolPreviewFormatter } from "#src/tool-preview-formatter";
import { makeCheckResult } from "#test/helpers/handler-fixtures";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { markModeExplicitlySet, resetModeState } from "#src/yolo-mode";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Permissive `allow-all` resolver — mirrors the no-config default state. */
function makeAllowAllResolver(): ScopedPermissionResolver {
  return {
    resolve: (_surface, input: { command?: string }) =>
      makeCheckResult({
        state: "allow",
        toolName: "bash",
        source: "bash",
        command: input.command ?? "",
      }),
    resolvePathPolicy: () =>
      makeCheckResult({ state: "allow", toolName: "bash", source: "bash" }),
  };
}

function makeFormatter(): ToolPreviewFormatter {
  return new ToolPreviewFormatter({
    toolInputPreviewMaxLength: TOOL_INPUT_PREVIEW_MAX_LENGTH,
    toolTextSummaryMaxLength: TOOL_TEXT_SUMMARY_MAX_LENGTH,
    toolInputLogPreviewMaxLength: TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH,
  });
}

const mockRequestApproval = vi.fn();

function makePrompterDeps(): PermissionPrompterDeps {
  return {
    config: {
      current: () => ({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: false }),
    },
    logger: { review: vi.fn() },
    events: { emit: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) },
    forwarder: { requestApproval: mockRequestApproval },
  };
}

/**
 * Run a command through the full BACH-gate path and report whether it would
 * auto-approve (true) or force-prompt (false) under BACH + auto-approve.
 *
 * `source: "tool_call"` + built `promptDetails.fullCommand` exactly mirror what
 * `describeToolGate` produces for a live `bash` tool call.
 */
async function bachGateAutoApproves(command: string): Promise<boolean> {
  const program = await BashProgram.parse(command);
  const check = resolveBashCommandCheck(
    command,
    program.commands(),
    undefined,
    makeAllowAllResolver(),
  );
  const tcc: ToolCallContext = {
    toolName: "bash",
    agentName: null,
    input: { command },
    toolCallId: "tc-corpus",
    cwd: "/test/project",
  };
  const descriptor = describeToolGate(tcc, check, makeFormatter());

  const prompter = new PermissionPrompter(makePrompterDeps());
  const ctx = {
    hasUI: false,
    ui: { select: vi.fn(), input: vi.fn() },
    sessionManager: { getSessionDir: vi.fn().mockReturnValue(null) },
  } as unknown as Parameters<PermissionPrompter["prompt"]>[0];

  const decision = await prompter.prompt(ctx, {
    requestId: "req-corpus",
    ...descriptor.promptDetails,
  });
  return decision.autoApproved === true;
}

// ── Corpus ─────────────────────────────────────────────────────────────────

/** Each entry: [command, mustForcePrompt]. `true` = destructive (must prompt). */
const CORPUS: Array<
  [label: string, command: string, mustForcePrompt: boolean]
> = [
  // ── Direct mutating invocations (baseline — already worked) ──
  ["bare wrangler deploy", "wrangler deploy", true],
  ["npx wrangler deploy", "npx wrangler deploy", true],
  ["pinned-version deploy", "npx wrangler@3.10.0 deploy", true],
  ["wrangler secret put", "wrangler secret put KEY", true],
  ["wrangler d1 execute", "wrangler d1 execute db --command 'SELECT 1'", true],
  ["wrangler versions upload", "wrangler versions upload", true],
  ["wrangler kv namespace delete", "wrangler kv namespace delete my-ns", true],
  ["cf deploy", "cf deploy", true],

  // ── Single-line chained (already worked via whole-string regex match) ──
  ["cd && wrangler deploy", "cd ./worker && wrangler deploy", true],
  [
    "env-prefix wrangler deploy",
    "CLOUDFLARE_ACCOUNT_ID=1 wrangler deploy",
    true,
  ],

  // ── Multi-line: destructive op on a LATER line (the regression) ──
  [
    "audit-session deploy",
    [
      "cd /home/sparkik/Documents/Projects/gyg-modern-app",
      "git add packages/api/src/scrapers/dequienes-gyg/CONTEXT.md",
      'git commit -m "docs: skip dead source"',
      'echo "---"',
      'echo "deploying..."',
      "cd packages/api",
      "npx wrangler deploy --name scrapers --env production 2>&1 | tail -8",
    ].join("\n"),
    true,
  ],
  ["newline deploy after cd", "cd /repo\necho hi\nwrangler deploy", true],
  ["newline secret put after cd", "cd /repo\nwrangler secret put KEY", true],
  [
    "newline d1 execute",
    "cd /repo\nwrangler d1 execute db --file ./s.sql",
    true,
  ],
  ["newline git push", "cd /repo\ngit add .\ngit commit -m x\ngit push", true],
  ["newline rm -rf", "cd /repo\nrm -rf node_modules", true],
  ["newline sudo", "cd /repo\nsudo apt-get update", true],
  ["newline kubectl delete", "cd /repo\nkubectl delete pod foo", true],
  ["newline DROP TABLE via echo", "cd /repo\necho 'DROP TABLE users'", true],
  [
    "deploy in trailing pipe",
    "cd /repo\nnpx wrangler deploy 2>&1 | tail -8",
    true,
  ],

  // ── Read-only wrangler (must auto-approve) ──
  ["bare wrangler tail", "wrangler tail", false],
  ["wrangler tail my-worker", "wrangler tail my-worker", false],
  ["wrangler secret list", "wrangler secret list", false],
  ["wrangler deployments list", "wrangler deployments list", false],
  ["wrangler kv key list", "wrangler kv key list", false],
  ["wrangler r2 bucket list", "wrangler r2 bucket list", false],
  ["wrangler d1 list", "wrangler d1 list", false],
  ["wrangler whoami", "wrangler whoami", false],
  ["wrangler dev", "wrangler dev", false],
  ["wrangler types", "wrangler types", false],
  [
    "newline read-only ops",
    "cd /repo\nwrangler tail\nwrangler deployments list",
    false,
  ],
  ["pinned-version read", "npx wrangler@latest tail", false],

  // ── Benign non-wrangler (must auto-approve) ──
  ["ls", "ls -la", false],
  ["git status", "git status", false],
  ["npm install", "npm install", false],
  ["benign multi-line", "cd /repo\nls -la\necho done\ngit status", false],
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe("BACH-gate validation corpus (integration)", () => {
  beforeEach(() => {
    mockRequestApproval.mockReset();
    mockRequestApproval.mockResolvedValue({
      approved: true,
      state: "approved",
    });
    // BACH + auto-approve (real post-session_start runtime behavior).
    markModeExplicitlySet();
  });

  afterEach(() => {
    resetModeState();
  });

  it.each(CORPUS)("%s → %s", async (label, command, mustForcePrompt) => {
    const autoApproved = await bachGateAutoApproves(command);

    if (mustForcePrompt) {
      expect(
        autoApproved,
        `corpus "${label}" must force-prompt (destructive), but auto-approved:
${command}`,
      ).toBe(false);
    } else {
      expect(
        autoApproved,
        `corpus "${label}" must auto-approve (benign), but force-prompted:
${command}`,
      ).toBe(true);
    }
  });

  it("the regression's exact command force-prompts", async () => {
    // The exact command from session 019f77e4 that auto-approved ungated.
    const command = [
      "cd /home/sparkik/Documents/Projects/gyg-modern-app",
      "git add packages/api/src/scrapers/dequienes-gyg/CONTEXT.md",
      'git commit -m "docs(dequienes): §CPLT-no-RUT — cplt is a dead source"',
      'echo "---"',
      'echo "deploying..."',
      "cd packages/api",
      "npx wrangler deploy --name scrapers --env production 2>&1 | tail -8",
    ].join("\n");
    expect(await bachGateAutoApproves(command)).toBe(false);
  });
});
