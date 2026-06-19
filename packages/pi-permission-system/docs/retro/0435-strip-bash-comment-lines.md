---
issue: 435
issue_title: "fix(pi-permission-system): strip shell comment lines from bash commands before matching"
---

# Retro: #435 — strip shell comment lines from bash commands before matching

## Stage: PR Review (2026-06-19T17:06:21Z)

### Session summary

Third-party PR #435 from `@rnavarro` (Robert Navarro) fixes a real gap: when an agent prepends a `# description` comment line before a bash command, both the surface match value and the session-approval suggestion tokenize the comment instead of the command, so an explicitly-approved pattern (e.g. `nvm ls`) fails to match and the suggestion is built from `# list…` tokens.
The PR adds `stripBashCommentLines()` to `bash-arity.ts` and applies it in `normalizeInput` (`input-normalizer.ts`) and `suggestBashPattern` (`pattern-suggest.ts`).
The operator reviewed the diff and chose to **adopt mostly as-is** — merge-rebase the branch unchanged, with any future tweaks landing as commits on top — classified as a non-breaking `fix:`.

### Evaluation

The underlying problem is real and reproducible.
`normalizeInput` (`input-normalizer.ts:94`) returns the raw multi-line command as the bash match value, and `suggestBashPattern` (`pattern-suggest.ts:26`) splits the trimmed command on whitespace — a leading `# …` line shifts the leading tokens onto the comment in both paths.

The approach is sound and right-sized; there is little to simplify:

- `stripBashCommentLines` lands in `bash-arity.ts`, the module already responsible for bash command structure (`ARITY`/`prefix`), exported-for-testability in the same style as its siblings — good convention fit.
- The `/^\s*#/` line filter is conservative: it strips only lines whose first non-whitespace character is `#`, so `echo "#foo"` and inline trailing comments (`nvm ls  # note`) are left intact.
  It cannot over-strip into a permission bypass — gating now operates on the *real* command rather than a comment-confused value, which is security-positive.
- Both applications are necessary, not redundant.
  `normalizeInput` strips for the match value while preserving the original in `resultExtras.command`; `suggestBashPattern` must strip independently because `deriveSuggestionValue` (`handlers/gates/tool.ts:21`) feeds it `check.command` — the preserved original.
  The fallback `stripBashCommentLines(command) || command` keeps an all-comment command evaluating against its literal text.
- No new parameters threaded, no schema/config/docs surface touched, no speculative types — nothing over-built to collapse.

Breaking call: non-breaking `fix:`.
It makes a previously-prompted (comment-defeated) command auto-allow *only* when it matches a pattern the user explicitly approved, aligning behavior with intent rather than loosening policy.
`# nvm ls\nrm -rf /` still strips to `rm -rf /` and still will not match an `nvm ls` pattern, so no bypass is introduced.

Verification on the branch: `tsc` clean, `lint` exit 0 (3 pre-existing biome infos in an unrelated path test), 2033 tests pass, `fallow dead-code` clean.

### Decision and attribution

Direction: **adopt mostly as-is** — rebase-merge PR #435 unchanged; follow-up changes (if any) as commits on top.

Contributor: Robert Navarro `<crshman@gmail.com>` (`@rnavarro`).
Because the branch is merged as-is, his commits carry his authorship directly.
Any follow-up commit we author on top must end its body with a blank line followed by:

```text
Co-authored-by: Robert Navarro <crshman@gmail.com>
```

The PR merge auto-closes #435; a close/thank-you comment credits `@rnavarro` by name and links the merge SHA.
