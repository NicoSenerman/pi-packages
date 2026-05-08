---
issue: 22
issue_title: "Depend on @earendil-works/pi-coding-agent for runtime types instead of duck-typing"
---

# Plan: Adopt `@earendil-works/pi-coding-agent` Types (Issue #22)

## Problem Statement

`src/extension.ts` declares the entire Pi runtime API surface as duck-typed `*Like` aliases (`ExtensionApiLike`, `ExtensionContextLike`, `ExtensionUILike`, `ToolResultEventLike`, `ToolCallEventLike`, `TextContentLike`, `ThemeColorName`).
Pi already publishes the real shapes via `@earendil-works/pi-coding-agent`, but we have no Pi dependency in `package.json`, so the duck-typed surface is what TypeScript checks against.

That looseness shipped a real bug: our `theme?: { fg(...): string }` shape happily accepted plain arrow-function stubs in tests, which hid the `this`-binding regression in `themed()` for an entire release cycle until a user surfaced it (retro `0016`, fixes `6a6ec16` / `6ba7576`).
Anchoring against Pi's real types — especially the `Theme` class — would have caught the bug at compile time.

This is a typing-only refactor: no behavior change, no public-config change, no schema change.

## Goals

- Add `@earendil-works/pi-coding-agent@^0.72.0` to `devDependencies` (types-only; Pi loads us at runtime).
- Replace every `*Like` alias in `src/extension.ts` with the corresponding real export from `@earendil-works/pi-coding-agent`.
- Type the public entrypoint and `pi.on(...)` handlers with the real `ExtensionAPI`, `ExtensionContext`, `ToolCallEvent`, and `ToolResultEvent` so a class-based `Theme` substitute is required at the boundary.
- Update test stubs (`test/extension.test.ts`, others as needed) so they compile against the real types and continue to exercise the behavior we already cover.
- Keep the diff zero-runtime-weight: no `dependencies`, no new imports of values from `@earendil-works/pi-coding-agent` (types only).

This change is **not** breaking from the consumer's perspective — Pi already injects these shapes at runtime.
It is, however, a build-time tightening: a future incompatible Pi release will fail our build until the dep is bumped.

## Non-Goals

- Adding `@earendil-works/pi-coding-agent` to `dependencies` or `peerDependencies`.
  Pi is the loader, not a consumer of our package.
- Behavior changes to formatter dispatch, status reporting, or config loading.
- Touching `src/config-loader.ts`, `src/formatter-config.ts`, `src/prompt-autoformatter.ts`, etc. — none of them reference the Pi runtime API.
- Pinning Pi tighter than the issue suggests; `^0.72.0` stays.
- Updating `schemas/pi-autoformat.schema.json`, `docs/configuration.md`, `README.md`, or `docs/plans/`.
  None reference the duck-typed shapes.
- Adopting Pi's `isBashToolResult` / `isEditToolResult` / `isWriteToolResult` type guards as the dispatch mechanism.
  Our existing `toolName === "bash"` / `"edit"` / `"write"` string checks are equivalent and out of scope; introducing new dispatch utilities is a separate change.

## Background

Relevant pieces in this repo:

