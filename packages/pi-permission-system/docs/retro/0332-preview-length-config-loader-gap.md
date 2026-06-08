---
issue: 332
issue_title: "`toolInputPreviewMaxLength` (and `toolTextSummaryMaxLength`) in `config.json` are silently ignored — preview is always truncated at the hardcoded default"
---

# Retro: #332 — Fix `toolInputPreviewMaxLength` / `toolTextSummaryMaxLength` loader gap

## Stage: Planning (2026-06-08T00:00:00Z)

### Session summary

Planned the fix for the loader-pipeline gap that drops `toolInputPreviewMaxLength` and `toolTextSummaryMaxLength`.
Confirmed the downstream machinery (`normalizePermissionSystemConfig`, `resolveToolPreviewLimits`, `ToolPreviewFormatter`) is already correct and the break is confined to `UnifiedPermissionConfig` / `normalizeUnifiedConfig` / `mergeUnifiedConfigs` in `src/config-loader.ts`.
Plan committed at `docs/plans/0332-preview-length-config-loader-gap.md`.

### Observations

- The issue body references `src/runtime.ts`, which no longer exists — the relevant save/refresh logic now lives in `src/config-store.ts` (`ConfigStore.save()` / `ConfigStore.refresh()`).
- Schema (`schemas/permissions.schema.json`), example (`config/config.example.json`), and `docs/configuration.md` already document both fields, so the kuba follow-up comment about the docs schema is stale — no doc edits are needed.
- The "secondary" `save()` bug fixes itself once the loader is fixed: `save()` merges via `{ ...existing.config, … }` and `existing.config` is loaded through the same loader, so the spread carries the parsed fields through unchanged.
- Decision (confirmed with user): rely on the `...existing.config` spread in `save()` rather than the issue's proposed explicit write of `normalized.toolInputPreviewMaxLength`.
  The in-memory `normalized` value is the *merged* value; writing it into the global file would bake a project/per-agent override into global.
  The two preview-length fields are not modal-editable, so leaving the on-disk global value untouched is correct.
- The issue's circular-dependency concern about `normalizeOptionalPositiveInt` is not literal (neither `config-loader.ts` nor `extension-config.ts` imports the other today), but the cleanest home is the dependency-light `src/common.ts` that both already import — avoids the loader depending on the higher-level config-shape module.
- `normalizeOptionalPositiveInt` has only two references: `extension-config.ts` (use) and `test/extension-config.test.ts` (direct tests).
  The package skill does not reference it.
  Relocation is low-risk.

## Stage: Implementation — TDD (2026-06-08T20:37:00Z)

### Session summary

All four TDD steps completed in a single session.
Four commits landed: relocation of `normalizeOptionalPositiveInt` to `common`, parse fix in `normalizeUnifiedConfig`, merge fix in `mergeUnifiedConfigs`, and a save-preservation regression guard in `config-store.test.ts`.
Test count went from 1837 to 1858 (+21 tests across `common.test.ts`, `config-loader.test.ts`, and `config-store.test.ts`).

### Observations

- The plan's single combined scalar loop in `mergeUnifiedConfigs` required splitting into two type-separated loops (boolean scalars, number scalars) because TypeScript rejected assigning `boolean | number` to the narrowed per-property type.
  The type fix was applied during the post-step cleanup and committed as part of the step-3 commit.
- Step 4 (save-preservation test) passed immediately on the first run — confirming the spread approach does the right thing once the loader is fixed.
  No production code change was needed for `config-store.ts`.
- A mid-step rebase (mixed reset + re-commit) was required to correct a commit where the type-safety fix accidentally landed in the step-4 test commit rather than the step-3 production commit.
  Resolved before push with `git reset HEAD~2` and clean re-commits.
- Pre-completion reviewer verdict: **WARN** — the only finding was the missing implementation stage note in this retro file (now addressed).
