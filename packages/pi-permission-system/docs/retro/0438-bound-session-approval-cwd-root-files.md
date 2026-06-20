---
issue: 438
issue_title: "pi-permission-system: Session approval for path-bearing tools on files in the current working directory never matches (always re-prompts)"
---

# Retro: #438 — Bound session approval for current-directory files

## Stage: Planning (2026-06-20T01:37:22Z)

### Session summary

Planned the fix for the dead session-approval rule on CWD-root files.
Confirmed the root cause: `deriveApprovalPattern("index.html")` returns `"./*"` (because `dirname` is `"."`), which never matches the policy values `["<abs-cwd>/index.html", "index.html"]` that carry no `"./"` prefix.
Wrote `packages/pi-permission-system/docs/plans/0438-bound-session-approval-cwd-root-files.md` with a four-step TDD plan.

### Observations

- This is a **third-party** issue (author `Alexoidus` ≠ the gh CLI user), so the `ask-user` direction gate was mandatory.
  The operator chose the **bounded** fix (`<cwd>/*`) over the issue's literal suggestion (`return "*"`), which would have over-approved every path — including files outside CWD — for the rest of the session, conflicting with the package's least-privilege priority.
- The issue's reproduction configures the `edit` **tool** surface (`edit: { "*": "ask" }`), so the **primary** affected gate is the per-tool gate (`describeToolGate` → `suggestSessionPattern`), not the cross-cutting `path` gate the issue's "Affected code" section emphasizes.
  The cross-cutting `path` gate (`path.ts`) and the bash `path` gate (`bash-path.ts`) are the same root-relative bug, so all three thread `tcc.cwd`.
- Chose **Strategy 2** (only the `dirname === "."` branch changes) over Strategy 1 (derive every pattern from the absolute path).
  Strategy 1 would have changed the readable sub-directory dialog label from `edit "src/*"` to `edit "/Users/.../project/src/*"` — a UX regression for the common case.
  Only the currently-broken root branch shows the absolute CWD glob, which is unavoidable for boundedness.
- `external-directory.ts` already passes the absolute path to `deriveApprovalPattern`, so external-directory approvals were never affected — a useful precedent the fix mirrors.
- Verified no import cycle: `session-rules.ts` will import `normalizePathForComparison` from `path-utils.ts`, and `path-utils` imports neither `session-rules` nor `pattern-suggest`.
- The `cwd`-absent edge keeps its safe-but-re-prompting `"./*"` output (no absolute policy value exists to bind to); flagged as a Non-Goal rather than over-approving with `"*"`.
- Release: ship independently — not part of any roadmap phase or release batch.

## Stage: Implementation — TDD (2026-06-20T01:48:25Z)

### Session summary

Fixed the dead session-approval rule for current-directory files by making every path gate derive the approval pattern from the canonical (cwd-resolved, absolute) path, so the pattern matches the policy values a later call produces.
`deriveApprovalPattern` and `suggestSessionPattern` stay single-arg pure functions; the per-tool gate (`tool.ts`), cross-cutting `path` gate (`path.ts`), and bash `path` gate (`bash-path.ts`) resolve to the canonical path before deriving — the tool/path gates via `normalizePathForComparison(path, tcc.cwd)` (mirroring the existing `external-directory.ts`), and the bash gate from its already-captured `policyValues[0]`.
Test count `pi-permission-system` 2029 → 2033 (+4); full suite, `check`, root `lint`, and `fallow dead-code` all green.

### Observations

- **Design pivot mid-session.**
  The first implementation threaded an optional `{ cwd }` parameter down into `deriveApprovalPattern` (and `suggestSessionPattern`).
  On review this was judged a design degradation — optionality on a core leaf function where none existed — so it was reworked into resolve-at-gate before shipping.
  The unpushed commits were collapsed (`git reset --mixed` to the planning-retro commit) into one clean `fix:` so the abandoned approach does not pollute history or the changelog.
- **Root structural cause.**
  The bug was drift between two representations of the same path — the approval *pattern* (derived without cwd → `./*`) and the policy *values* (derived with cwd → `[<abs>/index.html, index.html]`).
  Binding both to the canonical absolute form removes the drift class, not just the root-file symptom.
  `external-directory.ts` already did this; `path.ts`/`bash-path.ts` were the inconsistent gates.
- **Tradeoff accepted (operator-confirmed via `ask_user`).**
  Canonicalizing for matching also makes the "for this session" dialog label absolute (`edit "src/*"` → `edit "/…/project/*"`).
  Judged acceptable/clearer for a permission grant; the alternative (a `PathApprovalTarget` value object separating match-pattern from display-label) was offered and declined as more surface area than warranted.
- **Bash token nuance.**
  A bare `index.html` (no leading `.`, no `/`) is rejected by `classifyTokenAsRuleCandidate`, so the realistic bash root-relative case is a dotfile (`cat .env`); the test uses that.
  Deriving from `policyValues[0]` also tightens cd-offset cases (`cd sub && cat .env` → `/…/project/sub/*`) for free.
- The pure functions `deriveApprovalPattern` / `suggestSessionPattern` reverted to their original signatures (only a doc-comment contract added); no architecture-doc update needed (bug fix, not a roadmap step).
- A fresh pre-completion review should run against the final design before `/ship-issue` (the earlier PASS was for the superseded optional-param implementation).
