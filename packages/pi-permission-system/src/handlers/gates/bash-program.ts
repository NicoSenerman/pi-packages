import { createRequire } from "node:module";
import { basename, isAbsolute, join, resolve } from "node:path";
import { canonicalizePath } from "#src/canonicalize-path";
import {
  classifyTokenAsPathCandidate,
  classifyTokenAsRuleCandidate,
} from "#src/handlers/gates/bash-token-classification";
import {
  getPathPolicyValues,
  isPathWithinDirectory,
  isSafeSystemPath,
  normalizePathForComparison,
  normalizePathPolicyLiteral,
} from "#src/path-utils";
import type { BashCommandContext } from "#src/types";

// ── tree-sitter-bash lazy parser ───────────────────────────────────────────

/**
 * Minimal subset of web-tree-sitter's SyntaxNode used by the AST walker.
 * Defined locally so callers do not need to import web-tree-sitter types.
 */
interface TSNode {
  readonly type: string;
  readonly text: string;
  readonly childCount: number;
  /** False for anonymous tokens (operators, delimiters); true for named nodes. */
  readonly isNamed: boolean;
  child(index: number): TSNode | null;
}

/**
 * Minimal subset of web-tree-sitter's Parser used by this module.
 */
interface TSParser {
  parse(input: string): { rootNode: TSNode; delete(): void } | null;
  delete(): void;
}

let parserPromise: Promise<TSParser> | null = null;

async function initParser(): Promise<TSParser> {
  // Use named imports — web-tree-sitter exports Parser as a named class.
  const { Parser, Language } = await import("web-tree-sitter");
  const req = createRequire(import.meta.url);
  const treeSitterWasm = req.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => treeSitterWasm });

  const parser = new Parser();
  const bashWasm = req.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
  const bash = await Language.load(bashWasm);
  parser.setLanguage(bash);
  return parser;
}

function getParser(): Promise<TSParser> {
  parserPromise ??= initParser();
  return parserPromise;
}

// ── Parsed bash command representation ───────────────────────────────────────

/**
 * One command-pattern unit of a parsed bash program.
 *
 * Minimal by design — `text` is the simple-command (or whole compound
 * statement) string matched against the bash rules. The type is the stable
 * extension point: #306 adds an execution `context`, #307 adds per-command
 * path candidates and an effective working directory.
 */
export interface BashCommand {
  readonly text: string;
  /**
   * Execution context for a nested command (substitution or subshell); absent
   * for a current-shell (top-level) command.
   */
  readonly context?: BashCommandContext;
}

/**
 * The working directory in force where a path candidate appears.
 *
 * A `known` base carries an `offset` to be joined with `cwd` at resolution time
 * (the parse-time walk never sees `cwd`): a relative-or-absolute path string
 * built by folding the literal targets of current-shell `cd` commands (`""` =
 * `cwd`); an absolute offset (from `cd /abs`) ignores `cwd` at resolution time.
 * An `unknown` base marks a non-literal `cd` target (`cd "$DIR"`, `cd $(…)`,
 * `cd -`, bare `cd`, `cd ~…`) that made the effective directory unresolvable.
 */
type EffectiveBase =
  | { readonly kind: "known"; readonly offset: string }
  | { readonly kind: "unknown" };

/**
 * A path-candidate token paired with the effective working directory projected
 * onto the point in the command stream where it appears.
 */
interface PathCandidate {
  readonly token: string;
  readonly base: EffectiveBase;
}

export interface BashPathRuleCandidate {
  /** Raw path-like token shown in prompts, logs, and session approvals. */
  readonly token: string;
  /** Equivalent values used for permission policy matching. */
  readonly policyValues: readonly string[];
}

/**
 * A bash command parsed once into a reusable representation.
 *
 * Parsing is the expensive step (tree-sitter WASM); `BashProgram` performs it
 * a single time and exposes typed slices derived from the same AST walk so the
 * bash permission gates do not each re-parse and re-walk the command, and so
 * the slices are guaranteed to agree.
 *
 * Construct via the async `parse()` factory; the constructor is private.
 */
