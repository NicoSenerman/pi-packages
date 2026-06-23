---
issue: 434
issue_title: "Plan-driven release batching: annotate batches in architecture docs, recommend in /plan-issue, confirm early in /ship-issue"
---

# Plan-driven release batching

## Release Recommendation

**Release:** ship independently

This issue is an ad-hoc workflow/tooling change, not a step in any package's architecture roadmap, so it carries no batch annotation and releases on its own. (It also touches only `.pi/` prompt and skill files plus `AGENTS.md`, none of which trigger a package release — see Background.)

## Problem Statement

Release batching is currently an ad-hoc question asked at ship time, not a decision recorded where tooling can read it.
`/ship-issue` step 4b infers whether to batch a release by phrase-matching the plan's framing ("step N of M", "phased roadmap", sibling `#M` issues) and then asks the user mid-flow.
The batch boundaries live nowhere structured, so the heuristic both over-fires (asking when a step was explicitly independently releasable) and under-fires (missing genuine batches whose framing does not match the phrases).
Shipping [#425] (Phase 18 Step 6) surfaced the over-fire: the step was marked "Independent of the disentanglement spine — can land at any time", yet the heuristic still asked whether to batch, and the operator reversed an initial "batch" choice once the consequence was visible.
The signal that should have driven the decision was already written down — just not anywhere the tooling could read deterministically, and the question arrived mid-flow rather than up front.

The fix threads a structured release-batch concept through three surfaces so the architecture document becomes the source of truth for release coordination, the plan carries a deterministic recommendation, and `/ship-issue` confirms (only when needed) before the irreversible push/CI work.

## Goals

- Define a grep-able, machine-readable vocabulary for release batches in architecture-doc roadmaps: a per-step `Release:` tag plus a `Release batches` subsection.
- Teach the architecture-authoring surfaces (`improvement-discovery` skill and `/plan-improvements`) to emit those annotations when drafting a phase's steps.
- Teach `/plan-issue` to read a phase's batch annotations, locate the current issue's step, and write a prominent `Release Recommendation` section into the plan — one of `ship independently`, `ship now — batch tail`, or `mid-batch — defer`.
- Replace `/ship-issue` step 4b's phrase-matching heuristic with a deterministic read of the plan's `Release Recommendation`, evaluated **early** (before `git pull`/push/CI), that asks the operator **only** when the recommendation is `mid-batch — defer`.
- Preserve backward compatibility: plans with no `Release Recommendation` default to releasing now with no question; steps with no `Release:` tag default to `ship independently`.

## Non-Goals

- No package source code or tests change — this is a `.pi/` prompt-and-skill plus `AGENTS.md` documentation change.
  The follow-up is `/build-plan`, not `/tdd-plan`.
- No change to `/finish-phase`: it archives the roadmap section verbatim, so per-step `Release:` tags travel into the history file with no special handling.
- No change to the deterministic "no releasing commit in range → release-please cuts nothing" check at the head of step 4b — it is correct and complementary, and stays.
- Not adding batch metadata to filed GitHub issues (`/plan-improvements`'s "File the issues" step) — the architecture doc and the plan remain the source of truth.
- Not retrofitting batch annotations onto already-written roadmaps (e.g. pi-subagents Phase 18); the vocabulary applies to roadmaps drafted from here forward, and the backward-compatible defaults cover the rest.

## Background

Relevant surfaces and how they relate:

- `.pi/skills/improvement-discovery/SKILL.md` — the heuristics skill loaded by `/plan-improvements`.
  Its "Output format" and "Grouping heuristics" sections define what a roadmap step looks like (Title, Target, Smell, Outcome) and how steps are grouped into parallel tracks.
  This is the natural home for the release-batch vocabulary definition.
- `.pi/prompts/plan-improvements.md` — drafts a phase's roadmap into `packages/<PKG>/docs/architecture/architecture.md`.
  Its "## Output" section lists what each numbered step must contain and what subsections the roadmap gets (step dependency diagram, parallel tracks).
- `.pi/prompts/plan-issue.md` — writes a per-issue plan to `docs/plans/` (this file's own producer).
  Its "Gather context" and "Write the plan" sections are where reading the batch annotations and emitting the `Release Recommendation` section belong.
- `.pi/prompts/ship-issue.md` — the consumer. "## 4b.
  Check for a stacked release" (lines 45–52) holds the deterministic no-releasing-commit check (keep) and the phrase-matching batch heuristic (replace).
- Existing roadmaps already express batch intent in prose: pi-subagents Phase 18 says "Steps 6–7 are independent hygiene" and its "Parallel tracks" list marks tracks "Independent; can land any time."
  This change converts that prose signal into a structured, grep-able form.

AGENTS.md constraints that apply:

- Commits that only touch excluded paths do not trigger releases; `.pi/` and root `docs/` are not package paths, so this change is itself non-releasing (consistent with the `Release Recommendation` above).
- Markdown must follow the `markdown-conventions` skill: one sentence per line, sequential list numbering restarting per heading, fenced-code languages, compact tables, and reference-style issue links in long-lived docs.

The `design-review` skill checklist targets code dependency/layer-wiring smells; this change introduces no code collaborators or shared interfaces, so the checklist does not apply.

## Design Overview

### Vocabulary (single source of truth: the architecture roadmap)

Two grep-able artifacts, both living in `packages/<PKG>/docs/architecture/architecture.md`.

1. A per-step `Release:` tag, emitted on its own line in each roadmap step alongside the existing `Smell:`/`Outcome:`/`Landed:` lines.
   Exactly one of:
   - `Release: independent` — the step ships on its own; no coordination.
   - `Release: batch "<batch-name>"` — the step is a member of the named batch and is meant to ship together with the rest of that batch.

2. A `Release batches` subsection, placed after "Parallel tracks" in the roadmap, that names each batch and lists its member steps in dependency order (the last listed member is the batch **tail** — the step whose landing completes the batch):

   ```markdown
   ### Release batches

   - **Batch "activity-disentanglement":** Steps 1, 2, 3, 4, 5 (ship together; tail = Step 5).
   - Independently releasable: Steps 6, 7, 8.
   ```

Agents locate the data by grepping for the `Release:` line (per step) and the `Release batches` heading (per phase) — no prose parsing.

### Recommendation derivation (`/plan-issue`)

`/plan-issue` computes the plan's `Release Recommendation` deterministically:

```text
1. Locate the issue's step in packages/<PKG>/docs/architecture/architecture.md
   (grep for the step's "(#<issue>)" / "[#<issue>]" reference).
2. If found, read its `Release:` tag:
   - "independent"        -> "ship independently"
   - "batch <name>"       -> look up <name> in the "Release batches" subsection;
                             if this step is the batch tail (last member)
                               -> "ship now — batch tail"
                             else
                               -> "mid-batch — defer"
3. If the issue is not in any roadmap (ad-hoc / third-party / no arch doc)
   -> default "ship independently".
```

The recommendation is written as a prominent `## Release Recommendation` section (first section after the H1, as in this plan), with a canonical grep-able marker line:

```markdown
## Release Recommendation

**Release:** ship independently
```

The three canonical `**Release:**` values:

- `**Release:** ship independently`
- `**Release:** ship now — batch "<name>" tail (this issue completes the batch)`
- `**Release:** mid-batch — defer (batch "<name>"); confirm at ship time`

### Consumption (`/ship-issue`): early gate + step 4b

The decision is **gathered up front** and **applied at the existing 4b location**, so the irreversible work (pull/push/CI) never runs before the operator has confirmed a deferral.

A new early section, placed before "## 1.
Sync with remote":

```text
## Release coordination (decide before step 1)

1. Locate the plan for issue $1:
     grep -rl "^issue: $1$" docs/plans packages/*/docs/plans
2. Read its `**Release:**` marker:
   - "mid-batch — defer"  -> ask the operator now: defer/batch, or release anyway?
                             Record the decision.
   - "ship independently" / "ship now — batch tail"
                          -> record "release now"; note the recommendation; do NOT ask.
   - no plan file, or no `**Release:**` marker
                          -> record "release now" (default); do NOT ask.
```

Step 4b is rewritten to:

- Keep the deterministic first paragraph (all-non-releasing range → release-please cuts nothing → skip the batch question and say so).
- Replace the phrase-matching paragraph with: apply the decision recorded in the early gate.
  If the recorded decision was defer/batch, stop here — push and CI are done; leave the issue open, skip steps 5–6, and note the deferral in the report.
  Otherwise continue.

This directly fixes the [#425] friction: an `independent`/tail recommendation proceeds to release with no prompt, and the only blocking question is the genuine `mid-batch — defer` case, surfaced from a deterministic source before the push.

### Edge cases

- Issue not part of a roadmap (this very issue, third-party feature requests): `/plan-issue` defaults to `ship independently`; `/ship-issue` releases with no question.
- Plan predates this change (no `Release Recommendation`): `/ship-issue` defaults to release now (no question) — matches the operator's chosen fallback.
- Step has no `Release:` tag in an otherwise-annotated roadmap: treat as `ship independently` (safe default — never silently batches).
- Batch tail already shipped out of order: the tail is positional (last listed member); `/plan-issue` records the recommendation from the doc as authored, and the `mid-batch — defer` confirmation remains the human gate for anything unusual.

## Module-Level Changes

- `.pi/skills/improvement-discovery/SKILL.md` — add the release-batch vocabulary: define what a release batch is, the per-step `Release: independent` / `Release: batch "<name>"` tag, and the `Release batches` subsection (with the tail = last-listed-member rule).
  Most natural home is the "Output format" section (it already enumerates per-step contents and roadmap subsections); cross-reference from "Grouping heuristics".
- `.pi/prompts/plan-improvements.md` — in "## Output", require each numbered step to carry a `Release:` tag and require the roadmap to include a `Release batches` subsection after "Parallel tracks".
- `.pi/prompts/plan-issue.md` — two edits: (1) add a "Gather context" sub-step to read the package roadmap's batch annotations and locate the issue's step; (2) add a `Release Recommendation` bullet to the "Write the plan" section list, with the derivation rules and the canonical `**Release:**` marker values.
- `.pi/prompts/ship-issue.md` — add the early "Release coordination" section before "## 1.
  Sync with remote"; rewrite "## 4b" to keep the deterministic check and apply the recorded decision (remove the phrase-matching paragraph).
- `AGENTS.md` — add a one-line note in the "Multi-session issue lifecycle" area that `/plan-issue` records a `Release Recommendation` (sourced from the architecture roadmap's batch annotations) and `/ship-issue` confirms it early, so future agents discover the mechanism.

Grep confirmation already performed: the phrase-matching heuristic exists only in `.pi/prompts/ship-issue.md` (lines 45–52).
The "phased roadmap" string in `.pi/agents/pre-completion-reviewer.md` is an unrelated invariant-checking reference and is **not** changed.
`AGENTS.md`'s other "batch" occurrences ("Edit tool batches") are unrelated and untouched.

## Test Impact Analysis

Not applicable — this change touches only prompt-template and skill markdown plus `AGENTS.md`.
There is no executable surface and no unit-test layer for `.pi/` prompts.
Verification is by `pnpm run lint` (rumdl markdown gate) and a manual dry-run grep that the canonical markers (`Release:`, `Release batches`, `**Release:**`) are present and consistently spelled across the four files.

## Invariants at risk

- The deterministic 4b check ("all-non-releasing range → skip") must survive the 4b rewrite — it is independent of batching and must keep short-circuiting the batch question when release-please would cut nothing.
  Pinned by keeping that paragraph verbatim in the rewrite (Step 4).
- The early gate must not introduce any irreversible action before "## 1.
  Sync with remote" — it only reads the plan file and (conditionally) asks.
  Pinned by placing it as a read-and-ask-only section with no git/push/CI calls.

## Build Order

This is a docs-only build plan (no red→green→commit test cycles); the executor is `/build-plan`.
Steps are ordered so the vocabulary is defined before the surfaces that reference it; each is an independent, reviewable `docs:` commit.

1. Define the release-batch vocabulary in `.pi/skills/improvement-discovery/SKILL.md`.
   Commit: `docs: define release-batch vocabulary in improvement-discovery skill (#434)`.
2. Require `Release:` tags and a `Release batches` subsection in `.pi/prompts/plan-improvements.md` output.
   Commit: `docs: annotate release batches in plan-improvements roadmap output (#434)`.
3. Add the batch read-step and the `Release Recommendation` plan section to `.pi/prompts/plan-issue.md`.
   Commit: `docs: recommend a release decision in plan-issue (#434)`.
4. Replace the phrase-matching heuristic with the early gate + recorded-decision 4b in `.pi/prompts/ship-issue.md`.
   Commit: `docs: confirm release batching early in ship-issue (#434)`.
5. Note the `Release Recommendation` mechanism in `AGENTS.md`.
   Commit: `docs: document plan-driven release batching in AGENTS.md (#434)`.

After each edit, run `pnpm run lint` to keep the rumdl markdown gate green; finish with a grep dry-run that the canonical markers are present and consistently spelled across all four `.pi/` files.

## Risks and Mitigations

- Risk: the four surfaces drift on the canonical strings (`Release:`, `**Release:**`, the three recommendation phrasings), defeating grep-ability.
  Mitigation: the `improvement-discovery` skill is the single definition; the prompts reference it and reuse the exact spellings; the closing grep dry-run checks consistency.
- Risk: the early gate runs before `git pull`, so it reads a possibly-stale plan file.
  Mitigation: the plan was committed in a prior planning session and the recommendation is stable; a `mid-batch — defer` still routes through a human confirmation, and the deterministic 4b check runs post-CI against the actual pushed range.
- Risk: over-narrowing the question reintroduces an under-fire (a genuine batch ships early because its plan lacks a recommendation).
  Mitigation: this is the operator's chosen fallback (default release now when absent); roadmaps drafted from here forward carry the annotation, and `mid-batch — defer` plans always gate.

## Open Questions

- Whether to backfill `Release:` annotations onto the in-flight pi-subagents Phase 18 roadmap is deferred — the backward-compatible defaults make it optional, and it can be a follow-up if the next ship of a Phase 18 step wants the deterministic path.

[#425]: https://github.com/gotgenes/pi-packages/issues/425
