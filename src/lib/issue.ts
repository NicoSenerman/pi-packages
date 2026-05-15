/**
 * Platform-independent business logic for issue tools.
 *
 * Simplified from `@repone/agent-tools` — no board integration.
 */
import { gh } from "./github";

export interface CloseIssueArgs {
  issueNumber: number;
  reason?: string;
  comment?: string;
}

export async function closeIssue(args: CloseIssueArgs): Promise<string> {
  const reason = args.reason ?? "completed";

  if (reason === "not planned") {
    throw new Error(
      "Invalid reason 'not planned'. Use 'not_planned' (with underscore). Valid: completed, not_planned",
    );
  }
  if (reason !== "completed" && reason !== "not_planned") {
    throw new Error(
      `Invalid reason '${reason}'. Valid: completed, not_planned`,
    );
  }

  // Normalize to the value the gh CLI expects
  const ghReason = reason === "not_planned" ? "not planned" : reason;

  const closeArgs = [
    "issue",
    "close",
    String(args.issueNumber),
    "--reason",
    ghReason,
  ];
  if (args.comment) {
    closeArgs.push("--comment", args.comment);
  }

  await gh(closeArgs);

  return `Closed issue #${args.issueNumber} (reason: ${reason})`;
}
