---
issue: 370
issue_title: "Update higher-impact dependencies: Pi SDK 0.79.x, pi-subagents 14, @types/node, typebox, rollup"
---

# Retro: #370 — Update higher-impact dependencies: Pi SDK 0.79.x, pi-subagents 14, @types/node, typebox, rollup

## Stage: Planning (2026-06-12T00:00:00Z)

### Session summary

Produced the cross-package plan `docs/plans/0370-higher-impact-dependency-updates.md` for the remaining higher-impact dependency bumps.
Confirmed the operator authored the issue, surfaced three genuine ambiguities via `ask_user`, and scoped a build-style plan with five bump → verify → commit steps plus a project-trust decision deliverable.

### Observations

- `pi-permission-system` was already bumped to the Pi SDK `0.79.1` in [#382] (peer floor raised to `>=0.79.0`), so it is out of SDK scope here — the issue table predates that change.
- `@gotgenes/pi-subagents` latest is now `15.0.1`, not the `14.0.1` the issue names; `15.0.0` is a breaking append-prompt-mode default ([#360]) but does not touch the `WorkspaceProvider` API `pi-subagents-worktrees` consumes.
  Operator chose to track `15.x` for the worktrees floor.
- Operator chose `typebox` `^1.2.8` (latest, not the issue's `^1.2.3`) and to investigate + record the project-trust decision in this round rather than defer it.
- All SDK / `typebox` / `rollup` moves are `devDependencies` (packages ship source), so they are non-breaking at the consumer surface; each `chore(deps)` still triggers a patch release (precedent: the `15.0.1` chore-deps patch).
- The worktrees peer-floor narrow (`>=12.1.0` → `>=15.0.0`) is the only consumer-visible change; followed the repo precedent ([#382] raised an SDK peer floor inside a non-breaking commit) of treating floor raises as non-breaking.
- No package imports the removed `./hooks` subpath and none reference the project-trust APIs yet — both confirmed by grep.
- `minimumReleaseAge` is unset (`pnpm config get` → `undefined`), so the recently published targets are not install-gated locally; flagged as a risk if a CI age gate applies.
- The decision doc lands in `packages/pi-permission-system/docs/decisions/`, which is **not** in `release-please-config.json` `exclude-paths` — the plan adds it in the same step to avoid a spurious release.
- Next step is `/build-plan` (deps + docs), not `/tdd-plan` — there are no red→green cycles.

[#360]: https://github.com/gotgenes/pi-packages/issues/360
[#382]: https://github.com/gotgenes/pi-packages/issues/382

## Stage: Implementation — Build (2026-06-12T17:45:00Z)

### Session summary

Executed all five plan steps: bumped the Pi SDK trio to `0.79.1` across five packages, raised the `pi-subagents-worktrees` floor to `>=15.0.0` (`^15.0.1` devDep), bumped `typebox` to `^1.2.8` in `pi-colgrep` and `pi-github-tools`, bumped `rollup` to `^4.61.1` in `pi-subagents` (with `verify:public-types` passing), and wrote the project-trust adoption decision at `packages/pi-permission-system/docs/decisions/0001-project-trust-adoption.md`.
Pre-completion reviewer returned PASS; 3512 tests across seven packages all green.

### Observations

- **Unplanned deviation — Step 2:** `pi-subagents-worktrees` had no devDependency for `@earendil-works/pi-coding-agent`, so pnpm resolved its peer to the stale `0.75.4` even after the Step 1 SDK bump.
  Fixed by adding `@earendil-works/pi-coding-agent: 0.79.1` as an explicit devDependency to `pi-subagents-worktrees/package.json`.
  Folded into the Step 2 commit with explanation in the body.
- **Project-trust investigation findings:** `pi-permission-system` loads project configs unconditionally; the merge order (global → project → project-agent, highest-precedence last) means an untrusted project's `.pi/settings.json` can expand global restrictions.
  `ctx.isProjectTrusted()` is available in `session_start` (trust resolves before that event), and `handleResourcesDiscover` already handles trust-grant reloads.
  Decision: adopt `ctx.isProjectTrusted()` guard in a follow-up issue.
- `typebox@1.1.38` also appears in the lockfile as a transitive dep inside the Pi SDK itself (`@earendil-works/pi-coding-agent@0.79.1` → `typebox@1.1.38`); both versions coexist correctly.
- Pre-completion reviewer: PASS — all ACs verified, no warnings.
