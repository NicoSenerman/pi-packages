// Shared bash-command body shaping for permission ask prompts.
// TUIs (pi + piru) treat 2-space-indented lines after a blank line as a code
// panel; long inlined commands blow that layout apart.

export function truncateCommandForPrompt(
  command: string | null | undefined,
  maxLines = 3,
): string {
  if (!command) return "";
  // A trailing newline is a terminator, not an extra line — exclude it when
  // counting so `cat <<EOF\nhello\nEOF` shows 3 lines, not 4.
  const trailing = command.endsWith("\n") ? 1 : 0;
  const lines = command.split("\n");
  const contentLines = lines.length - trailing;
  if (contentLines <= maxLines) return command;
  return `${lines.slice(0, maxLines).join("\n")}\n  … (${contentLines - maxLines} more lines)`;
}

export function indentCommandForPrompt(command: string): string {
  return command
    .split("\n")
    .map((l) => (l.trim() ? `  ${l}` : l))
    .join("\n");
}

export function formatCommandPromptBody(
  command: string | null | undefined,
): string {
  return indentCommandForPrompt(truncateCommandForPrompt(command));
}
