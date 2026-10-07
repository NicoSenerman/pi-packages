# pi-autoname port 0.6.5 → 0.6.8

Canonical base: `pi-rust-tui` copy (M13 per-session state). `pi-packages` was synced to that tree before the port. End state is byte-identical excluding `.git` / `node_modules`.

Upstream reference: `/tmp/upstream/pi-autoname` at package version 0.6.8, plus the unreleased CJK language fix on that tree.

## Ported

- **0.6.6 settled lifecycle.** `agent_end` replaced by `agent_settled`. Naming is fire-and-forget so it does not hold settlement. `session_shutdown` aborts in-flight work.
- **0.6.6 shared 30s budget / 12s attempt timeout** across the model fallback chain (`completeWithinBudget`).
- **0.6.6 controller.** `extensions/controller.ts`: unnamed/named/fallback, stale-request cancellation, unchanged title does not rewrite `setSessionName` but refreshes the marker and cooldown.
- **0.6.6 sticky manual names.** `/name` is observed immediately on `session_info_changed`. `respectManualName: true` blocks periodic/initial rename until `/autoname`.
- **0.6.6 recent context.** Periodic mode uses tail dialogue. Unmarked sessions with history use recent context (`getInitialDialogue`), not only the first exchange. Prompt asks the model to keep the current title when it still fits.
- **0.6.7 / 0.6.8 / unreleased language.** Dominant language comes from user messages, not `LANG` / `PI_LOCALE`. pi-di18n `/lang` is optional fallback when user text has no natural language. CJK in a user message wins over English noise injected into that same turn.
- **Spanish/English.** Upstream buckets all Latin script as English, which would force Spanish user text into an English label. This port scores Spanish vs English function words and, for the English bucket, tells the model not to translate other Latin-script languages. Covered by a new unit test.
- **Tests.** Upstream `tests/pi-autoname.test.ts` and `tests/extension-lifecycle.test.ts`, plus the Spanish case. Upstream `naming language` test was syntactically broken (unclosed `it`); fixed so the suite runs.
- **Docs.** README lifecycle/language sections, extensions README, AGENTS.md, CHANGELOG 0.6.6–0.6.8 and unreleased CJK note. Version bumped to 0.6.8.

## Fork behavior kept (not overwritten)

- M13: controllers live in a module-level `Map` keyed by `sessionManager.getSessionId()`, not one closure shared by BACH children.
- Config path via `getAgentDir()`, not `homedir()`.
- `loadRegistryDefaults` (`utility-models.json` `autoname` role). `DEFAULT_CONFIG.model` remains `ollama-cloud/glm-5.3-flash`.
- `getModel` fallback when `modelRegistry.find` misses.
- `MAX_NAME_TOKENS` stays **1024** (upstream 0.6.6 uses 64) so reasoning models can still emit a label. Over-long labels are truncated on a word boundary before the quality gate.
- `getRichDialogue` tool-call markers are appended to the naming prompt. Dialogue selection for language and topic comparison is still the upstream initial/recent extractors.
- Root `index.ts` keeps the `.js` re-export (NodeNext). Extension imports use `.js`.
- `tsconfig.json` kept (present in both copies before the port).
- Vitest scripts and devDependencies kept so `env -u PITUI_BRIDGE npx vitest run` works. Upstream 0.6.6 removed Vitest in favor of `node --test`.

## Skipped

- `doc/` and `.doc/` (upstream review notes in Chinese). Not loaded at runtime. Not copied.
- `package-lock.json`. Upstream lock has no installable deps after Vitest removal; this fork still uses Vitest from the existing `node_modules`.
- No `{ systemPrompt }` extension-handler return was added. The `systemPrompt` field passed to `complete()` is the model call, not an extension handler result.

## Files touched

- `extensions/index.ts` (rewritten)
- `extensions/controller.ts` (new)
- `extensions/lib.ts` (upstream language/dialogue + registry, rich dialogue, Spanish scoring, fallback length clamp)
- `extensions/README.md`, `README.md`, `CHANGELOG.md`, `AGENTS.md`, `.gitignore`
- `package.json` (version 0.6.8 only)
- `tests/pi-autoname.test.ts`, `tests/extension-lifecycle.test.ts`
- `PORT-REPORT.md`

## Tests

`env -u PITUI_BRIDGE npx vitest run` in `pi-packages/packages/pi-autoname`:

```
Test Files  2 passed (2)
Tests       23 passed (23)
Duration    487ms
```

Trees were rsynced after this report so both copies include it.
