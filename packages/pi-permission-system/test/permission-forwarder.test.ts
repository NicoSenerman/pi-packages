import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PermissionForwarder } from "#src/forwarded-permissions/permission-forwarder";
import type { PermissionForwardingDeps } from "#src/forwarded-permissions/polling";
import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
} from "#src/permission-dialog";
import type { ForwardedPromptDisplay } from "#src/permission-forwarding";

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockConfirmPermission = vi.hoisted(() => vi.fn());
const mockProcessForwardedPermissionRequests = vi.hoisted(() => vi.fn());

vi.mock("#src/forwarded-permissions/polling", () => ({
  confirmPermission: mockConfirmPermission,
  processForwardedPermissionRequests: mockProcessForwardedPermissionRequests,
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function makeCtx(): ExtensionContext {
  return {} as unknown as ExtensionContext;
}

// The forwarder never reads the bag — it stores it and passes it straight to
// the polling functions — so a sentinel is sufficient to assert identity.
const deps = { sentinel: "deps" } as unknown as PermissionForwardingDeps;

// ── Tests ─────────────────────────────────────────────────────────────────

describe("PermissionForwarder", () => {
  beforeEach(() => {
    mockConfirmPermission.mockReset();
    mockProcessForwardedPermissionRequests.mockReset();
  });

  describe("requestApproval", () => {
    it("delegates to confirmPermission with the stored deps and returns its result", async () => {
      const decision: PermissionPromptDecision = {
        approved: true,
        state: "approved",
      };
      mockConfirmPermission.mockResolvedValue(decision);
      const ctx = makeCtx();
      const options: RequestPermissionOptions = {
        sessionLabel: "for this session",
      };
      const forwarded: ForwardedPromptDisplay = {
        source: "tool_call",
        surface: "bash",
        value: "ls",
      };

      const forwarder = new PermissionForwarder(deps);
      const result = await forwarder.requestApproval(
        ctx,
        "needs approval",
        options,
        forwarded,
      );

      expect(mockConfirmPermission).toHaveBeenCalledWith(
        ctx,
        "needs approval",
        deps,
        options,
        forwarded,
      );
      expect(result).toBe(decision);
    });

    it("forwards undefined options and forwarded when omitted", async () => {
      mockConfirmPermission.mockResolvedValue({
        approved: false,
        state: "denied",
      });
      const ctx = makeCtx();

      const forwarder = new PermissionForwarder(deps);
      await forwarder.requestApproval(ctx, "needs approval");

      expect(mockConfirmPermission).toHaveBeenCalledWith(
        ctx,
        "needs approval",
        deps,
        undefined,
        undefined,
      );
    });
  });

  describe("processInbox", () => {
    it("delegates to processForwardedPermissionRequests with the stored deps", async () => {
      mockProcessForwardedPermissionRequests.mockResolvedValue(undefined);
      const ctx = makeCtx();

      const forwarder = new PermissionForwarder(deps);
      await forwarder.processInbox(ctx);

      expect(mockProcessForwardedPermissionRequests).toHaveBeenCalledWith(
        ctx,
        deps,
      );
    });
  });
});
