---
issue: 459
issue_title: "Allow commands scoped to subdirectories."
---

# Document treefmt for subdirectory-scoped formatters (#459)

## Release Recommendation

**Release:** ship independently

`pi-autoformat` has no architecture roadmap with release-batch annotations, and this is a self-contained documentation change.
It ships on its own cadence.

## Problem Statement

Issue #459 (filed by `michaelmior`, a third-party contributor) asks for the ability to scope different formatters to different subdirectories of a monorepo, and to run each formatter from the working directory of its subproject so it can pick up local config and construct commands relative to it.
The proposed mechanism is a new per-formatter `baseDir` key that would both (a) scope the formatter to files under that directory and (b) set the command's `cwd` to that directory.

The operator's decision (confirmed via the planning `Decide` gate) is **not** to add the `baseDir` runtime mechanism.
The capability already exists through the built-in `treefmt` formatter, which `pi-autoformat` shipped in plan `0015-builtin-treefmt-and-treefmt-nix-support.md`.
`treefmt`'s per-formatter `includes`/`excludes` glob rules express subdirectory scoping directly, and they handle the multi-subdirectory and batch-partitioning cases that a singular `baseDir` cannot.
This plan documents that path and closes the issue as solved by an existing feature.

## Goals

- Add a `docs/configuration.md` subsection that shows how to scope formatters to subdirectories (and to per-subproject tools) using `treefmt` with `includes`/`excludes`.
- Explain how local per-subproject tool config is resolved (formatters walk up the tree; `treefmt` runs from the discovered config root).
- Give a concrete monorepo example: `eslint` in one subproject, a different tool in another, wired through a `pi-autoformat` chain.
- Close #459 with a comment that points to the new documentation and explains why `baseDir` was declined.

## Non-Goals

- No `baseDir` config key, no per-formatter `cwd`/`workingDir` option, no scope-filter-per-formatter mechanism.
  The scope-filter half of `baseDir` is subsumed by `treefmt` `includes`; the `cwd` half is largely redundant because formatters discover their own config by walking up the tree.
- No change to `schemas/pi-autoformat.schema.json`, the config loader, the executor, or any other source module.
- No change to the existing built-in `treefmt`/`treefmt-nix` discovery or execution behavior.
- No new `treefmt` flags or capabilities; this documents the tool as it already integrates.

## Background

Relevant existing pieces:

- `docs/configuration.md` — the canonical config reference.
  It already has a `#### Built-in formatters` subsection (under `### chains`) describing `treefmt` and `treefmt-nix` discovery and skip semantics, and a `#### Wildcard chain key ('*')` subsection showing the `"*": [{ "fallback": ["treefmt-nix", "treefmt"] }]` dispatcher pattern.
  The new subdirectory-scoping content belongs adjacent to these so readers encounter it in the `treefmt` context.
- `src/builtin-formatters.ts` / the `treefmt` built-in — discovers `treefmt.toml` (preferred) or `.treefmt.toml` by walking up from each touched file, then invokes `treefmt --config-file <found> -- <paths...>` from the discovered root.
  This is the mechanism that makes per-subdirectory `includes` work: `treefmt` receives the touched paths and routes each to the formatters whose globs match.
- Package priority (from the `package-pi-autoformat` skill): *"When a config pattern or documented recommendation can solve a problem, prefer that over a new runtime mechanism.*
  *Mechanism is forever; docs are reversible."* and *"Trust formatters to discover their own project configs (most walk up the directory tree natively)."*
  This change is the direct application of both.

Constraint from AGENTS.md: do not edit `CHANGELOG.md` (release-please owns it).
`docs/configuration.md` is **not** in the package's `exclude-paths` (only `docs/assets`, `docs/plans`, `docs/retro` are), so the `docs:` commit is a normal tracked change; it does not trigger a version bump on its own under conventional-commit rules.

## Design Overview

The documentation presents `treefmt` as the supported answer to subdirectory-scoped formatting.
The core pattern: a single `treefmt.toml` at the relevant root declares one `[formatter.<name>]` table per tool, each constrained by `includes` (and optionally `excludes`) globs.
`treefmt` matches each touched file to the formatters whose globs cover it and runs each formatter against only its matching files — many subprojects, many tools, one pass.

Example `treefmt.toml` (the monorepo case from the issue — eslint for one subproject, a different tool for another):

```toml
[formatter.eslint]
command = "eslint"
options = ["--fix"]
includes = ["project/foo/**/*.{js,ts}"]

[formatter.prettier]
command = "prettier"
options = ["--write"]
includes = ["project/bar/**/*.{js,ts}"]
```

The matching `pi-autoformat` chain references the built-in `treefmt` dispatcher across the whole batch:

```json
{
  "chains": {
    "*": ["treefmt"]
  }
}
```

Documentation points to cover:

