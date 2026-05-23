/**
 * session-config.ts — Pure configuration assembler for agent sessions.
 *
 * `assembleSessionConfig()` is the pure core extracted from `runAgent()`.
 * It accepts resolved inputs (agent type, narrow context, run options, env info)
 * and returns everything `runAgent()` needs to create the SDK session — without
 * importing or constructing any Pi SDK types.
 *
 * The only async IO in the assembly phase (`detectEnv`) is handled by the caller
 * before invoking this function, keeping the assembler synchronous.
 */

import {
  type AgentConfigLookup,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
} from "./config/agent-types";
import type { EnvInfo } from "./env";
import type { PromptExtras } from "./prompts";
import type { PreloadedSkill } from "./skill-loader";
import type {
  AgentPromptConfig,
  MemoryScope,
  SubagentType,
  ThinkingLevel,
} from "./types";

// ── Public interfaces ────────────────────────────────────────────────────────

/**
 * IO collaborators injected into `assembleSessionConfig`.
 *
 * Bundling the four IO-touching (or promptly testable) functions into a single
 * interface keeps the assembler free of direct module imports and makes it
 * trivially testable without `vi.mock()` — callers inject real implementations
 * at the edge (`agent-runner.ts`) or stubs in tests.
 */
export interface AssemblerIO {
  preloadSkills: (skills: string[], cwd: string) => PreloadedSkill[];
  buildMemoryBlock: (name: string, scope: MemoryScope, cwd: string) => string;
  buildReadOnlyMemoryBlock: (
    name: string,
    scope: MemoryScope,
    cwd: string,
  ) => string;
  buildAgentPrompt: (
    config: AgentPromptConfig,
    cwd: string,
    env: EnvInfo,
    parentPrompt?: string,
    extras?: PromptExtras,
  ) => string;
}

/**
 * Narrow context the assembler reads from the parent session.
 * Tests construct plain objects satisfying this interface — no SDK mocking needed.
 *
 * Models are treated as opaque handles: the assembler never inspects their
 * internals, only passes them through. `getAvailable` returns just enough
 * structural information ({ provider, id }) for the availability check in
 * `resolveDefaultModel`.
 */
export interface AssemblerContext {
  /** Parent working directory (overridable via options.cwd). */
  cwd: string;
  /** Parent's effective system prompt (for append-mode agents). */
  parentSystemPrompt: string;
  /** Parent's current model instance (fallback when agent config has no model). */
  parentModel?: unknown;
  /** Model registry for resolving config.model strings. */
  modelRegistry: {
    find(provider: string, modelId: string): unknown;
    getAvailable?(): Array<{ provider: string; id: string }>;
  };
}

/**
 * Narrow slice of RunOptions consumed by the assembler.
 * All fields are optional — callers pass only what they have.
 */
