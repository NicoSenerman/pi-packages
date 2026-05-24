---
issue: 188
issue_title: "refactor(pi-subagents): replace any casts with SDK types in extractText and SubscribableSession"
---

# Retro: #188 — Replace any casts with SDK types

## Stage: Planning (2026-05-24T20:04:58Z)

### Session summary

Produced a two-step refactoring plan for replacing `any` casts in `extractText` (with a `TextContent` type predicate) and `SubscribableSession` (with `AgentSessionEvent`).
Verified that both SDK types are already imported and used in adjacent files within the package.
Confirmed mock session compatibility via function parameter contravariance — no test changes expected.

### Observations

- The `extractText` parameter type stays `unknown[]` to avoid rippling through callers in `message-formatters.ts` that declare `content: unknown[]`.
  A future cleanup could tighten those caller signatures.
- `SubscribableSession` moves to `src/types.ts` as the shared location, matching existing cross-domain types there (`SubagentType`, `ThinkingLevel`, `ShellExec`).
- All three `eslint-disable` top-level comments (`context.ts`, `record-observer.ts`, `ui-observer.ts`) should be removable once the `any` casts are gone, since the SDK union's discriminated members cover the property access patterns.
- Risk: if `AgentSessionEvent` doesn't cover `assistantMessageEvent` in `ui-observer.ts`, the type checker will surface it immediately — the mitigation is to check the union members during implementation.
