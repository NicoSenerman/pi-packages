# pi-packages

A monorepo of [Pi](https://github.com/badlogic/pi-mono) extension packages, published to npm under `@gotgenes/`.
Some packages (like pi-permission-system) are designed for broad use; others scratch a personal itch and are shared in case they help others.

## Packages

| Package                                                            | Description                                        |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| [@gotgenes/pi-autoformat](./packages/pi-autoformat/)               | Prompt-end auto-formatting (Biome, Prettier, etc.) |
| [@gotgenes/pi-github-tools](./packages/pi-github-tools/)           | Deterministic GitHub CI, release, and issue tools  |
| [@gotgenes/pi-permission-system](./packages/pi-permission-system/) | Permission enforcement for the Pi coding agent     |
| [@gotgenes/pi-subagents](./packages/pi-subagents/)                 | Claude Code-style autonomous sub-agents for Pi     |

Each package has its own README with setup instructions, usage, and configuration details.

## Install

Install every package in this repo at once:

```bash
pi install git:github.com/gotgenes/pi-packages
```

Or install a single package via npm:

```bash
pi install npm:@gotgenes/<package-name>
```

## Uninstall

If installed via git:

```bash
pi remove git:github.com/gotgenes/pi-packages
```

If installed individually via npm:

```bash
pi remove npm:@gotgenes/<package-name>
```

## Development

### Prerequisites

- Node.js ≥ 20
- [pnpm](https://pnpm.io/) 11

### Setup

```bash
pnpm install
```

### Commands

```bash
pnpm run check    # typecheck all packages
pnpm run test     # test all packages
pnpm run lint     # biome + markdownlint
pnpm run lint:fix # auto-fix lint issues
```

### Agentic development workflow

To work on a package, `cd` into it and start Pi from there:

```bash
cd packages/pi-permission-system
pi -e .
```

This matters because `/reload` live-reloads the extension from the current directory.
If you start Pi from the repo root, `/reload` won't pick up your source changes.

Pi also concatenates the root `AGENTS.md` with the package's own `AGENTS.md`, so the agent gets both monorepo-wide and package-specific context regardless of where you start.

The one exception is pi-autoformat: because it hooks into file mutations made by the agent, you typically test it by installing it into a separate target project rather than running it against itself.

## License

MIT
