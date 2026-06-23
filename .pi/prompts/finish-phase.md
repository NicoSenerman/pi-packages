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
- Any **follow-on** issues the phase spawned (later-resolved cleanups, deferred migrations that landed after a step shipped — e.g. a builder unification or a sibling-package migration).
  They are non-gating but belong in the archive's issue table; record them under a separate "follow-on" grouping rather than as steps.

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

### Deriving the delivered numbers

Do not copy a doc metric forward — recompute it:

- Run `pnpm fallow:health` and `pnpm fallow:dupes --workspace @gotgenes/$1` for the current health score, LOC, dead code, and duplication.
  The fallow scripts are root-level and take `--workspace @gotgenes/$1`; the `--filter`/`-C package` forms used elsewhere do **not** apply to them.
- "Total LOC" / "Source LOC" counts `src/` only (`find packages/$1/src -name '*.ts' | wc -l` for the file count; `… -exec wc -l {} +` for LOC).
  Test counts come from `pnpm --filter @gotgenes/$1 run test`.
- If a doc metric carries a mid-phase label ("as of Step N", "Phase N Step M"), replace it with the end-of-phase value and drop the label — the archived doc should read as the settled post-phase baseline, not a snapshot.

### Stop versus fix

Stale counts, files missing from the layout tree, and mid-phase labels are **expected drift** — fix them in place; that is the job of this step.
Stop and report **only** when a documented `Outcome:` / `Landed:` claim is contradicted by the code: a symbol that should be gone still exists, a field documented as "mandatory" is still optional, a module said to be removed is still present.
That is an outcome failure — do not paper over it in the archive.

## Step 4: Archive the phase

Follow the package's **existing** convention — read `history/` and the document's "Refactoring history" section first, and match the established style (pi-subagents uses a Phase/Title/Status table plus a structural-issues table; pi-permission-system uses prose `### Phase N (complete)` subsections).
Do not impose a new format.

1. Create `packages/$1/docs/architecture/history/phase-N-<slug>.md` (create the `history/` directory if the package does not have one yet) and move the **full** detailed roadmap — findings table, numbered steps with outcomes, dependency diagram, and tracks — into it.
   Move the prose verbatim, but **rebase link targets**: same-doc anchors become `../architecture.md#…`, and relative paths gain one `../` level (`../decisions/…` → `../../decisions/…`).
   "Verbatim" applies to the words, not the paths — an un-rebased anchor dangles silently.
   Mechanics: author the history file fresh with the `Write` tool, then delete the roadmap from `architecture.md` with a scripted start/end-marker replacement (a small `python3` or `sed` block keyed on the section heading and the next `##` heading).
   Do **not** attempt an `Edit` `oldText` match on the roadmap block — it is typically multiple KB and the match is impractical and error-prone.
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
2. Confirm the move is loss-free with deterministic checks against the history file rather than eyeballing:
   - `grep -c '^### Step' …/history/phase-N-<slug>.md` equals the step count.
   - `grep -c '```mermaid' …` accounts for the dependency diagram (and any others moved).
   - the tracks table and findings table are present.
   - `architecture.md` retains only the concise summary (the `^### Step` count there is now 0).
   Also confirm the package skill (`.pi/skills/package-$1/SKILL.md`) — note any stale phase-scored numbers it carries (test counts, file/domain counts); flag them in the hand-off but do not necessarily fix them here.
3. Once checks pass, commit and push automatically:

```bash
git add packages/$1/docs/architecture/architecture.md packages/$1/docs/architecture/history/phase-N-<slug>.md
git commit -m "docs($1): archive Phase N to history"
git push
```

Use the real phase number and slug in the commit subject and `git add` paths.
The archive commit does two things — archive **and** reconcile — so summarise the reconciliation in the body (metric refreshes, layout-tree additions, file-count corrections), since that is the more reviewable half.
Do not put `Closes #N` / `Fixes #N` in the message — reference issues as `Refs #A, #Z` in the body if useful (these issues are already closed).

## Hand off

After the push succeeds, report:

- The archived phase (number, title, history file path).
- The closed issues it covered (steps and any follow-on issues).
- Any stale phase-scored numbers noted in the package skill (`.pi/skills/package-$1/SKILL.md`) that a future pass should refresh.
- A reminder to run `/plan-improvements $1` to scope the next round.

Then stop.
Do not propose the next phase.
