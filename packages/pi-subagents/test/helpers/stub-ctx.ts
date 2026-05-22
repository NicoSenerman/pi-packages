/**
 * Stub ExtensionContext for tool.execute() calls in tests.
 *
 * The tool implementations receive ctx from the Pi framework but access
 * injected deps instead — ctx is never inspected. This typed stub avoids
 * 'as any' while documenting the intent.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STUB_CTX = {} as unknown as ExtensionContext;