export interface AssemblerOptions {
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /** When true, forces extensions and skills to false. */
  isolated?: boolean;
  /** Explicit model override — wins over agentConfig.model and parent model. */
  model?: unknown;
  /** Explicit thinking level — wins over agentConfig.thinking. */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Assembled configuration returned to `runAgent()`.
 * Contains everything needed to create the SDK session and filter tools —
 * with no SDK object references.
 */
export interface SessionConfig {
  /** Resolved working directory (`options.cwd ?? ctx.cwd`). */
  effectiveCwd: string;
  /** Fully-assembled system prompt string (ready for `systemPromptOverride`). */
  systemPrompt: string;
  /** Built-in tool names for session creation, filtering, and memory augmentation. */
  toolNames: string[];
  /** Disallowed tool set from agentConfig (for `filterActiveTools`). undefined when empty. */
  disallowedSet: Set<string> | undefined;
  /** Resolved extensions setting for resource loader and tool filtering. */
  extensions: boolean | string[];
  /**
   * Resolved model instance (undefined → use parent model as passed to SDK).
   * Opaque handle — the assembler passes it through without inspection.
   * Caller casts to the SDK’s Model<any> at the session-creation boundary.
   */
  model: unknown;
  /** Resolved thinking level (undefined → inherit from session). */
  thinkingLevel: ThinkingLevel | undefined;
  /** Whether to skip skill loading in the resource loader (`noSkills` flag). */
  noSkills: boolean;
  /** Prompt extras (memory block, preloaded skill blocks) — for transparency. */
  extras: PromptExtras;
  /** Per-agent configured max turns (from agentConfig.maxTurns). */
  agentMaxTurns: number | undefined;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the default model from the agent config's model string.
 *
 * Priority: parentModel is the fallback; if `configModel` is a "provider/modelId"
 * string that resolves against the registry AND is in the available set, return
 * that model instead.
 */
function resolveDefaultModel(
  parentModel: unknown,
  registry: AssemblerContext["modelRegistry"],
  configModel?: string,
): unknown {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }
  return parentModel;
}

// ── Public function ──────────────────────────────────────────────────────────

/**
 * Assemble all configuration needed to create an agent session.
 *
 * Synchronous and side-effect-free — all IO is delegated through the `io`
 * parameter. The caller is responsible for resolving `EnvInfo` beforehand
 * via `detectEnv()`.
 *
 * @param type       The subagent type name (case-insensitive registry lookup).
 * @param ctx        Narrow context from the parent session.
 * @param options    Per-call overrides (cwd, isolated, model, thinkingLevel).
 * @param env        Pre-resolved environment info from `detectEnv()`.
 * @param registry   Agent config lookup — provides resolveAgentConfig and getToolNamesForType.
 * @param io         IO collaborators (skill loader, memory builder, prompt builder).
 */
export function assembleSessionConfig(
  type: SubagentType,
  ctx: AssemblerContext,
  options: AssemblerOptions,
  env: EnvInfo,
  registry: AgentConfigLookup,
  io: AssemblerIO,
): SessionConfig {
  const agentConfig = registry.resolveAgentConfig(type);

  const effectiveCwd = options.cwd ?? ctx.cwd;

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : agentConfig.extensions;
  const skills = options.isolated ? false : agentConfig.skills;

  // Build prompt extras (memory, preloaded skills)
  const extras: PromptExtras = {};

  // Skill preloading: when skills is string[], preload their content into the prompt
  if (Array.isArray(skills)) {
    const loaded = io.preloadSkills(skills, effectiveCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = registry.getToolNamesForType(type);

  // Persistent memory: detect write capability and branch accordingly.
  // Account for disallowedTools — a tool in the base set but on the denylist
  // is not truly available.
  if (agentConfig.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools
      ? new Set(agentConfig.disallowedTools)
      : undefined;
    const effectivelyHas = (name: string) =>
      existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = io.buildMemoryBlock(
        agentConfig.name,
        agentConfig.memory,
        effectiveCwd,
      );
    } else {
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = io.buildReadOnlyMemoryBlock(
        agentConfig.name,
        agentConfig.memory,
        effectiveCwd,
      );
    }
  }

  // Build system prompt from the resolved agent config
  const systemPrompt = io.buildAgentPrompt(
    agentConfig,
    effectiveCwd,
    env,
    ctx.parentSystemPrompt,
    extras,
  );

  // noSkills: when we've already preloaded skills into the prompt, or skills = false,
  // tell the resource loader not to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  // Disallowed tools set (for filterActiveTools in runAgent)
  const disallowedSet = agentConfig.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  // Model resolution: explicit option > config model string > parent model
  const model =
    options.model ??
    resolveDefaultModel(ctx.parentModel, ctx.modelRegistry, agentConfig.model);

  // Thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig.thinking;

  // Per-agent max turns (combined with options.maxTurns and defaultMaxTurns by runAgent)
  const agentMaxTurns = agentConfig.maxTurns;

  return {
    effectiveCwd,
    systemPrompt,
    toolNames,
    disallowedSet,
    extensions,
    model,
    thinkingLevel,
    noSkills,
    extras,
    agentMaxTurns,
  };
}
