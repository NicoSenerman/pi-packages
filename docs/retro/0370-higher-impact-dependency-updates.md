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

## Stage: Final Retrospective (2026-06-12T22:04:41Z)

### Session summary

Three-stage cross-package dependency update (Planning → Build → Ship) executed cleanly: all six deferred dependencies bumped, project-trust adoption recorded as ADR-0001, six packages released, issue closed.
The only rework was a one-line `style:` fixup commit for a duplicate markdown link-reference definition in the retro file; the only plan deviation was an unanticipated explicit-devDep addition in `pi-subagents-worktrees`.

### Observations

#### What went well

- **Planning verified every claim in the issue table rather than trusting it.**
  The issue named `pi-subagents` `14.0.1` and listed `pi-permission-system` as needing the SDK bump; planning checked npm (`15.0.1` is latest), git (`pi-permission-system` already on `0.79.1` via [#382]), and the `pi-subagents` CHANGELOG (confirmed `WorkspaceProvider` unaffected by the `14.0.0` event-payload break) before writing.
  The scope correction dropped one package and retargeted another major.
- **Tight incremental feedback loop in Build.**
  `check` / `lint` / `test` ran after every one of the five steps, not just at the end — plus targeted gates (`verify:public-types` after the `rollup` bump, worktree integration tests after the floor bump).
  No end-of-session surprise.
- **Clean deviation handling in Build Step 2.**
  The stale-`0.75.4` peer resolution was investigated (lockfile reads), diagnosed (no SDK devDep in `pi-subagents-worktrees`), fixed, and folded into the same commit with an explanatory body — no separate churn commit.

#### What caused friction (agent side)

- `missing-context` — the Build stage rewrote the retro with `Write`, re-adding `[#360]:` / `[#382]:` link-reference definitions that the Planning stage had already defined at the end of the file.
  Link reference definitions are file-scoped, so the duplicate tripped markdownlint MD053 (caught by `rumdl check` at turn 105).
  Impact: one extra fixup commit (`style: fix duplicate link definitions in retro #370`, `9f93b135`).
- `missing-context` — the plan's Module-Level Changes for `pi-subagents-worktrees` listed only the `pi-subagents` pin bump; it did not anticipate that the package declares the SDK only as a peer (no devDep), so pnpm resolved the peer to the stale `0.75.4` after the Step 1 bump.
  Impact: ~8 investigation tool calls (turns 43–51) and one unplanned `package.json` edit, folded into the Step 2 commit (no separate commit).
- `rabbit-hole` (minor) — on the `typebox` step, `pnpm install --force` was run reactively (turn 58) before confirming why `1.1.38` lingered; it turned out to be a transitive dep of the Pi SDK and coexists with `1.2.8` by design.
  Impact: ~6 tool calls of confirmation; no rework, no commit churn.

#### What caused friction (user side)

- None.
  The Planning `ask_user` gate resolved all three direction choices (pi-subagents floor, typebox target, project-trust scope) up front, so Build and Ship needed no mid-flight user input.

### Diagnostic details

- **Model-performance correlation** — Planning ran on `anthropic/claude-opus-4-8` (judgment-heavy: scope verification, ambiguity surfacing); Build and Ship ran on `anthropic/claude-sonnet-4-6` (mechanical edits + verification).
  Appropriate split; no mismatch.
- **Feedback-loop gap analysis** — no gap: verification ran incrementally after each Build step, not deferred to the end.
- **Escalation-delay tracking** — the two longest investigation runs (worktrees peer, ~8 calls; typebox transitive, ~6 calls) were productive lockfile reads, not repeated spinning on one error; neither warranted an Explore/Plan subagent.

### Follow-up (not implemented inline)

- The `pi-subagents-worktrees` peer-without-devDep gotcha is real but pnpm-specific and niche; recorded here as a lesson rather than a prompt rule.
  If it recurs in another package, revisit whether the planning prompt should flag peer-only SDK declarations.

### Changes made

1. `.pi/skills/markdown-conventions/SKILL.md` — appended a sentence to the reference-style links bullet noting that link reference definitions are file-scoped, so an appended stage entry must not re-add a `[#N]:` already defined earlier in the file (prevents the MD053 duplicate that caused the `style:` fixup commit this session).
