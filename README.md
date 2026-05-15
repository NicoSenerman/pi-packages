[![npm version](https://img.shields.io/npm/v/@gotgenes/pi-github-tools?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@gotgenes/pi-github-tools) [![CI](https://img.shields.io/github/actions/workflow/status/gotgenes/pi-github-tools/ci.yml?style=flat&logo=github&label=CI)](https://github.com/gotgenes/pi-github-tools/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

# pi-github-tools

Pi extension providing deterministic GitHub CI, release, and issue tools.

Replaces ad-hoc `gh` CLI polling with structured tools that have exponential backoff, progress streaming, and structured success/timeout returns.

## Installation

Add to your Pi settings (`~/.pi/agent/settings.json`):

```json
{
  "packages": ["@gotgenes/pi-github-tools"]
}
```

## Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated (`gh auth login`)
- Node.js ≥ 20

## Tools

### CI tools

#### `ci_find`

Wait for a GitHub Actions run matching a specific commit SHA to appear.
Uses exponential backoff (5 s base, 30 s cap) until the run appears or the timeout expires.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `workflow` | string | yes | Workflow filename without extension (e.g., `"ci"` for `ci.yml`) |
| `expected_sha` | string | yes | Full 40-char SHA of the commit |
| `timeout` | number | no | Seconds to wait (default: 120) |

Returns `run_id`, `url`, `status`, `sha`, `title`, and job list on success.
Returns a structured timeout message (not an error) if the run does not appear.

#### `ci_watch`

Poll a GitHub Actions run by run ID until it completes or times out.
Streams compact job-level progress lines (e.g., `[2/5] deploy — in_progress (120s)`).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `workflow` | string | yes | Workflow filename without extension |
| `run_id` | number | yes | Run ID from `ci_find` |
| `timeout` | number | no | Seconds to wait (default: 300) |

#### `ci_list`

List recent GitHub Actions runs for a workflow.
Useful for diagnostics without constructing `gh` invocations.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `workflow` | string | yes | Workflow filename without extension |
| `limit` | number | no | Number of runs to return (default: 5) |

### Release tools

#### `release_pr_find`

Find the release-please PR after a push to `main`.
Polls until an open release-please PR appears or the timeout expires.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `timeout` | number | no | Seconds to wait (default: 120) |

Returns PR number, title, head branch, mergeable status, and URL.

#### `release_pr_merge`

Merge a release-please PR after confirming it is clean.
Checks `MERGEABLE` + `CLEAN` status, merges, and runs `git pull --ff-only`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pr_number` | number | yes | The PR number to merge |
| `method` | string | no | Merge strategy: `"rebase"`, `"squash"`, or `"merge"` |

Merge method precedence (highest to lowest):

1. Explicit `method` parameter
2. `defaultMergeMethod` from [configuration](#configuration)
3. `"rebase"` (hardcoded fallback)

Returns merge confirmation with new HEAD SHA, or a structured error if not mergeable.

#### `release_watch`

Wait for a release tag to appear on HEAD after merging a release-please PR.
Polls every 10 s until a tag appears or the timeout expires.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `timeout` | number | no | Seconds to wait (default: 180) |

Returns the tag name, version, and SHA.

### Issue tools

#### `issue_close`

Close a GitHub issue with an optional comment.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `issue_number` | number | yes | The issue number to close |
| `comment` | string | no | Comment to add when closing |
| `reason` | string | no | `"completed"` (default) or `"not_planned"` |

## Usage example

A typical CI + release flow using these tools:

```text
1. Push changes to a branch and create a PR.
2. Use ci_find with the pushed SHA to locate the CI run.
3. Use ci_watch to wait for the CI run to complete.
4. Merge the PR.
5. Use release_pr_find to locate the release-please PR.
6. Use release_pr_merge to merge it.
7. Use release_watch to wait for the release tag to land.
8. Use issue_close to close the shipped issue.
```

## Configuration

Optional JSON config files control default behavior.
Two locations are supported — project config takes precedence over global:

| Scope | Path |
| --- | --- |
| Global | `~/.pi/agent/extensions/@gotgenes/pi-github-tools/config.json` |
| Project | `.pi/extensions/@gotgenes/pi-github-tools/config.json` |

### Options

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultMergeMethod` | `"rebase"` \| `"squash"` \| `"merge"` | `"rebase"` | Default merge strategy for `release_pr_merge` |

### Example

```json
{
  "defaultMergeMethod": "squash"
}
```

## Architecture

Portable business logic in `src/lib/` — no Pi SDK imports.
Thin Pi wrappers in `src/tools/` register each tool and map progress callbacks.

```text
src/
├── extension.ts          # Pi extension entry point
├── progress.ts           # onProgress → Pi onUpdate adapter
├── tool-result.ts        # AgentToolResult helper
├── tools/                # one file per tool (thin wrappers)
└── lib/                  # portable business logic
    ├── ci.ts             # findRun, watchRun, listRuns
    ├── ci-helpers.ts     # CIJob, findRetryDelay, formatProgress
    ├── config.ts         # config loading and normalization
    ├── release.ts        # findReleasePR, mergeReleasePR, watchRelease
    ├── issue.ts          # closeIssue
    ├── github.ts         # gh(), ghJson(), git(), detectRepo()
    └── process.ts        # runCommand(), sleep()
```

## License

MIT
