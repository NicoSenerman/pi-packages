/**
 * Shared harness for acceptance tests that drive the real `pi` CLI in
 * `--mode rpc`.
 *
 * Resolves the `pi` binary from the locally-installed
 * `@earendil-works/pi-coding-agent` devDependency rather than the global
 * PATH so the suite runs whenever `pnpm install` has been done. Tests
 * that depend on this harness use the `piAvailable` flag to skip when
 * the binary is missing (e.g. stale `node_modules`).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const PI_BIN = resolve("node_modules/.bin/pi");
export const piAvailable = existsSync(PI_BIN);

export type RpcResponse = {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  data?: unknown;
};

export type RpcEvent = {
  type: string;
  [key: string]: unknown;
};

export type RpcSessionOptions = {
  cwd: string;
  commands: object[];
  /**
   * Additional `-e <path>` extension entrypoints loaded alongside the
   * production `src/extension.ts`. Useful for mounting fixture extensions
   * that drive specific code paths from RPC.
   */
  extraExtensions?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Override the production extension path. Defaults to the resolved
   * absolute path of `src/extension.ts`.
   */
  productionExtension?: string;
};

export type RpcSessionResult = {
  responses: RpcResponse[];
  events: RpcEvent[];
  stderr: string;
  exitCode: number | null;
};

const DEFAULT_PRODUCTION_EXTENSION = resolve("src", "extension.ts");

export async function runRpcSession(
  options: RpcSessionOptions,
): Promise<RpcSessionResult> {
  const {
    cwd,
    commands,
    extraExtensions = [],
    timeoutMs = 10_000,
    env,
    productionExtension = DEFAULT_PRODUCTION_EXTENSION,
  } = options;

  const extensionArgs: string[] = [];
  for (const path of [productionExtension, ...extraExtensions]) {
    extensionArgs.push("-e", path);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      PI_BIN,
      [
        "--mode",
        "rpc",
        "--no-tools",
        "--no-extensions",
        "--no-session",
        ...extensionArgs,
      ],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: env ? { ...process.env, ...env } : process.env,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(
        new Error(
          `pi rpc session timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const messages = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            JSON.parse(line) as { type: string } & Record<string, unknown>,
        );

      const responses: RpcResponse[] = [];
      const events: RpcEvent[] = [];
      for (const message of messages) {
        if (message.type === "response") {
          responses.push(message as RpcResponse);
        } else {
          events.push(message as RpcEvent);
        }
      }
      resolvePromise({ responses, events, stderr, exitCode: code });
    });

    for (const command of commands) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }
    child.stdin.end();
  });
}
