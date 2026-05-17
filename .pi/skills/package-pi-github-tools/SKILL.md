---
name: package-pi-github-tools
description: |
  Package-specific context for @gotgenes/pi-github-tools.
  Load when working on code, tests, or docs in packages/pi-github-tools/.
---

# pi-github-tools

Pi extension that registers deterministic GitHub CI, release, and issue tools via `pi.registerTool()`.
Replaces ad-hoc `gh` CLI polling with structured tools that have exponential backoff, progress streaming, and structured success/timeout returns.

## Architecture

Portable business logic in `src/lib/` — no Pi SDK imports.
Thin Pi wrappers in `src/tools/` register each tool and map `onProgress` to Pi's `onUpdate`.
`src/extension.ts` is the Pi extension entry point.

```text
src/
├── extension.ts          # default export: registers all tools
├── tools/                # Pi tool wrappers (one per tool)
├── lib/                  # portable business logic
│   ├── ci.ts             # findRun, watchRun, listRuns
│   ├── ci-helpers.ts     # CIJob, findRetryDelay, formatProgress
│   ├── config.ts         # config loading and normalization
│   ├── release.ts        # findReleasePR, mergeReleasePR, watchRelease
│   ├── issue.ts          # closeIssue
│   ├── github.ts         # gh(), ghJson(), git(), detectRepo()
│   └── process.ts        # runCommand(), sleep()
└── progress.ts           # maps onProgress → Pi onUpdate
```

## Implementation Priorities

- `src/lib/` must not import from `@earendil-works/pi-coding-agent` — only `src/tools/` and `src/progress.ts` touch Pi types.
- The `gh` CLI is the sole external binary dependency.

## Testing

- Mock `runCommand` in `lib/` tests to avoid real `gh` calls — every lib test should run offline.
- Test backoff timing, progress formatting, timeout handling, structured output.
- `tools/` wrappers are thin and tested lightly.
