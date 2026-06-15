/**
 * Builds the working-directory instruction block appended to the system prompt.
 *
 * Pi already states the resolved CWD: its system prompt ends with a
 * `Current working directory: <path>` footer, and that line survives downstream
 * shaping (e.g. pi-anthropic-auth, which only rewrites the preamble span). What
 * Pi ships nowhere — default or shaped — is any *instruction* against
 * `cd`-prefixing the CWD; the footer is a bare statement of fact, not a rule.
 *
 * This block adds that missing prohibition. It repeats the literal resolved path
 * only to make the forbidden `cd <path> &&` example concrete, not because the
 * path is otherwise unavailable to the agent.
 */

/** Marker used to detect and avoid double-appending the block. */
export const WORKING_DIRECTORY_HEADING = "# Working Directory";

/**
 * Build the instruction block for a given resolved working directory.
 *
 * @param cwd - The resolved current working directory (e.g. `ctx.cwd`).
 * @returns A markdown block naming the literal path and forbidding `cd`-into-cwd.
 */
export function buildWorkingDirectoryPrompt(cwd: string): string {
  return [
    WORKING_DIRECTORY_HEADING,
    "",
    `Shell commands already execute in \`${cwd}\`. ` +
      "Never prefix a command with `cd` into the current working directory — " +
      `neither \`cd ${cwd} &&\` nor \`cd $(pwd) &&\`. ` +
      "Just run the command directly.",
  ].join("\n");
}

/**
 * Append the working-directory block to an existing system prompt.
 *
 * Idempotent: if the block's heading is already present, the prompt is returned
 * unchanged so chained `before_agent_start` handlers do not stack duplicates.
 *
 * @param systemPrompt - The fully assembled system prompt.
 * @param cwd - The resolved current working directory.
 * @returns The system prompt with the working-directory block appended.
 */
export function appendWorkingDirectoryPrompt(
  systemPrompt: string,
  cwd: string,
): string {
  if (systemPrompt.includes(WORKING_DIRECTORY_HEADING)) {
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${buildWorkingDirectoryPrompt(cwd)}`;
}
