import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCommand = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/process", () => ({
  runCommand: mockRunCommand,
}));

import {
  detectRepo,
  gh,
  ghJson,
  git,
  resetRepoCache,
} from "../../src/lib/github";

beforeEach(() => {
  mockRunCommand.mockReset();
  resetRepoCache();
});

describe("gh", () => {
  it("returns trimmed stdout on success", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: "  some output\n",
      stderr: "",
      exitCode: 0,
    });
    const result = await gh(["run", "list"]);
    expect(result).toBe("some output");
    expect(mockRunCommand).toHaveBeenCalledWith({
      cmd: "gh",
      args: ["run", "list"],
      signal: undefined,
    });
  });

  it("forwards signal to runCommand", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
    });
    const controller = new AbortController();
    await gh(["run", "list"], controller.signal);
    expect(mockRunCommand).toHaveBeenCalledWith({
      cmd: "gh",
      args: ["run", "list"],
      signal: controller.signal,
    });
  });

  it("throws on non-zero exit code", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: "",
      stderr: "not found",
      exitCode: 1,
    });
    await expect(gh(["run", "view", "999"])).rejects.toThrow(
      /gh run view 999 failed \(exit 1\)/,
    );
  });
});

describe("ghJson", () => {
  it("parses JSON stdout", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: '{"id": 42}\n',
      stderr: "",
      exitCode: 0,
    });
    const result = await ghJson<{ id: number }>(["issue", "view", "1"]);
    expect(result).toEqual({ id: 42 });
  });

  it("forwards signal to runCommand", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: '{"id": 42}\n',
      stderr: "",
      exitCode: 0,
    });
    const controller = new AbortController();
    await ghJson(["issue", "view", "1"], controller.signal);
    expect(mockRunCommand).toHaveBeenCalledWith({
      cmd: "gh",
      args: ["issue", "view", "1"],
      signal: controller.signal,
    });
  });
});

describe("git", () => {
  it("returns trimmed stdout on success", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: "  abc1234\n",
      stderr: "",
      exitCode: 0,
    });
    const result = await git(["rev-parse", "HEAD"]);
    expect(result).toBe("abc1234");
    expect(mockRunCommand).toHaveBeenCalledWith({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      signal: undefined,
    });
  });

  it("forwards signal to runCommand", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: "abc1234\n",
      stderr: "",
      exitCode: 0,
    });
    const controller = new AbortController();
    await git(["rev-parse", "HEAD"], controller.signal);
    expect(mockRunCommand).toHaveBeenCalledWith({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      signal: controller.signal,
    });
  });

  it("throws on non-zero exit code", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
    });
    await expect(git(["rev-parse", "HEAD"])).rejects.toThrow(
      /git rev-parse HEAD failed \(exit 128\)/,
    );
  });
});

describe("detectRepo", () => {
  it("uses gh repo view when available", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: JSON.stringify({ owner: { login: "gotgenes" }, name: "my-repo" }),
      stderr: "",
      exitCode: 0,
    });
    const repo = await detectRepo();
    expect(repo).toEqual({ owner: "gotgenes", repo: "my-repo" });
  });

  it("falls back to git remote SSH URL", async () => {
    // First call: gh repo view fails
    mockRunCommand.mockResolvedValueOnce({
      stdout: "",
      stderr: "not logged in",
      exitCode: 1,
    });
    // Second call: git remote get-url
    mockRunCommand.mockResolvedValueOnce({
      stdout: "git@github.com:gotgenes/pi-github-tools.git\n",
      stderr: "",
      exitCode: 0,
    });
    const repo = await detectRepo();
    expect(repo).toEqual({ owner: "gotgenes", repo: "pi-github-tools" });
  });

  it("falls back to git remote HTTPS URL", async () => {
    mockRunCommand.mockResolvedValueOnce({
      stdout: "",
      stderr: "error",
      exitCode: 1,
    });
    mockRunCommand.mockResolvedValueOnce({
      stdout: "https://github.com/gotgenes/pi-github-tools.git\n",
      stderr: "",
      exitCode: 0,
    });
    const repo = await detectRepo();
    expect(repo).toEqual({ owner: "gotgenes", repo: "pi-github-tools" });
  });

  it("caches the result across calls", async () => {
    mockRunCommand.mockResolvedValue({
      stdout: JSON.stringify({ owner: { login: "a" }, name: "b" }),
      stderr: "",
      exitCode: 0,
    });
    await detectRepo();
    await detectRepo();
    // Only one runCommand call — second was served from cache
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
  });

  it("throws when both gh and git remote fail", async () => {
    mockRunCommand.mockResolvedValueOnce({
      stdout: "",
      stderr: "error",
      exitCode: 1,
    });
    mockRunCommand.mockResolvedValueOnce({
      stdout: "not-a-github-url\n",
      stderr: "",
      exitCode: 0,
    });
    await expect(detectRepo()).rejects.toThrow(
      /Could not detect GitHub repository/,
    );
  });
});
