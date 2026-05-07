import { createRequire } from "node:module";
import { basename } from "node:path";

import {
  isPathOutsideWorkingDirectory,
  normalizePathForComparison,
} from "../../path-utils";

// ── tree-sitter-bash lazy parser ───────────────────────────────────────────

/**
 * Minimal subset of web-tree-sitter's SyntaxNode used by the AST walker.
 * Defined locally so callers do not need to import web-tree-sitter types.
 */
interface TSNode {
  readonly type: string;
  readonly text: string;
  readonly childCount: number;
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
  return parser as TSParser;
}

function getParser(): Promise<TSParser> {
  if (!parserPromise) {
    parserPromise = initParser();
  }
  return parserPromise;
}

/**
 * Reset the cached parser promise.  Only used by tests to avoid
 * cross-test pollution or to inject a mock parser.
 */
export function resetParserForTesting(): void {
  parserPromise = null;
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
      if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
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
  tokens: string[],
  config: PatternCommandConfig,
): void {
  const patternPositionals = config.patternPositionals ?? 1;
  let hasExplicitScript = false;
  let positionalsSeen = 0;
  let nextArgAction: "skip" | "extract" | null = null;
  let pastEndOfFlags = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Skip command_name and variable_assignment nodes.
    if (child.type === "command_name" || child.type === "variable_assignment")
      continue;

    // Only process argument-like nodes; recurse into others
    // (e.g. command_substitution) for nested commands.
    if (!ARG_NODE_TYPES.has(child.type)) {
      collectPathCandidateTokens(child, tokens);
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
      if (text === "--") {
        pastEndOfFlags = true;
        continue;
      }
      if (config.argConsumingFlags.has(text)) {
        nextArgAction = "skip";
        if (text === "-e" || text === "-f") {
          hasExplicitScript = true;
        }
        continue;
      }
      if (config.fileConsumingFlags.has(text)) {
        nextArgAction = "extract";
        hasExplicitScript = true;
        continue;
      }
      // Regular flag — skip it.
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
function collectPathCandidateTokens(node: TSNode, tokens: string[]): void {
  if (SKIP_SUBTREE_TYPES.has(node.type)) return;

  // Extract arguments from `command` nodes.
  if (node.type === "command") {
    const commandName = extractCommandName(node);
    const patternConfig = commandName
      ? PATTERN_FIRST_COMMANDS.get(commandName)
      : undefined;

    if (patternConfig) {
      collectPatternCommandTokens(node, tokens, patternConfig);
      return;
    }

    // Generic extraction: collect all arguments (skip command name).
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
      collectPathCandidateTokens(child, tokens);
    }
    return;
  }

  // Extract redirect destinations from `file_redirect` nodes.
  if (node.type === "file_redirect") {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (
        child.type === "word" ||
        child.type === "concatenation" ||
        child.type === "string" ||
        child.type === "raw_string"
      ) {
        tokens.push(resolveNodeText(child));
      }
    }
    return;
  }

  // For all other node types, recurse into children.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    collectPathCandidateTokens(child, tokens);
  }
}

/**
 * URL pattern to skip tokens that look like URLs rather than paths.
 */
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Regex metacharacter sequences that are never found in real filesystem paths.
 * If a token contains any of these, it is almost certainly a regex pattern
 * (e.g. a grep argument) rather than a path.
 */
const REGEX_METACHAR_PATTERN = /\.\*|\.\+|\\\||\\\(|\\\)|\[.*?\]|\^\//;

/**
 * Determines whether a token looks like a path candidate worth resolving.
 * Returns the raw token string if it's a candidate, or null to skip.
 */
function classifyTokenAsPathCandidate(token: string): string | null {
  // Skip empty tokens
  if (!token) return null;

  // Skip flags
  if (token.startsWith("-")) return null;

  // Skip env assignments (FOO=/bar)
  const eqIndex = token.indexOf("=");
  const slashIndex = token.indexOf("/");
  if (eqIndex !== -1 && (slashIndex === -1 || eqIndex < slashIndex)) {
    return null;
  }

  // Skip URLs
  if (URL_PATTERN.test(token)) return null;

  // Skip @scope/package patterns
  if (token.startsWith("@") && !token.startsWith("@/")) return null;

  // Skip bare-slash tokens (// JS comments, lone /, etc.) — they resolve to root
  // and are never meaningful path arguments in practice.
  if (/^\/+$/.test(token)) return null;

  // Skip tokens that contain regex metacharacter sequences — these are almost
  // certainly grep/sed/awk patterns, not filesystem paths.
  // Matches: .*, .+, \|, \(, \), [...], or ^/ (anchored regex starting with /)
  if (REGEX_METACHAR_PATTERN.test(token)) return null;

  // Must look like a path: starts with /, ~/, or contains ..
  if (token.startsWith("/")) return token;
  if (token.startsWith("~/")) return token;
  if (token.includes("..")) return token;

  return null;
}

/**
 * Extracts paths from a bash command string that resolve outside CWD.
 * Uses tree-sitter-bash to parse the command into a full AST, then walks
 * command argument and redirect-destination nodes.  Heredoc bodies, comments,
 * and other non-argument content are skipped, eliminating false positives.
 */
export async function extractExternalPathsFromBashCommand(
  command: string,
  cwd: string,
): Promise<string[]> {
  const parser = await getParser();
  const tree = parser.parse(command);
  if (!tree) return [];

  const tokens: string[] = [];
  try {
    collectPathCandidateTokens(tree.rootNode, tokens);
  } finally {
    tree.delete();
  }

  const seen = new Set<string>();
  const externalPaths: string[] = [];

  for (const token of tokens) {
    const candidate = classifyTokenAsPathCandidate(token);
    if (!candidate) continue;

    const normalized = normalizePathForComparison(candidate, cwd);
    if (!normalized) continue;

    if (
      isPathOutsideWorkingDirectory(candidate, cwd) &&
      !seen.has(normalized)
    ) {
      seen.add(normalized);
      externalPaths.push(normalized);
    }
  }

  return externalPaths;
}
