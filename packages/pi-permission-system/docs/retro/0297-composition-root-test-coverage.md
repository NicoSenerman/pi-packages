---
issue: 297
issue_title: "Add composition-root test coverage for pi-permission-system (makeFakePi harness + backfill)"
---

# Retro: #297 — Add composition-root test coverage for pi-permission-system

## Stage: Planning (2026-06-01T16:55:17Z)

### Session summary

Produced a numbered TDD plan to build a `makeFakePi()` harness in `test/helpers/` and backfill six composition-root wiring tests against the real `piPermissionSystemExtension(pi)` factory.
The plan covers the [#296] regression class (registry sharing), handler-registration completeness, shutdown teardown, service/gate formatter-registry sharing, `ready`-after-publish ordering, and a characterization of the suspected multi-instance global-state bug, then a final step consolidating the existing inline `createToolCallHarness` onto the new harness.

### Observations

- Discovered an existing inline `createToolCallHarness` in `test/permission-system.test.ts` (≈line 110) that already runs the real factory with a hand-rolled fake `pi` — but with a **no-op** event bus (not `createEventBus()`), a `Record` of handlers (not an inspectable map), and no `fire()` driver.
  `makeFakePi()` is its generalization; user chose to build standalone first, then fold consolidation into this plan as a final step.
- Key correction carried into the plan: the issue pseudocode keys the subagent registry and the `subagents:child:session-created` payload by `sessionDir`, but the current code (post [#221] / [#296]) keys by `sessionId`.
  `isSubagentExecutionContext` checks `registry.has(ctx.sessionManager.getSessionId())`.
  Tests must use `sessionId`.
- The factory calls `getAgentDir()` internally (via `createExtensionRuntime()` with no `agentDir` option), so every composition-root test must `vi.stubEnv("PI_CODING_AGENT_DIR", <tmpdir>)` and clean **both** `Symbol.for()` global slots (`:service` and `:subagent-registry`) in `afterEach`, or factory runs leak across tests.
  The registry slot has no public unpublish accessor by design, so tests delete it directly (the `subagent-registry.test.ts` pattern).
- User decision: target 6 (suspected latent bug where a child's `session_shutdown` unpublishes the parent's global service) is **characterize-only** — assert current behavior, use `test.fails` for the desired behavior if confirmed, and file a separate fix issue.
- `pnpm exec markdownlint-cli2` is not installed in the workspace; a `rumdl fmt` pre-commit hook handles markdown formatting and passed on commit.
- Next stage is `/tdd-plan` — the plan is structured as red→green→commit cycles.

[#221]: https://github.com/gotgenes/pi-packages/issues/221
[#296]: https://github.com/gotgenes/pi-packages/issues/296