- `src/extension.ts` declares (around lines 35–100):
  - `NotificationType` — kept (it's our own narrow alias for the literal union, not duck-typing).
  - `ThemeColorName` — superseded by `ThemeColor` (re-exported from Pi's main entrypoint).
  - `ExtensionUILike` — superseded by `ExtensionUIContext`.
  - `ExtensionContextLike` — superseded by `ExtensionContext`.
  - `TextContentLike` — Pi exports `TextContent` (and `ToolResultEventBase.content` is `(TextContent | ImageContent)[]`).
  - `ToolCallEventLike` / `ToolResultEventLike` — Pi exports `ToolCallEvent` / `ToolResultEvent` as discriminated unions over `toolName`.
  - `ExtensionApiLike` — Pi exports `ExtensionAPI`. Note Pi's `events` channel is **not** part of `ExtensionAPI` today; we currently piggyback via an optional `events?` property.
- `src/extension.ts` uses internal helpers (`setAutoformatStatus`, `reportMessage`, `formatStatusLine`, `defaultReportFlushResult`, `subscribeToEventBus`, `runFormatter`, …) that read only `ctx.cwd`, `ctx.hasUI`, `ctx.ui.notify`, `ctx.ui.setStatus`, and `ctx.ui.theme`.
- `test/extension.test.ts` builds lightweight `TestContext` objects with exactly those fields plus a `theme.fg` stub.
  Real `ExtensionContext` requires `sessionManager`, `modelRegistry`, `model`, `signal`, `isIdle()`, `abort()`, `hasPendingMessages()`, `shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()` — none of which our extension touches.
- `test/extension.test.ts` already has one `class StubTheme` (the regression test for `6a6ec16`) that demonstrates the class-based stub pattern.

Pi's exports we will pull in (all `import type`, all from the main `@earendil-works/pi-coding-agent` entrypoint):

- `ExtensionAPI`
- `ExtensionContext`
- `ExtensionUIContext`
- `ToolCallEvent`
- `ToolResultEvent`
- `TextContent`
- `Theme`, `ThemeColor`

## Design Overview

### Boundary policy (decided via `ask-user`)

The public entrypoint `autoformatExtension(pi: ExtensionAPI)` and every `pi.on(...)` handler use **real** Pi types.
That alone is enough to force test stubs to substitute a real `Theme` (or class-based equivalent) for `ctx.ui.theme`, which is the property that hid the regression.

Internal helpers narrow their `ctx` parameter to the subset they actually consume:

```typescript
type AutoformatExtensionContext = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;
```

This keeps test setup cheap (no need to fabricate `sessionManager`, `modelRegistry`, etc.) while still anchoring `ui` to Pi's real `ExtensionUIContext`.
A handler registered through `pi.on("agent_end", handler)` receives a full `ExtensionContext`; passing it to `setAutoformatStatus(ctx)` is a structural-narrowing pass-through, not a cast.

### Event-bus channel

Our optional `pi.events?.on(...)` access is **not** part of Pi's `ExtensionAPI` today.
We preserve the runtime feature by extending the locally-imported `ExtensionAPI` with an optional `events` member through intersection at the `subscribeToEventBus` call site, not by re-declaring the whole API:

```typescript
type ExtensionAPIWithEvents = ExtensionAPI & {
  events?: {
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
};
```

This is the only documented place where we widen Pi's surface.
If/when Pi adds `events` to `ExtensionAPI` proper, deleting this alias is a one-line change.

### Tool-event handling

`ToolResultEvent` is a discriminated union (`BashToolResultEvent | EditToolResultEvent | WriteToolResultEvent | …`).
Our existing dispatch already keys on `event.toolName === "bash" | "edit" | "write" | "custom_*"`, which TypeScript narrows naturally — no new type guards required.
`event.content` is typed `(TextContent | ImageContent)[]`; `extractToolOutputText` already filters by `typeof item.text === "string"`, which works unchanged for both branches.

### Test stubs

`test/extension.test.ts` `TestContext` and `createContext` change:

- `TestContext` becomes `Pick<ExtensionContext, "cwd" | "hasUI"> & { ui: Pick<ExtensionUIContext, "notify" | "setStatus"> & { theme?: Theme } }` (minimal surface required by the helpers under test).
- `createContext`'s default `theme` becomes a single shared class-based stub (`StubTheme` from the existing regression test, hoisted to a test util) so plain-arrow-function themes are not accepted anywhere.
- `TestPi.on` is typed as `ExtensionAPI["on"]`; callers narrow per event name.
- `TestPi.events` is typed against the local `ExtensionAPIWithEvents["events"]`.

### Edge cases

- **`ctx.ui.theme` is optional in Pi's types.** All call sites already null-check it; no behavior change.
- **Tests that emit synthetic tool events** currently build object literals matching `ToolResultEventLike`. Real `ToolResultEvent`'s discriminated branches require concrete `details` and full `content` typing.
  We satisfy them with `as ToolResultEvent` casts at the test boundary (the events do not originate from real Pi at runtime in tests, and the cast is one-place per emit), or — preferred — `satisfies` checks against `Partial<BashToolResultEvent>` etc. where the field set is already complete.
  Choose the lighter option per call site; the goal is "tests still compile and still cover the same paths."

## Module-Level Changes

### `package.json`

- Add `"@earendil-works/pi-coding-agent": "^0.72.0"` to `devDependencies`.
- No other field changes.

### `src/extension.ts`

- Remove `ThemeColorName`, `ExtensionUILike`, `ExtensionContextLike`, `TextContentLike`, `ToolResultEventLike`, `ToolCallEventLike` (~25 lines).
- Add `import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ToolCallEvent, ToolResultEvent, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";` (only the symbols actually referenced).
- Introduce local narrow aliases:
  - `type AutoformatExtensionContext = Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;`
  - `type ExtensionAPIWithEvents = ExtensionAPI & { events?: { on(channel: string, handler: (data: unknown) => void): () => void } };`
- Replace `ExtensionApiLike` with `ExtensionAPI` at the public entrypoint, and `ExtensionAPIWithEvents` only at `subscribeToEventBus`.
- Replace `ExtensionContextLike` with `AutoformatExtensionContext` on internal helpers; the top-level `pi.on(...)` handlers receive the real `ExtensionContext`.
- Replace `ThemeColorName` parameter types with `ThemeColor`.
- Re-export `ExtensionApiLike` is removed (`export type { ExtensionApiLike }`); replace with `export type { ExtensionAPI }` re-export from Pi if any consumer needs it. (Internal-only today; verify with a `rg` before deleting.)

### `test/extension.test.ts`

- Drop the local `Handler`, `EventName`, `TestContext` definitions in favor of:
  - `EventName` keyed on Pi's `ExtensionEvent` literal subset we use.
  - `TestContext` narrowed via `Pick<ExtensionContext, ...>` (see Design).
- Hoist `StubTheme` to module scope and reuse it as the default `createContext` theme.
- Replace remaining `theme: { fg: (_name, text) => text }` literals with `theme: new StubTheme()`.
- Cast or `satisfies`-check synthetic events against `ToolResultEvent` / `ToolCallEvent` at emit sites.
- Update the `import type { ExtensionApiLike }` line to whatever the new export name is (if exported).

### `test/acceptance.test.ts`

- Audit for any duck-typed shape; today it does not reference `*Like` aliases (`grep` returned no hits), so the change is likely no-op.
  Re-check after `src/extension.ts` lands.

### Other tests

- `rg -l "Like\b" test/` to be sure nothing else duck-types Pi shapes.
  Update if found.

### Docs

- No changes to `docs/configuration.md`, `README.md`, `schemas/pi-autoformat.schema.json` (verified — none reference the duck-typed shapes).

## TDD Order

This is a typing-only refactor, so the "red" step is **a failing `tsc`/`vitest` typecheck**, not a failing runtime assertion.
Every cycle ends with `pnpm test` and `pnpm exec tsc --noEmit` (or whatever typecheck script lands as part of step 1).

1. **chore: add `@earendil-works/pi-coding-agent` devDependency.** Install via `pnpm add -D @earendil-works/pi-coding-agent@^0.72.0`. Verify `pnpm test` still passes (no source changes yet). Commit: `chore: add pi-coding-agent for runtime types`.

2. **test: prove a plain-function `theme.fg` stub will fail to typecheck once we adopt real types.** Add a single isolated typecheck-only test (e.g. `test/types/theme-stub.test-d.ts` using `expectTypeOf` or a `// @ts-expect-error` block in a new TS file under `test/`) that asserts `{ fg: (_n, t) => t }` is **not** assignable to `Theme`.
   This is currently `// @ts-expect-error` against the duck type (so it red-flags) — it goes green in step 4. Commit: `test: pin Theme stub-shape expectations`.

3. **feat: replace `*Like` aliases in `src/extension.ts` with real Pi types.** Import real types, introduce `AutoformatExtensionContext` and `ExtensionAPIWithEvents`, swap every signature.
   Tests will fail to compile here; that's expected.
   Do **not** touch test files yet — this commit captures the boundary-changing diff in isolation.
   *(Tip: temporarily skip `pnpm test` in this commit if needed; mark in commit body. Or fold steps 3+4 into one commit if a half-broken intermediate offends — author's call.)* Commit: `refactor: import Pi types from pi-coding-agent`.

4. **test: update test stubs to satisfy real Pi types.** Hoist `StubTheme`, narrow `TestContext`, cast synthetic events, etc.
   `pnpm test` and typecheck both green. Step 2's expectation flips from `@ts-expect-error` to a positive assertion. Commit: `test: adopt class-based Theme stubs and Pi event types`.

5. **chore: verify lint / docs alignment.** Run `pnpm run lint` and `pnpm run lint:md`. No expected changes; confirm `schemas/pi-autoformat.schema.json`, `docs/configuration.md`, `README.md` untouched. If any drift, address in a single follow-up commit. Commit (only if needed): `docs: align after Pi types adoption`.

If steps 3 and 4 must be merged to keep CI green at every commit, do so and label the merged commit `refactor: adopt pi-coding-agent types` — but prefer the split when feasible because the test-stub diff is mechanical and noisy.

## Risks and Mitigations

- **Risk: future Pi release breaks our build.** Mitigation: `^0.72.0` range + Renovate/Dependabot bump.
  Build-time breakage is the desired tradeoff vs the runtime bug we just shipped.
- **Risk: real `ExtensionContext` requires fields we never use, churning every test stub.** Mitigation: narrow internal helpers to `Pick<ExtensionContext, "cwd" | "hasUI" | "ui">` (decision recorded above).
- **Risk: discriminated-union `ToolResultEvent` rejects our synthetic test events.** Mitigation: cast at emit sites; the test-side narrowing has no production value beyond "compiles."
- **Risk: `pi.events` is not in Pi's `ExtensionAPI`, so the real type loses the channel we depend on.** Mitigation: local `ExtensionAPIWithEvents` intersection alias, scoped to `subscribeToEventBus`, with a TODO comment to delete once Pi exposes it natively.
- **Risk: `export type { ExtensionApiLike }` is re-exported and consumed downstream.** Mitigation: `rg "ExtensionApiLike"` before deletion; if external consumers exist (none expected — this is an extension package), preserve as a deprecated alias for one release.
- **Risk: pnpm install pulls a large transitive tree.** Mitigation: it's a `devDependency`, not shipped; verify with `pnpm why`.

## Open Questions

- Should we adopt Pi's `isBashToolResult` / `isEditToolResult` / `isWriteToolResult` type guards in `src/extension.ts` instead of `event.toolName === "..."` string checks? Out of scope for this plan; revisit if the dispatch grows or a guard would simplify a future change.
- Should the local `ExtensionAPIWithEvents` alias migrate into a shared `src/pi-types.ts` module if other modules ever need it? Defer — only one call site uses it today.
- Should we narrow `TextContent` further (e.g. require `type === "text"`)? Defer — the existing runtime check on `typeof item.text === "string"` is already the contract; tightening the type adds no value.
