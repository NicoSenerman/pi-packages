import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import {
  AUTOFORMAT_EXTENSION_ID,
  type ConfigValidationIssue,
  type LoadConfigResult,
  loadAutoformatConfig,
} from "./config-loader.js";
import {
  createCustomToolHandlers,
  parseTouchedPayload,
} from "./custom-mutation-tools.js";
import { resolveFormatScope } from "./format-scope.js";
import type { AutoformatConfig } from "./formatter-config.js";
import type { CommandRunner, CommandRunResult } from "./formatter-executor.js";
import { formatRunOutputBlock } from "./formatter-output-report.js";
import {
  PromptAutoformatter,
  type PromptAutoformatterResult,
} from "./prompt-autoformatter.js";
import {
  matchWrapper,
  parseKnownCommand,
  SnapshotTracker,
} from "./shell-mutation-detector.js";
import {
  type MutationSourceHandler,
  writeOrEditHandler,
} from "./touched-files-queue.js";

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

type NotificationType = "info" | "warning" | "error";

/**
 * Narrowed view of Pi's real `ExtensionContext`, restricted to the surface
 * this extension actually consumes. Pi's full `ExtensionContext` requires
 * `sessionManager`, `modelRegistry`, `model`, `signal`, `isIdle`, etc., none
 * of which the autoformatter uses. Internal helpers take this narrow alias
 * so test stubs do not have to fabricate the unused fields, while top-level
 * `pi.on(...)` handlers still receive the real `ExtensionContext` from Pi.
 */
type AutoformatExtensionContext = Pick<
  ExtensionContext,
  "cwd" | "hasUI" | "ui"
>;

/**
 * Re-export of Pi's real `ExtensionAPI` under the legacy `ExtensionApiLike`
 * name so any downstream importer that pinned to the old alias keeps working.
 * Internal usage prefers `ExtensionAPI` directly.
 */
export type ExtensionApiLike = ExtensionAPI;

const AUTOFORMAT_STATUS_KEY = "autoformat";

function setAutoformatStatus(
  ctx: AutoformatExtensionContext,
  text: string | undefined,
): void {
  if (!ctx.hasUI) {
    return;
  }
  if (typeof ctx.ui.setStatus !== "function") {
    return;
  }
  ctx.ui.setStatus(AUTOFORMAT_STATUS_KEY, text);
}

type PromptAutoformatterLike = Pick<
  PromptAutoformatter,
  "recordToolResult" | "flushPrompt" | "addTouchedPath"
>;

type AutoformatExtensionDependencies = {
  loadConfig?: (cwd: string) => LoadConfigResult;
  createAutoformatter?: (
    cwd: string,
    config: AutoformatConfig,
  ) => PromptAutoformatterLike;
  reportFlushResult?: (
    result: PromptAutoformatterResult,
    options: {
      config: AutoformatConfig;
      ctx: AutoformatExtensionContext;
    },
  ) => void;
  reportConfigIssues?: (
    issues: ConfigValidationIssue[],
    options: {
      ctx: AutoformatExtensionContext;
    },
  ) => void;
};

type SessionState = {
  cwd: string;
  loadResult: LoadConfigResult;
  autoformatter: PromptAutoformatterLike;
  snapshotTracker: SnapshotTracker | undefined;
  unsubscribeEventBus: (() => void) | undefined;
};

type ExecFileError = Error & {
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

function toOutputText(value: string | Buffer | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? value : value.toString("utf-8");
}

function normalizeExecError(error: unknown): CommandRunResult {
  if (!(error instanceof Error)) {
    return {
      exitCode: 1,
      stderr: String(error),
    };
  }

  const execError = error as ExecFileError;
  return {
    exitCode: typeof execError.code === "number" ? execError.code : 1,
    stdout: toOutputText(execError.stdout),
    stderr: toOutputText(execError.stderr) ?? execError.message,
  };
}

function createCommandRunner(commandTimeoutMs: number): CommandRunner {
  return async (
    command: string,
    args: string[],
    options,
  ): Promise<CommandRunResult> => {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options?.cwd,
        env: options?.env
          ? {
              ...process.env,
              ...options.env,
            }
          : process.env,
        encoding: "utf-8",
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        timeout: commandTimeoutMs,
      });

      return {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      return normalizeExecError(error);
    }
  };
}

