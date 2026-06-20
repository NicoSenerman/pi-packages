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
