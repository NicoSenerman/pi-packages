# PORT-REPORT — pi-vision-handoff 0.4.0 → 0.10.8

Canonical source: `pi-rust-tui/extensions/pi-vision-handoff`.
`pi-packages/packages/pi-vision-handoff` was synced to that tree before the port, then both were left byte-identical (excluding `.git` / `node_modules`).

Upstream checkout: `/tmp/upstream/pi-vision-handoff` @ `ce66f20` (Pi 1.0.0), package version **0.10.8**. No `CHANGELOG.md` in that clone (shallow history starts at 0.5.1). Items below are from `git log` plus the 0.4.0→0.10.8 file delta.

## Ported

- 0.5.1+ error log (`src/error-log.ts`) — describer failures under the agent log dir.
- 0.6.0 max thinking level (`max`) for the vision describer.
- 0.7.0 pi-fabric / codemode support (nested `pi.read`, context hook keeps nested fabric image).
- 0.7.1 retry describer on transient total-batch failure; recover images the read tool omitted.
- 0.8.0 GUI/RPC fallback for `/vision-handoff` model picker.
- 0.8.1 registry routing — custom vision providers go through `ModelRegistry` (not `completeSimple` alone).
- 0.9.0 async pasted-path fallback (`asyncClipboardHandoff`) and generalized paste detection.
- 0.9.2 bounded custom renderer (`Text` width cap).
- 0.9.3 isolate vision provider sessions (dedicated helper session id; Neuralwatt `X-NW-Conversation-ID` not inherited from the main session).
- 0.9.4 fallback chain (`fallbackModels`, same-model retry then next describer).
- 0.9.7 lazy describer / editor off the startup path (`getLoader()`, dynamic `resizeImage` / selector). In-process `resolveAgentDir()` replaces importing `getAgentDir()` from `pi-coding-agent` (same `PI_CODING_AGENT_DIR` behavior, no runtime graph on load).
- 0.10.0 `awarePrompt` + `persistDescriptions` (session-file resume fast-path).
- 0.10.4 keep Pi's embedded working status on the prewarm editor.
- Pi 0.85–0.99 / 1.0.0 host migration (`completeSimple` from `@earendil-works/pi-ai/compat`, `scripts/pi1-host.mjs`).
- Ownership-safe fetch interceptor in `src/usage.ts` (does not clobber a wrapper installed after ours).
- New modules: `src/agent-dir.ts`, `src/error-log.ts`, `src/prewarm-editor.ts`, plus upstream tests (codemode, persist, error-log, selector width, native-runtime).

## Fork behavior kept

- M11: LRU eviction skips in-flight description keys (`pendingKeys` in `src/dataloader.ts`).
- `bindTurnContext` still assigns a resolved primary before fallback resolution. Call-time failover (upstream) replaces the old `turnVisionFallbacks` array; registry fallbacks are appended after `config.fallbackModels`.
- Prompt presets (`promptMode`, `/vision-handoff preset`, `resolveSystemPrompt`).
- Default describer `neuralwatt/kimi-k3-fast` when `visionModel` is absent. Explicit `null` / blank still means unset.
- `utility-models.json` `describer.model` overrides that default when the field is absent; `describer.fallbacks` join the failover chain.
- Green `vis → <model>` footer via `onInFlightChange`.
- `getAgentDir()` import was dropped in favor of upstream `resolveAgentDir()` (equivalent env override, required by the lazy-load fix). The old config-dir test that asserted a `pi-coding-agent` import was replaced by upstream's resolver test.

## pi 1.0 constraint

`before_agent_start` does **not** return `{ systemPrompt }`. `awarePrompt` writes `event.systemPromptOptions.appendSystemPrompt`. Codemode test updated to match.

## Skipped

- Publishing / `git commit` / `git push` (forbidden).
- `bun.lock` left as upstream shipped it; local `package-lock.json` from `npm install` was deleted so it is not part of the tree.
- No fork-only files were deleted (the two copies had no files upstream lacked, aside from the divergence that was synced first).

## Breaking notes

- Config default `visionModel` is no longer `null`. A missing field now describes with NeuralWatt Kimi K3-fast (or the utility-models registry entry). Explicit `null` still disables.
- `awarePrompt` no longer replaces the whole system prompt; it appends. Hosts that only honor a returned `{ systemPrompt }` will not see the note.
- Startup no longer imports `getAgentDir` from `pi-coding-agent`. `PI_CODING_AGENT_DIR` still works via `src/agent-dir.ts`.

## Tests

`env -u PITUI_BRIDGE npx vitest run` in the pi-rust-tui copy:

- 12 files, 261 tests, all passed (vitest 4.1.7).
- One failure during the port (`normalizeConfig({ visionModel: "  " })` kept the default) was fixed before the final run: a present blank/invalid ref is unset, not the default.

## Files touched

Upstream tree copied in, then local edits:

- `src/index.ts` — presets, defaults, registry describer, `promptMode`
- `src/dataloader.ts` — M11 pending keys; registry fallbacks appended to `fallbackModels`
- `src/describer.ts` — `resolveSystemPrompt`; in-flight footer hook
- `vision-handoff.ts` — aware-prompt append, preset command, registry fallbacks, footer
- `__tests__/unit/vision-handoff-codemode.test.ts` — aware-prompt assertion
- `README.md` — default describer, `promptMode`, appendSystemPrompt note
- `PORT-REPORT.md` — this file

Everything else is the upstream 0.10.8 tree (`package.json` version `0.10.8`).
