---
issue: 434
issue_title: "Plan-driven release batching: annotate batches in architecture docs, recommend in /plan-issue, confirm early in /ship-issue"
---

# Retro: #434 — Plan-driven release batching

## Stage: Planning (2026-06-18T00:00:00Z)

### Session summary

Produced a docs-only build plan for threading a structured release-batch concept through three workflow surfaces: architecture-doc authoring (`improvement-discovery` skill + `/plan-improvements`), `/plan-issue` (writes a `Release Recommendation`), and `/ship-issue` (reads it, confirms early).
Confirmed via grep that the phrase-matching heuristic lives only in `.pi/prompts/ship-issue.md` (lines 45–52); the "phased roadmap" string in `pre-completion-reviewer.md` is unrelated and untouched.
Plan filed at `docs/plans/0434-plan-driven-release-batching.md`; the next step is `/build-plan` (no test cycles).

### Observations

- This is the operator's own issue (`gotgenes`), unambiguous in direction, so no third-party direction gate — but two genuine format/fallback choices were surfaced via `ask_user`.
- Decision 1 (`ask_user`): annotation format should be maximally grep-able → a per-step `Release: independent` / `Release: batch "<name>"` tag **plus** a `Release batches` subsection (tail = last-listed member).
- Decision 2 (`ask_user`): when a plan has no `Release Recommendation`, `/ship-issue` defaults to release-now with no question (removes the phrase-match heuristic for the absent case).
- Decision 3 (`ask_user` follow-up, the `#425` crux): `/ship-issue` blocks/asks **only** on `mid-batch — defer`; `ship independently` and `ship now (batch tail)` proceed to release with no prompt.
  This is the precise fix for the `#425` over-fire.
- Architecture: the roadmap is the single source of truth; `/plan-issue` derives the recommendation deterministically; `/ship-issue` gathers the decision in a new early section before `git pull` so no irreversible work precedes a deferral confirmation.
- Backward compatibility is load-bearing: missing `Release:` tag → `ship independently`; missing `Release Recommendation` → release now.
  Backfilling pi-subagents Phase 18 is deferred (Open Question).
- The `design-review` skill checklist was judged not applicable — no code collaborators or shared interfaces, purely prompt/skill markdown plus `AGENTS.md`.

## Stage: Implementation — Build (2026-06-18T00:00:00Z)

### Session summary

Executed all 5 build steps (docs-only, no test cycles): added the release-batch vocabulary to the `improvement-discovery` skill, required `Release:` tags + a `Release batches` subsection in `/plan-improvements`, added the recommendation derivation + `Release Recommendation` section to `/plan-issue`, replaced the `/ship-issue` step-4b phrase-match heuristic with an early read-and-confirm gate, and documented the mechanism in `AGENTS.md`.
All deterministic checks (`check`, `lint`, `test`, `fallow dead-code`) pass; `CHANGELOG.md` untouched.

### Observations

- Pre-completion reviewer: **WARN** (one non-blocking finding) — now resolved.
- Reviewer warning: the "ship now" pattern was phrased three slightly different ways (`ship now (batch tail)` in the plan Goals, `ship now — batch tail` in `ship-issue.md`, canonical marker `ship now — batch "<name>" tail` in `plan-issue.md`), undercutting the grep-ability premise.
  Fixed in commit `ec40e75b`: `ship-issue.md` now matches on the decisive `mid-batch — defer` substring (everything else → release now), and the plan Goals shorthand was normalized to the em-dash form.
- Behavior hinges only on detecting `mid-batch — defer` vs. everything else, so the label-vs-literal distinction between the recommendation label and the written `**Release:**` marker is intentional and safe.
- One extra commit beyond the planned 5 (the WARN fixup); no scope deviation otherwise.
- This issue is itself ad-hoc (not in any roadmap), so its own `Release Recommendation` is `ship independently` — it releases on its own once shipped.
- Closing grep dry-run confirmed the canonical markers (`Release:`, `Release batches`, `**Release:**`) are present and consistent across all four `.pi/` files.

