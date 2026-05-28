---
issue: 249
issue_title: "Bash external-directory gate ignores config-level allow rules for /tmp/* paths"
---

# Retro: #249 — Bash external-directory gate ignores config-level allow rules for /tmp/* paths

## Stage: Planning (2026-05-28T18:00:00Z)

### Session summary

Planned a two-step TDD fix for the `uncoveredPaths` filter in `describeBashExternalDirectoryGate`.
The core fix changes the filter predicate from `source !== "session"` to `state !== "allow"`, and replaces the path-less `extCheck` call with a worst-check computation over uncovered paths.

### Observations

- The sibling gates (`path.ts`, `bash-path.ts`) already use `check.state` for filtering — `bash-external-directory.ts` is the outlier.
- `deriveSource()` maps `external_directory` to `"special"` for all non-session rules, making source-based filtering unable to distinguish config allow from config ask/deny.
- The path-less `extCheck` call is a secondary bug: it always returns the `"*"` catch-all, potentially downgrading a `"deny"` to `"ask"`.
- One existing test ("uses config-level checkPermission for the policy state") explicitly asserts the buggy behavior and must be rewritten.
- The bypass log event says `"session_approved"` even when the bypass comes from config — noted as cosmetic, deferred.
