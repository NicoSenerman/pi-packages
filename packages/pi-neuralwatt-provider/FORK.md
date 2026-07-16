# FORK — pi-neuralwatt-provider

Local tracked fork of **upstream [monotykamary/pi-neuralwatt-provider](https://github.com/monotykamary/pi-neuralwatt-provider)**, version **v1.7.3** (commit `62ee5c2`, `feat(settings): add drill-in chevron to submenu items`).

Forked into the `pi-packages` monorepo at `~/Documents/Projects/pi-packages/packages/pi-neuralwatt-provider/` and loaded via a `settings.json → packages[]` local path (same pattern as `pi-xai-oauth`, `pi-subagents`, `pi-permission-system`, `pi-vision-handoff`). This bypasses npm so edits survive `pi update`.

---

## 1. Why this fork exists — catalog merge

The upstream ships a `models.json` curated for the general public. The user has a **hand-tuned `neuralwatt` provider block in `~/.pi/agent/models.json`** with 20 models, several of which the upstream catalog does NOT have:

- `zai-org/GLM-5.1-FP8`
- `openai/gpt-oss-20b`
- `MiniMaxAI/MiniMax-M2.5`
- `mistralai/Devstral-Small-2-24B-Instruct-2512`
- `moonshotai/Kimi-K2.5`
- `kimi-k2.5-fast`

Wholesale-replacing `~/.pi/agent/models.json` with the upstream catalog would **silently drop these models**. This fork's `models.json` is therefore the **union**:

- start from the user's 20 models (preserving hand-tuned `cost.cacheRead: 0.36` where present),
- merge in upstream models the user was missing: `qwen3.5-397b-fast`, `qwen3.6-35b-fast`, `nemotron-3-nano-mcr`.

Result: **23 models** in the fork's `models.json`. The 3 MCR long-context variants (`neuralwatt/glm-5-long`, `neuralwatt/glm-5.1-fast-long`, `neuralwatt/kimi-k2.5-long`) are NOT in `models.json` — they live in `custom-models.json` (kept byte-for-byte from upstream) and are merged in at runtime by `buildModels()`.

### Compat / `chatTemplateKwargs` mapping (applied per upstream's own logic)

Read from `index.ts` (`NeuralwattModel.compat` comment block + `README.md` "Compat Settings" / "chatTemplateKwargs"):

| flag                                              | applies to                                                                                                         | why                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `supportsDeveloperRole: false`                    | **ALL** models                                                                                                     | vLLM doesn't support the `developer` role; pi sends system prompts as `system`.                                   |
| `supportsReasoningEffort: true`                   | GLM-5.2 family only (`glm-5.2`, `-flex`, `-fast`, `-short`, `-short-flex`, `-short-fast`)                          | sends `reasoning_effort` (maps `/reasoning` levels onto GLM-5.2's `high`/`max`/`minimal` via `thinkingLevelMap`). |
| `chatTemplateKwargs: { clear_thinking: false }`   | GLM-5.2 family reasoning variants                                                                                  | stops the template clearing older assistant reasoning → full-history preservation (1/4 → 4/4 recall).             |
| `chatTemplateKwargs: { preserve_thinking: true }` | Kimi K2.6 / K2.7 reasoning variants (`kimi-k2.6`, `-flex`, `kimi-k2.7-code`, `-flex`, `neuralwatt/kimi-k2.6-long`) | keeps full reasoning history across turns (0/6 → 6/6 recall).                                                     |

The reasoning-preservation kwargs are baked into `models.json` AND re-applied at runtime by `patch.json` (kept byte-for-byte). `patch.json` deep-merges `compat.chatTemplateKwargs` + `thinkingLevelMap` on top of `models.json` by model id; harmless duplication, and means the catalog is correct standalone if `patch.json` is ever dropped.

The runtime merge pipeline (in `buildModels()`) is:
**base (`models.json`) → `patch.json` → `custom-models.json` → user `modelOverrides` (from `neuralwatt.json`)**.

### Files touched by this fork (vs upstream v1.7.3)

- `models.json` — **rewritten** as the merged 23-model union (see above).
- `tsconfig.json` — `module`/`moduleResolution` → `ESNext`/`bundler`, added `"types": ["node"]`. Matches the `pi-xai-oauth` fork and silences import-attribute TS2823 errors + lets the `@earendil-works/*` symlinks resolve via package `exports`.
- `node_modules/@earendil-works/{pi-ai,pi-coding-agent}` + `node_modules/@types/node` — **dev-only symlinks** for `tsc` (gitignored; not committed). Point at the installed pi (`~/.pi/agent/npm` + `~/.npm-global`).
- `FORK.md` — this file.

Everything else (`index.ts`, `transform.ts`, `custom-models.json`, `patch.json`, `docs/`, `scripts/`, `tests/`, `README.md`, `AGENTS.md`, `package.json`, `knip.json`, `vitest.config.ts`, `.gitignore`, `.npmignore`, `LICENSE`) is **byte-for-byte identical to upstream v1.7.3**. (The upstream `neuralwatt-mcr.ts` companion extension and its vendored `chad-mcr-upstream.ts` were removed in Section 6 below.)

---

## 2. Manual steps the user must take (DO THESE BEFORE RESTARTING pi)

This fork now owns the `neuralwatt` provider. The plain `openai-completions` `neuralwatt` block in `~/.pi/agent/models.json` MUST be removed (otherwise `registerProvider("neuralwatt", ...)` collides with the provider block and one silently wins depending on load order).

### Step A — remove the `neuralwatt` block from `~/.pi/agent/models.json`

Delete the entire `neuralwatt` object under `providers`. It is everything from the line:

```json
    "neuralwatt": {
      "baseUrl": "https://api.neuralwatt.com/v1",
      "api": "openai-completions",
      "apiKey": "$NEURALWATT_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "maxTokensField": "max_tokens"
      },
      "models": [
        ... (20 models) ...
      ]
    },
```

…through its closing `},`. Leave `ollama-cloud` and `dgx-spark` untouched. The `NEURALWATT_API_KEY` env reference moves to `auth.json` (see Step C) — you can remove the `"$NEURALWATT_API_KEY"` literal here since the extension reads the key from `auth.json` / env, not from `models.json`.

### Step B — add the fork to `settings.json → packages[]`

Edit `~/.pi/agent/settings.json`, add this entry to the `packages` array (relative path is resolved from the agent dir, same as the other local forks):

```json
"../../Documents/Projects/pi-packages/packages/pi-neuralwatt-provider"
```

Append it as a new array element, e.g. after the existing `pi-xai-oauth` entry. The full line for context:

```json
    "../../Documents/Projects/pi-packages/packages/pi-xai-oauth",
    "../../Documents/Projects/pi-packages/packages/pi-neuralwatt-provider",
```

### Step C — create the extension config + put the API key in `auth.json`

The extension reads display config from **`~/.pi/agent/extensions/neuralwatt.json`** (derived in `index.ts` from `path.join(getAgentDir(), "extensions", "neuralwatt.json")`). If the file is missing, the extension auto-creates it with defaults on first load, so this step is optional. Schema (the `NeuralwattConfig` interface — all fields optional, defaults shown):

```json
{
  "energy": "widget",
  "quota": "widget",
  "carbon": "widget",
  "hideOnOtherProvider": false
}
```

- `"widget"` (default) → below-editor status line
- `"statusbar"` → built-in pi status bar
- `"off"` → hidden entirely (for `quota`, also skips the API fetch)
- `hideOnOtherProvider` → auto-hide all Neuralwatt display when a non-Neuralwatt model is active
- optional `modelOverrides` per-model map (see README "Model Overrides") — deep-merges `compat` / `thinkingLevelMap` / `vision` over `patch.json` + `custom-models.json`

For **API key auth**, the extension (`streamNeuralwatt`) reads `options.apiKey || cachedApiKey`; pi resolves `"$NEURALWATT_API_KEY"` against `~/.pi/agent/auth.json`. Add (or confirm) the entry:

```json
{
  "neuralwatt": { "type": "api_key", "key": "your-neuralwatt-api-key" }
}
```

…or keep the `NEURALWATT_API_KEY` environment variable exported in your shell. Either works.

### Step D — restart pi

After Steps A–C, restart pi (or quit and relaunch the session). The extension's default export runs `pi.registerProvider("neuralwatt", makeProviderConfig(...))`, which registers the custom `api: "neuralwatt"` provider (NOT `openai-completions`) with the `streamNeuralwatt` handler. models appear in `/model`.

---

## 3. Provider identity — do NOT simplify the fetch tee

The extension registers `api: "neuralwatt"` with a custom `streamSimple: streamNeuralwatt` handler. This is **the mechanism that captures energy / cost data**: it overrides `globalThis.fetch`, tees the SSE response body (`response.body.tee()`), feeds one half to `readEnergyFromTee()` while the OpenAI SDK consumes the other, and parses the `: energy` / `: cost` SSE comment lines the SDK would otherwise discard.

**Keep this intact.** The user explicitly wants energy tracking.

### `globalThis.fetch` override — restore logic (already correct, preserved)

The override is localized to `streamNeuralwatt()` and ALWAYS reverts `originalFetch`:

1. **happy path** — `stream.end` is monkey-patched to call `globalThis.fetch = originalFetch` before delegating to `originalEnd`. So when the stream ends, fetch is restored.
2. **throw path** — a `try/catch` around `streamOpenAICompletions(...)` calls `globalThis.fetch = originalFetch; throw error;` if construction throws.

The invariant: every code path that enters `streamNeuralwatt` restores `originalFetch` before the function returns or the stream completes. **Do not remove the `stream.end` patch or the try/catch** — they are the restore safety net.

### What else uses `globalThis.fetch` (collision risk)

While a Neuralwatt stream is active, `globalThis.fetch` is the tee-wrapper. Other pi subsystems that call `fetch` during that window will also be tee'd — they get a normal `Response` back (the wrapper only tees when `url.includes("/chat/completions")`, otherwise passes through untouched), so behavior is unchanged. Known fetch users:

- **pi-vision-handoff** — image-understanding proxy; makes OpenAI-compatible calls (its bulk import broke under pi 0.80 and moved to `@earendil-works/pi-ai/compat`, same as this extension). Will be tee'd only if its requests hit a `/chat/completions` URL pattern while a Neuralwatt stream is mid-flight; pass-through otherwise.
- **MCP HTTP transport** — MCP servers reached over HTTP(S) use `fetch`. These URLs do NOT contain `/chat/completions`, so the wrapper passes them through untouched. No risk.
- **pi-rag sidecar** — RAG index/query HTTP calls to the sidecar. Same as MCP: non-`/chat/completions` URLs, pass-through. No risk.

Net risk: low. The wrapper's URL guard (`/chat/completions`) scopes the tee to Neuralwatt chat calls. The only theoretical interference is two concurrent Neuralwatt streams racing on the single `teeReader` global — but `teeReader` is reassigned per call and the prior reader is `.catch(() => {})`'d on `stream.end`, so a leak is bounded to one dropped energy read, not a hang or a stuck fetch override.

---

## 4. TypeScript compile status

Run from the fork dir:

```
cd ~/Documents/Projects/pi-packages/packages/pi-neuralwatt-provider
npx tsc --noEmit
```

**State:** 9 errors, all **pre-existing in upstream v1.7.3** (verified by running the fork's tsc against `/tmp/nwp-review` — the upstream original produces the _same_ 9 errors plus 3 more import-attribute TS2823 errors that the fork's improved tsconfig fixes). Nothing the fork introduced.

Breakdown:

| error                                                                                                               | cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | in fork scope?                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot find module '@earendil-works/pi-ai/compat'` (index.ts:67,68)                                                | **tsc-only, NOT a runtime issue.** There are two pi-ai installs: a stale `~/.pi/agent/npm/node_modules/@earendil-works/pi-ai` (0.74.2, no `./compat` export — leftover from old `pi install`s, unused at runtime) AND the pi-bundled `~/.npm-global/.../pi-coding-agent/node_modules/@earendil-works/pi-ai` (0.80.7, which DOES export `./compat`). tsc resolves the 0.74.2 copy via the dev symlink and errors; runtime jiti resolves the 0.80.7 copy and succeeds. Verified: `node --input-type=module -e "await import('@earendil-works/pi-ai/compat')"` against 0.80.7 returns the real exports. | **No** — tsc artifact only. **Runtime is fine.**                                                                                                                    |
| `Cannot find module '@earendil-works/pi-coding-agent'` (was chad-mcr-upstream.ts:1)                                 | Previously raised by the vendored `chad-mcr-upstream.ts`, which imported the _old_ package name `@mariozechner/pi-coding-agent` (now `@earendil-works/pi-coding-agent`). upstream's own `sync-mcr` script fetched this file verbatim from `neuralwatt-tools`. **Both `chad-mcr-upstream.ts` and `neuralwatt-mcr.ts` were deleted in Section 6**, so this error no longer occurs.                                                                                                                                                                                                                     | **N/A** — file deleted.                                                                                                                                             |
| `Cannot find module 'typebox'` (was chad-mcr-upstream.ts:6)                                                         | was declared in upstream `package.json` devDeps but not installed (no `pnpm install` in the fork). **`chad-mcr-upstream.ts` was deleted in Section 6**, so this error no longer occurs.                                                                                                                                                                                                                                                                                                                                                                                                              | **N/A** — file deleted.                                                                                                                                             |
| `Cannot find module '@earendil-works/pi-tui'` (index.ts:1835)                                                       | not a resolvable package on this host (pi-tui is bundled into pi-coding-agent at runtime, not a standalone module here).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **No** — runtime-resolved by jiti; tsc can't see it.                                                                                                                |
| `Cannot find module 'vitest/config'` (vitest.config.ts:1)                                                           | vitest not installed in the fork.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **No** — `vitest.config.ts` is a test runner config, not compiled into the extension. Upstream tsconfig `include: ["./*.ts"]` matches it but it's inert at runtime. |
| `Cannot find name 'RequestInfo'` (index.ts:1543)                                                                    | `RequestInfo` is a DOM/`undici` type, not in `@types/node`. The upstream code uses it in the `globalThis.fetch` wrapper signature.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **No** — upstream typing; would need a `lib: ["DOM"]` addition or upstream fix.                                                                                     |
| `Type 'unknown' is not assignable...` (index.ts:151) / `Property 'data' does not exist on 'unknown'` (index.ts:416) | upstream's own loose `unknown` casts in `loadConfig` / `transformApiModel` paths. `strict: false` in tsconfig.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **No** — upstream logic; acceptance contract forbids rewriting.                                                                                                     |

**Runtime is fine — the `./compat` import resolves correctly at load.** pi bundles pi-ai 0.80.7 inside `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/`, and that version exports the `./compat` subpath (`dist/compat.js` exists, `package.json exports` lists it). jiti (pi's loader) uses ESM import resolution, which honors the `exports` map and resolves `@earendil-works/pi-ai/compat` to the bundled 0.80.7 copy — verified by `node --input-type=module -e "const m=await import('@earendil-works/pi-ai/compat'); console.log(Object.keys(m).slice(0,5))"` returning `[AssistantMessageEventStream, EventStream, InMemoryCredentialStore, ModelsError, StringEnum]` (incl. the `streamOpenAICompletions`/`clampThinkingLevel` the extension imports).

The stale `~/.pi/agent/npm/node_modules/@earendil-works/pi-ai` (0.74.2) that tsc sees is a leftover from old `pi install` package installs and is **not** what runtime extensions resolve against. No `pi update` needed for this fork to load.

**Dev symlink note:** the gitignored `node_modules/@earendil-works/pi-ai` symlink in this fork is for tsc only and must point at the **bundled 0.80.7** copy (`~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`), NOT the stale 0.74.2 one — otherwise tsc errors and the type-check is misleading. If you re-clone or the symlink breaks, recreate it: `ln -sfn ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai`.

---

## 5. How to update from upstream

The fork dir is part of the `pi-packages` git repo (NOT its own repo). To pull upstream changes:

```bash
cd ~/Documents/Projects/pi-packages/packages/pi-neuralwatt-provider

# Add the upstream remote (once). Points at the original extension repo.
git -C ~/Documents/Projects/pi-packages remote add nwp-upstream https://github.com/monotykamary/pi-neuralwatt-provider
# NOTE: this remote is on the pi-packages repo, NOT a nested repo in the fork dir.

# Fetch + merge. The upstream is a separate repo, so use --allow-unrelated-histories
# the first time, and subtree-style merge thereafter. Simplest reliable flow:
git fetch nwp-upstream
# merge upstream's tree into just this subdirectory:
git merge -X subtree=packages/pi-neuralwatt-provider --allow-unrelated-histories nwp-upstream/main
```

After any upstream merge, **re-confirm the catalog merge**: upstream may have added/renamed models in `models.json`. Re-apply the union logic (preserve the user's hand-tuned `cost.cacheRead: 0.36` and the 6 user-only models; merge in any new upstream models). The `patch.json` + `custom-models.json` are kept byte-for-byte and upstream changes to them merge cleanly.

If `index.ts` changes the `NeuralwattConfig` schema or the `buildModels` pipeline, re-read the new versions and update this `FORK.md`'s Step C / Section 1 accordingly.

### Alternative: re-sync from a fresh shallow clone

If the git merge gets messy (the fork's `models.json` and `tsconfig.json` diverged from upstream, so merges will conflict on exactly those two files):

```bash
# fresh shallow clone of the new upstream version
git clone --depth 1 -b <new-tag> https://github.com/monotykamary/pi-neuralwatt-provider /tmp/nwp-new
# re-copy all files EXCEPT models.json, tsconfig.json, FORK.md, node_modules/
rsync -a --exclude='models.json' --exclude='tsconfig.json' --exclude='FORK.md' \
  --exclude='node_modules/' --exclude='.git/' --exclude='pnpm-lock.yaml' \
  /tmp/nwp-new/ ~/Documents/Projects/pi-packages/packages/pi-neuralwatt-provider/
# then re-do the catalog merge into models.json by hand
```

This is the lower-cognitive-load path and guarantees a clean upstream snapshot with only the fork's intentional deltas preserved.

---

## 6. MCR subsystem stripped

In a follow-up pass, the entire **MCR (Memory / Context Reuse)** subsystem was removed from this fork. The neuralwatt API serves long-context (1M-token) "-long" model variants that participate in an upstream MCR companion extension; that companion and all of its wiring in `index.ts` have been deleted. **Energy and cost tracking are unaffected** — the `: energy` and `: cost` SSE comment branches and the entire fetch-tee pipeline (Section 3) are preserved verbatim.

What changed:

- **`index.ts`**
  - `transformApiModel()` now returns `null` early for any live-API model whose `id` ends in `-long` (e.g. `neuralwatt/kimi-k2.6-long`); the `filter(m => m !== null)` at the call site drops them. The live API still serves these variants, but this extension no longer exposes them.
  - The `mcr` field was removed from the `NeuralwattConfig` interface, `DEFAULT_CONFIG`, and `loadConfig()`. The `/neuralwatt-settings` command lost its "MCR display" row; the command description now reads "energy/quota/carbon" instead of "energy/quota/MCR/carbon".
  - The `: mcr-session` branch was removed from `readEnergyFromTee()` (the `: energy` and `: cost` branches are unchanged).
  - Removed MCR session state (`sessionMcrFp`, `sessionSafeDropBefore`, `sessionApcHitRate`, `sessionCompactRatio`, `pendingMcrSessionRaw`), the `STATUS_KEY_MCR` status key, the `sse_mcr_session_raw` persistence field, the `MCR` segment from `buildEnergyText()` / `updateEnergyStatus()` statusbar+widget rendering, and the `X-NW-MCR-Ext-Version` request header.
  - Removed the entire `globalThis` MCR bridge (`NW_MCR_BRIDGE` symbol, `NWMCRRidge` interface, `getMCRRidge`, `publishMCRRidge`, `consumePendingMCR`) plus the `publishMCRRidge()` call in `turn_end` — it existed solely so the deleted companion could read MCR data.
- **`neuralwatt-mcr.ts`** (the companion extension entry) and **`chad-mcr-upstream.ts`** (76 KB vendored upstream MCR code, imported only by `neuralwatt-mcr.ts`) were **deleted**.
- **`package.json`** — removed the `./neuralwatt-mcr.ts` entry from `pi.extensions` and the `sync-mcr` script; version bumped `1.7.3` → `1.7.4`.
- **`README.md`** — removed the `mcr` row from the Display Configuration table and the (MCR)-branded model rows from the Available Models table (the now-filtered `neuralwatt/kimi-k2.6-long` row is preserved in the table for catalog completeness, but the model is dropped at runtime by the `transformApiModel` filter above).
- **`FORK.md`** — this section; also updated the file list (line 50), the SSE-comment description (Section 3), the schema reference (Section 5), and the two `chad-mcr-upstream.ts` tsc-error rows in Section 4.
- **Tests** — deleted `tests/neuralwatt-mcr.test.ts` and `tests/neuralwatt-mcr-wrapper.test.ts` (they exercised the deleted companion). Updated `tests/config.test.ts`, `tests/energy-reader.test.ts`, and `tests/progressive-disclosure.test.ts` to drop MCR assertions; `energy-reader.test.ts` gains a test confirming `: mcr-session` comments are now silently ignored.

Untouched (per preservation rules): `models.json`, `custom-models.json`, `patch.json`.

> **Catalog note:** `models.json` still contains `neuralwatt/kimi-k2.6-long` ("Kimi K2.6 Long (Virtual Context)"). Per the preservation rules, `models.json` was left byte-for-byte unchanged; the `transformApiModel` `-long` filter drops this model at runtime instead. If you want it gone from the catalog file itself, remove the `neuralwatt/kimi-k2.6-long` object from `models.json` by hand (the runtime filter makes this cosmetic). The historical Section 1 narrative (lines 23/25) describes the upstream catalog-merge state at fork time and still mentions the now-removed `nemotron-3-nano-mcr` / `*-long` custom-models entries — `custom-models.json` is currently `[]`, so those variants are no longer merged in regardless.
