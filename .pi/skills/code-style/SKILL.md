---
name: code-style
description: |
  TypeScript conventions, structural design heuristics (dependency width, LoD, output arguments),
  pnpm rules, ES2024 target, and Pi SDK patterns.
  Load during implementation, refactoring, or code review.
---

# Code Style

Load this skill when implementing, refactoring, or reviewing TypeScript code.

## TypeScript

- Avoid `any` unless absolutely necessary.
- Use standard top-level imports only.
- Keep modules focused and composable (one concern per file).
- Prefer explicit configuration over hidden behavior.
- Business logic should be pure functions wherever possible — keep IO at the edges.

### Pi SDK boundaries

Keep Pi SDK imports out of business-logic modules.
Tool definitions, event handlers, and command handlers are SDK consumers — they may import SDK types directly.
The restriction targets pure helpers, utilities, and domain modules that should remain SDK-independent.
When a new capability is needed in a library module, accept it as a parameter or callback — do not reach for the Pi SDK directly.

When writing event handlers that consume Pi SDK types, prefer lean local payload interfaces over full SDK event types.
The SDK may not export all event interfaces, and exported types often require fields the handler does not read.
Define a minimal interface with only the fields the handler uses.

## Structural Design

### Dependency width

Do not pass a shared dependency bag to functions that only use a subset of it.
When a function receives an object and only touches a few of its fields, the function's real dependencies are invisible.
Define a narrow interface or accept the needed values directly.

When a shared interface references a collaborator, use a narrow interface type — not the concrete class.
Concrete class types expose private fields to TypeScript's structural checker, forcing test mocks to cast or replicate internals.

### Law of Demeter

Do not reach through an injected collaborator to talk to a stranger.
If multiple callers do the same reach-through, the missing abstraction is a method on the intermediate object that delegates internally.

### Output arguments

Do not write back into a received dependency bag.
If a function sets a field on a received object, it is doing work that belongs inside the owning object.
Encapsulate the mutation behind a method.

### Scattered resets

When the same set of fields is reset to the same values in multiple places, extract a single method (`reset()`, `shutdown()`) on the owning object.

### Parameter relay

When a new parameter must flow through a callback chain, check whether the intermediaries actually need it.
If they only relay it, the parameter belongs on an object the endpoints share — not threaded through every layer.

## Tooling

- This project uses **pnpm** exclusively (`"packageManager"` in root `package.json`; `pnpm-lock.yaml`).
  Use `pnpm run`, `pnpm exec`, and `pnpm add` — never `npm` or `npx`.
- The tsconfig target is ES2024 (`noEmit: true`).
  ES2023 APIs (`findLast`, `findLastIndex`, `toReversed`, `toSorted`, `toSpliced`, `with`) and ES2024 APIs (`Promise.withResolvers`, `Object.groupBy`, `Map.groupBy`, `Array.fromAsync`) are available and preferred.
  Do not use APIs introduced after ES2024.
