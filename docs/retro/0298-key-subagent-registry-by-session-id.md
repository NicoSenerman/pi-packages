---
issue: 298
issue_title: "Concurrent subagent siblings collide on one registry key — a finishing sibling unregisters the shared entry and blocks the others' ask forwarding"
---

# Retro: #298 — Concurrent subagent siblings collide on one registry key

## Stage: Planning (2026-06-01T15:58:57Z)

### Session summary

Produced a cross-package implementation plan (`docs/plans/0298-key-subagent-registry-by-session-id.md`) to re-key `SubagentSessionRegistry` on the child session id instead of the session directory, fixing the sibling-collision bug where one finishing child's `disposed` evicts the shared entry for all siblings.
The plan spans `@gotgenes/pi-subagents` (producer event payloads) and `@gotgenes/pi-permission-system` (consumer registry + detection + forwarding) plus docs.

### Observations

- Confirmed `#296` (process-global registry storage via `globalThis`) is already landed and closed — the collision is **live now**, not latent, so the fix is `fix:`-typed and forwarding is currently active.
- Two `ask_user` decisions resolved the only ambiguities: (1) **replace** `sessionDir` with `sessionId` on the `session-created`/`disposed` payloads rather than adding alongside (avoids a vestigial field), and (2) **remove** the never-read `agentName` from `SubagentSessionInfo` and the `session-created` payload as part of this fix.
- Key structural insight: the two packages are **type-decoupled** (event contract is a runtime channel name + independently-declared duck-typed payloads, no cross-import under jiti) but **runtime-coupled** — so producer/consumer changes can land in separate commits with green tests, but must ship together to avoid a forwarding-break window.
  This shaped the TDD ordering (consumer steps 1–2, producer step 3, docs step 4).
- The pi-subagents payload change is a **breaking** event-contract change (`fix!` + `BREAKING CHANGE:` footer) since `session-created`/`disposed` are public lifecycle events; `spawning`/`completed` are deliberately left untouched (`completed` still legitimately carries `sessionDir`/`agentName`).
- Rejected alternatives (per the issue, reaffirmed in the plan): refcounting the shared directory key (masks the dir-as-identity conflation) and giving each child a unique directory (alters on-disk layout and resume).
- Verified `sessionManager.getSessionId()` exists on both producer (`types.ts`) and consumer (`polling.ts` already uses `ctx.sessionManager.getSessionId()`), so no new SDK surface is required — only adding `getSessionId` to the producer's `SessionManagerLike` IO interface and the test `createSessionManager` mock.
- Flagged a risk to verify during implementation: whether `SubagentSessionInfo` is on the package's public type surface (would make the `agentName` removal externally breaking).

## Stage: Implementation — TDD (2026-06-01T16:18:03Z)

### Session summary

Completed all 4 TDD cycles: 2 consumer-side `pi-permission-system` commits (registry + lifecycle subscriber re-keyed by session id, then detection + forwarding resolution re-keyed), 1 producer-side `pi-subagents` breaking commit (event payload shape change), and 1 docs commit.
Test count increased by 2 (two new sibling-collision regression tests in `subagent-lifecycle-events.test.ts` and `subagent-registry.test.ts`).
Pre-completion reviewer returned **PASS**.

### Observations

- Risk resolved: `SubagentSessionInfo` is not re-exported from `packages/pi-permission-system/src/index.ts` — the `agentName` removal is not externally breaking for that package.
- Steps 1 and 2 stayed cleanly independent: the registry-key change (step 1) and the detection/forwarding lookup change (step 2) touched different source files and committed separately with green tests at each step.
- The `polling.ts` change was smaller than planned: removing the `sessionDir` local variable also eliminated the `ctx.sessionManager.getSessionDir()` call in `waitForForwardedPermissionApproval` entirely — `requesterSessionId` was already computed and served as the `sessionId` argument.
- `isSubagentExecutionContext` required a `try/catch` around `getSessionId()` because the SDK's `ExtensionContext` interface does not expose `getSessionId` as a typed member.
  The same defensive pattern was already present in the `getSessionId(ctx)` helper in `polling.ts`.
- `SubagentSessionMeta` keeps both `sessionId` and `sessionDir`/`agentName` — `completed` still legitimately needs the latter two as transcript location and UI/telemetry identity.
  This is the intentional dual-field design from the plan.
- The `createSessionManager` mock in `subagent-session-io.ts` was extended with `getSessionId: vi.fn().mockReturnValue("child-session-id")`; this propagated to all factory-using tests without per-test overrides.
