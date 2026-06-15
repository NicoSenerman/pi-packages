import type { BashCommand } from "#src/handlers/gates/bash-program";
import { pickMostRestrictive } from "#src/handlers/gates/candidate-check";
import type { ScopedPermissionResolver } from "#src/permission-resolver";
import type { PermissionCheckResult } from "#src/types";

/**
 * Resolve the bash command-pattern decision for a (possibly chained) command.
 *
 * A bash invocation may be a shell program with several commands joined by
 * `&&`, `||`, `;`, `|`, `&`, or newlines. Matching the whole string against the
 * bash patterns lets a denied command ride through on an allowed leading one
 * (issue #301). Instead, the caller supplies the program's command units (from
 * the shared `BashProgram.commands()` parse) — including those nested inside
 * substitutions and subshells (#306); each is evaluated on the `bash` surface
 * and the most restrictive result wins (`deny > ask > allow`).
 *
 * The selected result carries the offending sub-command in `command`, its rule
 * in `matchedPattern`, and the offending command's execution context in
 * `commandContext` (set only for a nested command), so the prompt,
 * session-approval suggestion, and decision event scope to that command.
 *
 * When `commands` is empty (an empty command, a comment, or a bare compound
 * statement), the whole `command` is evaluated as before, so the surface is
 * never weaker than the previous behavior.
 *
 * Pure and synchronous: the (async, tree-sitter) parse happens once in the
 * handler, which passes the decomposed `commands` here.
 */
export function resolveBashCommandCheck(
  command: string,
  commands: BashCommand[],
  agentName: string | undefined,
  resolver: ScopedPermissionResolver,
): PermissionCheckResult {
  const results = commands.map((cmd) => {
    const result = resolver.resolve("bash", { command: cmd.text }, agentName);
    return cmd.context ? { ...result, commandContext: cmd.context } : result;
  });
  return (
    pickMostRestrictive(results) ??
    resolver.resolve("bash", { command }, agentName)
  );
}
