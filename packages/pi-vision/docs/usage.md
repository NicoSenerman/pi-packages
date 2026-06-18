# Usage

> Forked from [glm-vision](https://github.com/eiei114/glm-vision) (MIT).
> Refactored to use Pi's `complete()` API and target NeuralWatt vision models.

## What it does

pi-vision gives **non-vision** Pi models image understanding. It intercepts
`read` tool results containing images and, when the active model lacks `image`
in its `input` array, routes the images through a vision-capable model via
Pi's `complete()` primitive, then injects a text description back into the
tool result.

## Install (local fork)

From the `@gotgenes/pi-packages` repo root:

```sh
pnpm install
```

Enable the extension in `.pi/settings.json`:

```jsonc
{
  "packages": ["../packages/pi-vision"],
}
```

## Slash commands

All subcommands are available as both `/pi-vision <args>` and `/pi-vision:<subcommand>`.

- `/pi-vision:status` — status, model, prompt mode, cache stats
- `/pi-vision:on` / `/pi-vision:off`
- `/pi-vision:reset`
- `/pi-vision:model <id>` — e.g. `moonshotai/Kimi-K2.7-Code` (default)
- `/pi-vision:mode` — pick a prompt preset (TUI)
- `/pi-vision:prompt` — show the active prompt
- `/pi-vision:prompt-set <text>` — save a custom prompt
- `/pi-vision:cache-status` / `/pi-vision:cache-on` / `/pi-vision:cache-off`
- `/pi-vision:cache-clear`
- `/pi-vision:cache-max <n>`
- Presets: `/pi-vision:default`, `:ocr`, `:ui`, `:code`, `:diagram`, `:brief`

## Config files

- Config: `~/.pi/pi-vision.json`
- Cache: `~/.pi/pi-vision-cache.json`

## How the gate works

The extension fires only when `currentModel.input` does **not** include
`"image"`. If your active model already supports images, pi-vision stays out
of the way — no double-description, no wasted calls. This replaces glm-vision's
hard-coded `provider === "zai"` gate.

## Vision model + auth resolution

pi-vision resolves the configured model through `ctx.modelRegistry.find(provider, modelId)`
and its auth through `ctx.modelRegistry.getApiKeyAndHeaders(visionModel)`, exactly
mirroring how Pi itself makes provider requests. There is no hand-rolled HTTP,
retry, or timeout logic — `complete()` from `@earendil-works/pi-ai` handles all
of that.

## License

MIT. Original © eiei114 (glm-vision).