export function createDefaultAutoformatter(
  cwd: string,
  config: AutoformatConfig,
): PromptAutoformatterLike {
  const scope = resolveFormatScope({ cwd, setting: config.formatScope });
  const handlers: MutationSourceHandler[] = [writeOrEditHandler];

  if (config.customMutationTools.length > 0) {
    handlers.push(...createCustomToolHandlers(config.customMutationTools));
  }

  if (config.shellMutationDetection.enabled) {
    handlers.push(createBashMutationHandler(config));
  }

  return new PromptAutoformatter(
    cwd,
    config,
    createCommandRunner(config.commandTimeoutMs),
    { scope, mutationHandlers: handlers },
  );
}

function createBashMutationHandler(
  config: AutoformatConfig,
): MutationSourceHandler {
  const detection = config.shellMutationDetection;
  return (toolName, payload, output) => {
    if (toolName !== "bash") {
      return [];
    }
    const command = extractBashCommand(payload);
    if (!command) {
      return [];
    }
    const candidates: string[] = [];
    if (detection.argumentParsing) {
      candidates.push(...parseKnownCommand(command));
    }
    if (detection.wrappers.length > 0) {
      candidates.push(...matchWrapper(command, output, detection.wrappers));
    }
    return candidates;
  };
}

function extractBashCommand(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "command" in payload &&
    typeof (payload as { command: unknown }).command === "string"
  ) {
    return (payload as { command: string }).command;
  }
  return undefined;
}

function subscribeToEventBus(
  pi: ExtensionAPI,
  config: AutoformatConfig,
  autoformatter: PromptAutoformatterLike,
): (() => void) | undefined {
  const channelConfig = config.eventBusMutationChannel;
  if (!channelConfig.enabled || !pi.events) {
    return undefined;
  }
  return pi.events.on(channelConfig.channel, (data: unknown) => {
    const paths = parseTouchedPayload(data);
    for (const candidate of paths) {
      autoformatter.addTouchedPath(candidate);
    }
  });
}

function extractToolOutputText(
  content: ToolResultEvent["content"] | undefined,
): string {
  if (!content) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      item &&
      "text" in item &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function reportMessage(
  ctx: AutoformatExtensionContext,
  message: string,
  type: NotificationType,
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
    return;
  }

  const output = `[${AUTOFORMAT_EXTENSION_ID}] ${message}`;
  if (type === "error" || type === "warning") {
    console.warn(output);
    return;
  }

  console.log(output);
}

type FailureSummary = {
  lines: string[];
  failedBatchCount: number;
};

function formatterLabel(
  name: string,
  fallbackContext?: { skipped: string[] },
): string {
  if (!fallbackContext || fallbackContext.skipped.length === 0) {
    return name;
  }
  return `${name} (fallback after ${fallbackContext.skipped.join(", ")} unavailable)`;
}

function summarizeFailures(
  result: PromptAutoformatterResult,
  config?: AutoformatConfig,
): FailureSummary {
  const lines: string[] = [];
  let failedBatchCount = 0;

  for (const group of result.groups) {
    for (const run of group.runs) {
      if (run.success) {
        continue;
      }
      failedBatchCount += 1;
      lines.push(
        `${formatterLabel(run.formatterName, run.fallbackContext)} (exit ${run.exitCode}): ${run.files.join(", ")}`,
      );
      if (config) {
        const outputBlock = formatRunOutputBlock(run, config.formatterOutput);
        if (outputBlock) {
          lines.push(outputBlock);
        }
      }
    }
  }

  return { lines, failedBatchCount };
}

