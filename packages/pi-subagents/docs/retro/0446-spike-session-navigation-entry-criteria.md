---
issue: 446
issue_title: "pi-subagents: spike — resolve ADR-0004 session-navigation entry criteria"
---

# Retro: #446 — pi-subagents: spike — resolve ADR-0004 session-navigation entry criteria

## Stage: Planning (2026-06-20T00:00:00Z)

### Session summary

Planned the Phase 19 Step 1 spike that answers the four ADR-0004 session-navigation entry criteria and records them as an ADR-0004 addendum.
Confirmed the release is independent and that the only committed artifact is the addendum.
The plan lives at `packages/pi-subagents/docs/plans/0446-spike-session-navigation-entry-criteria.md`; next stage is `/build-plan` (docs/spike deliverable, no committed TDD cycles).

### Observations

- Operator owns the issue (`gotgenes` == gh user), so the "Proposed change" is the working hypothesis.
  Used `ask_user` once to resolve two method ambiguities: spike method = **automated observed test (vitest)**, committed artifact = **ADR addendum only** (the vitest harness is throwaway, discarded).
- Gathered the SDK evidence up front so the addendum's expected answers are grounded: `switchSession` is a full active-session takeover that tears down the current runtime via `session_shutdown` (so it threatens the root's in-flight turn); `ReplacedSessionContext` exposes `sendUserMessage` (switch makes the child interactive); `loadEntriesFromFile`/`parseSessionEntries` read entries without switching; `Subagent.outputFile` already exposes the child JSONL path; sibling commands use flat hyphenated names (`agents`, `colgrep-reindex`, `permission-system`).
- Expected recommendations the spike will confirm: read-only `loadEntriesFromFile` transcript (resolves root-continuity by construction), command-first parallel-agent selection (widget gesture deferred), and `/subagents-settings` (reject the ADR's tentative `/subagents:settings`).
- `setBeforeSessionInvalidate` is a **host** runtime seam (`agent-session-runtime`/`interactive-mode`), not on the extension command context — noted in Background so Step 4 does not assume the extension can call it.
- No production code changes and no invariants at risk; the read-only path was chosen partly to keep transcript rendering out of core (preserving the Phase 18 spine invariants from issues #422–#425).

## Stage: Implementation — Build (2026-06-20T10:00:00Z)

### Session summary

Executed the spike: ran a throwaway vitest harness against a real 43-entry child session JSONL, confirmed the read-only transcript path, then wrote the ADR-0004 addendum answering all four entry criteria.
Discarded the harness (operator decision: addendum only) and folded the architecture.md doc-sync into this build rather than deferring it.
Four `docs:` commits; pre-completion reviewer returned WARN, whose findings were then resolved.

### Observations

- **Key divergence from the plan (Finding 0):** the plan's Design Overview assumed `loadEntriesFromFile(path)` would be the read mechanism, but it is **declared in the SDK `.d.ts` yet not exported at runtime** — `dist/index.js` omits it from the `session-manager` re-export, so it resolves to `undefined`.
  Only `parseSessionEntries` is exported.
  The viable path is `parseSessionEntries(readFileSync(outputFile, "utf8"))`.
  The addendum records this as Finding 0 and the architecture.md Step 4 mechanism line was corrected.
- **Upgrade check (operator question):** verified the omission is **not** version-specific — the latest `0.79.8` tarball has the identical `index.js` re-export line as the pinned `0.79.1`, so an SDK bump does not restore `loadEntriesFromFile`.
  No upgrade pursued (out of scope for a docs-only spike); noted the routine `0.79.1` → `0.79.8` freshness gap as a separate, unrelated item.
- **Doc-sync landed now, not deferred:** the reviewer flagged architecture.md line 997 ("Mechanism (confirmed by Step 1): `switchSession` … or `loadEntriesFromFile`") as actively contradicting the spike.
  Since the spike now exists, I marked Step 1 ✅ (heading + Mermaid node `S1`), corrected the Phase 18 summary line, and rewrote the Step 4 mechanism line to `parseSessionEntries(readFileSync(...))` — closing the WARN.
- **Pre-completion reviewer: WARN** (no FAILs) — three architecture.md staleness findings, all addressed in the final `docs:` commit (`74e2374f`).
  No `src/`/`test/` changes; `pnpm run check` + `pnpm run lint` + `pnpm fallow dead-code` all green at baseline and after.
- Release recommendation unchanged: **ship independently** (`Release: independent`).
