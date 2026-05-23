---
issue: 146
issue_title: "Narrow UI context for menu handlers (Phase 9, Step N)"
---

# Narrow UI context for menu handlers

## Problem Statement

Menu handler functions (`showAgentsMenu`, `showAgentDetail`, `showCreateWizard`, etc.) declare `ctx: ExtensionContext` but only call `ctx.ui.select/confirm/input/notify/editor/custom` and `ctx.modelRegistry`.
This forces 42 `ctx as any` casts across 3 test files (`agent-menu.test.ts`: 8, `agent-config-editor.test.ts`: 20, `agent-creation-wizard.test.ts`: 14) because tests cannot construct a full `ExtensionContext`.

## Goals

- Define a `MenuUI` interface with the subset of `ctx.ui` methods that menu handlers actually use (`select`, `confirm`, `input`, `notify`, `editor`, `custom`).
- Menu handler functions accept `MenuUI` (plus `modelRegistry` passed separately) instead of `ExtensionContext`.
- `index.ts` handler registration extracts `ctx.ui` and `ctx.modelRegistry` from the SDK `ExtensionContext`.
- Change `WizardManager.spawnAndWait` to accept `ParentSnapshot` (introduced by #145) instead of `ExtensionContext`.
- Apply dependency bag convention: dissolve ≤4-field deps into plain parameters; keep ≥5-field interfaces but destructure in signature.
- Eliminate all 42 `ctx as any` casts from menu, editor, and wizard test files.

## Non-Goals

- Changing the behavior of `ctx.ui.custom` — pass-through only.
- Narrowing `ExtensionContext` usage in `index.ts` closures (the `as any` casts for `runtime.currentCtx?.ctx` are addressed separately).
- Injecting `modelRegistry` further (already a narrow interface from `model-resolver.ts`).

## Background

### Dependency: #145 (Step M) — Decompose execute

Issue #145 is **closed/implemented**.
`buildParentSnapshot(ctx)` converts `ExtensionContext` → `ParentSnapshot` at the call site.
This enables `WizardManager.spawnAndWait` to accept `ParentSnapshot` instead of `ExtensionContext`.

### Existing modules

- `agent-menu.ts` (296 lines) — menu handler factory, 8-field `AgentMenuDeps`, all inner functions take `ctx: ExtensionContext`
- `agent-config-editor.ts` (202 lines) — `AgentConfigEditorDeps` (4 fields), `showAgentDetail` takes `ctx: ExtensionContext`
- `agent-creation-wizard.ts` (246 lines) — `AgentCreationWizardDeps` (5 fields), `WizardManager.spawnAndWait` takes `ctx: ExtensionContext`
- `tools/get-result-tool.ts` — `GetResultDeps` (4 fields)
- `tools/steer-tool.ts` — `SteerToolDeps` (4 fields)
- `index.ts` — wires everything, handler registration extracts `ctx.ui` and passes `ExtensionContext`

### ExtensionContext usage in menu handlers

Every `ctx` reference in the three menu UI modules maps to exactly one of:

- `ctx.ui.select(...)` — 9 call sites
- `ctx.ui.confirm(...)` — 5 call sites
- `ctx.ui.input(...)` — 7 call sites
- `ctx.ui.notify(...)` — 15 call sites
- `ctx.ui.editor(...)` — 2 call sites
- `ctx.ui.custom(...)` — 1 call site (conversation viewer overlay)
- `ctx.modelRegistry` — 1 call site (model label resolution in `showAllAgentsList`)

No other `ExtensionContext` properties (session, tools, hooks, etc.) are accessed.

## Design Overview

### MenuUI interface

A narrow interface capturing only the `ctx.ui` methods used by menu handlers:

```typescript
import type { ModelRegistry } from "../model-resolver.js";

export interface MenuUI {
  select<T extends string>(title: string, options: T[]): Promise<T | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  editor(title: string, content: string): Promise<string | undefined>;
  custom<R>(component: any, options?: any): Promise<R>;
}
```

`modelRegistry` is not included in `MenuUI` — it is not a UI concern.
Instead, the handler registration in `index.ts` passes it separately.

### Handler signature change

The menu handler currently receives `ExtensionContext` directly:

```typescript
// index.ts — before
handler: async (_args, ctx) => { await agentsMenuHandler(ctx); },
```

After this change, `index.ts` destructures what each handler needs:

```typescript
// index.ts — after
handler: async (_args, ctx) => {
  await agentsMenuHandler({ ui: ctx.ui, modelRegistry: ctx.modelRegistry });
},
```

In `agent-menu.ts`, the return type changes from `(ctx: ExtensionContext) => Promise<void>` to a function that accepts `{ ui: MenuUI; modelRegistry: ModelRegistry }`.
The `ExtensionContext` import is removed from `agent-menu.ts`, `agent-config-editor.ts`, and `agent-creation-wizard.ts`.

### Wizard spawnAndWait — ParentSnapshot

`WizardManager.spawnAndWait` currently takes `ctx: ExtensionContext` and passes it to `manager.spawnAndWait(...)`.
After #145, `index.ts` can call `buildParentSnapshot(ctx)` at the call site and pass the result:

```typescript
// index.ts — spawnAndWait call site
spawnAndWait: (snapshot, type, prompt, opts) =>
  manager.spawnAndWait(snapshot, type, prompt, opts),
```

The `WizardManager` interface changes from `spawnAndWait(ctx: ExtensionContext, ...)` to `spawnAndWait(snapshot: ParentSnapshot, ...)`.
The creation wizard no longer imports `ExtensionContext`.

### Dependency bag convention

Per `docs/architecture/architecture.md` § Dependency bag convention:

- **≤4 fields** → dissolve the interface, accept as plain parameters.
- **≥5 fields** → keep the interface but destructure in the function signature.

#### Dissolve (≤4 fields)

`AgentConfigEditorDeps` (4 fields: `fileOps`, `registry`, `personalAgentsDir`, `projectAgentsDir`) → plain parameters on `createAgentConfigEditor`.

`GetResultDeps` (4 fields: `getRecord`, `cancelNudge`, `getConversation`, `registry`) → plain parameters on `createGetResultTool`.

`SteerToolDeps` (4 fields: `getRecord`, `emitEvent`, `steerAgent`, `queueSteer`) → plain parameters on `createSteerTool`.

#### Keep + destructure (≥5 fields)

`AgentMenuDeps` (8 fields) — keep the interface, destructure in `createAgentsMenuHandler({ manager, registry, ... })`.

`AgentCreationWizardDeps` (5 fields) — keep the interface, destructure in `createAgentCreationWizard({ fileOps, manager, ... })`.

### Consumer call-site sketch (menu handler registration)

```typescript
// index.ts
pi.registerCommand('agents', {
  description: 'Manage agents',
  handler: async (_args, ctx) => {
    await agentsMenuHandler({
      ui: ctx.ui,
      modelRegistry: ctx.modelRegistry,
    });
  },
});
```

### Extracted module interaction sketch (agent-config-editor)

```typescript
// agent-config-editor.ts — after dissolving deps
export function createAgentConfigEditor(
  fileOps: AgentFileOps,
  registry: AgentTypeRegistry,
  personalAgentsDir: string,
  projectAgentsDir: string,
) {
  // ... closures capture these directly; no deps.foo indirection
}
```

No Tell-Don't-Ask violations — each parameter is a primitive or injectable collaborator.
No output-argument mutations — pure closure capture.

## Module-Level Changes

### New file: none

All changes are modifications to existing files.

### Modified: `src/ui/agent-menu.ts`

- Add `MenuUI` interface export (the new narrow type).
- Import `ModelRegistry` from `model-resolver.js`.
- Remove `ExtensionContext` import.
- Change all inner function signatures from `(ctx: ExtensionContext)` to `(ui: MenuUI)`.
- Replace `ctx.ui.xxx(...)` → `ui.xxx(...)`.
- Replace `ctx.modelRegistry` → parameter `modelRegistry` threaded to `showAllAgentsList`.
- Change `AgentMenuDeps` usage: destructure in `createAgentsMenuHandler` signature.
- Change return type from `(ctx: ExtensionContext) => Promise<void>` to `(params: { ui: MenuUI; modelRegistry: ModelRegistry }) => Promise<void>`.
- Update `AgentMenuManager.spawnAndWait` to accept `ParentSnapshot` instead of `ExtensionContext`.
- Remove `Omit<AgentSpawnConfig, "isBackground">` in favor of plain inline type.

### Modified: `src/ui/agent-config-editor.ts`

- Remove `ExtensionContext` import.
- Add `MenuUI` import from `agent-menu.js`.
- Change all inner function signatures from `(ctx: ExtensionContext)` to `(ui: MenuUI)`.
- Replace `ctx.ui.xxx(...)` → `ui.xxx(...)`.
- Dissolve `AgentConfigEditorDeps`: replace single deps parameter with 4 plain parameters.

### Modified: `src/ui/agent-creation-wizard.ts`

- Remove `ExtensionContext` import.
- Add `MenuUI` import from `agent-menu.js`.
- Add `ParentSnapshot` import from `parent-snapshot.js`.
- Change all inner function signatures from `(ctx: ExtensionContext)` to `(ui: MenuUI)`.
- Replace `ctx.ui.xxx(...)` → `ui.xxx(...)`.
- Change `WizardManager.spawnAndWait` to accept `ParentSnapshot` instead of `ExtensionContext`.
- Destructure `AgentCreationWizardDeps` in signature.

### Modified: `src/tools/get-result-tool.ts`

- Dissolve `GetResultDeps`: replace single deps parameter with 4 plain parameters.

### Modified: `src/tools/steer-tool.ts`

- Dissolve `SteerToolDeps`: replace single deps parameter with 4 plain parameters.

### Modified: `src/index.ts`

- Update `createAgentConfigEditor` call: pass 4 plain args instead of `AgentConfigEditorDeps`.
- Update `createAgentCreationWizard` call: pass 4 plain args instead of `AgentCreationWizardDeps` (registry is the `WizardRegistry`, not the full `AgentTypeRegistry` — pass `{ reload: () => registry.reload() }`).
- Update `createGetResultTool` call: pass 4 plain args instead of `GetResultDeps`.
- Update `createSteerTool` call: pass 4 plain args instead of `SteerToolDeps`.
- Update `spawnAndWait` call in menu handler deps: wrap with `buildParentSnapshot(ctx)`.
- Update `/agents` command handler to destructure `ctx.ui` and `ctx.modelRegistry`.

### Modified: test files

- `test/ui/agent-menu.test.ts` — remove `ctx as any` casts; pass `{ ui: { ... }, modelRegistry: {} }`.
- `test/ui/agent-config-editor.test.ts` — remove `ctx as any` casts; pass `MenuUI` objects.
- `test/ui/agent-creation-wizard.test.ts` — remove `ctx as any` casts; pass `MenuUI` objects and `ParentSnapshot` mocks.

### Unchanged

- `src/ui/conversation-viewer.ts` — unrelated; uses its own deps.
- `src/ui/agent-widget.ts` — already narrow (no `ExtensionContext`).
- `src/agent-manager.ts` — already accepts `ParentSnapshot` from #145.
- `src/parent-snapshot.ts` — unchanged.

## Test Impact Analysis

1. **New unit tests enabled:** None — this is a signature change, not an extraction.
   The existing test coverage already exercises menu navigation, editing, creation, and tool operations.

2. **Existing tests that simplify:** All 42 `ctx as any` casts are removed from the three test files.
   `makeCtx()` returns a plain `MenuUI`-shaped object (already structurally compatible).
   The `makeCtx` helper in `agent-menu.test.ts` already returns the right shape — it just needs the cast removed and the handler-call interface updated.

3. **Tests that must stay:** All existing test assertions stay — only the method of constructing the handler input changes.
   `get-result-tool.test.ts` and `steer-tool.test.ts` may need minor updates if the deps dissolve changes the factory call signature, but no assertion changes.

## TDD Order

1. **Red → Green:** Update `agent-config-editor.ts` — dissolve `AgentConfigEditorDeps` into 4 plain parameters.
   Update `agent-config-editor.test.ts` — remove `ctx as any` casts, pass `MenuUI` directly.
   Commit: `refactor: dissolve AgentConfigEditorDeps into plain parameters (#146)`

2. **Red → Green:** Update `agent-creation-wizard.ts` — destructure `AgentCreationWizardDeps`, change `WizardManager.spawnAndWait` to accept `ParentSnapshot`.
   Update `agent-creation-wizard.test.ts` — remove `ctx as any` casts, pass `MenuUI` and stub `ParentSnapshot`.
   Commit: `refactor: narrow creation wizard to MenuUI and ParentSnapshot (#146)`

3. **Red → Green:** Update `agent-menu.ts` — add `MenuUI` interface, destructure `AgentMenuDeps`, thread `modelRegistry` separately.
   Update `agent-menu.test.ts` — remove `ctx as any` casts, pass `{ ui, modelRegistry }`.
   Commit: `refactor: narrow agent menu to MenuUI interface (#146)`

4. **Red → Green:** Update `get-result-tool.ts` — dissolve `GetResultDeps` into 4 plain parameters.
   Commit: `refactor: dissolve GetResultDeps into plain parameters (#146)`

5. **Red → Green:** Update `steer-tool.ts` — dissolve `SteerToolDeps` into 4 plain parameters.
   Commit: `refactor: dissolve SteerToolDeps into plain parameters (#146)`

6. **Red → Green:** Update `index.ts` — update all 5 factory call sites for the new signatures; update handler to extract `ctx.ui` + `ctx.modelRegistry`.
   Commit: `refactor: wire narrow menu UI context at call sites (#146)`

7. **Verify:** Run full test suite and type check.
   Confirm zero `ctx as any` in the three menu test files.
   Commit: none (verification only).

## Risks and Mitigations

| Risk                                                                                     | Mitigation                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.ui.custom` signature mismatch between `MenuUI` and real `ExtensionContext.ui`       | `MenuUI.custom` uses `any` for the component and options parameters since these are opaque TUI types internal to the SDK. This matches the existing usage where `ctx.ui.custom<undefined>(...)` passes a TUI component constructor.                    |
| `ParentSnapshot` vs `ExtensionContext` mismatch at `WizardManager.spawnAndWait` boundary | `index.ts` already wraps with `buildParentSnapshot(ctx)` in the `spawnAndWait` call site. `AgentMenuManager` already has it too. Making `WizardManager` match eliminates the last divergence.                                                          |
| Deper interface dissolution breaks `index.ts` type check                                 | The deps interfaces are only used by their factory and `index.ts`. Since both change in the same commit sequence, there is no intermediate state where they diverge. Steps 1–5 change module + test; step 6 updates `index.ts` for all simultaneously. |

## Open Questions

- None — the design follows the architecture doc's Step N specification and the dependency (#145) is already implemented.
