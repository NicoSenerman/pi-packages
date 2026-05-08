---
name: testing
description: |
  Vitest mock patterns (vi.mock, vi.hoisted, vi.fn reset), TDD planning rules,
  test strategy for permission resolution, and common pitfalls.
  Load when writing or debugging tests.
---

# Testing

Load this skill when writing, debugging, or planning tests.

## Test strategy

- Add focused tests for permission resolution (allow/deny/ask decisions across tools, bash, MCP, skills, special).
- Test wildcard matching (bash patterns, skill globs) including over-match and under-match cases.
- Test policy merge precedence: global → project → per-agent frontmatter.
- Test system-prompt sanitization (denied tools removed, allowed tools preserved, multi-block skill prompts).
- Test the external-directory guard for path-bearing file tools.
- Test config loading, validation issues, and tolerance of deprecated keys.

## Vitest mock patterns

- When using `vi.mock()`, extract each `vi.fn()` stub to a module-scope variable and reset it in `beforeEach` — `vi.restoreAllMocks()` only operates on `vi.spyOn()` spies, not on `vi.fn()` instances.
  Use `.mockReset()` when the stub has no default implementation.
  Use `.mockClear()` when the `vi.mock()` factory provides a default implementation that tests must preserve.
- When a `vi.mock()` factory references a module-scope `vi.fn()` stub, wrap the stub declaration in `vi.hoisted()` — Vitest hoists `vi.mock()` above normal declarations, so unhoisted variables are `undefined` when the factory runs.
- When mocking a class constructor with `vi.mock()`, use `vi.fn()` with no implementation — not `vi.fn(() => ({}))`.
  Arrow-function implementations are not constructable; `new MockClass()` throws `"is not a constructor"`.
- When mocking `node:*` built-in modules with `vi.mock()`, include a `default` key mirroring the named exports — omitting it causes "No default export defined on the mock" errors.
- When testing code that uses `setInterval`, never use `vi.runAllTimersAsync()` — it loops infinitely.
  Use `vi.advanceTimersByTimeAsync(ms)` with a specific duration instead.

## Test assertions

- Prefer a concrete test asserting current (even imperfect) behavior over `test.todo`.
  A real assertion documents the limitation and lets a future fix flip the expectation.
- When a test reveals a pre-existing bug rather than a wrong assumption, use `test.fails` to document the expected behavior and file a GitHub issue.
- Do not insert no-op statements (`void 0;`, unused locals) in tests just to make an `Edit` tool's `oldText` unique — widen `oldText` with surrounding context instead.

## Type checking

Vitest uses esbuild and does not typecheck.
Run `pnpm run build` (`tsc -p tsconfig.json`) for type-only changes.

## Running tests

- Run a single file: `pnpm vitest run <test-path>`
- Run the full suite: `pnpm vitest run`
- When a fix changes shared helper functions, run the full suite before committing — not just the directly affected test file.

## TDD planning rules

- When a TDD step changes behavior, account for existing tests that will break.
  Either fold the test updates into the same step or place a dedicated test-update step immediately before it.
- When a TDD plan lists separate steps that share a type definition, changing that type in step N breaks steps N+1…N+k.
  Either fold them into one step or introduce the new type alongside the old one and migrate callers incrementally.
- When a plan adds a parameter that flows through callback chains, the "Module-Level Changes" section must list every file in the chain.
- When a TDD step changes a shared interface, run `pnpm run build` immediately after that step's commit.
- When adding a field to a shared interface, grep for ALL test files that construct a compatible mock — not just `makeDeps` factories.
- When integrating an unfamiliar library or data structure, write a disposable exploratory script first to inspect the actual runtime shape.