- **Subdirectory scoping** is expressed by `includes`/`excludes` globs, not by a `pi-autoformat` setting.
  A formatter runs only on the files its globs match, so the same tool name can serve multiple subprojects, and multiple tools can coexist under one config.
- **Per-subproject local config** is resolved by the formatters themselves (eslint, prettier, biome all walk up from each file to find their nearest config), consistent with the package's "trust formatters to discover their own project configs" stance.
  `treefmt` invokes from the discovered config root; the formatters resolve their own per-directory config from the file paths they receive.
- **Why not `baseDir`** — a short rationale paragraph: a singular `baseDir` cannot express one tool used by several subprojects without redeclaring the formatter under synthetic names, and the `pi-autoformat` batch-dispatch model (all touched files of a chain group passed to one invocation) conflicts with a single per-formatter `cwd` when a turn touches multiple subprojects.
  `treefmt`'s per-formatter `includes` plus its own per-formatter execution resolve both cleanly.

This is a pure-documentation change introducing no new collaborator, type, or runtime behavior, so the structural design heuristics (Tell-Don't-Ask, LoD, ISP, dependency width) do not apply — there is no code surface to review.

## Module-Level Changes

- `packages/pi-autoformat/docs/configuration.md` — **changed.**
  Add a new subsection documenting subdirectory-scoped formatting via `treefmt` `includes`/`excludes`, placed within the `### chains` section near the existing `#### Built-in formatters` / `#### Wildcard chain key` content (e.g. a `#### Scoping formatters to subdirectories (monorepos)` subsection).
  Include the `treefmt.toml` example, the `pi-autoformat` chain snippet, the local-config-discovery note, and the brief "why not a per-formatter `baseDir`" rationale.
- No source, schema, or test files change.
  `schemas/pi-autoformat.schema.json` stays as-is (no new property), and `test/schema.test.ts` / `test/config-loader.test.ts` remain valid because no config surface changed.
- No `README.md` change — its formatter/`treefmt` reference is a single link to `docs/configuration.md`, which already covers the new content by reference.

## Test Impact Analysis

This is a documentation-only change, so there are no red→green test cycles.

1. **New tests enabled:** none — no new code surface.
2. **Tests made redundant:** none.
3. **Tests that must stay as-is:** all existing tests stay unchanged.
   `test/schema.test.ts` and `test/config-loader.test.ts` continue to assert the current config surface; this plan deliberately does not alter that surface, so they must remain green without modification.
   `pnpm --filter @gotgenes/pi-autoformat run check` / `lint` / `test` should pass unchanged after the doc edit (markdown lint via `rumdl` is the only gate the edit touches).

## Build Steps

This plan is executed by `/build-plan` (docs-only, no test cycles).

1. Add the `#### Scoping formatters to subdirectories (monorepos)` subsection to `packages/pi-autoformat/docs/configuration.md` within the `### chains` section, adjacent to the existing `treefmt` built-in documentation.
   Cover: the `treefmt.toml` `includes`/`excludes` example, the `pi-autoformat` `"*": ["treefmt"]` chain snippet, the local-config-discovery note, and the "why not `baseDir`" rationale.
   Follow `markdown-conventions` (one sentence per line, fenced-block languages, compact tables).
   Run `pnpm --filter @gotgenes/pi-autoformat run lint` to confirm `rumdl` passes.
   Commit: `docs(pi-autoformat): document treefmt for subdirectory-scoped formatters (#459)`.

The issue is closed during `/ship-issue` (via `issue_close`) with a comment summarizing that subdirectory scoping is supported through `treefmt` `includes`/`excludes`, linking the new documentation, and noting that a `baseDir` mechanism was declined in favor of the existing tool.
Do not put a closing keyword in the commit message.

## Risks and Mitigations

- **Risk:** the documented `treefmt.toml` `includes`/`excludes` syntax drifts from upstream `treefmt`.
  **Mitigation:** keep the example minimal and canonical (`command`, `options`, `includes`), matching the form already validated by the built-in `treefmt` integration; do not document advanced/edge `treefmt` features.
- **Risk:** users read this as a `pi-autoformat` feature rather than a `treefmt` one and look for a `pi-autoformat` setting.
  **Mitigation:** state explicitly that scoping lives in `treefmt.toml`, not in `pi-autoformat` config, and that `pi-autoformat` only references the `treefmt` dispatcher.
- **Risk:** closing #459 without a code change disappoints the third-party author.
  **Mitigation:** the close comment explains the reasoning (multi-subdirectory and batch-dispatch limitations of singular `baseDir`) and gives a concrete, working alternative, so the underlying need is addressed.

## Open Questions

- Whether to also add a short cross-link from the `#### Wildcard chain key ('*')` subsection to the new monorepo subsection.
  Defer to build time; add only if it reads naturally and does not duplicate content.