export class BashProgram {
  private constructor(
    private readonly rawCandidates: readonly PathCandidate[],
    private readonly commandUnits: readonly BashCommand[],
  ) {}

  /**
   * Parse a bash command into a `BashProgram`.
   *
   * Uses tree-sitter-bash to build the full AST and walks command-argument and
   * redirect-destination nodes once into raw candidate tokens, each tagged with
   * the effective working directory projected onto its position by folding
   * current-shell `cd` commands. Heredoc bodies, comments, and other
   * non-argument content are skipped. An unparseable command yields an empty
   * program.
   */
  static async parse(command: string): Promise<BashProgram> {
    const parser = await getParser();
    const tree = parser.parse(command);
    if (!tree) return new BashProgram([], []);

    try {
      const rawCandidates = collectPathCandidates(tree.rootNode);
      const commandUnits = collectCommands(tree.rootNode);
      return new BashProgram(rawCandidates, commandUnits);
    } finally {
      tree.delete();
    }
  }

  /**
   * Path-rule candidates paired with their policy lookup values.
   *
   * When `cwd` is available, each relative token is resolved against the
   * effective working directory in force at the token's position (folding
   * literal current-shell `cd` commands), while raw and project-relative
   * aliases are retained for backward-compatible relative rules. A token after
   * a non-literal `cd` keeps only its literal value so no spurious absolute
   * rule can match.
   */
  pathRuleCandidates(cwd?: string): BashPathRuleCandidate[] {
    const seen = new Set<string>();
    const result: BashPathRuleCandidate[] = [];

    for (const { token, base } of this.rawCandidates) {
      const candidate = classifyTokenAsRuleCandidate(token);
      if (!candidate) continue;

      const policyValues = getPolicyValuesForRuleCandidate(
        candidate,
        base,
        cwd,
      );
      if (policyValues.length === 0) continue;

      const key = policyValues.join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ token: candidate, policyValues });
    }

    return result;
  }

  /**
   * The top-level command-pattern units of the chain, in source order.
   *
   * Splits on the shell chain operators (`&&`, `||`, `;`, `|`, `&`, newlines);
   * quotes, command substitution, and subshells are respected by the parser and
   * are NOT split — a subshell or other compound statement is emitted whole. May
   * be empty (e.g. an empty command or a comment-only line); callers fall back
   * to the whole command so the surface is never evaluated weaker than before.
   */
  // Used by resolveBashCommandCheck (bash-command.ts) and tests. Fallow's
  // syntactic analysis cannot resolve the static-factory return type (private
  // ctor), so it reports a false positive here.
  // fallow-ignore-next-line unused-class-member
  commands(): BashCommand[] {
    return [...this.commandUnits];
  }

  /**
   * Deduplicated paths that resolve outside `cwd`.
   *
   * Each candidate is resolved against the effective working directory in force
   * where it appears, projected by folding a sequence of current-shell `cd`
   * commands (joined by `&&`, `||`, `;`, or a newline). A `cd` inside a
   * pipeline or a backgrounded command runs in a subshell and does not update
   * the running directory.
   */
  externalPaths(cwd: string): string[] {
    const normalizedCwd = canonicalizePath(
      normalizePathForComparison(cwd, cwd),
    );

    const seen = new Set<string>();
    const externalPaths: string[] = [];

    for (const { token, base } of this.rawCandidates) {
      const candidate = classifyTokenAsPathCandidate(token);
      if (!candidate) continue;

      // Unknown effective directory: a relative candidate could resolve
      // anywhere, so flag it conservatively (resolving against `cwd` only for a
      // display path). Absolute / `~` candidates are base-independent and
      // resolve normally below.
      if (base.kind === "unknown" && isRelativeCandidate(candidate)) {
        const normalized = canonicalizePath(
          normalizePathForComparison(candidate, cwd),
        );
        if (
          normalized &&
          normalizedCwd !== "" &&
          !isSafeSystemPath(normalized) &&
          !seen.has(normalized)
        ) {
          seen.add(normalized);
          externalPaths.push(normalized);
        }
        continue;
      }

      const resolveBase =
        base.kind === "known" ? resolve(cwd, base.offset) : cwd;
      const normalized = canonicalizePath(
        normalizePathForComparison(candidate, resolveBase),
      );
      if (!normalized) continue;

      if (
        normalizedCwd !== "" &&
        !isSafeSystemPath(normalized) &&
        !isPathWithinDirectory(normalized, normalizedCwd) &&
        !seen.has(normalized)
      ) {
        seen.add(normalized);
        externalPaths.push(normalized);
      }
    }

    return externalPaths;
  }
}

