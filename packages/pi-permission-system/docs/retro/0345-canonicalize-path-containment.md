---
issue: 345
issue_title: "external_directory gate uses lexical path normalization (no symlink resolution) — in-cwd symlink escapes the cwd boundary"
---

# Retro: #345 — Canonicalize paths before the external-directory containment check

## Stage: Planning (2026-06-08T21:59:34Z)

### Session summary

Planned a fix for the lexical-containment flaw in the `external_directory` gate: containment is decided on lexically-normalized paths with no symlink resolution, so an in-cwd symlink escapes cwd (symptom 1) and a symlinked cwd flags its own paths as external (symptom 2).
The plan introduces a best-effort `canonicalizePath` helper (`src/canonicalize-path.ts`) and routes both containment computations — `isPathOutsideWorkingDirectory` (tool-call surface) and `BashProgram.externalPaths` (bash surface) — through it.
Filed at `packages/pi-permission-system/docs/plans/0345-canonicalize-path-containment.md`.

### Observations

- Both reported repros (`cat ./link/hosts`, `/tmp/...`) actually run through `bash` → `BashProgram.externalPaths`, not the tool-call gate; the tool-call gate (`isPathOutsideWorkingDirectory`, used by `read`/`write`/`edit`/`find`/`grep`/`ls`) carries the identical flaw.
  User confirmed fixing both surfaces.
- Issue [#350] already shipped `$HOME` expansion in `normalizePathForComparison`, so the "secondary gap" the issue mentions is already closed — the plan only addresses symlink canonicalization.
- IO approach decided via `ask_user`: direct `fs.realpathSync` in a small isolated module, tested with `vi.mock("node:fs")` (mirroring the existing `node:os` mock in `path-utils.test.ts`), rather than threading a `realpath` dependency through the pipeline.
  User pushed back on DI threading as overkill and was right that vitest can mock the builtin.
- Key safety property: the best-effort walk-up returns the lexical input unchanged when no ancestor exists, so the integration tests that use synthetic non-existent paths (`/test/project`) keep current behavior with no mock and need no edits.
- Kept `normalizePathForComparison` lexical (skill-read / skill-prompt matching is not a security boundary); canonicalization is surgical to the two containment paths.
- Deferred (Non-Goals): the optional path-pattern deny-evasion surface (symlink alias vs `*.env`) and skill-read canonicalization.
- TOCTOU is inherent and accepted — the fix narrows the gap, does not close it.
