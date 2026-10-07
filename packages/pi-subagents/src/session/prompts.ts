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
    ? inheritParentPrompt(inherited.systemPrompt, inherited.cwd, cwd)
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

const SKILLS_SECTION_HEADING =
  "The following skills provide specialized instructions for specific tasks.";
const SKILLS_CATALOGUE_CLOSE = "</available_skills>";
const SKILLS_SECTION_OPEN = "<skills>";
const SKILLS_SECTION_CLOSE = "</skills>";
const CWD_SECTION_OPEN = "<cwd>";
const CWD_SECTION_CLOSE = "</cwd>";
const TOOLS_SECTION_OPEN = "<tools>";
const TOOLS_SECTION_CLOSE = "</tools>";
const RULES_SECTION_OPEN = "<rules>";
const RULES_SECTION_CLOSE = "</rules>";
const SECTIONS_BELOW_RULES: ReadonlySet<string> = new Set([
  "<docs>",
  "<addendum>",
  "<project_context>",
  "<skills>",
  "<cwd>",
]);
const PROJECT_CONTEXT_OPEN = "<project_context>";
const PROJECT_CONTEXT_CLOSE = "</project_context>";
const PROJECT_CONTEXT_LEAD_IN = "Project-specific instructions and guidelines:";

type PromptShape = "footer" | "section" | "unanchored";

interface AnchoredTail {
  readonly at: number;
  readonly shape: PromptShape;
}

/**
 * Reduce an inherited prompt to the identity a child may adopt.
 *
 * Cuts Pi's per-session tail (skills catalogue + cwd footer, or ≥0.86 `<skills>`
 * / `<cwd>` sections — #958) and, when that tail is section-shaped, excises the
 * parent's `<tools>` / `<rules>` pair (#1009). A relocated child also loses the
 * parent's `<project_context>` (#918). The per-turn stash in parent-snapshot.ts
 * is complementary: it stops forceSystemPrompt leaks from entering this string;
 * this function removes the session-resolved sections that remain.
 */
function inheritParentPrompt(prompt: string, parentCwd: string, childCwd: string): string {
  const lines = prompt.split("\n");
  const cutProject = toPromptPath(parentCwd) !== toPromptPath(childCwd);
  const tail = sessionResolvedTailStart(lines, parentCwd, cutProject);
  const head = tail.at === -1 ? lines : lines.slice(0, tail.at);
  const excised = tail.shape === "section" ? withoutToolSurface(head) : head;
  const kept = (tail.at === -1 ? prompt : excised.join("\n").trimEnd());
  return withoutOwnStaticSections(
    withoutRecursionGuardedToolLines(
      tail.shape === "section" ? kept : withoutContradictoryCwdFooter(kept, parentCwd, childCwd),
    ),
  );
}

function withoutToolSurface(head: readonly string[]): readonly string[] {
  const bound = laterSectionStart(head);
  const toolsAt = head.indexOf(TOOLS_SECTION_OPEN);
  if (toolsAt === -1 || toolsAt >= bound) return head;
  const toolsCloseAt = head.indexOf(TOOLS_SECTION_CLOSE, toolsAt);
  if (toolsCloseAt === -1 || toolsCloseAt >= bound) return head;
  const rulesAt = toolsCloseAt + 2;
  if (head[toolsCloseAt + 1] !== "" || head[rulesAt] !== RULES_SECTION_OPEN) return head;
  const rulesCloseAt = head.indexOf(RULES_SECTION_CLOSE, rulesAt);
  if (rulesCloseAt === -1 || rulesCloseAt >= bound) return head;
  const spanEnd = head[rulesCloseAt + 1] === "" ? rulesCloseAt + 2 : rulesCloseAt + 1;
  return [...head.slice(0, toolsAt), ...head.slice(spanEnd)];
}

function laterSectionStart(head: readonly string[]): number {
  const at = head.findIndex((line) => SECTIONS_BELOW_RULES.has(line));
  return at === -1 ? head.length : at;
}

