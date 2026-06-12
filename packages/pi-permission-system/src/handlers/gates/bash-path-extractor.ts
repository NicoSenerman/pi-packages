import { BashProgram } from "./bash-program";

/**
 * Extract paths from a bash command string that resolve outside CWD.
 *
 * Thin facade over {@link BashProgram.externalPaths}; parses the command and
 * returns the cd-aware external paths. See `BashProgram` for the parsing and
 * resolution semantics.
 */
export async function extractExternalPathsFromBashCommand(
  command: string,
  cwd: string,
): Promise<string[]> {
  return (await BashProgram.parse(command)).externalPaths(cwd);
}
