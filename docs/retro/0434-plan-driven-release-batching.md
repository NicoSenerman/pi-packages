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
