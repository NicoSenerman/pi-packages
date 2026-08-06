import { formatCommandPromptBody } from "#src/command-prompt-body";

export function formatExternalDirectoryAskPrompt(
  toolName: string,
  pathValue: string,
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested tool '${toolName}' for path '${pathValue}' outside working directory '${cwd}'. Allow this external directory access?`;
}

export function formatBashExternalDirectoryAskPrompt(
  command: string,
  externalPaths: string[],
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  const pathList = externalPaths.join(", ");
  const body = formatCommandPromptBody(command);
  // Same shape as formatAskPrompt's bash branch: short prose + blank line +
  // 2-space-indented (and truncated) command. Inlining the full command inside
  // quotes blows piru/pi permission dialogs on multi-line curl|python scripts.
  return `${subject} requested bash command which references path(s) outside working directory '${cwd}': ${pathList}. Allow this external directory access?\n\n${body}`;
}
