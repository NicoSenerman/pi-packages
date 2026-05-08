---
name: code-style
description: |
  TypeScript conventions, structural design heuristics (dependency width, LoD, output arguments),
  pnpm rules, ES2023 target, and Pi SDK event handler patterns.
  Load during implementation, refactoring, or code review.
---

# Code Style

Load this skill when implementing, refactoring, or reviewing TypeScript code in this project.

## TypeScript

- Avoid `any` unless absolutely necessary.
- Use standard top-level imports only.
- Keep modules focused and composable (one concern per file).
- Prefer explicit configuration over hidden behavior.
- Permission decisions should be pure functions of (policy, request) wherever possible — keep IO at the edges.

### Pi SDK event handlers

When writing handler functions that consume Pi SDK events, prefer lean local payload interfaces over full SDK event types.
The SDK may not export all event interfaces, and exported types often require fields the handler does not read.
Define a minimal interface with only the fields the handler uses (e.g., `interface SessionStartPayload { reason: string; }`).

### Module-scope caching

Do not cache `getAgentDir()` or other environment-derived values at module scope — tests set `PI_CODING_AGENT_DIR` after import.
Call `getAgentDir()` at invocation time inside `piPermissionSystemExtension()` closures.

## Structural Design

### Dependency width

Do not pass a shared dependency bag to functions that only use a subset of it.
When a function receives an object and only touches 3 of its 15 fields, the function's real dependencies are invisible.
Define a narrow interface or accept the needed values directly.

When a shared interface (e.g., `HandlerDeps`) references a collaborator, use a narrow interface type — not the concrete class.
Concrete class types expose private fields to TypeScript's structural checker, forcing test mocks to cast or replicate internals.

### Law of Demeter

Do not reach through an injected collaborator to talk to a stranger (`deps.session.permissionManager.checkPermission(...)` is a violation).
If multiple callers do the same reach-through, the missing abstraction is a method on the intermediate object that delegates internally.

### Output arguments

Do not write back into a received dependency bag.
If a handler sets `deps.session.runtimeContext = ctx`, the handler is doing work that belongs inside the session object.
Encapsulate the mutation behind a method (`session.activate(ctx)`).

### Scattered resets

When the same set of fields is reset to the same values in multiple places, extract a single method (`reset()`, `shutdown()`) on the owning object.

### Parameter relay

When a new parameter must flow through a callback chain, check whether the intermediaries actually need it.
If they only relay it, the parameter belongs on an object the endpoints share — not threaded through every layer.

## Tooling

- This project uses **pnpm** exclusively (`"packageManager"` in `package.json`; `pnpm-lock.yaml`).
  Use `pnpm run`, `pnpm exec`, and `pnpm add` — never `npm` or `npx`.
  An npm shim in `scripts/bin/npm` (activated via `mise.toml`) blocks npm at the shell level; `npm root` is the sole pass-through.
- The tsconfig target is ES2023 (`noEmit: true`).
  ES2023 APIs (`findLast`, `findLastIndex`, `toReversed`, `toSorted`, `toSpliced`, `with`) are available and preferred.
  Do not use APIs introduced after ES2023 (`Object.groupBy`, `Array.fromAsync`, etc.).
