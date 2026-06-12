---
issue: 370
issue_title: "Update higher-impact dependencies: Pi SDK 0.79.x, pi-subagents 14, @types/node, typebox, rollup"
---

# Higher-impact dependency updates

## Problem Statement

The low-risk dependency tiers (pnpm, fallow, and the tooling minors) already landed on `main`.
This issue tracks the remaining higher-impact bumps that cross major boundaries or touch the Pi platform, so they warrant their own testing pass rather than a blind bump.
The work is mostly bumping pinned `devDependencies` and verifying the suites against the newer APIs, plus one investigation deliverable: deciding whether the new Pi SDK 0.79.x project-trust APIs should be adopted.

Two facts changed since the issue was written and reshape the scope:

1. `pi-permission-system` was already bumped to the Pi SDK `0.79.1` (its peer floor raised to `>=0.79.0`) as part of [#382] — so it needs no further SDK work here.
2. `@gotgenes/pi-subagents` latest is now `15.0.1`, not the `14.0.1` named in the issue table.
   `15.0.0` carried a breaking behavioral change (custom agents default to append prompt mode, [#360]), but it does not touch the `WorkspaceProvider` API that `pi-subagents-worktrees` consumes.

## Goals

- Bump the Pi SDK trio (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) from `0.75.4` to `0.79.1` in every package still pinned to `0.75.4`.
- Bump the `pi-subagents-worktrees` dependency on `@gotgenes/pi-subagents` to `15.x` (devDependency pin and peer floor), tracking the current latest major (operator decision).
- Bump `typebox` from `^1.1.38` to `^1.2.8` in `pi-colgrep` and `pi-github-tools` (operator decision: latest).
- Bump `rollup` from `^4.60.4` to `^4.61.1` in `pi-subagents` (the only package with a build step).
- Keep `@types/node` on `^22.x` — the Node floor stays at v22 to match Pi (decided in the issue, no change).
- Investigate the Pi SDK 0.79.x project-trust APIs and record an adoption decision for `pi-permission-system` in this round (operator decision: investigate and record here, no behavior change).
- Keep all peer ranges that already admit `0.79.x` (`>=0.75.0`) untouched — only the pinned `devDependencies` move.

This change is **not breaking** at the consumer surface: every SDK / `typebox` / `rollup` move is a `devDependency` (these packages ship source and re-use the platform-provided runtime), and the consumer-facing SDK peer ranges are unchanged.
The one consumer-visible change is the `pi-subagents-worktrees` peer-floor narrowing (`>=12.1.0` → `>=15.0.0`); the repo precedent ([#382] raised the permission-system SDK peer floor inside a `fix:`, not a breaking commit) is to treat sibling/SDK floor raises as non-breaking, and this plan follows that precedent.

## Non-Goals

- Implementing any project-trust behavior change.
  This round produces a recorded decision only; any adoption work is a follow-up.
- Touching `pi-permission-system`'s SDK pins — already on `0.79.1` via [#382].
- Bumping `@types/node` to v25 — explicitly held at `^22.x`.
- Bumping `@sinclair/typebox` in `pi-subagents` — that is a different package from `typebox` and is out of scope.
- Raising any SDK peer range floors (`>=0.75.0` stays) in the packages that do not use 0.79-only APIs.

## Background

- Relevant packages and their current SDK pins live in each `packages/<pkg>/package.json` `devDependencies`.
  Packages still on the SDK trio `0.75.4`: `pi-autoformat`, `pi-colgrep`, `pi-github-tools`, `pi-session-tools`, `pi-subagents`.
  `pi-permission-system` is already on `0.79.1`.
- `pi-subagents-worktrees` consumes only the stable `WorkspaceProvider` / `registerWorkspaceProvider` API (exported since `12.1.0`); it does not subscribe to the `subagents:child:session-created` / `:disposed` lifecycle events that broke in `14.0.0`.
  So the floor bump to `15.x` is low-risk.
- The SDK `0.79.0` removed the stale `./hooks` export subpath; a repo grep confirms nothing imports it — a non-event.
- No package currently references the project-trust APIs (`project_trust`, `ctx.isProjectTrusted()`, `defaultProjectTrust`).
- `pi-subagents` carries the repo's only build step (`rollup -c rollup.dts.config.mjs` → `dist/public.d.ts`); a `rollup` bump must be followed by `pnpm run verify:public-types`.
- `minimumReleaseAge` is currently unset in this repo (`pnpm config get minimumReleaseAge` → `undefined`), so installing the recently published targets is not gated locally.
  The `minimumReleaseAgeExclude` list in `pnpm-workspace.yaml` exists but no active age gate consumes it.
- AGENTS.md constraint: `linkWorkspacePackages: false` — `pi-subagents-worktrees` resolves `@gotgenes/pi-subagents` from the published registry tarball, not a workspace symlink, so `pnpm install` after the floor bump pulls the real `15.0.1` release.
- AGENTS.md constraint: any new internal docs subdirectory must be added to `exclude-paths` in `release-please-config.json`.
  `packages/pi-permission-system/docs/decisions` is **not** currently excluded.

## Design Overview

Per-dependency decision model:

| Dependency                        | Packages                                                                             | From                   | To                     | Kind          | Release impact        |
| --------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- | ---------------------- | ------------- | --------------------- |
| `@earendil-works/pi-ai`           | `pi-session-tools`, `pi-subagents`                                                   | `0.75.4`               | `0.79.1`               | devDep        | `chore(deps)` → patch |
| `@earendil-works/pi-coding-agent` | `pi-autoformat`, `pi-colgrep`, `pi-github-tools`, `pi-session-tools`, `pi-subagents` | `0.75.4`               | `0.79.1`               | devDep        | `chore(deps)` → patch |
| `@earendil-works/pi-tui`          | `pi-colgrep`, `pi-subagents`                                                         | `0.75.4`               | `0.79.1`               | devDep        | `chore(deps)` → patch |
| `@gotgenes/pi-subagents`          | `pi-subagents-worktrees`                                                             | `^12.1.0` / `>=12.1.0` | `^15.0.1` / `>=15.0.0` | devDep + peer | `chore(deps)` → patch |
| `typebox`                         | `pi-colgrep`, `pi-github-tools`                                                      | `^1.1.38`              | `^1.2.8`               | devDep        | `chore(deps)` → patch |
| `rollup`                          | `pi-subagents`                                                                       | `^4.60.4`              | `^4.61.1`              | devDep        | `chore(deps)` → patch |
| `@types/node`                     | all (catalog)                                                                        | `^22.15.3`             | unchanged              | —             | none                  |

Each `chore(deps)` commit triggers a patch release for the affected package(s) — consistent with the existing `15.0.1` release, which was itself a `chore(deps)` patch.

The project-trust deliverable is an investigation that ends in a recorded decision, not code.
The investigation evaluates whether `pi-permission-system` should consume `ctx.isProjectTrusted()` / the `project_trust` event / the `defaultProjectTrust` setting, or continue relying on implicit trust when loading project-local resources.
The output is a decision document at `packages/pi-permission-system/docs/decisions/0001-project-trust-adoption.md`.

The worktrees floor bump is a pure version change — no call-site updates, since `WorktreeWorkspaceProvider implements WorkspaceProvider` and that interface is unchanged from `12.1.0` through `15.0.1`:

```typescript
// packages/pi-subagents-worktrees/src/index.ts — unchanged behavior
const service = ctx.getService<SubagentsService>(SUBAGENTS_SERVICE);
const unregister = service.registerWorkspaceProvider(
  new WorktreeWorkspaceProvider(config),
);
```

## Module-Level Changes

1. `packages/pi-autoformat/package.json` — `devDependencies`: `@earendil-works/pi-coding-agent` `0.75.4` → `0.79.1`.
2. `packages/pi-colgrep/package.json` — `devDependencies`: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `0.75.4` → `0.79.1`; `typebox` `^1.1.38` → `^1.2.8`.
3. `packages/pi-github-tools/package.json` — `devDependencies`: `@earendil-works/pi-coding-agent` `0.75.4` → `0.79.1`; `typebox` `^1.1.38` → `^1.2.8`.
4. `packages/pi-session-tools/package.json` — `devDependencies`: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` `0.75.4` → `0.79.1`.
5. `packages/pi-subagents/package.json` — `devDependencies`: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` `0.75.4` → `0.79.1`; `rollup` `^4.60.4` → `^4.61.1`.
6. `packages/pi-subagents-worktrees/package.json` — `devDependencies`: `@gotgenes/pi-subagents` `^12.1.0` → `^15.0.1`; `peerDependencies`: `@gotgenes/pi-subagents` `>=12.1.0` → `>=15.0.0`.
7. `pnpm-lock.yaml` — regenerated by `pnpm install` for each bump.
8. `packages/pi-permission-system/docs/decisions/0001-project-trust-adoption.md` — new decision document (created in the investigation step).
9. `release-please-config.json` — add `packages/pi-permission-system/docs/decisions` to `exclude-paths` so the decision doc does not trigger a permission-system release.

No `src/` or `test/` changes are anticipated.
If the SDK bump surfaces a type error against the `0.79.x` API, fold the minimal fix into the SDK-bump step.

## Test Impact Analysis

This is a dependency-and-docs change, so the standard extraction/refactor test analysis does not apply.

1. No new unit tests are warranted — there is no new behavior or extracted unit.
2. No existing tests become redundant.
3. The existing suites stay as-is and serve as the regression gate: the full `pnpm -r run test` run (including `pi-subagents`'s ~973-test suite and the worktree integration tests) is the verification that the newer SDK and sibling majors do not regress assembly, lifecycle, or worktree behavior.

The verification command set per the issue's testing plan is: `pnpm -r run check`, `pnpm run lint`, `pnpm -r run test`, `pnpm fallow dead-code`, plus `pnpm -C packages/pi-subagents run verify:public-types` after the `rollup` bump.

## Build Order

This is a build-style plan (dependency + docs), so the next step is `/build-plan`, not `/tdd-plan` — there are no red→green test cycles.
Each step is a bump → verify → commit cycle; every step runs `pnpm install` to refresh `pnpm-lock.yaml` and the listed verification gates before committing.

1. **Pi SDK trio.**
   Bump `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` to `0.79.1` across `pi-autoformat`, `pi-colgrep`, `pi-github-tools`, `pi-session-tools`, `pi-subagents`.
   Run `pnpm install`, `pnpm -r run check`, `pnpm run lint`, `pnpm -r run test`, `pnpm fallow dead-code`.
   Confirm nothing imports the removed `./hooks` subpath.
   Commit: `chore(deps): bump Pi SDK to 0.79.1 (#370)`.
2. **pi-subagents-worktrees sibling floor.**
   Bump the `@gotgenes/pi-subagents` devDependency to `^15.0.1` and the peer floor to `>=15.0.0`.
   Run `pnpm install`, then the worktree integration tests (`pnpm -C packages/pi-subagents-worktrees run test`) plus `pnpm -r run check`.
   Commit: `chore(deps): bump @gotgenes/pi-subagents to 15 in worktrees (#370)`.
3. **typebox.**
   Bump `typebox` to `^1.2.8` in `pi-colgrep` and `pi-github-tools`.
   Run `pnpm install`, `pnpm -r run check`, `pnpm -r run test` for both packages (schema validation paths in particular).
   Commit: `chore(deps): bump typebox to 1.2.8 (#370)`.
4. **rollup.**
   Bump `rollup` to `^4.61.1` in `pi-subagents`.
   Run `pnpm install`, `pnpm -C packages/pi-subagents run build:types`, and `pnpm -C packages/pi-subagents run verify:public-types`.
   Commit: `chore(deps): bump rollup to 4.61.1 (#370)`.
5. **Project-trust investigation + decision record.**
   Evaluate the `project_trust` event, `ctx.isProjectTrusted()`, and `defaultProjectTrust` against `pi-permission-system`'s project-local loading.
   Write `packages/pi-permission-system/docs/decisions/0001-project-trust-adoption.md` with the findings and the adopt/defer decision.
   Add `packages/pi-permission-system/docs/decisions` to `exclude-paths` in `release-please-config.json`.
   Commit: `docs(pi-permission-system): record project-trust adoption decision (#370)`.

## Risks and Mitigations

- **SDK 0.79.x type drift** — the newer API may surface type errors during `check`.
  Mitigation: run `pnpm -r run check` in step 1 before committing; fold any minimal source fix into the same step.
- **Worktree behavior against pi-subagents 15** — the `15.0.0` append-prompt-mode default is behavioral, not API-level.
  Mitigation: the worktree integration tests in step 2 exercise the seam against the real published `15.0.1` tarball (registry, not symlink).
- **rollup dts-bundle regression** — a `rollup` bump could change the generated `dist/public.d.ts`.
  Mitigation: step 4 runs `verify:public-types`, which packs the tarball and type-checks a throwaway consumer.
- **Recently published targets** — `pi-subagents@15.0.1`, `typebox@1.2.8`, and `pi-coding-agent@0.79.1` are only days old.
  Mitigation: `minimumReleaseAge` is currently unset, so installs proceed; if a global age gate is active in CI, add the new pins to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
- **Missing exclude-path** — a decision doc under an unexcluded `docs/decisions/` would trigger a spurious permission-system release.
  Mitigation: step 5 adds the path to `exclude-paths` in the same commit as the doc.

## Open Questions

- Does the project-trust investigation conclude in adoption or deferral?
  Resolved during step 5; the decision doc captures the outcome and any follow-up issue.

[#360]: https://github.com/gotgenes/pi-packages/issues/360
[#382]: https://github.com/gotgenes/pi-packages/issues/382
