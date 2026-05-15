import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunCommand = vi.hoisted(() => vi.fn());
const mockSleep = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/process", () => ({
  runCommand: mockRunCommand,
  sleep: mockSleep,
}));

import {
  findReleasePR,
  mergeReleasePR,
  watchRelease,
} from "../../src/lib/release";

beforeEach(() => {
  mockRunCommand.mockReset();
  mockSleep.mockReset();
  mockSleep.mockResolvedValue(undefined);
});

function mockGhJson(value: unknown) {
  mockRunCommand.mockResolvedValueOnce({
    stdout: JSON.stringify(value),
    stderr: "",
    exitCode: 0,
  });
}

function mockCmd(stdout: string) {
  mockRunCommand.mockResolvedValueOnce({
    stdout,
    stderr: "",
    exitCode: 0,
  });
}

describe("findReleasePR", () => {
  it("finds a release-please PR on first poll", async () => {
    mockGhJson([
      {
        number: 42,
        title: "chore(main): release 1.2.0",
        headRefName: "release-please--branches--main",
        url: "https://github.com/o/r/pull/42",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      },
    ]);

    const result = await findReleasePR({ timeout: 120 });
    expect(result).toContain("pr_number: 42");
    expect(result).toContain("release 1.2.0");
  });

  it("returns timeout when no PR appears", async () => {
    // Empty list on every poll
    mockGhJson([]);

    const result = await findReleasePR({ timeout: 0 });
    expect(result).toContain("timeout:");
  });

  it("invokes onProgress on retries", async () => {
    const onProgress = vi.fn();
    mockGhJson([]);
    mockGhJson([]);

    await findReleasePR({ timeout: 5, onProgress });
    expect(onProgress).toHaveBeenCalled();
  });
});

describe("mergeReleasePR", () => {
  function setupMergeMocks() {
    // gh pr view (check state)
    mockGhJson({
      number: 42,
      title: "chore(main): release 1.2.0",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });
    // gh pr merge
    mockCmd("merged");
    // git pull --ff-only
    mockRunCommand.mockResolvedValueOnce({
      stdout: "Already up to date.\n",
      stderr: "",
      exitCode: 0,
    });
    // git rev-parse HEAD
    mockRunCommand.mockResolvedValueOnce({
      stdout: "abc1234567890\n",
      stderr: "",
      exitCode: 0,
    });
  }

  it("defaults to --merge when no method is specified", async () => {
    setupMergeMocks();

    const result = await mergeReleasePR({ prNumber: 42 });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Merged PR #42");
    expect(result.content).toContain("abc1234");

    expect(mockRunCommand).toHaveBeenNthCalledWith(2, {
      cmd: "gh",
      args: ["pr", "merge", "42", "--merge"],
      signal: undefined,
    });
    expect(mockRunCommand).toHaveBeenNthCalledWith(3, {
      cmd: "git",
      args: ["pull", "--ff-only"],
      signal: undefined,
    });
    expect(mockRunCommand).toHaveBeenNthCalledWith(4, {
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      signal: undefined,
    });
  });

  it("uses --squash when method is squash", async () => {
    setupMergeMocks();
    await mergeReleasePR({ prNumber: 42, method: "squash" });
    expect(mockRunCommand).toHaveBeenNthCalledWith(2, {
      cmd: "gh",
      args: ["pr", "merge", "42", "--squash"],
      signal: undefined,
    });
  });

  it("uses --merge when method is merge", async () => {
    setupMergeMocks();
    await mergeReleasePR({ prNumber: 42, method: "merge" });
    expect(mockRunCommand).toHaveBeenNthCalledWith(2, {
      cmd: "gh",
      args: ["pr", "merge", "42", "--merge"],
      signal: undefined,
    });
  });

  it("returns error when PR is not mergeable", async () => {
    mockGhJson({
      number: 42,
      title: "chore(main): release 1.2.0",
      mergeable: "CONFLICTING",
      mergeStateStatus: "BLOCKED",
    });

    const result = await mergeReleasePR({ prNumber: 42 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not mergeable");
  });
});

describe("watchRelease", () => {
  it("returns when a tag is found on HEAD", async () => {
    // git fetch --tags
    mockRunCommand.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    // git tag --points-at HEAD
    mockRunCommand.mockResolvedValueOnce({
      stdout: "v1.2.0\n",
      stderr: "",
      exitCode: 0,
    });
    // git rev-parse HEAD
    mockRunCommand.mockResolvedValueOnce({
      stdout: "abc1234567890\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await watchRelease({ timeout: 120 });
    expect(result).toContain("v1.2.0");

    expect(mockRunCommand).toHaveBeenNthCalledWith(1, {
      cmd: "git",
      args: ["fetch", "--tags"],
      signal: undefined,
    });
    expect(mockRunCommand).toHaveBeenNthCalledWith(2, {
      cmd: "git",
      args: ["tag", "--points-at", "HEAD"],
      signal: undefined,
    });
    expect(mockRunCommand).toHaveBeenNthCalledWith(3, {
      cmd: "git",
      args: ["rev-parse", "HEAD"],
      signal: undefined,
    });
  });

  it("returns timeout when no tag appears", async () => {
    // git fetch --tags
    mockCmd("");
    // No tags on first poll
    mockCmd("\n");

    const result = await watchRelease({ timeout: 0 });
    expect(result).toContain("timeout:");
  });
});