function sessionResolvedTailStart(
  lines: readonly string[],
  parentCwd: string,
  cutProjectContext: boolean,
): AnchoredTail {
  const tail = cwdAnchoredTailStart(lines, parentCwd);
  if (!cutProjectContext || tail.at === -1) return tail;
  const projectContextAt = projectContextStart(lines, tail.at);
  return projectContextAt === -1 ? tail : { ...tail, at: projectContextAt };
}

function cwdAnchoredTailStart(lines: readonly string[], parentCwd: string): AnchoredTail {
  const footerAt = lines.lastIndexOf(`Current working directory: ${toPromptPath(parentCwd)}`);
  if (footerAt !== -1) {
    const catalogueAt = skillsSectionStart(lines, footerAt);
    return { at: catalogueAt === -1 ? footerAt : catalogueAt, shape: "footer" };
  }
  const cwdAt = cwdSectionStart(lines, parentCwd);
  if (cwdAt !== -1) {
    return { at: skillsSectionWrapperStart(lines, cwdAt), shape: "section" };
  }
  return { at: skillsSectionStart(lines, -1), shape: "unanchored" };
}

function cwdSectionStart(lines: readonly string[], parentCwd: string): number {
  for (
    let openAt = lines.lastIndexOf(CWD_SECTION_OPEN);
    openAt !== -1;
    openAt = lines.lastIndexOf(CWD_SECTION_OPEN, openAt - 1)
  ) {
    if (lines[openAt + 1] === toPromptPath(parentCwd) && lines[openAt + 2] === CWD_SECTION_CLOSE) {
      return openAt;
    }
  }
  return -1;
}

function skillsSectionWrapperStart(lines: readonly string[], cwdAt: number): number {
  let closeAt = cwdAt - 1;
  while (closeAt >= 0 && lines[closeAt] === "") closeAt--;
  if (closeAt < 0 || lines[closeAt] !== SKILLS_SECTION_CLOSE) return cwdAt;
  const openAt = lines.lastIndexOf(SKILLS_SECTION_OPEN, closeAt);
  if (openAt === -1 || lines[openAt + 1] !== SKILLS_SECTION_HEADING) return cwdAt;
  return openAt;
}

function projectContextStart(lines: readonly string[], tailAt: number): number {
  let closeAt = tailAt - 1;
  while (closeAt >= 0 && lines[closeAt] === "") closeAt--;
  if (closeAt < 0 || lines[closeAt] !== PROJECT_CONTEXT_CLOSE) return -1;
  for (
    let openAt = lines.lastIndexOf(PROJECT_CONTEXT_OPEN, closeAt);
    openAt !== -1;
    openAt = lines.lastIndexOf(PROJECT_CONTEXT_OPEN, openAt - 1)
  ) {
    if (lines[openAt + 2] === PROJECT_CONTEXT_LEAD_IN || lines[openAt + 1] === PROJECT_CONTEXT_LEAD_IN) {
      return openAt;
    }
  }
  return -1;
}

function skillsSectionStart(lines: readonly string[], footerAt: number): number {
  const catalogueEnd = catalogueCloseBefore(lines, footerAt);
  return catalogueEnd === -1 ? -1 : lines.lastIndexOf(SKILLS_SECTION_HEADING, catalogueEnd);
}

function catalogueCloseBefore(lines: readonly string[], footerAt: number): number {
  if (footerAt === -1) return lines.lastIndexOf(SKILLS_CATALOGUE_CLOSE);
  return lines[footerAt - 1] === SKILLS_CATALOGUE_CLOSE ? footerAt - 1 : -1;
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

/**
 * Fallback when no parent contribution is usable.
 *
 * Asserts nothing about the child's tools: a capability list here told a
 * read-only child it could write files (#904). The agent's own prompt and
 * the tool array state those facts.
 */
const genericBase = `# Instructions
Do what has been asked; nothing more, nothing less.`;