## Stage: Final Retrospective (2026-06-18T17:30:20Z)

### Session summary

One continuous session carried #434 through planning, build, and ship: a docs-only change threading a grep-able release-batch concept through the `improvement-discovery` skill, `/plan-improvements`, `/plan-issue`, and `/ship-issue`, plus an `AGENTS.md` note.
The change was dogfooded by its own ship — the new `/ship-issue` early gate read the plan's `**Release:** ship independently` marker and proceeded without asking.
Seven build/plan commits landed; all `docs:` type, so release-please cut nothing (auto-batches until a `feat`/`fix` lands).

### Observations

#### What went well

- **Dogfooding closed the loop in-session** (novel) — the early release-coordination gate this issue *introduced* was exercised by the same issue's `/ship-issue`, reading its own `**Release:**` marker and correctly skipping the batch question.
  A workflow change validated by shipping itself.
- **Pre-completion reviewer earned its keep** — it caught a real cross-file consistency bug (the "ship now" marker phrased three ways) that directly undercut the grep-ability premise of the whole change; fixed in `ec40e75b` before push.
- **The planning `ask_user` gate front-loaded every ambiguity** — all three design decisions (annotation grep-ability, absent-plan fallback, the `#425` ask-trigger) were resolved up front, so build and ship ran with zero redirection.

#### What caused friction (agent side)

- `other` (Edit-tool schema misuse) — the `Edit` tool rejected two calls for extra keys: `oldText2`/`newText2` on the `improvement-discovery` skill edit, and `additionalProperties: false` on the `AGENTS.md` edit.
  Both self-identified and retried cleanly.
  Impact: 2 wasted tool calls, no content rework.
  Distinct from the existing "Edit tool batches" guidance, which covers match failures, not schema-key rejections.
- `other` (shell portability) — in the ship phase (running on `opencode-go/deepseek-v4-flash`), `grep -oP` failed (BSD/macOS grep has no `-P`) and a `gh issue view --jq` string-concat expression failed; both self-corrected in one retry each.
  Impact: 2 wasted tool calls, no rework.
- `premature-convergence` (mild) — the plan itself introduced the canonical release marker in three slightly different forms despite grep-ability being the point.
  Caught by the reviewer (the designed safety net), so borderline win/friction.
  Impact: 1 extra commit (`ec40e75b`).

#### What caused friction (user side)

- None — the up-front `ask_user` answers were sufficient for the agent to run all three stages without correction.

### Diagnostic details

- **Model-performance correlation** — planning ran on `anthropic/claude-opus-4-8` (judgment-heavy: design decisions + `ask_user` framing; appropriate); the ship phase ran entirely on `opencode-go/deepseek-v4-flash`.
  Ship is mostly mechanical, but its one judgment step (the release-coordination gate) was trivial here (`ship independently`), so the cheaper model was acceptable — though it produced both shell-portability errors above.
  A `mid-batch — defer` marker (real batching judgment) would have wanted stronger reasoning on that step.
- **Escalation-delay tracking** — no `rabbit-hole`s; the longest same-error streak was a single retry.
  Nothing to flag.
- **Unused-tool detection** — no `missing-context` gaps; the `.pi/` files were familiar, so `colgrep`/`Explore` were correctly unnecessary.
- **Feedback-loop gap analysis** — `pnpm run lint` ran after *every* build step (incremental, not end-only); `test`/`check` were correctly skipped (docs-only).
  Clean verification cadence.

### Changes made

1. `docs/retro/0434-plan-driven-release-batching.md` — appended this Final Retrospective stage entry.
2. Proposed an `AGENTS.md` Edit-schema note (extra `edits[]` keys reject the whole call); the operator declined it as a one-off, so the slip is recorded only as a friction observation above — no `AGENTS.md` change.
