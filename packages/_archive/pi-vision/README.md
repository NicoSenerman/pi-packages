# pi-vision

> Forked from [glm-vision](https://github.com/eiei114/glm-vision) by eiei114 (MIT).
> Refactored to use Pi's `complete()` API and target NeuralWatt-routed vision models.

`pi-vision` is a Pi coding-agent extension that gives **non-vision models** image
understanding. When a `read` tool result contains images, pi-vision routes the
images through a vision-capable model via Pi's official `complete()` primitive
(from `@earendil-works/pi-ai`) and injects a text description back into the tool
result — so a text-only coding model can still "see" screenshots, diagrams, and
code images.

## How it works

1. **Intercepts** `tool_result` events for the `read` tool.
2. **Smart gate** — fires _only_ when the active model lacks `image` in its
   `input` array. If your model already supports images, pi-vision gets out of
   the way and lets it handle the image natively. (This is the key improvement
   over glm-vision, which hard-coded the gate to `provider === "zai"`.)
3. **Describes** the images with the configured vision model via `complete()`,
   passing through the model registry's resolved API key and request headers.
4. **Caches** results by image hash + model + prompt (off by nothing — on by
   default, 100 entries) so repeat `read`s of the same image are instant.
5. **Injects** a `[pi-vision: …]` text block into the tool result, preserving
   the original image blocks on error or when the vision model is unavailable.

`complete()` respects provider compatibility, auth, retries, and abort signals
internally — so pi-vision has no hand-rolled `fetch`, retry, or timeout logic.

## Install (local fork)

This package lives in the `@gotgenes/pi-packages` monorepo. From the repo root:

```sh
pnpm install
```

Then enable it in your `.pi/settings.json` alongside the other workspace
packages:

```jsonc
{
  "packages": [
    "../packages/pi-vision",
    // …other packages…
  ],
}
```

Or load just the extension directly:

```jsonc
{
  "packages": [
    { "source": "../packages/pi-vision", "extensions": ["./src/index.ts"] },
  ],
}
```

## Configure

The default vision model is `moonshotai/Kimi-K2.7-Code` (NeuralWatt-routed).
Configure via slash commands — all aliased as `/pi-vision:<subcommand>`:

| Command                                        | Description                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `/pi-vision:status`                            | Show status, model, prompt mode, cache stats, config path                     |
| `/pi-vision:on` / `/pi-vision:off`             | Enable / disable image description                                            |
| `/pi-vision:reset`                             | Reset model, prompt mode, and cache to defaults                               |
| `/pi-vision:model <id>`                        | Switch vision model (e.g. `moonshotai/Kimi-K2.6`)                             |
| `/pi-vision:mode`                              | Pick a prompt preset interactively (TUI)                                      |
| `/pi-vision:prompt`                            | Show the active prompt text                                                   |
| `/pi-vision:prompt-set <text>`                 | Save and use a custom prompt                                                  |
| `/pi-vision:cache-status`                      | Show cache status and file path                                               |
| `/pi-vision:cache-on` / `/pi-vision:cache-off` | Toggle the response cache                                                     |
| `/pi-vision:cache-clear`                       | Clear cached responses                                                        |
| `/pi-vision:cache-max <n>`                     | Set max cache entries                                                         |
| `/pi-vision:<preset>`                          | Switch to a prompt preset: `default`, `ocr`, `ui`, `code`, `diagram`, `brief` |

Config is stored at `~/.pi/pi-vision.json`; the cache at `~/.pi/pi-vision-cache.json`.

### Available models

```text
moonshotai/Kimi-K2.7-Code        (default)
moonshotai/Kimi-K2.6
kimi-k2.6-fast
neuralwatt/kimi-k2.6-long
moonshotai/Kimi-K2.5
kimi-k2.5-fast
Qwen/Qwen3.6-35B-A3B
mistralai/Devstral-Small-2-24B-Instruct-2512
```

Any `provider/model-id` string the Pi model registry knows is accepted at the
config level (not just the curated list above). Strings without a slash
default to the `neuralwatt` provider. Authenticate the relevant provider with
`pi --login <provider>` if the model needs an API key.

## License

MIT — see [LICENSE](./LICENSE). Original work © eiei114 (glm-vision).
