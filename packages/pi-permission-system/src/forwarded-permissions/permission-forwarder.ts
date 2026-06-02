import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
} from "#src/permission-dialog";
import type { ForwardedPromptDisplay } from "#src/permission-forwarding";

import {
  confirmPermission,
  type PermissionForwardingDeps,
  processForwardedPermissionRequests,
} from "./polling";

/**
 * Narrow seam describing what `ForwardingManager` needs from the forwarder:
 * a single method that drains this session's forwarded-permission inbox.
 *
 * Depending on the interface (not the concrete `PermissionForwarder`) keeps
 * the manager's unit tests free of casts — they inject a plain
 * `{ processInbox: vi.fn() }` mock.
 */
export interface InboxProcessor {
  processInbox(ctx: ExtensionContext): Promise<void>;
}

/**
 * Owner of the forwarded-permission behavior.
 *
 * Replaces the `PermissionForwardingDeps` bag that callers previously threaded
 * into the `polling.ts` free functions. For this lift-and-shift step the
 * forwarder holds the bag privately and delegates each method to the matching
 * free function, so behavior is unchanged; a later step inlines the polling
 * bodies as methods reading `this` and removes the bag.
 */
export class PermissionForwarder implements InboxProcessor {
  constructor(private readonly deps: PermissionForwardingDeps) {}

  /**
   * Resolve a permission decision for the current context: prompt directly
   * when this session has UI, otherwise forward to the parent session.
   */
  requestApproval(
    ctx: ExtensionContext,
    message: string,
    options?: RequestPermissionOptions,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision> {
    return confirmPermission(ctx, message, this.deps, options, forwarded);
  }

  /** Drain and respond to this session's forwarded-permission inbox. */
  processInbox(ctx: ExtensionContext): Promise<void> {
    return processForwardedPermissionRequests(ctx, this.deps);
  }
}
