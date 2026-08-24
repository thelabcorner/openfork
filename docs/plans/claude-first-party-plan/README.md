# First-Party Claude Agent Integration

Status: planning only. No implementation is authorized by these documents.

Date: 2026-08-24

Owner: OpenFork desktop/server maintainers

## Purpose

Replace the third-party `@openchamber/opencode-claude` plugin with a first-party OpenCode feature that is:

- shipped and versioned with OpenCode;
- available without npm plugin installation or config duplication;
- compatible with Bun development, the Node Electron sidecar, the standalone CLI, and the desktop renderer;
- explicit about Anthropic authentication, branding, data use, and commercial approval;
- testable as a provider/runtime rather than as an opaque local proxy;
- safe around project boundaries, credentials, tools, permissions, cancellation, and session resume.

## Product Boundary

The requested feature is a faithful first-party port of the plugin's existing local runtime, not a new direct Anthropic API product. The official Claude CLI remains the authentication owner: OpenCode starts or relays CLI login and never reads, copies, refreshes, stores, injects, or sends CLI credentials. See `research/external-constraints.md`.

Terms, distribution, and branding review remains a release verification task, not an assumption that the port is disallowed. If review requires a behavior change, record that as a product decision before changing the parity implementation.

## Recommended Shape

Use a first-party `ClaudeAgentRuntime` and an internal provider adapter. Do not copy the external plugin as an internal plugin and do not make the long-term design depend on a loopback HTTP server.

The runtime owns:

- optional, lazy Agent SDK loading;
- executable and credential detection;
- official CLI-authenticated subscription-mode policy;
- a project-scoped session binding store;
- the tool/permission bridge;
- streaming event translation, cancellation, process cleanup, and diagnostics.

The provider adapter owns model discovery, model variants, and conversion between the runtime event protocol and OpenCode's provider/session contracts. Quota reporting remains a separate advisory adapter.

## Reading Order

1. `research/current-state.md` - repository and plugin facts.
2. `research/external-constraints.md` - Anthropic SDK, branding, licensing, and data-use constraints.
3. `plan/architecture.md` - alternatives and recommended target architecture.
4. `plan/migration.md` - compatibility and rollout strategy.
5. `plan/security-privacy.md` - threat model and controls.
6. `plan/testing-release.md` - verification matrix and release gates.
7. `plan/decisions.md` - decision ledger and unresolved gates.
8. `plan/roadmap.md` - phased execution and no-go conditions.
9. `tasks` - dependency-ordered implementation task files.

## Scope

In scope:

- first-party provider/runtime integration;
- local Claude executable and SDK detection;
- API-key authentication and approved subscription mode;
- model catalog and effort variants;
- OpenCode tool and permission integration;
- session resume and project isolation;
- quota/status integration;
- desktop/CLI packaging;
- migration away from the external plugin;
- diagnostics, security, tests, and rollback.

Out of scope for the first release:

- reimplementing the Claude model/API itself;
- silently importing or rewriting user Claude settings;
- creating a second OpenCode session engine;
- exposing an unauthenticated localhost API;
- promising feature parity with every Claude Code surface before the core turn path is reliable;
- replacing the plugin's behavior with a different authentication or billing model.

## Exit Condition

The work is complete only when the release checklist in `plan/testing-release.md` is green, the hard gate is satisfied or subscription mode is disabled, the external plugin cannot double-register, and rollback to the prior provider behavior is documented and tested.
