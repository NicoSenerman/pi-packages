# @gotgenes/pi-nocd

[![npm version](https://img.shields.io/npm/v/@gotgenes/pi-nocd?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@gotgenes/pi-nocd) [![CI](https://img.shields.io/github/actions/workflow/status/gotgenes/pi-packages/ci.yml?style=flat&logo=github&label=CI)](https://github.com/gotgenes/pi-packages/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

Pi extension that appends an instruction to the system prompt forbidding the agent from `cd`-prefixing the current working directory.

## Why

Pi already tells the agent the resolved CWD: its system prompt ends with a `Current working directory: <path>` footer, and that line survives downstream shaping (for example [pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth), which only rewrites the preamble span and preserves the footer).

What Pi ships **nowhere** — default or shaped — is any *instruction* against `cd`-prefixing the CWD.
The footer is a bare statement of fact, not a rule, so the habit of prefixing commands with `cd $(pwd) &&` survives.

This extension hooks `before_agent_start` and appends a block that adds the missing prohibition — forbidding both the literal `cd <path> &&` form and the generic `cd $(pwd) &&` form.
It repeats the literal resolved path (from `ctx.cwd`) only to make the forbidden `cd <path> &&` example concrete, not because the path is otherwise unavailable to the agent.

## Install

```bash
pi install npm:@gotgenes/pi-nocd
```

Or add it to your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["npm:@gotgenes/pi-nocd"]
}
```

## What it injects

For a session whose working directory resolves to `/Users/you/project`, the following block is appended to the system prompt:

```markdown
# Working Directory

Shell commands already execute in `/Users/you/project`.
Never prefix a command with `cd` into the current working directory — neither `cd /Users/you/project &&` nor `cd $(pwd) &&`.
Just run the command directly.
```

The append is idempotent: if a `# Working Directory` block is already present (e.g. another `before_agent_start` handler added one), the prompt is returned unchanged.

## How it works

| Hook                 | Behavior                                                                          |
| -------------------- | --------------------------------------------------------------------------------- |
| `before_agent_start` | Appends the working-directory block, naming the resolved `ctx.cwd`, to the prompt |

## License

MIT
