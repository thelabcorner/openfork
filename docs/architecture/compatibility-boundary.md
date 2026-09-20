# OpenFork compatibility boundary

OpenFork is an **independent product surface descended from OpenCode**, not an
OpenCode-compatible client distribution or wrapper.

Source ancestry, retained package names, and release-tag merges do not create a
compatibility promise. OpenFork may change its local client APIs, local server
routes, runtime semantics, plugin interfaces, UI, tools, persistence, configuration,
and feature set whenever the fork's architecture requires it.

## The one strict upstream compatibility boundary

OpenFork must remain compatible with **upstream-operated remote OpenCode services
that OpenFork chooses to consume**, because those systems run outside this repository
and cannot be changed by the fork.

Examples currently include the OpenCode-hosted model/provider path such as Zen/Go,
and may include upstream-operated authentication, account, usage/quota, sharing,
GitHub integration, or other remote service endpoints actually used by OpenFork.

For each consumed upstream-operated remote service, preserve the externally observed
contract required by that service, including where applicable:

- endpoint/path and method semantics;
- authentication and account-selection behavior;
- required headers and client identity;
- request schemas and provider-native payload semantics;
- streaming/framing behavior;
- model identifiers and advertised capabilities;
- response/error contracts;
- quota, usage, billing, and retry semantics;
- version negotiation or migration behavior.

When upstream changes one of those remote contracts, OpenFork must adapt its local
adapter. Do not "improve" a remote wire contract in a way the upstream service does
not accept.

This is the repository's meaningful **1:1 fidelity requirement**.

## What is explicitly not an OpenCode compatibility target

The following are OpenFork-owned surfaces unless a narrower compatibility promise is
explicitly documented:

- local HTTP/server APIs;
- V1/current/V2 client APIs and generated clients;
- session/runtime implementation;
- UI/desktop/mobile behavior;
- tool contracts and tool inventory;
- plugin and extension APIs;
- CLI/TUI behavior;
- local configuration semantics;
- persistence/database layout;
- local events and projections;
- fork-specific orchestration and agent behavior.

An OpenCode plugin, extension, client, script, config, or local-API consumer **may
not work with OpenFork**. Likewise, an OpenFork integration may not work with
OpenCode. Never advertise or assume cross-product compatibility from a shared
`@opencode-ai/*` package name or common ancestry.

If OpenFork intentionally supports a particular upstream local integration, that is
an **explicit compatibility exception**. Name the exact surface and version range,
add tests, and document the support boundary.

## Distribution is not compatibility

Retained executable, config, package, and protocol identifiers exist to avoid
gratuitous migration cost. They do not make upstream OpenCode distribution channels
part of OpenFork.

OpenFork-owned update and installation paths must resolve to fork-owned release
artifacts. In particular, an `opencode` executable name or `@opencode-ai/*`
import does not justify fetching or publishing through upstream npm, Homebrew,
Scoop, Chocolatey, GitHub releases, containers, or `opencode.ai/install`.

If an installation came from a channel OpenFork does not own, treat the executable
as externally managed. Update discovery may still inform the user about a matching
OpenFork release, but replacement must fail closed rather than invoking an upstream
package manager.

## OpenChamber comparison

OpenChamber-style products wrap or consume OpenCode while intentionally preserving
OpenCode as the underlying compatible runtime surface.

OpenFork is different: it is a source-level branch fork. It owns and changes the
runtime, client/server contracts, interface, and features. Git ancestry and upstream
tag merges are maintenance mechanisms, not a promise that OpenFork remains a drop-in
OpenCode client or server.

## Upstream source is a donor, not an authority over local behavior

Upstream release tags remain valuable sources of:

- provider/backend contract updates;
- security and correctness fixes;
- model/provider support;
- performance improvements;
- current/V2 architectural ideas worth backporting;
- dependency and ecosystem updates.

Each local upstream change is evaluated against OpenFork's architecture. It may be
taken, adapted, backported, or rejected. Current/V2 code is especially useful as a
semantic/reference implementation for improving V1, but OpenFork is not obligated to
adopt the current/V2 local client or runtime migration.

## Review rule

Whenever documentation or code says "compatibility," identify the target:

1. upstream-operated remote service compatibility;
2. third-party provider compatibility;
3. OpenFork internal migration/backward compatibility;
4. an explicitly supported OpenCode local integration.

Unqualified "OpenCode compatibility" is ambiguous and should not be used.
