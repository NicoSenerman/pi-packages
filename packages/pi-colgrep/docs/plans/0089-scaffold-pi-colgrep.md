---
issue: 89
issue_title: "Scaffold `@gotgenes/pi-colgrep` package"
---

# Scaffold pi-colgrep package

## Problem Statement

There is no `@gotgenes/pi-colgrep` package yet.
The monorepo needs a new package that will eventually expose [ColGrep](https://github.com/lightonai/next-plaid#colgrep) semantic code search as a Pi agent tool.
This plan covers only the infrastructure scaffold — the minimal files, monorepo wiring, and verification that the new package integrates cleanly.

## Goals

- Create the `packages/pi-colgrep/` directory with all standard package files.
- Wire the package into release-please, the publish script, and the CI pipeline.
- Provide a minimal `src/extension.ts` entry point that compiles and does nothing yet.
- Pass `pnpm -C packages/pi-colgrep run check` and `pnpm -C packages/pi-colgrep run lint`.
- Publish an initial release to npm so Trusted Publishing can be configured for continuous publication.

## Non-Goals

- Implementing ColGrep tool registration or any runtime logic (future issue).
- Adding tests — there is no behavior to test yet; tests will arrive alongside the first tool implementation.
- Creating a `package-pi-colgrep` skill file — that will be added when there is enough architecture to document.

## Background

Every existing package in the monorepo follows the same structural pattern:

| Concern            | Convention                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`     | `type: "module"`, `engines.node: ">=22"`, `pi.extensions: ["./src/extension.ts"]`, `publishConfig.access: "public"`, `catalog:` dev deps |
| `tsconfig.json`    | extends `../../tsconfig.base.json`                                                                                                       |
| `LICENSE`          | MIT, copyright Chris Lasher                                                                                                              |
| `CHANGELOG.md`     | empty (release-please owns it)                                                                                                           |
| `AGENTS.md`        | redirect stub pointing users to repo root                                                                                                |
| `src/extension.ts` | default export accepting `ExtensionAPI`                                                                                                  |
| `README.md`        | badges, description, install instructions                                                                                                |
| Monorepo configs   | entry in `release-please-config.json`, `.release-please-manifest.json`, and `scripts/publish-released.sh`                                |

The `pnpm-workspace.yaml` glob `packages/*` already covers any new directory.
Root-level `biome.json` and `.rumdl.toml` apply workspace-wide; no per-package overrides are needed.
CI runs `pnpm -r run check`, `pnpm -r run test`, and root `biome check . && rumdl check .`, so the new package will be included automatically once `pnpm install` wires it up.

## Design Overview

This is pure scaffolding — no runtime logic, no types to design, no edge cases.
The extension entry point will be a no-op default export:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piColGrepExtension(_pi: ExtensionAPI): void {
  // Tool registration will be added in a future issue.
}
```

The `package.json` will mirror `pi-github-tools` (the simplest existing package) with adjusted metadata.
The SDK dependency will use the same version as sibling packages (`0.75.4`).

## Module-Level Changes

### New files

1. `packages/pi-colgrep/package.json` — standard fields, `catalog:` dev deps, no `vitest` yet (no tests).
2. `packages/pi-colgrep/tsconfig.json` — extends base, includes `src`.
3. `packages/pi-colgrep/LICENSE` — MIT, 2026 Christopher D. Lasher.
4. `packages/pi-colgrep/CHANGELOG.md` — single heading `# Changelog` (release-please convention).
5. `packages/pi-colgrep/AGENTS.md` — redirect stub matching sibling packages.
6. `packages/pi-colgrep/src/extension.ts` — no-op default export.
7. `packages/pi-colgrep/README.md` — package name, brief description, prerequisites (ColGrep CLI), install instructions.

### Modified files

1. `release-please-config.json` — add `"packages/pi-colgrep": { "component": "pi-colgrep" }`.
2. `.release-please-manifest.json` — add `"packages/pi-colgrep": "0.0.0"` (first release-please run will create 0.1.0 or 1.0.0).
3. `scripts/publish-released.sh` — add `"packages/pi-colgrep:@gotgenes/pi-colgrep"` to the `packages` array.

### Post-scaffold

Run `pnpm install` to regenerate the lockfile with the new workspace package.

## TDD Order

Since this is infrastructure-only with no behavior, there are no red→green test cycles.
The plan uses a build-plan workflow instead.

1. Create all new files (`package.json`, `tsconfig.json`, `LICENSE`, `CHANGELOG.md`, `AGENTS.md`, `src/extension.ts`, `README.md`).
   Commit: `feat: scaffold @gotgenes/pi-colgrep package (#89)`.
2. Update `release-please-config.json`, `.release-please-manifest.json`, and `scripts/publish-released.sh`.
   Commit: `chore: wire pi-colgrep into release and publish (#89)`.
3. Run `pnpm install` to update the lockfile.
   Commit: `chore: update lockfile for pi-colgrep (#89)`.
4. Verify: `pnpm -C packages/pi-colgrep run check` and `pnpm -C packages/pi-colgrep run lint` pass.
   No separate commit — this is a gate check.
5. Push to `main`, wait for CI to pass, then merge the release-please PR to trigger the initial `0.1.0` publish.
   This enables Trusted Publishing setup on npm before any further development.

## Risks and Mitigations

| Risk                                                                                                        | Mitigation                                                                                               |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| SDK version mismatch — new package pins a different `@earendil-works/pi-coding-agent` version than siblings | Use the exact same version (`0.75.4`) as existing packages.                                              |
| release-please creates a PR for a `0.0.0 → 0.1.0` bump on first merge                                       | Expected and desired — merging it publishes the initial version so Trusted Publishing can be configured. |
| `rumdl check .` fails on empty or minimal markdown                                                          | Match the `CHANGELOG.md` heading style used by other packages; `README.md` will have an H1.              |
| Lockfile churn if catalog versions shift between plan and implementation                                    | Run `pnpm install` as the last step so the lockfile reflects current catalog state.                      |

## Open Questions

None — the issue scope is fully specified and the conventions are well-established.
