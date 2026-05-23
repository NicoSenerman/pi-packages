# pi-colgrep

[![npm version](https://img.shields.io/npm/v/@gotgenes/pi-colgrep?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@gotgenes/pi-colgrep) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/pnpm-%3E%3D10-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

Pi extension that integrates [ColGrep](https://github.com/lightonai/next-plaid#colgrep) semantic code search as a tool available to the agent.

ColGrep is a fully local semantic code search CLI built on multi-vector ColBERT embeddings and tree-sitter parsing.
It combines regex filtering with semantic ranking, supports 25 languages, and runs entirely on the user's machine.
This package exposes ColGrep as a Pi tool that complements (not replaces) the built-in `grep`.

## Prerequisites

- [ColGrep](https://github.com/lightonai/next-plaid#colgrep) installed and available on `PATH`
- Node.js ≥ 22

## Installation

Add to your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["@gotgenes/pi-colgrep"]
}
```

## License

MIT
