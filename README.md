<p align="center">
  <img src="docs/assets/logo.png" alt="pi-autoformat logo" width="400">
</p>

# pi-autoformat

[![npm version](https://img.shields.io/npm/v/@gotgenes/pi-autoformat?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@gotgenes/pi-autoformat) [![CI](https://img.shields.io/github/actions/workflow/status/gotgenes/pi-autoformat/ci.yml?style=flat&logo=github&label=CI)](https://github.com/gotgenes/pi-autoformat/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

`pi-autoformat` is a Pi extension package that automatically formats files after the agent edits them.

## Why

Pi agents often make correct code changes that still fail at commit time because formatting was never run.

That creates a frustrating workflow:

1. the agent edits files
2. the agent appears done
3. pre-commit hooks or CI run formatters later
4. files mutate after the fact
5. commits fail or the agent has to recover from surprise formatting changes

This package moves formatting earlier in the workflow so the agent is less likely to leave behind unformatted files.

## How it works

`pi-autoformat` watches files touched by Pi mutation tools and runs configured formatter commands for just those files.

Formatting is **opt-in**: no formatters run until you declare `chains` in your project config.

### Timing

Touched files are collected during each agent turn and formatted at `turn_end`, before the agent's next LLM call.
This means files are already formatted before any subsequent `git commit` command, eliminating pre-commit hook failures.

When formatting actually changes file content or a formatter fails, the extension sends a steering message that the agent sees at the start of its next turn.
This lets the agent react — for example, amending a commit or fixing a formatter error — without requiring a separate follow-up turn.

A safety-net flush also runs at `agent_end` to catch files added via the EventBus or other non-turn paths.

### Design goals

- format only files the agent touched
- flush between turns so commits see formatted files
- notify the agent inline only when formatting actually changed content or failed
- support repository-specific formatter commands and ordered chains
- surface formatter failures without blocking the original edit
- delegate formatter configuration to the formatters themselves — `pi-autoformat` invokes the tool and lets it find its own project config

See [docs/configuration.md](docs/configuration.md) for the full reference.

## Installation

### From npm

```bash
pi install npm:@gotgenes/pi-autoformat
```

### Local development checkout

```bash
pi install /absolute/path/to/pi-autoformat
```

## Quick start

Create `.pi/extensions/pi-autoformat/config.json` in your project.
No formatters run until you declare `chains` — this avoids surprises from a default formatter conflicting with your project's chosen tool.

```json
{
  "$schema": "https://raw.githubusercontent.com/gotgenes/pi-autoformat/main/schemas/pi-autoformat.schema.json",
  "formatters": {
    "biome": { "command": ["biome", "check", "--write", "--files-ignore-unknown=true"] }
  },
  "chains": {
    ".ts": ["biome"],
    ".tsx": ["biome"],
    ".json": ["biome"]
  }
}
```

For everything else — formatter chains and fallback groups, wildcard chains, built-in `treefmt` and `treefmt-nix` support, format scope, shell mutation coverage, custom mutation tools, the event-bus channel, turn-end steering notifications, and detailed failure output — see [docs/configuration.md](docs/configuration.md).

## Configuration

Config files live at two levels, merged with project overriding global:

1. global: `~/.pi/agent/extensions/pi-autoformat/config.json`
2. project: `.pi/extensions/pi-autoformat/config.json`

The only required fields are the `formatters` you declare and the `chains` that map file extensions to them. Everything else is optional.

### Key settings

- **`formatters`**: named formatter definitions, each with a `command` array.
- **`chains`**: maps file extensions (e.g. `".ts"`) to an ordered list of formatter names to run.
- **`formatScope`**: boundary for which touched files are eligible for formatting.
  - `"repoRoot"` (default): git root, falling back to cwd when not inside a repo.
  - `"cwd"`: strict cwd only.
  - `["packages/a", "/abs/path"]`: explicit roots, resolved relative to cwd.
- **`commandTimeoutMs`**: per-formatter timeout in milliseconds. Default: `10000`.
- **`shellMutationDetection`**: opt-in detection of files mutated by `bash` commands (e.g. `sed -i`, `mv`, `cp`). Disabled by default.
- **`hideSummariesInTui`**: set to `true` to suppress the success status footer in the interactive TUI.

See [docs/configuration.md](docs/configuration.md) for the full reference, JSON Schema, and examples.

## Reporting

By default, `pi-autoformat` reports concise success summaries and per-batch failure summaries.

In the interactive TUI, success renders as a persistent one-line footer status (e.g. `✓ autoformat: 3 files (biome, prettier)`).
Failures fire a warning notification and leave an error-styled footer status (e.g. `✗ autoformat: 1 batch failed (prettier)`) that persists until the next flush.

Outside the TUI, summaries are written as prefixed log lines on `stdout` / `stderr`.

Set `hideSummariesInTui` to `true` to suppress the success status line.
To surface failed-run stderr (or stdout+stderr), see [`formatterOutput`](docs/configuration.md#formatteroutput).

## Development

```bash
pnpm install
pnpm test
pnpm run lint
```

See [`docs/testing.md`](docs/testing.md) for the layout of unit, acceptance, and (future) LLM-gated test suites, and how the acceptance harness resolves the `pi` binary from `node_modules/.bin/pi`.

## License

MIT
