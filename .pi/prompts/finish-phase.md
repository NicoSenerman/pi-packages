---
model: anthropic/claude-sonnet-4-6
description: Verify the current improvement phase is complete, update docs, and archive its roadmap to history/
---

# Finish the current improvement phase

Package: `$1`

Your job is to close out the package's **current improvement phase**: confirm every step landed, bring the architecture document into agreement with the delivered code, and archive the phase's detailed roadmap into a per-phase history file.
Do **not** propose the next phase — that is `/plan-improvements`'s job.
Hand off to it at the end.

## Sync with remote (do this first)

1. Run `git pull --ff-only`.
2. If it fails for **any** reason — uncommitted changes, divergent history, merge conflict, network error, detached HEAD — stop immediately and report the failure to the user.
   Do not attempt to stash, rebase, force, or otherwise resolve.
3. Only proceed once the pull reports a clean fast-forward (or `Already up to date.`).

## Load skills

Load these skills before starting:

- `package-<PKG>` — package-specific context (replace `<PKG>` with `$1`).
- `markdown-conventions` — formatting rules for the architecture and history documents.
- `mermaid` — for any diagrams moved or updated.
- `code-design` — to judge whether the delivered code matches the phase's documented outcomes.

## Step 1: Identify the current phase

Read `packages/$1/docs/architecture/architecture.md` and locate the active **"Improvement roadmap (Phase N — …)"** section (or the package's equivalent open-phase section).

Record:

- The phase number N and its title/slug.
- The phase goal and the per-step outcomes (each `Outcome:` / `✅ Delivered` line).
- Every step's GitHub issue number.
- Any abandoned, superseded, parked, or closed-not-planned issues the phase references.

Then immediately call `set_session_name` with `$1 — Phase N Archive` so the session is labelled for the rest of the work.

If no open roadmap section exists (every phase is already archived), stop and report that there is nothing to finish.

## Step 2: Verify every step is complete (hard gate)

For each step issue recorded in Step 1, query its state:

```bash
gh issue view <N> --json number,state,title
```

This is a **hard gate**:

- If **any** step issue is still `OPEN`, stop immediately.
  List the open issues as `#N — title` and report that the phase cannot be archived until they are closed (or explicitly reclassified as abandoned/parked/not-planned in the roadmap).
  Do not archive.
- Treat issues the roadmap explicitly marks abandoned / superseded / parked / not-planned as expected non-blockers — note them, but they do not gate archiving.

Run `gh` from the repo root (it must execute inside the repository).

## Step 3: Reconcile the architecture document with delivered code

The architecture document describes the **current** architecture; after a phase lands it must match what shipped — not what was planned.

For each step outcome, verify the code agrees:

- Trace the named target files/modules/classes and confirm the documented end-state holds (renamed symbols, dropped fields, narrowed interfaces, removed modules).
- Update any stale prose in the body sections (target architecture, domain model, module structure, diagrams) that still describes the pre-phase state.
- Refresh any health-metrics or dependency-bag tables the phase was scored against, so the baseline reflects the delivered numbers.

If a step's documented outcome does not match the code, stop and report the discrepancy — do not paper over it in the archive.

## Step 4: Archive the phase

Follow the package's **existing** convention — read `history/` and the document's "Refactoring history" section first, and match the established style (pi-subagents uses a Phase/Title/Status table plus a structural-issues table; pi-permission-system uses prose `### Phase N (complete)` subsections).
Do not impose a new format.

1. Create `packages/$1/docs/architecture/history/phase-N-<slug>.md` (create the `history/` directory if the package does not have one yet) and move the **full** detailed roadmap — findings table, numbered steps with outcomes, dependency diagram, and tracks — into it verbatim.
2. In `architecture.md`, replace the detailed roadmap section with a concise completion summary that:
   - States the phase goal and what it delivered in a few sentences.
   - Lists the closed step issues (`All N steps are closed: [#A], …, [#Z].`).
   - Notes any abandoned / superseded / parked / not-planned issues.
   - Links to the new history file.
3. Update the "Refactoring history" table/section: mark Phase N **Complete**, link the new history file, and add it to any structural-refactoring-issues mapping table the package keeps.
4. Update the intro/summary line that enumerates completed phases (e.g. "Phases 1–N complete").
5. Use reference-style issue links (`[#N]` in the body, `[#N]:` definitions at the end of the file) per `markdown-conventions`, and verify every definition has a matching reference (MD053).

## Step 5: Verify and commit

1. Run `pnpm run lint` (or at least the markdown lint) to confirm the documents are clean — fix any `rumdl`/MD0xx findings.
2. Confirm the move is loss-free: every numbered step, its outcome, the dependency diagram, and the tracks now live in the history file, and `architecture.md` retains only the concise summary.
3. Once checks pass, commit and push automatically:

```bash
git add packages/$1/docs/architecture/architecture.md packages/$1/docs/architecture/history/phase-N-<slug>.md
git commit -m "docs($1): archive Phase N to history"
git push
```

Use the real phase number and slug in the commit subject and `git add` paths.
Do not put `Closes #N` / `Fixes #N` in the message — reference issues as `Refs #A, #Z` in the body if useful (these issues are already closed).

## Hand off

After the push succeeds, report:

- The archived phase (number, title, history file path).
- The closed issues it covered.
- A reminder to run `/plan-improvements $1` to scope the next round.

Then stop.
Do not propose the next phase.
