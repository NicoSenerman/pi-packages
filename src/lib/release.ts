/**
 * Platform-independent business logic for release tools.
 *
 * Each function mirrors a single tool entry point:
 *   - findReleasePR   → release_pr_find
 *   - mergeReleasePR  → release_pr_merge
 *   - watchRelease    → release_watch
 */

import { findRetryDelay } from "./ci-helpers";
import { gh, ghJson } from "./github";
import { runCommand, sleep } from "./process";

interface ReleasePR {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  mergeable: string;
  mergeStateStatus: string;
}

interface PRState {
  number: number;
  title: string;
  mergeable: string;
  mergeStateStatus: string;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

// ---------- findReleasePR ----------

export interface FindReleasePRArgs {
  timeout?: number;
  onProgress?: (line: string) => void;
}

export async function findReleasePR(args: FindReleasePRArgs): Promise<string> {
  const timeout = args.timeout ?? 120;
  const onProgress = args.onProgress;

  let elapsed = 0;
  let attempt = 0;

  while (true) {
    attempt++;

    const delay = findRetryDelay(attempt);
    if (delay > 0) {
      await sleep(delay * 1000);
      elapsed += delay;
    }

    if (attempt > 1 && onProgress) {
      onProgress(
        `awaiting release-please PR... (attempt ${attempt}, ${elapsed}s elapsed)`,
      );
    }

    const prs = await ghJson<ReleasePR[]>(
      "pr",
      "list",
      "--label",
      "autorelease: pending",
      "--json",
      "number,title,headRefName,url,mergeable,mergeStateStatus",
      "--limit",
      "5",
    );

    if (prs.length > 0) {
      const pr = prs[0];
      return [
        `pr_number: ${pr.number}`,
        `title: ${pr.title}`,
        `head_branch: ${pr.headRefName}`,
        `url: ${pr.url}`,
        `mergeable: ${pr.mergeable}`,
        `merge_state: ${pr.mergeStateStatus}`,
      ].join("\n");
    }

    if (elapsed >= timeout) {
      return [
        `timeout: no release-please PR found`,
        `  retries: ${attempt}`,
        `  elapsed: ${elapsed}s`,
      ].join("\n");
    }
  }
}

// ---------- mergeReleasePR ----------

export interface MergeReleasePRArgs {
  prNumber: number;
}

export async function mergeReleasePR(
  args: MergeReleasePRArgs,
): Promise<ToolResult> {
  const prNumber = args.prNumber;

  const pr = await ghJson<PRState>(
    "pr",
    "view",
    String(prNumber),
    "--json",
    "number,title,mergeable,mergeStateStatus",
  );

  if (pr.mergeable !== "MERGEABLE" || pr.mergeStateStatus !== "CLEAN") {
    return {
      content: [
        `PR #${prNumber} is not mergeable`,
        `  mergeable: ${pr.mergeable}`,
        `  merge_state: ${pr.mergeStateStatus}`,
        `  title: ${pr.title}`,
      ].join("\n"),
      isError: true,
    };
  }

  await gh("pr", "merge", String(prNumber), "--rebase");

  await runCommand({ cmd: "git", args: ["pull", "--ff-only"] });

  const headSha = await gh("rev-parse", "HEAD");

  return {
    content: [
      `Merged PR #${prNumber}: ${pr.title}`,
      `head_sha: ${headSha}`,
      `short_sha: ${headSha.substring(0, 7)}`,
    ].join("\n"),
    isError: false,
  };
}

// ---------- watchRelease ----------

export interface WatchReleaseArgs {
  timeout?: number;
  onProgress?: (line: string) => void;
}

export async function watchRelease(args: WatchReleaseArgs): Promise<string> {
  const timeout = args.timeout ?? 180;
  const onProgress = args.onProgress;

  const pollInterval = 10;
  let elapsed = 0;

  while (true) {
    const tagOutput = await gh("tag", "--points-at", "HEAD");
    const tags = tagOutput
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);

    if (tags.length > 0) {
      const tag = tags[tags.length - 1]; // most recent tag
      const headSha = await gh("rev-parse", "HEAD");
      return [
        `tag: ${tag}`,
        `version: ${tag.replace(/^v/, "")}`,
        `sha: ${headSha}`,
        `short_sha: ${headSha.substring(0, 7)}`,
      ].join("\n");
    }

    if (elapsed >= timeout) {
      return [
        `timeout: no release tag found on HEAD`,
        `  elapsed: ${elapsed}s`,
      ].join("\n");
    }

    if (onProgress) {
      onProgress(`waiting for release tag... (${elapsed}s elapsed)`);
    }

    await sleep(pollInterval * 1000);
    elapsed += pollInterval;
  }
}