function summarizeFallbackUsages(result: PromptAutoformatterResult): string[] {
  const lines: string[] = [];
  for (const group of result.groups) {
    for (const run of group.runs) {
      if (!run.success) {
        continue;
      }
      if (!run.fallbackContext || run.fallbackContext.skipped.length === 0) {
        continue;
      }
      lines.push(formatterLabel(run.formatterName, run.fallbackContext));
    }
  }
  return lines;
}

function collectAllFiles(result: PromptAutoformatterResult): string[] {
  const files: string[] = [];
  for (const group of result.groups) {
    files.push(...group.files);
  }
  return files;
}

function summarizeSuccessPaths(files: string[]): string | undefined {
  if (files.length === 0 || files.length > 3) {
    return undefined;
  }
  return files.join(", ");
}

type FlushSummary = {
  groupCount: number;
  fileCount: number;
  successBatchCount: number;
  failureBatchCount: number;
  failureLines: string[];
  formatterLabels: string[];
  fallbackUsages: string[];
};

function summarizeFlush(
  result: PromptAutoformatterResult,
  config?: AutoformatConfig,
): FlushSummary {
  const failureSummary = summarizeFailures(result, config);
  const fallbackUsages = summarizeFallbackUsages(result);
  const fileCount = collectAllFiles(result).length;

  const seen = new Set<string>();
  const formatterLabels: string[] = [];
  let successBatchCount = 0;
  for (const group of result.groups) {
    for (const run of group.runs) {
      if (run.success) {
        successBatchCount += 1;
      }
      const label = formatterLabel(run.formatterName, run.fallbackContext);
      if (!seen.has(label)) {
        seen.add(label);
        formatterLabels.push(label);
      }
    }
  }

  return {
    groupCount: result.groups.length,
    fileCount,
    successBatchCount,
    failureBatchCount: failureSummary.failedBatchCount,
    failureLines: failureSummary.lines,
    formatterLabels,
    fallbackUsages,
  };
}

type ThemeColorName = "success" | "warning" | "error" | "dim" | "accent";

function themed(
  ctx: AutoformatExtensionContext,
  color: ThemeColorName,
  text: string,
): string {
  const theme = ctx.ui.theme;
  if (!theme || typeof theme.fg !== "function") {
    return text;
  }
  // Call through the theme object so `this` stays bound. Pi's real Theme.fg
  // is an instance method that reads `this.fgColors`; destructuring it would
  // throw "Cannot read properties of undefined (reading 'fgColors')".
  try {
    return theme.fg(color, text);
  } catch {
    // Defensive: a theme that throws on a known color name (e.g. a partial
    // palette) should degrade to plain text rather than break the flush.
    return text;
  }
}

function formatStatusLine(
  summary: FlushSummary,
  ctx: AutoformatExtensionContext,
): string {
  const fileWord = summary.fileCount === 1 ? "file" : "files";
  const formatters =
    summary.formatterLabels.length > 0
      ? ` (${summary.formatterLabels.join(", ")})`
      : "";
  const label = themed(ctx, "dim", "autoformat:");

  if (summary.failureBatchCount > 0) {
    const batchWord = summary.failureBatchCount === 1 ? "batch" : "batches";
    const mark = themed(ctx, "error", "\u2717");
    const failureClause = themed(
      ctx,
      "error",
      `${summary.failureBatchCount} ${batchWord} failed`,
    );
    const okSuffix =
      summary.successBatchCount > 0
        ? themed(ctx, "dim", ` \u2014 ${summary.successBatchCount} ok`)
        : "";
    return `${mark} ${label} ${failureClause}${formatters}${okSuffix}`;
  }

  const mark = themed(ctx, "success", "\u2713");
  return `${mark} ${label} ${summary.fileCount} ${fileWord}${formatters}`;
}

const STEERING_MAX_FILES = 10;

