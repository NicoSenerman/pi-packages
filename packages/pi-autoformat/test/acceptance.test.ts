/**
 * Acceptance test: verify the extension actually loads under the real
 * `pi` CLI without errors.
 *
 * This is a smoke test, not a full end-to-end suite. It catches regressions
 * that pure unit tests cannot:
 *
 * - the extension entrypoint exports the right shape for Pi's loader
 * - module resolution works in the shipped TypeScript
 * - `session_start` does not throw against a real ExtensionContext
 *
 * It deliberately uses Pi's `--mode rpc` with `get_state`, which avoids any
 * LLM call (so no API keys, no cost, no flakiness).
 *
 * Skipped when `node_modules/.bin/pi` is missing (i.e. `pnpm install`
 * has not been run). See `test/helpers/rpc.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { piAvailable, runRpcSession } from "./helpers/rpc";

const describeIfPi = piAvailable ? describe : describe.skip;

describeIfPi("acceptance: extension loads under real pi CLI", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "pi-autoformat-acceptance-"));
  });

  afterAll(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("loads the extension and answers an rpc get_state command", async () => {
    const { responses, stderr, exitCode } = await runRpcSession({
      cwd: workDir,
      commands: [{ id: "1", type: "get_state" }],
    });

    // Pi must exit cleanly after stdin closes.
    expect(exitCode).toBe(0);

    // No "Extension load error" or stack trace from our entrypoint should
    // appear on stderr. We allow Pi's own informational lines to pass.
    expect(stderr).not.toMatch(/pi-autoformat/i);
    expect(stderr).not.toMatch(/Extension .* error/i);

    const stateResponse = responses.find((r) => r.id === "1");
    expect(stateResponse).toBeDefined();
    expect(stateResponse?.success).toBe(true);
    expect(stateResponse?.command).toBe("get_state");
  }, 15_000);
});

if (!piAvailable) {
  describe.skip("acceptance suite", () => {
    it("skipped because node_modules/.bin/pi is not present", () => {
      // Intentionally empty.
    });
  });
}
