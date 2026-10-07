/**
 * prompts.ts — System prompt builder for agents.
 */

import type { EnvInfo } from "#src/session/env";
import type { AgentPromptConfig } from "#src/types";

/** The parent session's contribution to a child prompt, plus the cwd that text claims. */
export interface InheritedPrompt {
  /** The parent agent's effective system prompt. */
  systemPrompt: string;
  /** The parent's working directory — the cwd its prompt footer names. */
  cwd: string;
}

/**
 * Build the system prompt for an agent from its config.
 *
 * Both modes place the shared/stable parent prompt (or `genericBase` when no
 * parent is available) first so the LLM's KV cache can reuse the inherited
 * prefix across all subagent invocations.
 *
 * - "replace" mode: parent/genericBase + active_agent tag + env header +
 *   config.systemPrompt.  No `<sub_agent_context>` bridge and no
 *   `<agent_instructions>` wrapper — the custom prompt has full control and
 *   the final say.
 * - "append" mode: parent/genericBase + sub-agent context bridge +
 *   active_agent tag + env header + config.systemPrompt (wrapped in
 *   `<agent_instructions>` when non-empty).
 * - "append" with empty systemPrompt: pure parent clone.
 *
 * Both modes include an `<active_agent name="${config.name}"/>` tag so
 * downstream extensions (e.g. `@gotgenes/pi-permission-system`) can resolve
 * per-agent policy inside the child session by parsing the system prompt.
 * The tag follows the cacheable parent prefix in both modes.
 *
 * @param inherited  The parent agent's effective system prompt and the cwd it names.
 */
export function buildAgentPrompt(
  config: AgentPromptConfig,
  cwd: string,
  env: EnvInfo,
  inherited?: InheritedPrompt,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  const identity = inherited
    ? withoutOwnStaticSections(
        withoutRecursionGuardedToolLines(
          withoutContradictoryCwdFooter(inherited.systemPrompt, inherited.cwd, cwd),
        ),
      )
    : genericBase;

  if (config.promptMode === "append") {

    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

    const customSection = config.systemPrompt.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";

    // Place shared/stable content first so the LLM's KV cache can reuse the
    // inherited prefix across all subagent invocations. The parent prompt is
    // placed verbatim (no wrapper tag) so it forms an identical byte prefix
    // with the parent session, maximising KV cache hits. The <active_agent>
    // tag and env block vary per call and are placed after the cached prefix.
    return (
      identity +
      "\n\n" +
      bridge +
      "\n\n" +
      activeAgentTag +
      envBlock +
      customSection
    );
  }

  // "replace" mode — parent/genericBase prefix first for KV cache reuse, then
  // the active_agent tag, env block, and the config's full system prompt.
  // Unlike append mode, no <sub_agent_context> bridge or <agent_instructions>
  // wrapper is injected — the custom prompt retains full control.
  return identity + "\n\n" + activeAgentTag + envBlock + "\n\n" + config.systemPrompt;
}

/**
 * Remove the parent's `Current working directory:` footer from the prompt the
 * child inherits, when it names a different directory than the child's.
 *
 * Pi's `buildSystemPrompt` ends every prompt with that footer and appends a
 * fresh one — naming the child session's own cwd — after this string. Left in
 * place, the inherited line gives a workspace-isolated child (e.g. one placed
 * in a git worktree by a `WorkspaceProvider`) a second, stale claim in the
 * exact phrasing Pi uses for the authoritative one, and the child follows it
 * back into the parent's directory (#640).
 *
 * A child sharing the parent's directory inherits a footer that agrees with its
 * own, so the prompt is returned untouched — keeping the inherited prefix
 * byte-identical to the parent's for prefix-caching providers. Editing it would
 * cost shared prefix (the parent's trailing extension-appended blocks shift
 * offset) to delete an accurate duplicate.
 *
 * The match is whole-line, so a footer naming a directory that merely shares a
 * prefix with the parent's survives, and it mirrors the separator normalization
 * `buildSystemPrompt` applies. An unmatched prompt is returned unchanged.
 */
function withoutContradictoryCwdFooter(
  prompt: string,
  parentCwd: string,
  childCwd: string,
): string {
  const inheritedClaim = toPromptPath(parentCwd);
  if (inheritedClaim === toPromptPath(childCwd)) {
    return prompt;
  }

  const footerLine = `Current working directory: ${inheritedClaim}`;
  return prompt
    .split("\n")
    .filter((line) => line !== footerLine)
    .join("\n");
}

/**
 * Drop the recursion-guarded dispatch tools from the inherited prompt's
 * `<tools>` listing. The create-subagent-session recursion guard removes
 * `subagent`/`get_subagent_result`/`steer_subagent` from the child's ACTIVE
 * set, but the embedded parent prompt still documents them — and combined
 * with any inherited per-turn appends the child may try to call tools it
 * does not have. The match is the exact `- name:` line format pi's tools
 * section renderer emits, so rule-list prose survives.
 */
function withoutRecursionGuardedToolLines(prompt: string): string {
  return prompt
    .split("\n")
    .filter(
      (line) =>
        !/^- (subagent|get_subagent_result|steer_subagent): /.test(line),
    )
    .join("\n");
}

/**
 * Drop the parent's `<skills>` and `<cwd>` sections from the inherited prompt.
 * The child's own pi 1.0 session renders both itself after the customPrompt
 * preamble — from the child's own (already skills-gated) options and the
 * child's effective cwd — so the embedded copies are stale duplicates that
 * waste ~1 KB per spawn and contradict worktree-isolated children on their
 * working directory. Block-exact matching; prose mentioning skills survives.
 */
function withoutOwnStaticSections(prompt: string): string {
  return prompt
    .replace(/(?:\n{2,})?<skills>\n[\s\S]*?\n<\/skills>/g, "")
    .replace(/(?:\n{2,})?<cwd>\n[\s\S]*?\n<\/cwd>/g, "");
}

/** Render a path the way `buildSystemPrompt` writes it into a prompt. */
function toPromptPath(cwd: string): string {
  return cwd.replaceAll("\\", "/");
}

/** Fallback base prompt when parent system prompt is unavailable (both modes). */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
