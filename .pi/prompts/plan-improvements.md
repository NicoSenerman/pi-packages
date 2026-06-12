---
description: Run fallow analysis, trace from index.ts outward, and propose the next improvement phase
---

# Plan the next improvement round

Package: `$1`

Your job is to analyze the package, identify structural improvements, and propose a numbered phase plan.
Do **not** start implementation — only produce the analysis and plan.

## Sync with remote (do this first)

1. Run `git pull --ff-only`.
2. If it fails for **any** reason — uncommitted changes, divergent history, merge conflict, network error, detached HEAD — stop immediately and report the failure to the user.
   Do not attempt to stash, rebase, force, or otherwise resolve.
3. Only proceed once the pull reports a clean fast-forward (or `Already up to date.`).

## Load skills

Load these skills before starting analysis:

- `improvement-discovery` — heuristics, smell taxonomy, prioritization framework.
- `fallow` — how to run and interpret fallow output.
- `package-<PKG>` — package-specific context (replace `<PKG>` with `$1`).
- `code-design` — design principles and structural heuristics.
- `markdown-conventions` — for the output document.

## Analysis (follow the improvement-discovery workflow)

### Step 1: Run fallow

Run the full fallow suite for the package, from the repo root — the `fallow:*` scripts exist only in the root `package.json`, and `--workspace` scopes the analysis:

```bash
pnpm fallow health --score --hotspots --targets --workspace @gotgenes/$1 2>&1 || true
pnpm fallow dead-code --workspace @gotgenes/$1 2>&1 || true
pnpm fallow dupes --workspace @gotgenes/$1 2>&1 || true
```

Record: health score, dead code findings, production/test duplication, hotspots, refactoring targets.

### Step 2: Read the architecture document

Read `packages/$1/docs/architecture/architecture.md`.
Note:

- Current health metrics table
- Dependency bag inventory — which are marked done vs. open
- Complexity hotspots
- Churn hotspots

Determine the next phase number N (last completed phase + 1), then immediately call `set_session_name` with `$1 — Phase N Planning` so the session is labelled for the rest of the work.

If the architecture document already declares a direction for Phase N (e.g. a deferred phase), treat it as a hypothesis, not a commitment — confirm the focus with the user (`ask_user`) before deep-tracing in that direction, and let the discovery findings decide.

### Step 3: Trace from entry point outward

Read `packages/$1/src/index.ts` and trace its dependency graph:

- For each import, read the target module
- Note size, exports, fan-out, code smells
- Pay special attention to: `as any` casts, adapter closure density, forward references, wide parameter lists, mixed responsibilities, anemic domain objects (data classes that a manager reaches into instead of telling)

### Step 4: Read the tests as evidence of constructibility

`fallow`'s metrics miss god objects, closure density, and DIP violations.
Read the largest test files and `test/helpers/`: module-level `vi.mock`, wide `as unknown as` casts, and multi-field fixtures (a `makeX` stubbing 10+ methods, or one mock passed to a constructor several times) mean the production object is hard to construct — a production smell, not a test-tree problem.
Do not accept the architecture doc's self-justification for a smell at face value; verify the claim against the code and tests.
When the analysis touches handler wiring or shared interfaces, load the `design-review` skill before writing the plan.

### Step 5: Apply the smell taxonomy

For each finding, classify it using the taxonomy from the `improvement-discovery` skill (Category A–E).
Score each on Impact (1–5) and Risk (1–5).
Compute Priority = Impact × (6 − Risk).

### Step 6: Propose the phase plan

Group findings into issue-sized steps (max 9 per phase).
Identify dependency ordering and parallel tracks.

## Output

Write the proposed plan as a new section in `packages/$1/docs/architecture/architecture.md`, replacing the existing "Improvement roadmap" section header with the next phase number.

The section should include:

1. A summary of findings (updated health metrics table).
2. Numbered steps with:
   - Title
   - Target files/functions
   - Smell category addressed
   - Expected measurable outcome
3. Step dependency diagram (Mermaid flowchart).
4. Named parallel tracks.

After writing the plan, present a summary to the user and ask whether to commit.
If confirmed, commit with:

```bash
git add packages/$1/docs/architecture/architecture.md
git commit -m "docs($1): propose Phase N improvement roadmap"
git push
```

## File the issues

The roadmap is not done until each step has a GitHub issue and the document links back to it.
After the plan is committed, ask whether to file the issues now; if confirmed:

1. Load the `github-voice` skill, then file the issues **one `gh issue create --label "enhancement,pkg:$1"` call per issue**, with the title and `--body-file` paired literally in the same command — never via shell-array index arithmetic (the shell is zsh; its 1-indexed arrays silently shift titles relative to bodies).
   Run `gh` from the repo root (it must execute inside the repository).
   Use the repo's `## What` / `## Why` / `## Proposed change` / `## Context` sections, referencing cross-step dependencies as "Phase N Step M" prose, not hardcoded numbers (the issue numbers are not known until filed).
2. Verify each created issue's title matches its body before continuing.
3. Link the doc back: append `([#N])` to each step heading, add `(#N)` to each Mermaid node, and add reference-link definitions at the end of the file.
4. Commit with `docs($1): link Phase N roadmap steps to issues #A-#B` and push.

Finally, restate the recommended working sequence: list the issues as `#N — title` lines in dependency order (a topological order of the step diagram), noting which can proceed in parallel and which are blocked until an earlier one lands.
Then stop.
