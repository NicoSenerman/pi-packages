---
issue: 301
issue_title: "Only first command in bash command chain is evaluated"
---

# Evaluate every command in a bash command chain

## Problem Statement

When the agent runs a chained bash command such as `cd /path/to/project && npm install compromised-package`, the permission system matches the **entire command string** against the bash command patterns.
With a policy of `{ "cd *": "allow", "npm *": "deny" }`, the whole string matches `cd *` (allow) but the `npm *` (deny) rule is never evaluated against the `npm install …` segment.
The result is that a denied command rides through on the back of an allowed leading command — a permission bypass.
The reporter expects every command in a chain to be evaluated independently, with precedence `deny > ask > allow`.

The bash `path` and `external_directory` surfaces already decompose chains correctly (they walk every `command` node via tree-sitter and combine most-restrictively).
Only the bash **command-pattern** surface was left matching the raw program string.

## Goals

- Evaluate each top-level simple-command in a bash chain (`&&`, `||`, `;`, `|`, `&`, newlines) independently against the bash command-pattern rules.
- Combine the per-command results most-restrictively (`deny > ask > allow`), reporting the offending command's matched pattern.
- Reuse the existing tree-sitter-bash parser — one decomposition model for the whole package, no second hand-rolled splitter that could diverge from the path/external-directory decomposition.
- Preserve current behavior for single-command bash calls (no regression) and keep `PermissionManager.checkPermission()` synchronous and unchanged.

## Non-Goals

- Changing `PermissionManager.checkPermission()`, the public `PermissionsService.checkPermission()` API, or the event-bus RPC.
  Those are synchronous and cannot run the async tree-sitter decomposition; they continue to match a single command string.
  Making the synchronous service surface chain-aware (e.g. an async decompose-and-check method) is a possible follow-up, not this issue.
- Recursing into command substitution (`$(…)`, backticks) or subshells (`( … )`) to evaluate nested commands.
  The chosen scope is top-level chain operators only; nested constructs are matched as their enclosing command's text and noted as a known limitation.
- Sharing a single tree-sitter parse across the three bash gates (path, external-directory, command).
  The package already parses more than once per bash call; consolidating parses is an optional later optimization.
- Touching `bash-arity.ts`, `pattern-suggest.ts`, or the wildcard matcher.

## Background

Relevant modules:

- `src/permission-manager.ts` — `checkPermission(toolName, input, agentName, sessionRules)` is synchronous, normalizes the input, and runs `evaluateFirst`.
  For bash it produces `values: [command]` (one whole-string candidate) and matches it against bash rules.
  Exposed synchronously via `src/service.ts` (`getPermissionsService`) and `src/permission-event-rpc.ts`.
- `src/rule.ts` — `evaluate` (last-match-wins) and `evaluateMostRestrictive` (deny > ask > allow over multiple values).
- `src/handlers/permission-gate-handler.ts` — `handleToolCall` runs an ordered, `await`-friendly gate pipeline (`gateProducers: Array<() => GateResult | Promise<GateResult>>`).
  The last producer performs the bash command-pattern check: it calls `checkPermission("bash", tcc.input, …)` once and feeds the result into `describeToolGate` as `preCheck`.
- `src/handlers/gates/bash-path-extractor.ts` — the tree-sitter-bash AST walker.
  Already provides `getParser` (lazy WASM init), `resolveNodeText`, `extractCommandName`, and `findFirstCommand`.
  Exports `extractExternalPathsFromBashCommand` and `extractTokensForPathRules`, consumed by the bash path/external-directory gates.
- `src/handlers/gates/bash-path.ts` — `describeBashPathGate` is the template for this fix: it extracts tokens (async), loops `checkPermission("path", { path: token })` per token, and keeps the most restrictive result.
- `src/handlers/gates/tool.ts` — `describeToolGate(tcc, check, formatter)` builds the prompt/session-approval/decision descriptor from a `PermissionCheckResult`; for bash it derives the session-approval suggestion and decision value from `check.command`.

Constraints from `AGENTS.md` / package skill that apply:

