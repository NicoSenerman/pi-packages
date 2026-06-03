---
issue: 320
issue_title: "Reframe the index.ts composition root as collaborator injection"
---

# Retro: #320 — Reframe the index.ts composition root as collaborator injection

## Stage: Planning (2026-06-03T23:07:04Z)

### Session summary

Planned the `index.ts` composition-root reframe.
The prerequisite collaborators (`PermissionForwarder`, `PermissionResolver`, `GateRunner`, `DecisionReporter`, gate pipelines) are already landed in `main` even though tracker issues #319/#322/#323 are still open, so the factory already injects them.
The plan extracts two genuinely anemic constructs — the inline `permissionsService` literal (→ `LocalPermissionsService`) and the service-publication lifecycle closures (→ `PermissionServiceLifecycle` implementing a narrow `ServiceLifecycle`, injected into `SessionLifecycleHandler`) — across three commits (two `refactor:` cycles + one `docs:`).

### Observations

- Scope was a genuine fork, surfaced via `ask_user`: collaborators-only vs. also-hit-`< 100`-lines via builder helpers vs. deep relay-closure elimination by retyping consumers onto `ExtensionRuntime` role interfaces.
  Chose **collaborators-only**.
  The "< 100 lines" roadmap target is intentionally not met (lands ~206 → ~170) because forcing it would require relocating the established injection bags (`PermissionSessionRuntimeDeps`, `PermissionForwarderDeps`, etc.) into `buildX()` helpers — pure statement relocation with no new collaborator, which AGENTS.md flags as procedure-splitting.
- Behavior-preservation hinge: the literal reads `runtime.permissionManager` / `runtime.sessionRules` (the **runtime's** manager, not the session's).
  Verified by grep that `runtime.permissionManager` is never reassigned on the runtime object (only `this.permissionManager` inside `PermissionSession`) and `sessionRules` is `readonly`, so injecting the instances is byte-identical — recorded as an Open Question / Risk with a clarifying-comment requirement.
- Noted a pre-existing curiosity (out of scope): the runtime's service-backing `permissionManager` is created global-only at factory time and never refreshed for project cwd via `refreshExtensionConfig`; preserved verbatim.
- `test/composition-root.test.ts` (the `make-fake-pi.ts` harness) is the behavior-preservation guard; the two new unit tests (`permissions-service.test.ts`, `service-lifecycle.test.ts`) add lower-level coverage previously only reachable through that harness.
- The `SessionLifecycleHandler` constructor-signature change (two callbacks → one `ServiceLifecycle`) forces the collaborator, handler retype, `lifecycle.test.ts` update, and `index.ts` wiring into one commit (step 2).

## Stage: Implementation — TDD (2026-06-03T19:35:00Z)

### Session summary

Completed all three TDD cycles: extracted `LocalPermissionsService` (step 1), introduced `PermissionServiceLifecycle` + `ServiceLifecycle` interface + retyped `SessionLifecycleHandler` (step 2), and updated `docs/architecture/architecture.md` + `SKILL.md` (step 3).
Test count delta: 1817 → 1834 (+17 tests across two new files: `test/permissions-service.test.ts` and `test/service-lifecycle.test.ts`).
`src/index.ts` reduced from 206 to ~170 lines.

### Observations

- One unplanned cleanup: a stale `emitReadyEvent` import in `src/index.ts` was not caught during step 2's commit (Biome flagged it but the pre-commit hook had already moved on); removed in the step 3 (`docs:`) commit with no behaviour change.
- The `makeSessionRules` helper in `test/permissions-service.test.ts` initially typed its argument as `unknown[]`; `pnpm run check` caught the `Ruleset = Rule[]` mismatch and required a full `{ surface, pattern, action, origin }` fixture object.
- `SessionLifecycleHandler` constructor-signature change (two callbacks → one `ServiceLifecycle`) correctly forced all touchpoints (collaborator impl, handler retype, handler test update, `index.ts` wiring) into one commit — consistent with the plan's prediction.
- Pre-completion reviewer: **PASS** — all deterministic checks, conventional commits, documentation, code design, test artifacts, and Mermaid diagrams passed with no warnings.