export function buildSteeringMessageContent(
  result: PromptAutoformatterResult,
): string | undefined {
  if (result.groups.length === 0) {
    return undefined;
  }

  const changedFiles: string[] = [];
  const failureLines: string[] = [];

  for (const group of result.groups) {
    changedFiles.push(...group.changedFiles);
    for (const run of group.runs) {
      if (run.success) {
        continue;
      }
      const fileList = run.files.join(", ");
      failureLines.push(
        `  ${run.formatterName} (exit ${run.exitCode}) on ${fileList}:`,
      );
      if (run.stderr) {
        failureLines.push(`    ${run.stderr}`);
      }
      if (run.stdout) {
        failureLines.push(`    ${run.stdout}`);
      }
    }
  }

  if (changedFiles.length === 0 && failureLines.length === 0) {
    return undefined;
  }

  const parts: string[] = [];

  if (changedFiles.length > 0) {
    const shown = changedFiles.slice(0, STEERING_MAX_FILES);
    const remaining = changedFiles.length - shown.length;
    let list = shown.join(", ");
    if (remaining > 0) {
      list += `, \u2026 and ${remaining} more`;
    }
    parts.push(
      `[autoformat] Formatted ${changedFiles.length} file(s): ${list}`,
    );
  }

  if (failureLines.length > 0) {
    if (changedFiles.length === 0) {
      parts.push(["[autoformat] Failures:", ...failureLines].join("\n"));
    } else {
      parts.push(["Failures:", ...failureLines].join("\n"));
    }
  }

  return parts.join("\n\n") || undefined;
}

function buildLegacyFailureMessage(summary: FlushSummary): string {
  const batchWord = summary.failureBatchCount === 1 ? "batch" : "batches";
  return [
    `Formatter failures in ${summary.failureBatchCount} ${batchWord}:`,
    ...summary.failureLines,
  ].join("\n");
}

function buildLegacySuccessMessage(
  result: PromptAutoformatterResult,
  summary: FlushSummary,
): string {
  const allFiles = collectAllFiles(result);
  const successPaths = summarizeSuccessPaths(allFiles);
  const fileWord = allFiles.length === 1 ? "file" : "files";
  const baseMessage = successPaths
    ? `Autoformatted ${allFiles.length} ${fileWord}: ${successPaths}`
    : `Autoformatted ${allFiles.length} ${fileWord}.`;

  return summary.fallbackUsages.length > 0
    ? `${baseMessage} [${summary.fallbackUsages.join("; ")}]`
    : baseMessage;
}

function defaultReportFlushResult(
  result: PromptAutoformatterResult,
  options: {
    config: AutoformatConfig;
    ctx: AutoformatExtensionContext;
  },
): void {
  if (result.groups.length === 0) {
    setAutoformatStatus(options.ctx, undefined);
    return;
  }

  const summary = summarizeFlush(result, options.config);

  if (summary.failureBatchCount > 0) {
    const message = buildLegacyFailureMessage(summary);
    if (options.ctx.hasUI) {
      setAutoformatStatus(options.ctx, formatStatusLine(summary, options.ctx));
    }
    reportMessage(options.ctx, message, "warning");
    return;
  }

  if (options.config.hideSummariesInTui && options.ctx.hasUI) {
    setAutoformatStatus(options.ctx, undefined);
    return;
  }

  if (options.ctx.hasUI) {
    setAutoformatStatus(options.ctx, formatStatusLine(summary, options.ctx));
    return;
  }

  reportMessage(
    options.ctx,
    buildLegacySuccessMessage(result, summary),
    "info",
  );
}

function defaultReportConfigIssues(
  issues: ConfigValidationIssue[],
  options: {
    ctx: AutoformatExtensionContext;
  },
): void {
  if (issues.length === 0) {
    return;
  }

  const lines = issues.slice(0, 3).map((issue) => {
    if (issue.sourcePath) {
      return `${issue.sourcePath} ${issue.path}: ${issue.message}`;
    }
    return `${issue.path}: ${issue.message}`;
  });

  const remainingCount = issues.length - lines.length;
  if (remainingCount > 0) {
    lines.push(
      `...and ${remainingCount} more issue${remainingCount === 1 ? "" : "s"}.`,
    );
  }

  reportMessage(
    options.ctx,
    ["Configuration issues detected:", ...lines].join("\n"),
    "warning",
  );
}

