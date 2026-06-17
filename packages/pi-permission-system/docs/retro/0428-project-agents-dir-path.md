---
issue: 428
issue_title: "pi-permission-system: permission-system using incorrect path for `projectAgentsDir`"
---

# Retro: #428 — pi-permission-system: permission-system using incorrect path for `projectAgentsDir`

## Stage: Planning (2026-06-17T00:00:00Z)

### Session summary

Planned the fix for `derivePolicyLoaderOptions` computing `projectAgentsDir` as `<cwd>/.pi/agent/agents` instead of the Pi-convention `<cwd>/.pi/agents`.
The plan corrects the path via a new `getProjectAgentsDir(cwd)` helper in `config-paths.ts`, adds a behavior-level regression test, and fixes the same wrong path propagated into `docs/configuration.md`.

### Observations

- Third-party issue (author `robertpeteuil`, not the operator), so the direction was confirmed through `ask_user` rather than assumed.
- The operator initially leaned toward a shared cross-package path helper, then toward `pi-subagents` owning it.
  Surfaced that pi-permission-system currently has **zero** code dependency on pi-subagents — they couple only via the Pi event bus (channels re-declared independently per ADR-0002), so pps works standalone.
  Importing from pi-subagents would have introduced the first hard dependency and ended standalone use.
- Reframed `<cwd>/.pi/agents` as a **Pi platform convention**, not pi-subagents' private knowledge: pps already independently (and correctly) encodes three sibling convention paths, including the global agents dir it shares with pi-subagents.
  Operator agreed on a local fix with a named helper + cross-reference comment + regression test, preserving the decoupling.
- Classified as **breaking** (`fix!:`): project-agent `permission:` frontmatter, silently ignored today, starts being enforced on upgrade and can make sessions more restrictive.
- Per-agent permissions apply to directly-activated agents too (via `/agents`), not only pi-subagents children — so the path cannot be pushed via pi-subagents lifecycle events without missing cases.
  This confirmed the path belongs in pps.
- Found a propagated documentation bug at `docs/configuration.md:532` repeating the same wrong path; folded its correction into the plan as a separate `docs:` step.
- Long-term framing corrected by the operator after the initial draft: Pi is **single-agent by deliberate design**; multiple named agents are an external concept (pi-subagents, pi-agent-router, MasuRii packages), not Pi core.
  Verified in the wiring — pps learns the active agent from a generic `<active_agent>` tag injected by pi-agent-router / an `active_agent` session entry, and `/agents` is a pi-subagents command; there is no agent activation independent of external tooling.
  So my earlier "directly-activated via `/agents`" justification was wrong, and both initial Open Questions (upstream `getProjectAgentsDir` to the SDK; have the core parse agent frontmatter) were withdrawn — they would push a multi-agent concept into a core that rejects it.
- Corrected long-term direction now in the plan: per-agent `permission:` frontmatter is an **extension bridge on pps's single-agent core**; a cleaner future keeps that bridge generic (the multi-agent extension supplies the active agent's overrides via an extension-agnostic channel, like the active-agent signal pps already consumes), so pps need not locate or parse agent files.
  Short-term fix is unchanged.
- Recorded the settled part of this framing in `docs/architecture/architecture.md` at the operator's request: a new design principle 9 ("Single-agent core, multi-agent by extension") plus a framing note annotating the `Agent frontmatter` (`AF`) input in the architecture-overview diagram.
  The forward-looking generic-channel evolution stays in the plan's Open Questions, not the architecture doc.