// ── AST walker ─────────────────────────────────────────────────────────────

/**
 * Node types whose subtrees must never be descended into for
 * path extraction — their text content is not a command argument.
 */
const SKIP_SUBTREE_TYPES = new Set(["heredoc_body", "heredoc_end", "comment"]);

/**
 * Resolve the "shell value" of an argument node — the string the shell
 * would pass to the command after quote removal.
 *
 * - `word`          → `.text` (already unquoted)
 * - `raw_string`    → strip surrounding single quotes
 * - `string`        → strip surrounding double quotes, concatenate children text
 * - `concatenation` → concatenate resolved children
 * - other           → `.text` as fallback
 */
function resolveNodeText(node: TSNode): string {
  switch (node.type) {
    case "word":
      return node.text;
    case "raw_string": {
      // Strip surrounding single quotes: 'content' → content
      const t = node.text;
      if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
        return t.slice(1, -1);
      }
      return t;
    }
    case "string": {
      // Double-quoted string: concatenate the resolved text of inner children,
      // skipping the quote-delimiter nodes (literal `"`).
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        // Skip the literal `"` delimiters
        if (child.type === '"') continue;
        result += resolveNodeText(child);
      }
      return result;
    }
    case "string_content":
    case "simple_expansion":
    case "expansion":
      return node.text;
    case "concatenation": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        result += resolveNodeText(child);
      }
      return result;
    }
    default:
      return node.text;
  }
}

// ── Pattern-first command config ───────────────────────────────────────────

interface PatternCommandConfig {
  /** Flags that consume the next argument as a non-path value (pattern, separator, etc.) */
  readonly argConsumingFlags: ReadonlySet<string>;
  /** Flags that consume the next argument as a file path */
  readonly fileConsumingFlags: ReadonlySet<string>;
  /**
   * Number of leading positional arguments that are patterns/scripts, not paths.
   * Default: 1 (covers sed, awk, grep, rg).
   * sd uses 2 (FIND and REPLACE_WITH are both non-path positionals).
   */
  readonly patternPositionals?: number;
}

/**
 * Commands whose first N positional arguments are inline patterns/scripts,
 * not filesystem paths. The map stores per-command flag configuration so
 * the walker can correctly identify which arguments are consumed by flags
 * vs. which are positional.
 */