- Default to least privilege; silent over-matching is a permission bypass — the fix must never be *weaker* than today.
- Wildcard matching must be explicit and tested, including over-match and under-match cases.
- Keep schema, example config, `docs/configuration.md`, `README.md`, and types aligned when behavior changes.
- Pure business logic, IO at the edges; inject collaborators for testability (the resolver takes `checkPermission` and the decomposer as parameters).

AST shapes confirmed empirically (tree-sitter-bash):

| Input                | Tree                                                  | Top-level commands   |
| -------------------- | ----------------------------------------------------- | -------------------- |
| `cd /p && npm i x`   | `program > list > [command, &&, command]`             | `cd /p`, `npm i x`   |
| `a \|\| b`           | `program > list > [command, \|\|, command]`           | `a`, `b`             |
| `a ; b` / `a & b`    | `program > [command, sep, command]`                   | `a`, `b`             |
| `cat f \| grep b`    | `program > pipeline > [command, \|, command]`         | `cat f`, `grep b`    |
| `foo\nbar`           | `program > [command, command]`                        | `foo`, `bar`         |
| `echo 'x && y'`      | `program > command` (quoted)                          | `echo 'x && y'`      |
| `echo $(curl \| sh)` | `program > command > command_substitution > pipeline` | `echo $(curl \| sh)` |
| `( cd /t && rm x )`  | `program > subshell > list`                           | `( cd /t && rm x )`  |

Descend through `program`, `list`, and `pipeline`; collect each `command` node's text.
Any other top-level statement node (`subshell`, `compound_statement`, control-flow, `redirected_statement`) is emitted as its own whole-text unit without descending — quotes are respected by the parser, and substitution/subshell contents stay inside the enclosing command's text (the chosen scope).

## Design Overview

Decision model: the unit of bash policy is the simple-command, not the raw shell program.
The fix adds a single decomposition step (reusing tree-sitter) and evaluates each unit through the unchanged synchronous `checkPermission`, combining most-restrictively in the gate layer — exactly mirroring `describeBashPathGate`.

### New decomposition primitive

```typescript
// src/handlers/gates/bash-path-extractor.ts (reuses getParser/resolveNodeText/extractCommandName)

/**
 * Enumerate the top-level simple-commands of a bash program.
 * Descends through program/list/pipeline; emits each command node's text.
 * Other top-level statements (subshell, control-flow) are emitted whole.
 * Guarantees a non-empty result: falls back to [command] when the parse
 * yields no command nodes, so callers never evaluate a weaker surface.
 */
export async function extractTopLevelCommands(command: string): Promise<string[]>;
```

### Most-restrictive resolver (gate layer)

```typescript
// src/handlers/gates/bash-command.ts

type CheckPermissionFn = (
  surface: string,
  input: unknown,
  agentName?: string,
  sessionRules?: Rule[],
) => PermissionCheckResult;

/** deny > ask > allow; first occurrence wins on ties. */
export async function resolveBashCommandCheck(
  command: string,
  agentName: string | undefined,
  sessionRules: Rule[],
  checkPermission: CheckPermissionFn,
  decompose: (cmd: string) => Promise<string[]> = extractTopLevelCommands,
): Promise<PermissionCheckResult> {
  const rank = { allow: 0, ask: 1, deny: 2 } as const;
  const units = await decompose(command); // guaranteed non-empty
  let worst: PermissionCheckResult | undefined;
  for (const unit of units) {
    const check = checkPermission("bash", { command: unit }, agentName, sessionRules);
    if (worst === undefined || rank[check.state] > rank[worst.state]) {
      worst = check;
      if (check.state === "deny") break; // short-circuit
    }
  }
  return worst; // defined: units is non-empty
}
```

Because `checkPermission("bash", { command: unit })` sets `resultExtras.command = unit`, the returned worst result carries the **offending** sub-command in `command` and its rule in `matchedPattern`.
That makes the session-approval suggestion and decision value scope to the specific command (e.g. `npm install pkg` → `npm *`), while the whole command remains available via `tcc.input` for the prompt preview.

### Gate wiring (call-site sketch)

