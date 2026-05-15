/**
 * Platform-independent business logic for the GitHub Actions CI tools.
 *
 * Each function mirrors a single tool entry point:
 *   - findRun  → ci_find
 *   - watchRun → ci_watch
 *   - listRuns → ci_list
 */
import { type CIJob, findRetryDelay, formatProgress } from "./ci-helpers";
import { ghJson } from "./github";
import { sleep } from "./process";

interface RunSummary {
  status: string;
  conclusion: string | null;
  headSha: string;
  name: string;
  databaseId: number;
  url: string;
  displayTitle: string;
}

interface RunDetail {
  status: string;
  conclusion: string | null;
  headSha: string;
  name: string;
}

interface RunJobs {
  jobs: CIJob[];
}

interface WatchPoll extends RunDetail {
  jobs: CIJob[];
}

function jobStatus(job: CIJob): string {
  if (job.status === "completed") return job.conclusion ?? "unknown";
  return job.status;
}

function formatWatch(run: RunDetail, runId: number): string {
  const shortSha = run.headSha.substring(0, 7);
  const conclusion = run.conclusion ?? "unknown";
  const status = run.status === "completed" ? conclusion : run.status;
  return `${status}  ${run.name} (${shortSha}) — run ${runId}`;
}

function formatFind(run: RunSummary, jobs: CIJob[]): string {
  const shortSha = run.headSha.substring(0, 7);
  const runStatus =
    run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;

  const jobLines = jobs.map((j) => `  ${j.name} — ${jobStatus(j)}`).join("\n");

  const findLines = [
    `run_id: ${run.databaseId}`,
    `url: ${run.url}`,
    `status: ${runStatus}`,
    `sha: ${run.headSha}`,
    `short_sha: ${shortSha}`,
    `title: ${run.displayTitle}`,
    `jobs:`,
    jobLines,
  ];
  return findLines.join("\n");
}

export interface FindRunArgs {
  workflow: string;
  expectedSha: string;
  timeout?: number;
  onProgress?: (line: string) => void;
}

export async function findRun(args: FindRunArgs): Promise<string> {
  const workflowFile = `${args.workflow}.yml`;
  const expectedSha = args.expectedSha;
  const timeout = args.timeout ?? 120;
  const onProgress = args.onProgress;

  const shortExpected = expectedSha.substring(0, 7);
  let elapsed = 0;
  let attempt = 0;
  let lastSeenRun: RunSummary | null = null;

  while (true) {
    attempt++;

    const delay = findRetryDelay(attempt);
    if (delay > 0) {
      await sleep(delay * 1000);
      elapsed += delay;
    }

    if (attempt > 1 && onProgress) {
      onProgress(
        `awaiting ${workflowFile} run for ${shortExpected}... (attempt ${attempt}, ${elapsed}s elapsed)`,
      );
    }

    const runs = await ghJson<RunSummary[]>([
      "run",
      "list",
      "--limit",
      "5",
      "--workflow",
      workflowFile,
      "--json",
      "databaseId,url,status,conclusion,headSha,displayTitle,name",
    ]);

    if (runs.length > 0) {
      lastSeenRun = runs[0];
    }

    const matchingRun = runs.find((r) => r.headSha === expectedSha);
    if (matchingRun) {
      const { jobs } = await ghJson<RunJobs>([
        "run",
        "view",
        String(matchingRun.databaseId),
        "--json",
        "jobs",
      ]);
      return formatFind(matchingRun, jobs);
    }

    if (elapsed >= timeout) {
      const lastSeenInfo = lastSeenRun
        ? `last_seen_sha: ${lastSeenRun.headSha.substring(0, 7)} (run ${lastSeenRun.databaseId})`
        : "last_seen_sha: none (no runs found for this workflow)";

      return [
        `timeout: no run found for workflow ${workflowFile} matching SHA ${expectedSha}`,
        `  retries: ${attempt}`,
        `  elapsed: ${elapsed}s`,
        `  ${lastSeenInfo}`,
        `  suggestion: check https://www.githubstatus.com for GitHub Actions status`,
      ].join("\n");
    }
  }
}

export interface WatchRunArgs {
  workflow: string;
  runId: number;
  timeout?: number;
  onProgress?: (line: string) => void;
}

export async function watchRun(args: WatchRunArgs): Promise<string> {
  const runId = args.runId;
  const timeout = args.timeout ?? 300;
  const onProgress = args.onProgress;

  const pollInterval = 15;
  let elapsed = 0;
  const progressLog: string[] = [];

  while (true) {
    const run = await ghJson<WatchPoll>([
      "run",
      "view",
      String(runId),
      "--json",
      "status,conclusion,name,headSha,jobs",
    ]);

    const progressLine = formatProgress(run.jobs, elapsed);
    progressLog.push(progressLine);
    if (onProgress) {
      onProgress(progressLine);
    }

    if (run.status === "completed") {
      const summary = formatWatch(run, runId);
      return [...progressLog, summary].join("\n");
    }

    if (elapsed >= timeout) {
      const shortSha = run.headSha.substring(0, 7);
      const timeoutLine = `timeout  ${run.name} (${shortSha}) still ${run.status} after ${timeout}s — run ${runId}`;
      return [...progressLog, timeoutLine].join("\n");
    }

    await sleep(pollInterval * 1000);
    elapsed += pollInterval;
  }
}

export interface ListRunsArgs {
  workflow: string;
  limit?: number;
}

export async function listRuns(args: ListRunsArgs): Promise<string> {
  const workflowFile = `${args.workflow}.yml`;
  const limit = args.limit ?? 5;

  const runs = await ghJson<RunSummary[]>([
    "run",
    "list",
    "--limit",
    String(limit),
    "--workflow",
    workflowFile,
    "--json",
    "databaseId,url,status,conclusion,headSha,name,displayTitle",
  ]);

  if (runs.length === 0) {
    return `No runs found for ${workflowFile}`;
  }

  const result = runs.map((run) => ({
    status:
      run.status === "completed" ? (run.conclusion ?? "unknown") : run.status,
    name: run.name,
    sha: run.headSha,
    short_sha: run.headSha.substring(0, 7),
    runId: run.databaseId,
    url: run.url,
  }));
  return JSON.stringify(result);
}
