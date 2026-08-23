# OpenSwarm → OpenCode Native Port — Investigation Deliverables

Investigation date: 2026-08-21. Produced by a 5-member planning swarm (all `opencode-go/ox-alpha-free`, max reasoning).

**Goal:** a comprehensive, decision-grade plan for porting the openswarm plugin (`C:\Users\slooshied\Documents\openswarm`) into OpenCode **natively** — first-class architecture, API, and premium UX/UI for swarm control & management. Planning only; no implementation.

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

IN PROGRESS — documents appear as lanes complete.
