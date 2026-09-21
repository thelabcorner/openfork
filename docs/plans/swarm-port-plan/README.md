# Legacy OpenSwarm investigation archive

Investigation date: 2026-08-21. Produced by a 5-member planning swarm (all `opencode-go/ox-alpha-free`, max reasoning).

**Historical goal:** inventory the old OpenSwarm plugin and extract useful
behavioral requirements for a first-party implementation.

**Current authority:** OpenFork's native Swarm implementation is independent of
the plugin. The plugin is not a runtime, API, storage, UI, or compatibility
dependency. Documents in this folder that describe OpenSwarm mechanics are
requirements archaeology only; current architecture is defined by
`00-first-party-overhaul-2026-09-18.md`,
`06-implementation-roadmap-v2.md`, the repository maps, and live source/tests.
Any future OpenSwarm support is a bounded **read/import migration source** only.

## Reading order

| # | Document | Owner lane |
|---|---|---|
| 1 | `00-INDEX.md` — executive summary, decision log, reading guide | migration-chief |
| 2 | `01-plugin-capability-map.md` — exhaustive inventory of what openswarm does today and how | scout (plugin archaeologist) |
| 3 | `02-native-integration-blueprint.md` — where each layer lives natively in the monorepo | architect (native core architect) |
| 4 | `03-api-and-data-design.md` — HTTP routes, events, config schema, persistence, native tool surface | api-designer |
| 5 | `04-ux-ui-experience-plan.md` — premium UX/UI across desktop / web app / TUI | ux-designer |
| 6 | `05-roadmap-risks-testing.md` — phased rollout, risk register, test-port plan, acceptance criteria | migration-chief |

## Status

HISTORICAL / MIGRATION INPUT — not an active plugin-port plan.
