---
name: testing
description: |
  Vitest mock patterns (vi.mock, vi.hoisted, vi.fn reset), TDD planning rules,
  and general test strategy. Load when writing or debugging tests.
---

# Testing

Load this skill when writing, debugging, or planning tests.

## Vitest mock patterns

- When using `vi.mock()`, extract each `vi.fn()` stub to a module-scope variable and reset it in `beforeEach` — `vi.restoreAllMocks()` only operates on `vi.spyOn()` spies, not on `vi.fn()` instances.
  Use `.mockReset()` when the stub has no default implementation.
  Use `.mockClear()` when the `vi.mock()` factory provides a default implementation that tests must preserve.
- When a `vi.mock()` factory references a module-scope `vi.fn()` stub, wrap the stub declaration in `vi.hoisted()` — Vitest hoists `vi.mock()` above normal declarations, so unhoisted variables are `undefined` when the factory runs.
- When a `vi.fn()` factory returns an empty array or narrow literal, annotate its return type explicitly — `vi.fn((): string[] => [])`, not `vi.fn(() => [])`.
  Without the annotation TypeScript infers `never[]`, and subsequent `mockReturnValueOnce([...])` calls fail with “not assignable to `never`”.
  Use `import type` to pull domain types (e.g., `AgentConfig`, `PreloadedSkill`) for the annotation.
- When typing a mock field on an interface, use `Mock<specific-signature>` — e.g., `Mock<() => void>`, `Mock<(arg: string) => Promise<void>>`.
  Do not use `ReturnType<typeof vi.fn>` — in Vitest v4 it expands to `Mock<Procedure | Constructable>`, a union that TypeScript cannot call.
- When mocking a class constructor with `vi.mock()`, use `vi.fn()` with no implementation — not `vi.fn(() => ({}))`.
  Arrow-function implementations are not constructable; `new MockClass()` throws `"is not a constructor"`.
- When mocking `node:*` built-in modules with `vi.mock()`, include a `default` key mirroring the named exports — omitting it causes "No default export defined on the mock" errors.
- When testing code that uses `setInterval`, never use `vi.runAllTimersAsync()` — it loops infinitely.
  Use `vi.advanceTimersByTimeAsync(ms)` with a specific duration instead.
- When a test factory returns an object satisfying a production interface (e.g., `RunnerIO`, `AssemblerIO`), do not annotate the return type with that interface — the annotation erases `Mock<...>` methods (`mockResolvedValue`, `mock.calls`, etc.) from the inferred type.
  Leave the return type unannotated so callers retain full mock access.
- When a test factory accepts overrides via `Partial<ProductionInterface>`, the spread `{ ...defaults, ...overrides }` creates a union type that also erases mock methods.
  Either remove the `Partial<ProductionInterface>` annotation (let TypeScript infer from the spread) or drop the overrides parameter and configure mocks on the returned object directly.
- Prefer reading `process.env` inside functions rather than capturing it as a module-level constant — `vi.stubEnv()` alone cannot change a constant already evaluated at import time.
  If a module-level constant is unavoidable, test it with `vi.resetModules()` + `await import(...)` inside the test body, and call `vi.unstubAllEnvs()` + `vi.resetModules()` in `afterEach`.

## Test assertions

- Prefer strong assertions that match the **entire** expected value (`toBe`, `toEqual`) over subset matchers (`toContain`, `toMatchObject`, `expect.objectContaining`).
  Weak assertions hide unexpected values and make tests less useful as documentation.
  When a weak assertion is necessary (third-party output, non-deterministic ordering), add a comment explaining why.
- Prefer a concrete test asserting current (even imperfect) behavior over `test.todo`.
  A real assertion documents the limitation and lets a future fix flip the expectation.
- When a test reveals a pre-existing bug rather than a wrong assumption, use `test.fails` to document the expected behavior and file a GitHub issue.
- Do not insert no-op statements (`void 0;`, unused locals) in tests just to make an `Edit` tool's `oldText` unique — widen `oldText` with surrounding context instead.

## Type checking

Vitest uses esbuild and does not typecheck.
Run `pnpm run check` (`tsc --noEmit`) for type-only changes.

## Running tests

- Run a single file: `pnpm vitest run <test-path>`
- Run the full suite: `pnpm vitest run`
- When a fix changes shared helper functions, run the full suite before committing — not just the directly affected test file.

## Operator semantics

- When `prefer-nullish-coalescing` flags `||`, check whether the left side could be a falsy non-null value (`""`, `0`, `false`) that the code intentionally converts to the fallback.
  If so, keep `||` and add `// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- || intentional: converts falsy values to fallback`.
  Do not mechanically replace `||` with `??` without verifying test expectations.

## TDD planning rules

- When a TDD step changes behavior, account for existing tests that will break.
  Either fold the test updates into the same step or place a dedicated test-update step immediately before it.
- When a TDD plan lists separate steps that share a type definition, changing that type in step N breaks steps N+1…N+k.
  Either fold them into one step or introduce the new type alongside the old one and migrate callers incrementally.
- When a plan adds a parameter that flows through callback chains, the "Module-Level Changes" section must list every file in the chain.
- When a TDD step changes a shared interface, run `pnpm run check` immediately after that step's commit.
- When a TDD step changes an interface that has a single call site (e.g., a deps bag constructed in `index.ts`), the step must include updating that call site — the type checker will not allow the interface change and the call-site update to land in separate commits.
- When adding a field to a shared interface, grep for ALL test files that construct a compatible mock — not just factory helpers.
- When removing fields from a shared init type, grep for all test files and factory helpers that pass the removed field — esbuild won't reject unknown properties at runtime, so tests silently get wrong default values instead of failing.
- When a TDD plan deletes a module across multiple steps (extract → remove consumers → delete), account for the doomed module's own imports at each intermediate step.
  If step N removes a type or function that the doomed module still imports, either delete the module in the same step or patch its imports to compile cleanly.
- When a TDD plan nests a previously-flat interface (e.g., splitting `Config` into `{ identity, execution }`), grep test factories for `Partial<OldInterface>` spread patterns.
  Top-level `...overrides` does not deep-merge — flat-key overrides like `{ description: "my task" }` silently become no-ops when the field moves into a nested sub-object.
  Either replace each call site with the full nested sub-object or switch to a deep-merge helper.
- When a TDD plan converts an interface to a class, grep for `{ ...variable` spread patterns in tests — spreading a class instance produces a plain object that lacks the class's methods and private fields.
  Replace with `createTestX({ ...overrides })` factory calls or direct field mutation.
- When integrating an unfamiliar library or data structure, write a disposable exploratory script first to inspect the actual runtime shape.
- When consolidating duplicate test factories into a shared helper, diff the default values across all copies before writing the shared factory.
  Different defaults cause cascading assertion failures during migration steps.
- When a TDD plan extracts a locally-declared type that shadows an SDK type, verify whether the SDK exports the type before planning around the local copy.
  Dead fallback branches in the local type produce dead test cases and unnecessary complexity.