export function createAutoformatExtension(
  pi: ExtensionAPI,
  dependencies: AutoformatExtensionDependencies = {},
): void {
  const loadConfig =
    dependencies.loadConfig ?? ((cwd: string) => loadAutoformatConfig({ cwd }));
  const createAutoformatter =
    dependencies.createAutoformatter ?? createDefaultAutoformatter;
  const reportFlushResult =
    dependencies.reportFlushResult ?? defaultReportFlushResult;
  const reportConfigIssues =
    dependencies.reportConfigIssues ?? defaultReportConfigIssues;

  let state: SessionState | undefined;
  let pendingFlush = Promise.resolve<PromptAutoformatterResult | undefined>(
    undefined,
  );

  function ensureState(cwd: string): SessionState {
    if (state && state.cwd === cwd) {
      return state;
    }

    const loadResult = loadConfig(cwd);
    const detection = loadResult.config.shellMutationDetection;
    const snapshotTracker =
      detection.enabled && detection.snapshotGlobs.length > 0
        ? new SnapshotTracker({
            cwd,
            globs: detection.snapshotGlobs,
          })
        : undefined;
    const autoformatter = createAutoformatter(cwd, loadResult.config);
    const unsubscribeEventBus = subscribeToEventBus(
      pi,
      loadResult.config,
      autoformatter,
    );
    state = {
      cwd,
      loadResult,
      autoformatter,
      snapshotTracker,
      unsubscribeEventBus,
    };
    return state;
  }

  function queueFlush(
    ctx: AutoformatExtensionContext,
  ): Promise<PromptAutoformatterResult | undefined> {
    const sessionState = state;
    if (!sessionState) {
      return pendingFlush;
    }

    pendingFlush = pendingFlush
      .then(async () => {
        const result = await sessionState.autoformatter.flushPrompt();
        reportFlushResult(result, {
          config: sessionState.loadResult.config,
          ctx,
        });
        return result;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        reportMessage(ctx, `Unexpected runtime error: ${message}`, "warning");
        return undefined;
      });

    return pendingFlush;
  }

  pi.on("session_start", async (_event, ctx) => {
    const sessionState = ensureState(ctx.cwd);
    reportConfigIssues(sessionState.loadResult.issues, { ctx });
    setAutoformatStatus(ctx, undefined);
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (event.toolName !== "bash") {
      return;
    }
    const sessionState = ensureState(ctx.cwd);
    sessionState.snapshotTracker?.before();
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    if (event.isError) {
      return;
    }

    const sessionState = ensureState(ctx.cwd);
    const output = extractToolOutputText(event.content);
    sessionState.autoformatter.recordToolResult(
      event.toolName,
      event.input,
      output,
    );

    if (event.toolName === "bash" && sessionState.snapshotTracker) {
      const snapshotTouched = sessionState.snapshotTracker.after();
      for (const touched of snapshotTouched) {
        sessionState.autoformatter.addTouchedPath(touched);
      }
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const result = await queueFlush(ctx);
    if (result) {
      const content = buildSteeringMessageContent(result);
      if (content) {
        pi.sendMessage({
          customType: "autoformat-steering",
          content,
          display: true,
        });
      }
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Safety-net flush: in the normal case, turn_end has already drained
    // the queue, so this is a no-op.
    await queueFlush(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionState = state;
    if (!sessionState) {
      return;
    }

    // Final safety-net flush for any touched files not yet formatted
    // (e.g. files added via EventBus without an agent loop).
    await queueFlush(ctx);

    setAutoformatStatus(ctx, undefined);
    sessionState.unsubscribeEventBus?.();
    state = undefined;
  });
}

export default function autoformatExtension(pi: ExtensionAPI): void {
  createAutoformatExtension(pi);
}
