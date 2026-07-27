import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import {
  PermissionForwarder,
  type PermissionForwarderDeps,
} from "#src/forwarded-permissions/permission-forwarder";
import { ForwardingManager } from "#src/forwarding-manager";
import { createPermissionForwardingLocation } from "#src/permission-forwarding";
import { markModeExplicitlySet, resetModeState } from "#src/yolo-mode";

// Regression test for the "stuck subagent permission prompt" bug:
// When a forwarded permission request reaches the manual UI dialog path
// (BACH-gated bash command) and the parent's `ui.select` never resolves
// (e.g. raised from the ForwardingManager setInterval while the agent loop
// is busy), the poller's `processing` flag stayed `true` forever and every
// subsequent inbox tick was starved. The result: every later forwarded
// request — including auto-approvable ones — timed out at the 10-minute
// deadline with zero `forwarded_permission.prompted` / `.auto_approved`
// review entries, exactly as observed in production session 019fa3d8.
//
// Fix contract: a hanging UI dialog for one forwarded request MUST NOT block
// the poller from draining later, independently-resolvable requests.

const PARENT_SESSION = "parent-session";

function makeDeps(
  forwardingDir: string,
  overrides: Partial<PermissionForwarderDeps> = {},
): PermissionForwarderDeps {
  return {
    forwardingDir,
    subagentSessionsDir: "/tmp/subagents",
    logger: { review: vi.fn(), debug: vi.fn() },
    requestPermissionDecisionFromUi: vi
      .fn()
      .mockResolvedValue({ approved: true, state: "approved" as const }),
    config: { current: () => ({ ...DEFAULT_EXTENSION_CONFIG }) },
    ...overrides,
  };
}

function makeCtx() {
  return {
    hasUI: true,
    ui: { select: vi.fn(), input: vi.fn() },
    sessionManager: {
      getSessionId: vi.fn(() => PARENT_SESSION),
      getSessionDir: vi.fn(() => ""),
      getEntries: vi.fn(() => []),
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
}

function writeRequest(forwardingDir: string, id: string, value: string): void {
  const location = createPermissionForwardingLocation(
    forwardingDir,
    PARENT_SESSION,
  );
  mkdirSync(location.requestsDir, { recursive: true });
  mkdirSync(location.responsesDir, { recursive: true });
  writeFileSync(
    join(location.requestsDir, `${id}.json`),
    JSON.stringify({
      id,
      createdAt: Date.now(),
      requesterSessionId: "child-session",
      targetSessionId: PARENT_SESSION,
      requesterAgentName: "general-purpose",
      message: `Agent 'general-purpose' requested bash command '${value}'. Allow this command?`,
      source: "tool_call",
      surface: "bash",
      value,
    }),
    "utf-8",
  );
}

describe("ForwardingManager poller — hung UI dialog must not stall the inbox", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mirror production post-session_start: BACH is the default mode and is
    // marked explicit so shouldAutoApprovePermissionState("ask", ...) returns
    // true (auto-approve active). BACH-gated commands still force a prompt.
    markModeExplicitlySet();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetModeState();
  });

  it("processes a later auto-approvable request even when an earlier prompted dialog never resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "pps-poller-stall-"));
    const forwardingDir = join(root, "forwarding");
    try {
      // requestPermissionDecisionFromUi (parent ui.select) hangs forever —
      // simulating a modal raised from the setInterval poller while the
      // agent loop is busy and never serviced.
      const neverResolvingUiSelect = vi
        .fn()
        .mockReturnValue(new Promise(() => {}));
      const review = vi.fn();
      const forwarder = new PermissionForwarder(
        makeDeps(forwardingDir, {
          requestPermissionDecisionFromUi: neverResolvingUiSelect,
          logger: { review, debug: vi.fn() },
        }),
      );
      const manager = new ForwardingManager("/tmp/subagents", forwarder);
      const ctx = makeCtx();
      manager.start(ctx);

      // Request 1: BACH-gated curl — forces the manual prompt path.
      writeRequest(
        forwardingDir,
        "req-hung-curl",
        "curl -sL https://example.com/x",
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(neverResolvingUiSelect).toHaveBeenCalledTimes(1);

      // Request 2: arrives later, auto-approvable (not BACH-gated).
      writeRequest(forwardingDir, "req-auto-ok", "ls -la");
      await vi.advanceTimersByTimeAsync(1000);

      // The auto-approvable request MUST have been drained (response written)
      // despite the earlier dialog still hanging. Before the fix, the poller's
      // `processing` flag stayed true and this second request was never
      // touched — it would time out at the 10-minute deadline.
      const location = createPermissionForwardingLocation(
        forwardingDir,
        PARENT_SESSION,
      );
      const autoResponsePath = join(location.responsesDir, "req-auto-ok.json");
      expect(existsSync(autoResponsePath)).toBe(true);

      const reviewEvents = review.mock.calls.map((c) => c[0]);
      expect(reviewEvents).toContain("forwarded_permission.prompted");
      expect(reviewEvents).toContain("forwarded_permission.auto_approved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