const PATTERN_FIRST_COMMANDS: ReadonlyMap<string, PatternCommandConfig> =
  new Map([
    [
      "sed",
      {
        argConsumingFlags: new Set(["-e", "-i"]),
        fileConsumingFlags: new Set(["-f"]),
      },
    ],
    [
      "awk",
      {
        argConsumingFlags: new Set(["-e", "-F", "-v"]),
        fileConsumingFlags: new Set(["-f"]),
      },
    ],
    [
      "gawk",
      {
        argConsumingFlags: new Set(["-e", "-F", "-v"]),
        fileConsumingFlags: new Set(["-f"]),
      },
    ],
    [
      "nawk",
      {
        argConsumingFlags: new Set(["-e", "-F", "-v"]),
        fileConsumingFlags: new Set(["-f"]),
      },
    ],
    [
      "grep",
      {
        argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
        fileConsumingFlags: new Set(["-f"]),
      },
    ],
    [
      "egrep",
      {
        argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
        fileConsumingFlags: new Set(["-f"]),
      },
    ],
    [
      "fgrep",
      {
        argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
        fileConsumingFlags: new Set(["-f"]),
      },
    ],
    [
      "rg",
      {
        argConsumingFlags: new Set([
          "-e",
          "-A",
          "-B",
          "-C",
          "-m",
          "-g",
          "-t",
          "-T",
          "-j",
          "-M",
          "-r",
          "-E",
        ]),
        fileConsumingFlags: new Set(["-f"]),
      },
    ],
    [
      "sd",
      {
        argConsumingFlags: new Set(["-n", "-f"]),
        fileConsumingFlags: new Set([]),
        patternPositionals: 2,
      },
    ],
  ]);

/** Node types that represent argument values in the AST. */
const ARG_NODE_TYPES = new Set([
  "word",
  "concatenation",
  "string",
  "raw_string",
]);

/**
 * Extract the command name from a `command` node.
 * Returns the basename (e.g. `/usr/bin/sed` → `sed`), or undefined
 * if the command name cannot be determined (e.g. variable expansion).
 */
function extractCommandName(node: TSNode): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === "command_name") {
      const text = resolveNodeText(child);
      return text ? basename(text) : undefined;
    }
  }
  return undefined;
}

/**
 * Describes what the walker should do when it encounters a flag word inside
 * a pattern-first command.  Using a discriminated union lets the `switch` in
 * `collectPatternCommandTokens` narrow `nextArgAction` without a non-null
 * assertion (which would trigger the Biome/ESLint assertion conflict).
 */
type PatternCommandFlagDirective =
  | { kind: "end-of-flags" }
  | { kind: "regular-flag" }
  | {
      kind: "consume-arg";
      nextArgAction: "skip" | "extract";
      setsExplicitScript: boolean;
    };

/**
 * Classify a flag word from a pattern-first command into a directive that
 * tells the walker how to handle the flag and its following argument.
 */
function classifyPatternCommandFlag(
  text: string,
  config: PatternCommandConfig,
): PatternCommandFlagDirective {
  if (text === "--") return { kind: "end-of-flags" };
  if (config.argConsumingFlags.has(text)) {
    return {
      kind: "consume-arg",
      nextArgAction: "skip",
      setsExplicitScript: text === "-e" || text === "-f",
    };
  }
  if (config.fileConsumingFlags.has(text)) {
    return {
      kind: "consume-arg",
      nextArgAction: "extract",
      setsExplicitScript: true,
    };
  }
  return { kind: "regular-flag" };
}

/**
 * Collect path-candidate tokens from a command known to have
 * pattern/script arguments in leading positional slots.
 *
 * Uses position-based skipping: the first N positional arguments
 * (where N = patternPositionals, default 1) are assumed to be
 * inline patterns/scripts and are skipped. Remaining positional
 * arguments are collected as path candidates.
 *
 * Flags listed in `argConsumingFlags` consume the next argument
 * (skipped). Flags in `fileConsumingFlags` consume the next
 * argument as a file path (collected). The flags `-e` and `-f`
 * additionally signal that an explicit script was provided via
 * flag, so no inline positional script is expected.
 */
