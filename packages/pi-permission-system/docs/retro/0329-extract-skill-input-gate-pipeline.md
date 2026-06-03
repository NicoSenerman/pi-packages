---
issue: 329
issue_title: "Extract a SkillInputGatePipeline for the handleInput skill-input gate"
---

# Retro: #329 — Extract a SkillInputGatePipeline for the handleInput skill-input gate

## Stage: Planning (2026-06-03T00:00:00Z)

### Session summary

Produced the implementation plan for extracting a `SkillInputGatePipeline` that mirrors the `ToolCallGatePipeline` ([#327]) for the `input` path.
Verified that prerequisites [#326] (`describeSkillInputGate`, `skill_input` denial kind) and [#327] (`ToolCallGatePipeline`, `GateHandlerSession`) are already landed in the codebase, and that `docs/architecture/architecture.md` already carries Step 12/13 entries for this work.

### Observations

- The one genuinely ambiguous design choice — whether to defer the request-id relocation to [#330] or fold it into this pipeline now — was surfaced via `ask_user`.
  The user chose to **absorb [#330]**: the pipeline mints its own id via a relocated `createSkillInputRequestId` helper, and `PermissionSession.createPermissionRequestId` is removed outright.
  The plan notes [#330] can be closed when this ships.
- Settled the notifier seam as a narrow `GateNotifier` interface (`warn(message)`) built per-event in `handleInput` from `ctx`, splitting the deny decision (pipeline) from the `hasUI` gate (notifier closure) — Tell-Don't-Ask, keeps `ExtensionContext` out of the pipeline.
- `evaluate` must be a non-`async` function returning `runner.run(...)` directly: it has no `await` of its own, and `@typescript-eslint/require-await` would reject an `async` body with no `await`.
- The runner is passed per-call (not injected into the pipeline), mirroring `ToolCallGatePipeline.evaluate(tcc, runner)` and avoiding dual ownership.
- Step 2 is deliberately one commit: the constructor-arity change plus the `GateHandlerSession` / `PermissionSession` shrink break every call site and all `createPermissionRequestId` consumers at the type level at once, so they cannot land separately.
- Tracked but not addressed: the handler reaches five injected collaborators after this change (dependency-width threshold) — grouping is [#320]'s concern.

[#320]: https://github.com/gotgenes/pi-packages/issues/320
[#326]: https://github.com/gotgenes/pi-packages/issues/326
[#327]: https://github.com/gotgenes/pi-packages/issues/327
[#330]: https://github.com/gotgenes/pi-packages/issues/330
