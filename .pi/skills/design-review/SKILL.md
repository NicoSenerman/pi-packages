---
name: design-review
description: |
  Review a module's dependency and structural patterns for code smells.
  Use when adding a parameter to a shared interface, when a dependency bag grows past 5 fields,
  or when planning a refactoring that touches handler/event wiring.
metadata:
  short-description: Structural design review for dependency and encapsulation smells
---

# Design Review

Use this skill to audit a module (or a set of related modules) for structural smells before they accumulate into a large refactoring.

## When to invoke

- A shared interface (deps bag, config type, handler params) is gaining a new field.
- A `makeDeps()` or `makeRuntime()` test factory has more than 8 fields.
- A plan adds a parameter that threads through 3+ layers.
- You are unsure whether a new dependency belongs on an existing object or needs a new one.

## Checklist

Work through each check in order.
Use `grep` and `read` to gather evidence before making judgments.

### 1. Dependency width

Grep for the interface or type being reviewed (e.g., `HandlerDeps`, `RuntimeConfig`).
Count the fields.
For each consumer (function or class that receives it), list which fields that consumer actually reads or writes.

Ask:

- Does every consumer use more than half the fields? If not, the interface is too wide.
- Are there natural clusters of fields that always appear together? Those are missing intermediate abstractions (value objects or collaborator interfaces).

### 2. Law of Demeter violations

Search for chained access patterns:

```bash
grep -n 'deps\.\w\+\.\w\+\.\w\+' src/handlers/**/*.ts
```

Each chain `a.b.c()` means `a` exposes `b` and the caller talks to `b` directly.
The fix is a method on `a` that delegates to `b` internally.

Ask:

- Do multiple callers perform the same reach-through? That confirms the missing method.
- Does the intermediate object (`b`) appear in the caller's test mocks? If yes, the coupling is leaking into tests.

### 3. Output arguments

Search for writes back into a received parameter:

```bash
grep -n 'deps\.\w\+ =' src/handlers/**/*.ts
```

Each `deps.foo = value` means the function is mutating state it does not own.
The fix is a method on the owning object (`deps.setFoo(value)` or `deps.activate(ctx)`).

Ask:

- Is the same field written in multiple handlers? That is scattered state management — extract a single method.
- Is the write paired with a read elsewhere? The object that reads should own the write.

### 4. Scattered resets

Search for repeated patterns of field initialization:

```bash
grep -n 'deps\.\w\+ = null\|deps\.\w\+ = \[\]' src/handlers/**/*.ts
```

If 3+ handlers set the same fields to the same defaults, extract a `reset()` or `shutdown()` method.

### 5. Parameter relay

When a parameter (e.g., `ctx: ExtensionContext`) is passed through a chain:

```text
handler(deps, event, ctx)
  → deps.someMethod(ctx, ...)
    → deps.anotherMethod(ctx, ...)
```

Check whether the intermediaries use `ctx` themselves or just relay it.
If they only relay, the parameter belongs on a shared object (e.g., `session.activate(ctx)` stores it once; downstream methods read it from the session).

### 6. Test mock depth

Read the test files for the module under review.
Look for:

- `as unknown as` casts — the mock cannot satisfy the real type naturally.
- Nested mock objects (`{ permissionManager: { checkPermission: vi.fn() } }`) — the production code has LoD violations.
- Fields in `makeDeps()` that no test in the file ever overrides — the interface is too wide for this consumer.

### 7. Missing intermediate abstractions

After completing checks 1–6, look for groups of raw dependencies that form a cohesive concept:

- Multiple path strings computed from the same root → value object.
- Multiple function deps that always appear together → interface.
- Mutable state + the methods that read/write it → class.

Name the abstraction. Verify it reduces the field count of the parent interface by at least 2.

## Output

Summarize findings as a table:

| Smell | Location | Evidence | Suggested fix |
| ----- | -------- | -------- | ------------- |
| Wide deps | `HandlerDeps` (20 fields) | `handleShutdown` uses 3 | Narrow per-handler interface or class |
| LoD violation | `tool-call.ts:101` | `deps.session.permissionManager.checkPermission` | Add `session.checkPermission()` |
| Output argument | `lifecycle.ts:22` | `deps.session.runtimeContext = ctx` | Add `session.activate(ctx)` |

Then recommend whether the fixes are:

- **Inline** — small enough to do in the current PR.
- **Follow-up issue** — needs its own plan.
- **Track and watch** — not yet painful enough to fix; note it and revisit if it grows.