function collectPatternCommandTokens(
  node: TSNode,
  config: PatternCommandConfig,
): string[] {
  const patternPositionals = config.patternPositionals ?? 1;
  let hasExplicitScript = false;
  let positionalsSeen = 0;
  let nextArgAction: "skip" | "extract" | null = null;
  let pastEndOfFlags = false;
  const tokens: string[] = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Skip command_name and variable_assignment nodes.
    if (child.type === "command_name" || child.type === "variable_assignment")
      continue;

    // Only process argument-like nodes; recurse into others
    // (e.g. command_substitution) for nested commands.
    if (!ARG_NODE_TYPES.has(child.type)) {
      tokens.push(...collectPathCandidateTokens(child));
      continue;
    }

    const text = resolveNodeText(child);

    // Handle consumed argument from previous flag.
    if (nextArgAction === "skip") {
      nextArgAction = null;
      continue;
    }
    if (nextArgAction === "extract") {
      tokens.push(text);
      nextArgAction = null;
      continue;
    }

    // Flag detection (only before "--" end-of-flags marker).
    if (
      !pastEndOfFlags &&
      child.type === "word" &&
      text.startsWith("-") &&
      text.length > 1
    ) {
      const directive = classifyPatternCommandFlag(text, config);
      switch (directive.kind) {
        case "end-of-flags":
          pastEndOfFlags = true;
          break;
        case "consume-arg":
          nextArgAction = directive.nextArgAction;
          if (directive.setsExplicitScript) hasExplicitScript = true;
          break;
        case "regular-flag":
          break;
      }
      continue;
    }

    // Positional argument.
    if (!hasExplicitScript && positionalsSeen < patternPositionals) {
      positionalsSeen++;
      continue; // Skip: this is an inline pattern/script.
    }

    // File argument — collect as path candidate.
    tokens.push(text);
  }

  return tokens;
}

/**
 * Collect all argument tokens from a generic (non-pattern-first) command node,
 * skipping the command name and variable assignments.
 */
function collectGenericCommandTokens(node: TSNode): string[] {
  const tokens: string[] = [];
  let seenCommandName = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "command_name") {
      seenCommandName = true;
      continue;
    }
    // Skip variable_assignment nodes (FOO=/bar)
    if (child.type === "variable_assignment") continue;

    // If there was no explicit command_name node, the first word-like
    // child is the command name itself — skip it.
    if (!seenCommandName && ARG_NODE_TYPES.has(child.type)) {
      seenCommandName = true;
      continue;
    }

    // Argument nodes: resolve their text and collect.
    if (ARG_NODE_TYPES.has(child.type)) {
      tokens.push(resolveNodeText(child));
      continue;
    }

    // Recurse into other children (e.g. command_substitution nested in args)
    tokens.push(...collectPathCandidateTokens(child));
  }

  return tokens;
}

/**
 * Collect redirect-destination tokens from a `file_redirect` node.
 */
function collectRedirectTokens(node: TSNode): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (ARG_NODE_TYPES.has(child.type)) {
      tokens.push(resolveNodeText(child));
    }
  }
  return tokens;
}

/**
 * Select the collection strategy for a `command` node: pattern-first
 * commands use `collectPatternCommandTokens`; all others use
 * `collectGenericCommandTokens`.
 */
function collectCommandTokens(node: TSNode): string[] {
  const commandName = extractCommandName(node);
  const config = commandName
    ? PATTERN_FIRST_COMMANDS.get(commandName)
    : undefined;
  return config
    ? collectPatternCommandTokens(node, config)
    : collectGenericCommandTokens(node);
}

/**
 * Recursively visit the AST and collect resolved text of nodes that
 * represent command arguments or redirect destinations.
 *
 * Skips `heredoc_body`, `heredoc_end`, and `comment` subtrees entirely.
 *
 * For commands in `PATTERN_FIRST_COMMANDS`, uses position-based
 * argument skipping to avoid collecting inline patterns/scripts
 * as path candidates. For all other commands, collects all
 * arguments generically.
 */
function collectPathCandidateTokens(node: TSNode): string[] {
  if (SKIP_SUBTREE_TYPES.has(node.type)) return [];
  if (node.type === "command") return collectCommandTokens(node);
  if (node.type === "file_redirect") return collectRedirectTokens(node);

  const tokens: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) tokens.push(...collectPathCandidateTokens(child));
  }
  return tokens;
}

