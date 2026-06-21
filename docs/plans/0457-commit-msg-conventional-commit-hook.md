---
issue: 457
issue_title: "Add a commit-msg hook to validate Conventional Commit headers"
---

# Add a commit-msg hook to validate Conventional Commit headers

## Release Recommendation

**Release:** ship independently

This change touches only repo-root tooling (`prek.toml`, root `package.json`, a new root commitlint config, `README.md`, `AGENTS.md`).
It changes no package source, so release-please cuts no package version — there is nothing to batch.
The `pkg:pi-permission-system` label is incongruent: it was applied because the motivating incident (#452) was a permission-system release, but the gate is monorepo-wide infra, so this is a repo-root plan in `docs/plans/`.

## Problem Statement

During the #452 release, a commit headed `fix!(pi-permission-system):` shipped a breaking change as a minor bump (`15.1.0`) instead of a major (`16.0.0`).
The `!` was placed before the scope.
That form does not match the Conventional Commits header grammar (`type(scope)!:`, not `type!(scope):`), so release-please silently dropped the commit — no changelog entry and no major bump — even though it carried a `BREAKING CHANGE:` footer.
Recovery required a roll-forward to `16.0.0` and a manual `npm deprecate` of `15.1.0`.

Nothing currently checks commit-message grammar.
The existing prek hooks cover formatting and lint; both downstream backstops missed this one (the `pre-completion-reviewer` validated the malformed form as a "valid breaking-change form", and `/ship-issue` never checks the version bump against the commit types).
A deterministic commit-time check is stronger than either prompt-level reminder and would have caught the mistake at the point it was made.

## Goals

- Add a `commit-msg` git hook, wired through the repo's existing `prek` framework, that validates each commit header against the Conventional Commits grammar before the commit lands.
- Reject the malformed `type!(scope):` form while accepting the correct `type(scope)!:` form and a bare `type!:`.
- Keep the accepted type set aligned with what release-please recognizes, so the hook and the release tooling agree.
- Wire installation into the existing `pnpm install` → `prepare` → `prek install` path so contributors get the hook with no extra step.
- Update `AGENTS.md` and `README.md` so the `!`-after-scope rule is now backed by a gate, not just guidance.

This change is **not** breaking: it adds a local developer gate and changes no package's observable behavior, output, or defaults.

## Non-Goals

- A CI-side commitlint job (see Open Questions) — the issue scopes the ask to a local `commit-msg` hook, and the standard workflow commits directly to a linear `main` with no PR to lint.
- A scope allow-list (`scope-enum`) — scope is left free-form (see Design Overview); catching scope typos is a separate concern from the `!`-placement bug.
- Changing any package source, version, or release configuration.
- Reworking the existing `pre-commit` hooks (biome, eslint, rumdl, builtin fixers) — they stay as-is.

## Background

- The repo manages git hooks with [`prek`](https://prek.j178.dev) (a Rust, pre-commit-compatible framework), configured in `prek.toml` at the repo root.
  The current config installs a `pre-commit` stage with `trailing-whitespace`, `end-of-file-fixer`, `check-added-large-files` (builtin), local `biome` and `eslint` hooks, and a remote `rumdl-fmt` hook.
- The root `package.json` `prepare` script runs `prek install` on `pnpm install`, so hooks are wired automatically.
  `prek install` installs only the `pre-commit` shim by default; the `commit-msg` shim must be requested.
- prek supports the top-level `default_install_hook_types` key (verified against the prek configuration reference), so adding `["pre-commit", "commit-msg"]` makes the existing `prek install` install both shims with no change to the `prepare` script's invocation.
- prek's `commit-msg` stage passes **Git's commit message file** as the hook's candidate filename (not repository file paths).
- The repo uses **git worktrees** for parallel sessions (`scripts/worktree-new.sh`), where `.git` is a file pointing at a separate gitdir.
  A hook that relied on commitlint's `.git/COMMIT_EDITMSG` fallback would read the wrong path in a worktree, so the hook must pass the real message-file path through.
- release-please's recognized commit types (from `release-please-config.json` `changelog-sections`) are exactly: `feat`, `fix`, `perf`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci`.
  This set is identical to `@commitlint/config-conventional`'s default `type-enum`, so the default config already agrees with the release tooling — no custom `type-enum` is needed.
- AGENTS.md (the "Commits" section) already documents the `!`-after-scope rule (Refs #452) as guidance.

## Design Overview

### Why the default config catches the bug

`@commitlint/config-conventional` parses the header with the conventional-commits header pattern (roughly `^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$`).

| Header                 | Parse result                                                                                                                                                                         | Verdict  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `fix!(scope): subject` | `(` does not follow `fix` (a `!` does), and `:` does not follow the `!` (a `(scope)` does) — the header pattern fails to match, so commitlint reports `type-empty` / `subject-empty` | rejected |
| `fix(scope)!: subject` | type `fix`, scope `scope`, breaking `!`, subject present                                                                                                                             | accepted |
| `fix!: subject`        | type `fix`, no scope, breaking `!`, subject present                                                                                                                                  | accepted |

So the malformed `type!(scope):` form is rejected by the default config, and both correct breaking forms are accepted, with no custom rule required.
This is the exact behavior the issue asks to confirm.

### Config shape

A root `.commitlintrc.json` extends config-conventional and applies a single override:

```json
{
  "extends": ["@commitlint/config-conventional"],
  "rules": {
    "header-max-length": [2, "always", 120]
  }
}
```

`header-max-length` is raised from the default 100 to 120 because the repo's real commit style (long package scopes like `pi-permission-system` plus `(#NNN)` issue refs) routinely approaches the limit — the longest recent subject is 101 chars and several sit at exactly 100.
All other config-conventional defaults are kept: `type-enum` (aligned with release-please), `subject-case` (the repo's lowercase-leading subjects pass), `subject-empty`, `subject-full-stop`, `type-empty`, `type-case`, and the body/footer length rules (commit bodies wrap at ~80 chars, well under the 100 default, so no relaxation is needed there).

Scope is left **free-form** (no `scope-enum`): config-conventional does not enforce a scope allow-list by default, which trivially satisfies "agree with release-please" (the hook is never more restrictive than the release tooling) and avoids false rejections on the many root commits that carry no scope (`docs:`, `feat:`) or non-package scopes (`docs(retro):`).

### Hook wiring

`prek.toml` gains a top-level `default_install_hook_types` and a new `local` repo entry scoped to the `commit-msg` stage:

```toml
default_install_hook_types = ["pre-commit", "commit-msg"]

[[repos]]
repo = "local"
hooks = [
    { id = "commitlint", name = "commitlint", entry = "pnpm exec commitlint --edit", language = "system", stages = ["commit-msg"] },
]
```

With `pass_filenames` left at its default (`true`), prek appends the commit-message file path to the entry, so the hook runs `pnpm exec commitlint --edit <msgfile>` — commitlint reads the exact file prek hands it, which is correct in both normal checkouts and worktrees.
`@commitlint/cli` is invoked via `pnpm exec`, matching the existing `biome`/`eslint` local hooks, so no global install is required.

### Verification approach (no unit-test framework at root)

There is no test runner at the repo root, so correctness is confirmed by running commitlint directly during the build:

1. Pipe each sample header through `pnpm exec commitlint` and assert the exit code (`type!(scope):` → non-zero; `type(scope)!:`, `type!:` → zero).
2. Lint a window of real history (`pnpm exec commitlint --from=HEAD~30 --to=HEAD`) to confirm the config does not reject the repo's existing commit style (in particular the #452 breaking-change footers and the 100-char subjects under the raised 120 limit).

## Module-Level Changes

- `package.json` (root) — add `@commitlint/cli` (`^19`) and `@commitlint/config-conventional` (`^19`) to `devDependencies`.
  No script change: `prepare` already runs `prek install`, which now installs the `commit-msg` shim via `default_install_hook_types`.
- `.commitlintrc.json` (new, root) — config extending `@commitlint/config-conventional` with `header-max-length` raised to 120.
- `prek.toml` (root) — add `default_install_hook_types = ["pre-commit", "commit-msg"]` and a new `local` repo entry with the `commitlint` hook scoped to `stages = ["commit-msg"]`.
- `pnpm-lock.yaml` — regenerated by `pnpm install` after the devDependency additions.
- `README.md` (root) — in the Development → Setup subsection, note that `pnpm install` wires the prek hooks, including a `commit-msg` hook that validates Conventional Commit headers.
- `AGENTS.md` (root, "Commits" section) — extend the existing `!`-after-scope rule (Refs #452) to note that a `commit-msg` commitlint hook now enforces it deterministically, so a malformed header fails locally before it can mis-version a release.

No package source, no `release-please-config.json`, and no `.release-please-manifest.json` changes (the new package wiring checklist in AGENTS.md does not apply — this adds no package).

## Test Impact Analysis

This is a tooling/config addition, not an extraction or refactor, so there are no existing unit tests to enable, simplify, or preserve.
The two commitlint verification commands above stand in for tests; they are run once during the build to confirm the config behaves as specified and does not regress on real history.
No `src/` or `test/` files change, so no existing test is affected.

## Invariants at risk

None.
The change adds an independent local gate and touches no surface a prior phase step refactored.
The existing `pre-commit` hooks (biome, eslint, rumdl, builtin fixers) are untouched and continue to run on the `pre-commit` stage; the new hook runs only on `commit-msg`, a separate stage.

## Build Order

This is a config/docs change with no red→green test cycles, so it proceeds as ordered build steps with explicit verify criteria.
The next workflow step is `/build-plan`.

1. **Add commitlint dependencies and config.**
   Add `@commitlint/cli` and `@commitlint/config-conventional` to root `devDependencies`; create `.commitlintrc.json` extending config-conventional with `header-max-length` 120; run `pnpm install` to update `pnpm-lock.yaml`.
   Verify: `pnpm exec commitlint --version` resolves; `printf 'fix!(x): y' | pnpm exec commitlint` exits non-zero; `printf 'fix(x)!: y' | pnpm exec commitlint` and `printf 'fix!: y' | pnpm exec commitlint` exit zero.
   Commit: `build: add commitlint with conventional-commits config (#457)`.

2. **Wire the commit-msg hook into prek.**
   Add `default_install_hook_types = ["pre-commit", "commit-msg"]` and the `local` `commitlint` hook (stage `commit-msg`) to `prek.toml`; run `prek install` (or `pnpm install` to re-run `prepare`) and confirm `.git/hooks/commit-msg` exists.
   Verify: an attempted commit with a `type!(scope):` header is rejected by the hook; a `type(scope)!:` header passes; `pnpm exec commitlint --from=HEAD~30 --to=HEAD` reports no errors on real history.
   Commit: `build: gate commit messages with a commit-msg commitlint hook (#457)`.

3. **Document the gate.**
   Add the Setup note in `README.md` and extend the `!`-after-scope rule in `AGENTS.md` to reference the new hook.
   Verify: `pnpm run lint` passes (biome + rumdl + eslint).
   Commit: `docs: document the commit-msg conventional-commit hook (#457)`.

Run `pnpm fallow dead-code` before the final push (CI gates on it) to confirm the new root devDependencies are not flagged; if they are, add them to `ignoreDependencies` in `.fallowrc.json` in the same commit that introduces them.

## Risks and Mitigations

- **Risk:** the raised `header-max-length` (120) still rejects an unusually long real subject.
  **Mitigation:** step 2 lints `HEAD~30..HEAD` to confirm the window passes; 120 clears the current 101-char maximum with headroom.
- **Risk:** config-conventional's body/footer length rules reject a long `BREAKING CHANGE:` footer.
  **Mitigation:** the repo wraps commit bodies at ~80 chars (verified across the last 30 commits), well under the 100 default; the history-lint in step 2 would surface any exception, at which point the rule can be relaxed.
- **Risk:** `prek install` does not pick up `default_install_hook_types` on an already-installed repo, leaving the `commit-msg` shim missing.
  **Mitigation:** step 2 explicitly re-runs `prek install` and checks for `.git/hooks/commit-msg`; a stale install is fixed by re-running it.
- **Risk:** `fallow dead-code` flags the new root devDependencies as unused (they are referenced by `prek.toml`/config, not imported by TS).
  **Mitigation:** the existing CLI-only root devDeps (biome, rumdl, fallow) are not flagged today, so commitlint should follow the same pattern; if flagged, add to `.fallowrc.json` `ignoreDependencies`.
- **Risk:** the hook is bypassable with `git commit --no-verify`.
  **Mitigation:** accepted — a local gate that catches the common mistake is the issue's scope; a CI backstop is recorded as an Open Question.

## Open Questions

- Should a CI commitlint job lint pushed commits as a second backstop?
  Deferred: the standard workflow pushes directly to a linear `main` (no PR to lint), and release-please already runs post-merge.
  A push-triggered commitlint check could flag a bad header post-hoc, but cannot prevent it the way the local hook does.
  Revisit if `--no-verify` bypasses recur.
- Should scope validation (`scope-enum`) be added later to catch package-name typos?
  Deferred per the design decision above; revisit only if scope typos cause a real mis-attribution.