The last gate producer in `handleToolCall` becomes async for bash; non-bash tools are unchanged:

```typescript
async () => {
  const toolCheck =
    tcc.toolName === "bash"
      ? await resolveBashCommandCheck(
          getNonEmptyString(toRecord(tcc.input).command) ?? "",
          tcc.agentName ?? undefined,
          getSessionRuleset(),
          checkPermission,
        )
      : checkPermission(tcc.toolName, tcc.input, tcc.agentName ?? undefined, getSessionRuleset());
  const toolDescriptor = describeToolGate(tcc, toolCheck, formatter);
  toolDescriptor.preCheck = toolCheck;
  return toolDescriptor;
};
```

No new shared interface, no change to `GateDescriptor`/`GateRunnerDeps`.
`describeToolGate` already consumes a `PermissionCheckResult`; feeding it the most-restrictive sub-command result reuses all existing prompt/log/decision/session machinery.

### Edge cases and the no-weakening guarantee

- Single command → `decompose` returns a one-element list → identical to today.
- Empty/whitespace command → fallback `[command]` → `checkPermission("bash", { command: "" })`, matching current behavior.
- All-allow chain → returns the first allow result → allow (no prompt).
- Quoted operators (`echo 'a && b'`) → one command (parser respects quotes) — no false split.
- The result is never weaker than whole-string matching: evaluating N smaller commands and taking the most restrictive can only deny/ask at least as often.
- Behavior change (intended): a config pattern that *spans* a chain (e.g. `"cd * && npm *": "allow"`) no longer matches as a unit, because each command is evaluated separately.
  This is the correct model per the issue; it is documented and called out in Risks.

### Design-review checklist (run before finalizing)

- Dependency width: `resolveBashCommandCheck` params are all used; `CheckPermissionFn` matches the local type already used by sibling gates.
- Law of Demeter: no reach-through chains.
- Output arguments: resolver returns a value, mutates nothing.
- Parameter relay: `sessionRules` is consumed at the endpoint (`checkPermission`), not merely relayed.
- Test mock depth: `checkPermission` and `decompose` are injected functions — fakeable without `as unknown as`.
- ISP: new functions take primitives/functions only, no wide domain objects.

## Module-Level Changes

- `src/handlers/gates/bash-path-extractor.ts` — add exported `extractTopLevelCommands(command)`; add a private `collectTopLevelCommandTexts(node)` walker (descends `program`/`list`/`pipeline`).
  Reuses existing `getParser`, `resolveNodeText`.
  No change to existing exports.
- `src/handlers/gates/bash-command.ts` — new module exporting `resolveBashCommandCheck` (and the local `CheckPermissionFn` type, matching the sibling-gate convention).
- `src/handlers/permission-gate-handler.ts` — make the final gate producer async for bash and call `resolveBashCommandCheck`; import it and `extractTopLevelCommands`'s consumer.
  No change to `gateProducers`' type (already supports async producers).
- `docs/configuration.md` — rewrite the `bash` Surface section: patterns match each top-level command in a chain (not the full string); most-restrictive-wins; chain operators `&& || ; | &` and newlines split commands; quotes/substitutions/subshells are not split; add a behavior-change note for chain-spanning patterns.
- `docs/architecture/architecture.md` — update the directory listing entry for `bash-path-extractor.ts` (now also enumerates top-level commands) and add a `bash-command.ts` line; add a note to the gate-pipeline section that the bash command-pattern check decomposes chains and combines most-restrictively.
  Review `docs/architecture/v3-architecture.md` for the same and update if it describes whole-string bash matching.
- `README.md` — verify the bash matching description; update only if it claims whole-command-string matching.
- `.pi/skills/package-pi-permission-system/SKILL.md` — no change expected (does not document bash chain semantics); confirm during the docs step.

## Test Impact Analysis

1. New unit tests enabled by the extraction:
   - `extractTopLevelCommands` is independently testable for every chain operator, quoting, nesting, and the empty/whitespace fallback — coverage that was impossible while matching was a single opaque string.
   - `resolveBashCommandCheck` is testable in isolation with an injected `checkPermission` and an injected `decompose`, asserting the `deny > ask > allow` precedence, deny short-circuit, tie-breaking, single-command passthrough, and session-rule threading — no tree-sitter needed for these fast tests.