// Token classification is delegated to bash-token-classification.ts,
// which exports classifyTokenAsPathCandidate and classifyTokenAsRuleCandidate
// with a shared rejectNonPathToken predicate eliminating the prior clone.

// ── Command enumeration ──────────────────────────────────────────────────────

/**
 * Container node types descended into when enumerating command units.
 */
const COMMAND_ENUM_DESCEND = new Set([
  "program",
  "list",
  "pipeline",
  "redirected_statement",
]);

/**
 * Named node types skipped during command enumeration: redirect targets,
 * comments, and heredoc bodies — none is a command to evaluate. Anonymous
 * tokens (chain operators `&&`/`;`/`|`, substitution and subshell delimiters
 * `$(`/`)`/`` ` ``/`(`) are filtered by the `isNamed` guard, not listed here.
 */
const COMMAND_ENUM_SKIP = new Set([
  "file_redirect",
  "heredoc_redirect",
  "herestring_redirect",
  "comment",
  "heredoc_body",
  "heredoc_end",
]);

/**
 * Nested execution contexts whose interior commands really execute and must be
 * evaluated too: command substitution (`$(…)`, backticks) and process
 * substitution (`<(…)`/`>(…)`). Subshells (`( … )`) are handled separately
 * because they are also emitted whole.
 */
const NESTED_EXECUTION_CONTEXTS = new Map<string, BashCommandContext>([
  ["command_substitution", "command_substitution"],
  ["process_substitution", "process_substitution"],
]);

/**
 * Enumerate the command units of a bash program, in source order.
 *
 * Descends container nodes (`program`, `list`, `pipeline`, `redirected_statement`)
 * and emits each `command` node whole. Additionally descends into the three
 * nested execution contexts — command substitution (`$(…)`, backticks), process
 * substitution (`<(…)`/`>(…)`), and subshells (`( … )`) — emitting each inner
 * command as its own unit *in addition to* the enclosing command, since those
 * inner commands really execute (#306). Control-flow bodies and `{ … }` brace
 * groups are emitted whole without descending (deferred).
 *
 * The enclosing command/subshell is always still emitted whole, so adding the
 * nested units can only ever produce a more-restrictive decision, never weaker.
 */
function collectCommands(node: TSNode): BashCommand[] {
  const out: BashCommand[] = [];
  collectCommandsInto(node, undefined, out);
  return out;
}

function collectCommandsInto(
  node: TSNode,
  context: BashCommandContext | undefined,
  out: BashCommand[],
): void {
  // Anonymous tokens (operators `&&`/`;`/`|`, delimiters `$(`/`)`/`` ` ``/`(`)
  // carry no command.
  if (!node.isNamed) return;
  if (COMMAND_ENUM_SKIP.has(node.type)) return;

  if (node.type === "command") {
    out.push(makeUnit(node.text, context));
    // A command's text already contains any substitution; descend its subtree
    // to ALSO emit the inner commands of command/process substitutions.
    collectSubstitutionCommands(node, out);
    return;
  }

  if (node.type === "subshell") {
    out.push(makeUnit(node.text, context)); // never-weaker whole emit
    descendCommandChildren(node, "subshell", out);
    return;
  }

  if (COMMAND_ENUM_DESCEND.has(node.type)) {
    descendCommandChildren(node, context, out);
    return;
  }

  // Any other named statement (compound_statement `{ … }`, if/while/for/case,
  // function_definition): emit whole, do not descend — deferred (#306).
  out.push(makeUnit(node.text, context));
}

function makeUnit(
  text: string,
  context: BashCommandContext | undefined,
): BashCommand {
  return context ? { text, context } : { text };
}

function descendCommandChildren(
  node: TSNode,
  context: BashCommandContext | undefined,
  out: BashCommand[],
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectCommandsInto(child, context, out);
  }
}

