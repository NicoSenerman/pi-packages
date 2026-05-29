---
issue: 270
issue_title: "Make @gotgenes/pi-subagents type-consumable by sibling workspace packages"
---

# Retro: #270 — Make @gotgenes/pi-subagents type-consumable by sibling workspace packages

## Stage: Planning (2026-05-29T00:00:00Z)

### Session summary

Diagnosed the consumability failure empirically with `tsc --traceResolution` and planned a `.d.ts`-emit fix.
The plan adds a `rollup-plugin-dts` build that bundles `src/service/service.ts` into a self-contained `dist/public.d.ts`, wires conditional `exports` (`types` → the bundle, `default` → the real source), generates the artifact at `prepack` time, ships it via a `files` allowlist, and proves external consumability with a `pnpm pack` → throwaway-consumer → `tsc` harness.

### Observations

- Root cause is two compounding failures: the stale `exports["."]` path (`./src/service.ts` does not exist) and, once fixed, an unresolvable `#src/*` cascade.
  The trace showed the consumer's own `paths` (`#src/*` → `./src/*`) intercept first (both packages define `#src/*`), and the publisher's `imports`-field fallback cannot resolve the extensionless `.ts` target.
- The public type closure is entangled: `WorkspaceProvider` → `AgentStatus` (in the 510-LOC `agent.ts`) → `types.ts` (which re-exports the `Agent` class).
  This made the alias-free-entry alternative (Option 2) a substantial source restructure, so it was rejected.
- Decisions taken via `ask_user`:
  1. Approach — emit a bundled `.d.ts` (the repo's first build step), over alias-free restructure or type re-declaration.
  2. Bundler — `rollup-plugin-dts` (purpose-built for flattening declarations; no JS bundle, which suits ship-source), over `tsdown`/`api-extractor`.
  3. Artifact — not committed; generated at `prepack` and shipped in the tarball, consumed via the package interface.
  4. Scope — tight: packaging + a `pnpm pack`-based verification harness in #270; defer the `pi-subagents-worktrees` registry-consumption flip (drop `workspace:*`, `link-workspace-packages: false`, wire the real import) to #263.
- Scope was deliberately narrowed after a chicken-and-egg surfaced: the registry version carrying the fix does not exist until #270 publishes, so the meaningful consumer flip belongs to #263.
- Sequencing constraint for #263 (captured in the plan): publish #270 first — merge its release-please PR so `pi-subagents` publishes — *before* resuming #263, otherwise #263's `pi-subagents` core edits batch into the same release.
  The current `#263` scaffold commits on `main` touch only the unregistered `pi-subagents-worktrees` component, so they do not batch into `pi-subagents` and #270 ships cleanly.
- Primary feasibility risk flagged: whether `rollup-plugin-dts` resolves `#src/*` while rolling up the type graph.
  Build Step 1 is the explicit checkpoint (emit + assert the output is alias-free and exports the expected symbols).
- `dist/` is gitignored and already excluded by eslint/biome; the new wrinkle is that a `files` allowlist is required so the gitignored `dist/public.d.ts` is included in the npm tarball — validate `pnpm pack --dry-run` parity so no currently-shipped file is dropped.