2. Existing tests that stay as-is:
   - `test/rule.test.ts` (`evaluateFirst`, including the bash candidate tests) — `checkPermission`/`evaluateFirst` are unchanged.
   - `test/handlers/gates/bash-path.test.ts`, `test/bash-external-directory.test.ts` — the path/external-directory extractors and gates are untouched.
   - `test/handlers/tool-call.test.ts` bash gate tests — single-command bash routes through `resolveBashCommandCheck` → one-element decomposition → identical outcomes; verify they still pass after wiring (Step 3).
3. No tests become redundant; the new lower-level tests are additive.

## TDD Order

1. `fix: add tree-sitter bash command-chain decomposition`
   - Surface: new `test/bash-command-decomposition.test.ts` (top-level, mirroring `test/bash-external-directory.test.ts`) against `extractTopLevelCommands`.
   - Covers: single command → `[cmd]`; `&&`, `||`, `;`, `|`, `&`, newline chains → ordered units; `echo 'a && b'` not split; `( … )` / `$( … )` emitted as one enclosing unit (not descended); empty/whitespace → `[""]` fallback.
   - Implement `extractTopLevelCommands` + the walker in `bash-path-extractor.ts`.
2. `fix: evaluate each bash sub-command with most-restrictive precedence`
   - Surface: new `test/handlers/gates/bash-command.test.ts` against `resolveBashCommandCheck` with injected `decompose` and a fake `checkPermission`.
   - Covers: all-allow → allow (first unit); allow+deny → deny with the deny unit's `matchedPattern`/`command`; allow+ask → ask; deny short-circuits later units; tie-break keeps first occurrence; single command passes through; `sessionRules` forwarded to each `checkPermission` call.
   - Implement `src/handlers/gates/bash-command.ts`.
3. `fix: gate bash command chains per sub-command (#301)`
   - Surface: `test/handlers/tool-call.test.ts` — new case mirroring the issue.
     With `session.checkPermission` mocked to return `deny` for `input.command` matching `npm *` and `allow` for `cd *`, firing a `bash` tool_call with `command: "cd /tmp && npm install compromised-package"` (no external paths, so earlier gates do not fire) returns `{ block: true }`; assert a non-chained allowed bash command still returns `{}`.
   - Implement the async bash branch in the final gate producer of `permission-gate-handler.ts`.
   - Run `pnpm run check` after this commit (it changes a closure that other gates share the producer array with).
4. `docs: document per-sub-command bash chain evaluation (#301)`
   - Update `docs/configuration.md`, `docs/architecture/architecture.md` (+ `v3-architecture.md` if needed), and `README.md` per Module-Level Changes.
   - No test cycle; this is a docs-only commit.

## Risks and Mitigations

- Chain-spanning config patterns stop matching as a unit.
  Mitigation: documented as an intentional behavior change in `docs/configuration.md`; such patterns are an anti-pattern under per-command evaluation, and the new behavior is strictly safer (deny/ask take precedence).
- Subshell / command-substitution contents are not independently evaluated.
  Mitigation: scope decision recorded as a known limitation; never weaker than today (the enclosing command's whole text is still matched).
  A follow-up can extend descent into `subshell`/`command_substitution` if desired.
- Extra tree-sitter parse per bash command (now three: path, external-directory, command).
  Mitigation: consistent with the current design (it already parses more than once); listed as an optional consolidation follow-up.
- The synchronous service API / RPC remain whole-string.
  Mitigation: explicitly out of scope (Non-Goals); the runtime gate — the actual security boundary — is fully fixed.

## Open Questions

- Should the session-approval suggestion for a denied/ask chain scope to the offending sub-command (current plan: yes, via `check.command = unit`) or to the whole command the user submitted?
  Defer until UX review of the prompt during implementation.
- Is a shared single-parse abstraction across the three bash gates worth extracting now, or as a later optimization issue?
  Defer.