/**
 * Search a command's subtree for command/process substitutions and enumerate
 * the commands inside them, tagged with the substitution's execution context.
 * A substitution can nest under `command_name` (when the whole command is
 * `$(…)`) or under an argument, so the entire subtree is searched.
 */
function collectSubstitutionCommands(node: TSNode, out: BashCommand[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const nestedContext = NESTED_EXECUTION_CONTEXTS.get(child.type);
    if (nestedContext) {
      descendCommandChildren(child, nestedContext, out);
    } else {
      collectSubstitutionCommands(child, out);
    }
  }
}

// ── Effective working directory projection ─────────────────────────────────

/** The working directory in force at the start of a program (`cwd`). */
const CWD_BASE: EffectiveBase = { kind: "known", offset: "" };

/** The effective directory after a non-literal or unresolvable `cd`. */
const UNKNOWN_BASE: EffectiveBase = { kind: "unknown" };

/**
 * Walk the AST once, collecting every path-candidate token tagged with the
 * effective working directory projected onto its position.
 *
 * The effective directory is stateful: it starts at `cwd` and each current-shell
 * `cd <literal>` (joined by `&&`, `||`, `;`, or a newline) folds into it for
 * subsequent commands. A `cd` inside a pipeline or a backgrounded command runs
 * in a subshell and does not update the running directory; subshell and
 * brace-group interiors inherit the enclosing base without folding their own
 * `cd`s (a conservative first tier).
 */
function collectPathCandidates(rootNode: TSNode): PathCandidate[] {
  const out: PathCandidate[] = [];
  walkForCandidates(rootNode, CWD_BASE, out);
  return out;
}

/**
 * Collect a single node's candidates tagged with `base`, returning the
 * effective base in force *after* the node (the input base unless the node is a
 * current-shell `cd <literal>` that folds the running directory).
 */
function walkForCandidates(
  node: TSNode,
  base: EffectiveBase,
  out: PathCandidate[],
): EffectiveBase {
  switch (node.type) {
    case "program":
    case "list":
    case "redirected_statement":
      return walkCurrentShellSequence(node, base, out);
    case "command":
      tagTokens(collectCommandTokens(node), base, out);
      return foldCd(node, base);
    case "subshell":
      // A subshell runs in a child shell: its interior `cd`s fold within the
      // subshell but reset on exit, so the folded base is discarded.
      walkCurrentShellSequence(node, base, out);
      return base;
    case "compound_statement":
      // A `{ … }` brace group runs in the current shell, so its `cd`s persist
      // to following commands — thread and return the folded base.
      return walkCurrentShellSequence(node, base, out);
    default:
      // Pipelines, control-flow bodies, redirect targets, and command/process
      // substitution interiors: collect every candidate in the subtree tagged
      // with the enclosing base and do not fold their internal `cd`s. (Folding
      // inside substitutions is deferred — conservative, never under-flags.)
      tagTokens(collectPathCandidateTokens(node), base, out);
      return base;
  }
}

/**
 * Fold a current-shell sequence (`program` / `list` / `redirected_statement`):
 * thread the effective base left-to-right through the children so a `cd` updates
 * the base for following siblings. A statement immediately followed by the
 * background operator (`&`) runs in a subshell, so its folded base is discarded.
 */
function walkCurrentShellSequence(
  seqNode: TSNode,
  base: EffectiveBase,
  out: PathCandidate[],
): EffectiveBase {
  let current = base;
  for (let i = 0; i < seqNode.childCount; i++) {
    const child = seqNode.child(i);
    if (!child?.isNamed) continue;
    if (SKIP_SUBTREE_TYPES.has(child.type)) continue;
    const after = walkForCandidates(child, current, out);
    current = isBackgrounded(seqNode, i) ? current : after;
  }
  return current;
}

/**
 * True when the statement at `index` is immediately followed by the background
 * operator (`&`) — distinct from the `&&` / `||` / `;` current-shell separators.
 */
