import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the BACH-gate full-command bug (#<issue>).
//
// Before the fix, the prompter fed `requiresBachPrompt` the single
// most-restrictive *unit* a chained bash program decomposed into
// (`details.command`), not the whole program. With no config policy lifting a
// later unit to "most restrictive", every unit resolved `allow` and the first
// unit (`cd …`) was chosen — so a `wrangler deploy` on line 5 slipped past the
// destructiveness gate and auto-approved. These tests drive the *real*
// prompter with a `fullCommand` mirroring `tcc.input.command` and assert the
// gate force-prompts on the whole program, not just the leading unit.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigReader } from "#src/config-store";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import type { PermissionPromptDecision } from "#src/permission-dialog";
import {
  PermissionPrompter,
  type PermissionPrompterDeps,
  type PromptPermissionDetails,
} from "#src/permission-prompter";
import { markModeExplicitlySet, resetModeState } from "#src/yolo-mode";

// ── Helpers ────────────────────────────────────────────────────────────────

const mockRequestApproval = vi.fn();

function makeCtx(hasUI: boolean): ExtensionContext {
  return {
    hasUI,
    ui: { select: vi.fn(), input: vi.fn() },
    sessionManager: { getSessionDir: vi.fn().mockReturnValue(null) },
  } as unknown as ExtensionContext;
}

function makeConfigReader(
  config: Partial<typeof DEFAULT_EXTENSION_CONFIG> = {},
): ConfigReader {
  return { current: () => ({ ...DEFAULT_EXTENSION_CONFIG, ...config }) };
}

function makeDeps(
  overrides?: Partial<PermissionPrompterDeps>,
): PermissionPrompterDeps {
  return {
    config: makeConfigReader(),
    logger: { review: vi.fn() },
    events: { emit: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) },
    forwarder: { requestApproval: mockRequestApproval },
    ...overrides,
  };
}

/** Build bash prompt details mirroring how `describeToolGate` populates them. */
function makeBashDetails(
  fullCommand: string,
  overrides?: Partial<PromptPermissionDetails>,
): PromptPermissionDetails {
  // `command` mirrors the (truncated) most-restrictive unit; `fullCommand` is
  // the whole program the prompter now feeds the BACH gate.
  const firstLine = fullCommand.split("\n")[0] ?? fullCommand;
  return {
    requestId: "req-bach",
    source: "tool_call",
    agentName: "test-agent",
    message: `Allow bash: ${firstLine}`,
    toolName: "bash",
    command: firstLine,
    fullCommand,
    ...overrides,
  };
}

// The exact multi-line command from the audit session that auto-approved
// ungated before the fix.
const AUDIT_SESSION_DEPLOY = [
  "cd /home/sparkik/Documents/Projects/gyg-modern-app",
  "git add packages/api/src/scrapers/dequienes-gyg/CONTEXT.md",
  'git commit -m "docs(dequienes): skip dead source"',
  'echo "---"',
  'echo "deploying..."',
  "cd packages/api",
  "npx wrangler deploy --name scrapers --env production 2>&1 | tail -8",
].join("\n");

// ── Tests ──────────────────────────────────────────────────────────────────

describe("PermissionPrompter — BACH gate sees the full bash program", () => {
  beforeEach(() => {
    mockRequestApproval.mockReset();
    mockRequestApproval.mockResolvedValue({
      approved: true,
      state: "approved",
    } satisfies PermissionPromptDecision);
    // BACH is the default mode; marking it explicit turns auto-approve ON, the
    // real runtime behavior after session_start. isBachMode() then returns true.
    markModeExplicitlySet();
  });

  afterEach(() => {
    resetModeState();
  });

  it("force-prompts (does NOT auto-approve) when wrangler deploy is on a later line", async () => {
    const logger = { review: vi.fn() };
    const deps = makeDeps({ logger });
    const prompter = new PermissionPrompter(deps);

    const decision = await prompter.prompt(
      makeCtx(false),
      makeBashDetails(AUDIT_SESSION_DEPLOY),
    );

    // The gate must NOT short-circuit to auto-approve. A destructive op
    // embedded mid-program forces a waiting entry and a forwarded/UI prompt.
    expect(decision.autoApproved).not.toBe(true);
    const events = logger.review.mock.calls.map((c) => c[0] as string);
    expect(events).toContain("permission_request.waiting");
    expect(events).not.toContain("permission_request.auto_approved");
    expect(mockRequestApproval).toHaveBeenCalled();
  });

  it.each([
    ["cd /repo\necho hi\nwrangler deploy", "plain newline-separated deploy"],
    [
      "cd /repo\ngit add .\ngit commit -m x\ngit push",
      "git push after a docs commit",
    ],
    ["cd /repo\nrm -rf node_modules", "rm -rf on a later line"],
    ["cd /repo\nsudo apt-get update", "sudo on a later line"],
    [
      "cd /repo\nwrangler d1 execute db --command 'SELECT 1'",
      "d1 execute later",
    ],
    [
      "cd /repo\nnpx wrangler deploy 2>&1 | tail -8",
      "deploy wrapped in a trailing pipe",
    ],
  ])(
    "force-prompts for destructive op on a later line: %s",
    async (fullCommand) => {
      const deps = makeDeps();
      const prompter = new PermissionPrompter(deps);

      const decision = await prompter.prompt(
        makeCtx(false),
        makeBashDetails(fullCommand),
      );

      expect(decision.autoApproved).not.toBe(true);
      expect(mockRequestApproval).toHaveBeenCalled();
    },
  );

  it("auto-approves a benign multi-line program with no destructive op", async () => {
    const logger = { review: vi.fn() };
    const deps = makeDeps({ logger });
    const prompter = new PermissionPrompter(deps);

    const decision = await prompter.prompt(
      makeCtx(false),
      makeBashDetails("cd /repo\nls -la\necho done\ngit status"),
    );

    expect(decision.autoApproved).toBe(true);
    const events = logger.review.mock.calls.map((c) => c[0] as string);
    expect(events).toContain("permission_request.auto_approved");
    expect(events).not.toContain("permission_request.waiting");
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it("auto-approves a benign multi-line program with only read-only wrangler ops", async () => {
    const deps = makeDeps();
    const prompter = new PermissionPrompter(deps);

    const decision = await prompter.prompt(
      makeCtx(false),
      makeBashDetails("cd /repo\nwrangler tail\nwrangler deployments list"),
    );

    expect(decision.autoApproved).toBe(true);
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it("falls back to details.command when fullCommand is absent (single-line)", async () => {
    // Mirrors the pre-fix single-line behavior so the fallback stays covered.
    const deps = makeDeps();
    const prompter = new PermissionPrompter(deps);

    const decision = await prompter.prompt(
      makeCtx(false),
      // Intentionally omit fullCommand; command alone carries the deploy.
      makeBashDetails("npx wrangler deploy", { fullCommand: undefined }),
    );

    expect(decision.autoApproved).not.toBe(true);
    expect(mockRequestApproval).toHaveBeenCalled();
  });

  it("does not trip the gate for non-bash tools even if fullCommand is set", async () => {
    const deps = makeDeps();
    const prompter = new PermissionPrompter(deps);

    const decision = await prompter.prompt(
      makeCtx(false),
      makeBashDetails(AUDIT_SESSION_DEPLOY, {
        toolName: "read",
        command: "/repo/file",
        fullCommand: AUDIT_SESSION_DEPLOY,
      }),
    );

    expect(decision.autoApproved).toBe(true);
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });
});