function isBackgrounded(seqNode: TSNode, index: number): boolean {
  const next = seqNode.child(index + 1);
  if (!next || next.isNamed) return false;
  return next.type === "&";
}

function tagTokens(
  tokens: readonly string[],
  base: EffectiveBase,
  out: PathCandidate[],
): void {
  for (const token of tokens) out.push({ token, base });
}

/**
 * True when a path candidate is relative (resolved against the effective
 * directory) rather than absolute (`/…`) or home-relative (`~…`), which are
 * base-independent. Used to decide which candidates an unknown base affects.
 */
function isRelativeCandidate(candidate: string): boolean {
  return !candidate.startsWith("/") && !candidate.startsWith("~");
}

function getPolicyValuesForRuleCandidate(
  candidate: string,
  base: EffectiveBase,
  cwd: string | undefined,
): string[] {
  if (!cwd) {
    const literal = normalizePathPolicyLiteral(candidate);
    return literal ? [literal] : [];
  }

  if (base.kind === "unknown" && isRelativeCandidate(candidate)) {
    const literal = normalizePathPolicyLiteral(candidate);
    return literal ? [literal] : [];
  }

  const resolveBase = base.kind === "known" ? resolve(cwd, base.offset) : cwd;
  return getPathPolicyValues(candidate, { cwd, resolveBase });
}

/**
 * Compute the effective base after a command runs. Returns `base` unchanged
 * unless the command is `cd`:
 *
 * - `cd /abs` (absolute literal) → a fresh known base, recovering from an
 *   earlier unknown base.
 * - `cd rel` (relative literal) → fold into a known base, or stay unknown if the
 *   base was already unknown.
 * - `cd "$DIR"` / `cd $(…)` / `cd -` / bare `cd` / `cd ~…` (non-literal) →
 *   unknown.
 */
function foldCd(commandNode: TSNode, base: EffectiveBase): EffectiveBase {
  if (extractCommandName(commandNode) !== "cd") return base;
  const target = cdLiteralTarget(commandNode);
  if (target === null) return UNKNOWN_BASE;
  if (isAbsolute(target)) return { kind: "known", offset: target };
  if (base.kind === "unknown") return UNKNOWN_BASE;
  return { kind: "known", offset: join(base.offset, target) };
}

/**
 * Resolve the literal target of a `cd` command, or `null` when the first
 * argument is not a static literal (contains an expansion or command
 * substitution) or cannot be resolved against the working directory (`cd -`,
 * `cd ~…`, bare `cd`).
 */
function cdLiteralTarget(commandNode: TSNode): string | null {
  for (let i = 0; i < commandNode.childCount; i++) {
    const child = commandNode.child(i);
    if (!child) continue;
    if (child.type === "command_name" || child.type === "variable_assignment")
      continue;
    if (!child.isNamed) continue;
    // Skip the `--` end-of-flags marker; the next argument is the target.
    if (child.type === "word" && child.text === "--") continue;
    if (!ARG_NODE_TYPES.has(child.type)) return null;
    return literalTextOf(child);
  }
  return null;
}

/**
 * The literal string value of an argument node, or `null` when it contains a
 * variable expansion / command substitution or is a non-resolvable `cd`
 * destination (`-`, `~…`).
 */
function literalTextOf(node: TSNode): string | null {
  switch (node.type) {
    case "word": {
      const text = node.text;
      if (text === "-" || text.startsWith("~")) return null;
      return text;
    }
    case "raw_string": {
      const text = node.text;
      return text.length >= 2 && text.startsWith("'") && text.endsWith("'")
        ? text.slice(1, -1)
        : text;
    }
    case "concatenation": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        const part = literalTextOf(child);
        if (part === null) return null;
        result += part;
      }
      return result;
    }
    case "string": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === '"') continue;
        if (child.type !== "string_content") return null;
        result += child.text;
      }
      return result;
    }
    default:
      return null;
  }
}
